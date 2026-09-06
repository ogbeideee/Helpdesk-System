// Ticket intake pipeline — turns an inbound message into a ticket.
//
// Used by POST /api/tickets/from-email today and designed to back the future
// Microsoft Graph ingestion without changing business logic:
//   validate -> dedupe -> classify -> number -> route -> assign -> audit
//
// No real email is sent from here; notifications go through the isolated
// notification service which logs them in development mode.
const prisma = require("../lib/prisma");
const { classify } = require("../graph/categoryRules");
const { nextTicketNumber } = require("../ticketNumbers");
const { computeDueAt } = require("../sla");
const slaService = require("../slaService");
const assignmentEngine = require("./assignmentEngine");
const notificationService = require("../mailer");
const auditService = require("./auditService");
const {
  prepareForStorage,
  uploadAll,
  deleteUploaded,
  createRows,
} = require("./attachmentService");
const { getAttachmentStorage } = require("./attachmentStorage");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMENT_MAX = 8000;
const DEFAULT_PRIORITY = "moderate"; // per intake policy; rules may classify category only

class IntakeValidationError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

/**
 * Strip angle brackets from an RFC 5322 Message-ID and split a header value
 * (one string, possibly space-separated) into a comparable id list.
 */
function messageIdList(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const item of list) {
    for (const token of String(item).split(/\s+/)) {
      const id = token.replace(/^</, "").replace(/>$/, "").trim();
      if (id) out.push(id);
    }
  }
  return out;
}

function normalizeMessage(payload = {}) {
  const internetMessageId =
    String(payload.internetMessageId || "")
      .replace(/^</, "")
      .replace(/>$/, "")
      .trim() || null;
  return {
    messageId: String(payload.messageId || "").trim(),
    // The RFC identity every ingestion source shares (Graph supplies it as
    // internetMessageId, IMAP as the Message-ID header). Dedupe and reference
    // threading match on it, so one mailbox fed by two sources cannot double-
    // ticket, and replies thread across sources.
    internetMessageId,
    inReplyTo: messageIdList(payload.inReplyTo),
    references: messageIdList(payload.references),
    conversationId: payload.conversationId
      ? String(payload.conversationId).trim()
      : null,
    subject: String(payload.subject || "").trim(),
    body: String(payload.body || ""),
    requesterEmail: String(payload.from || "").trim(),
    requesterName: payload.name ? String(payload.name).trim() : null,
  };
}

function validate(msg) {
  const errors = [];
  if (!msg.messageId) errors.push("messageId is required");
  else if (msg.messageId.length > 256)
    errors.push("messageId must be <= 256 characters");
  if (!EMAIL_RE.test(msg.requesterEmail))
    errors.push("from must be a valid email address");
  if (!msg.subject) errors.push("subject is required");
  else if (msg.subject.length > 200)
    errors.push("subject must be <= 200 characters");
  if (msg.requesterName && msg.requesterName.length > 120)
    errors.push("name must be <= 120 characters");
  if (msg.conversationId && msg.conversationId.length > 256)
    errors.push("conversationId must be <= 256 characters");
  if (errors.length) throw new IntakeValidationError(errors);
}

/**
 * Find an existing ticket this message belongs to:
 * explicit ticket-number reference first, then the RFC threading headers
 * (In-Reply-To / References) matched against either stored message identity,
 * then same-conversation reply from the same requester.
 */
async function resolveThread(msg) {
  const { extractTicketRef } = require("../ticketNumbers");
  const ref = extractTicketRef(msg.subject, msg.body);
  if (ref) {
    const byRef = await prisma.ticket.findUnique({
      where: { ticketNumber: ref },
    });
    if (byRef) return byRef;
  }
  // Threading headers. Works across sources: a reply fetched over IMAP can
  // reference a message whose ticket was created by Graph, because both store
  // the same stripped Message-ID.
  const chain = [
    ...new Set([...(msg.inReplyTo || []), ...(msg.references || [])]),
  ];
  if (chain.length) {
    const byMessage = await prisma.ticket.findFirst({
      where: {
        OR: [
          { graphMessageId: { in: chain } },
          { internetMessageId: { in: chain } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (byMessage) return byMessage;
    const byComment = await prisma.comment.findFirst({
      where: {
        OR: [
          { graphMessageId: { in: chain } },
          { internetMessageId: { in: chain } },
        ],
      },
      include: { ticket: true },
      orderBy: { createdAt: "desc" },
    });
    if (byComment) return byComment.ticket;
  }
  if (msg.conversationId && msg.requesterEmail) {
    const candidates = await prisma.ticket.findMany({
      where: { graphConversationId: msg.conversationId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const own = candidates.find(
      (t) =>
        (t.requesterEmail || "").toLowerCase() ===
        msg.requesterEmail.toLowerCase(),
    );
    if (own) return own;
  }
  return null;
}

function truncate(value, max) {
  const str = String(value || "");
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * Process one inbound message end-to-end.
 *
 * options.allowThreading (default true): when false, reply/thread matching is
 * skipped and every non-duplicate message becomes a brand-new ticket. The
 * Microsoft Graph integration passes false during the polling-only phase
 * (reply handling arrives in a later phase).
 *
 * Returns one of:
 *   { status: 'created',        ticket, assignment }
 *   { status: 'duplicate',      ticket }
 *   { status: 'comment_added',  ticket, comment }
 *   { status: 'reopened',       ticket, comment, assignment: null }
 *
 * options.mailer (default: the shared notification mailer) is injectable so
 * tests can capture exactly which emails a message produces.
 *
 * options.ruleEvaluator (default: the stored admin-configurable email parsing
 * rules) decides keyword-rule overrides; it may return {matches, effective}
 * or null. It influences ONLY the fields its rules explicitly set.
 */
/**
 * The default rule evaluator: the admin-configurable email parsing rules,
 * loaded from the database. Injectable via options.ruleEvaluator so tests can
 * drive specific rule sets without touching the table.
 */
async function defaultRuleEvaluator({ subject, body }) {
  const { evaluateForMessage } = require("./emailParsingRuleService");
  return evaluateForMessage({ subject, body }, prisma);
}

async function intakeEmailMessage(
  payload,
  {
    logger = console,
    allowThreading = true,
    mailer = notificationService,
    channel = null,
    ruleEvaluator = defaultRuleEvaluator,
    attachments = [],
    storage = null,
  } = {},
) {
  const msg = normalizeMessage(payload);
  validate(msg);

  // Loop guard parity with the Graph pipeline: never process our own mailbox.
  const selfMailbox = (process.env.GRAPH_SHARED_MAILBOX || "").toLowerCase();
  if (selfMailbox && msg.requesterEmail.toLowerCase() === selfMailbox) {
    logger.log(`[intake] skipped self-addressed message ${msg.messageId}`);
    return { status: "skipped_self", ticket: null };
  }

  // 1) messageId already processed? -> never duplicate. Both stored identities
  // are checked so a message that already arrived through the OTHER source
  // (Graph or IMAP) collapses to a duplicate too.
  const identityFilter = [
    { graphMessageId: msg.messageId },
    ...(msg.internetMessageId
      ? [{ internetMessageId: msg.internetMessageId }]
      : []),
  ];
  const existingByMessage = await prisma.ticket.findFirst({
    where: { OR: identityFilter },
  });
  if (existingByMessage) {
    logger.log(
      `[intake] message ${msg.messageId} already processed (${existingByMessage.ticketNumber})`,
    );
    return { status: "duplicate", ticket: existingByMessage };
  }

  // Same guarantee for activities: a redelivered reply (webhook retry, or the
  // poller racing the webhook) must not append the same comment twice.
  const existingByComment = await prisma.comment.findFirst({
    where: { OR: identityFilter },
    include: { ticket: true },
  });
  if (existingByComment) {
    logger.log(
      `[intake] message ${msg.messageId} already recorded as activity on ${existingByComment.ticket.ticketNumber}`,
    );
    return { status: "duplicate", ticket: existingByComment.ticket };
  }

  // Attachment persistence — the ONE shared path for every channel (IMAP,
  // Graph, dev endpoint). Planning is pure; binaries upload only after the
  // dedupe gates, so a replayed message never stores anything twice. A
  // storage failure throws before any ticket/comment/attachment row exists
  // and the message stays unseen for retry.
  const storageClient = storage || getAttachmentStorage();
  const plan = prepareForStorage(attachments);
  if (plan.rejected.length) {
    logger.warn(
      `[intake] ${plan.rejected.length} attachment(s) rejected: ` +
        plan.rejected.map((r) => `${r.filename} (${r.reason})`).join("; "),
    );
  }
  if (plan.accepted.length) {
    await uploadAll(plan.accepted, storageClient);
  }

  // Requester reply on an existing ticket?
  if (allowThreading) {
    const thread = await resolveThread(msg);
    if (thread) {
      // Comment + attachment rows commit together; if the transaction fails
      // the already-uploaded binaries are cleaned up and the error propagates
      // (the message stays unseen, so the retry is a clean replay).
      let comment;
      if (plan.accepted.length) {
        try {
          comment = await prisma.$transaction(async (tx) => {
            const created = await tx.comment.create({
              data: {
                ticketId: thread.id,
                authorName: truncate(msg.requesterName || "", 120),
                authorEmail: msg.requesterEmail,
                isRequester: true,
                viaEmail: true,
                graphMessageId: msg.messageId,
                internetMessageId: msg.internetMessageId,
                body: truncate(
                  msg.body.trim() || "(empty message)",
                  COMMENT_MAX,
                ),
              },
            });
            await createRows(
              plan.accepted,
              {
                ticketId: thread.id,
                commentId: created.id,
                messageId: msg.messageId,
                source: channel,
              },
              tx,
            );
            return created;
          });
        } catch (err) {
          await deleteUploaded(plan.accepted, storageClient);
          throw err;
        }
      } else {
        comment = await prisma.comment.create({
          data: {
            ticketId: thread.id,
            authorName: truncate(msg.requesterName || "", 120),
            authorEmail: msg.requesterEmail,
            isRequester: true,
            viaEmail: true,
            graphMessageId: msg.messageId,
            internetMessageId: msg.internetMessageId,
            body: truncate(msg.body.trim() || "(empty message)", COMMENT_MAX),
          },
        });
      }

      let current = thread;
      let reopened = false;
      if (thread.state === "RESOLVED" || thread.state === "CLOSED") {
        current = await prisma.ticket.update({
          where: { id: thread.id },
          data: {
            state: "IN_PROGRESS",
            resolvedAt: null,
            closedAt: null,
            resolution: null,
            auditLogs: {
              create: {
                fromState: thread.state,
                toState: "IN_PROGRESS",
                actor: msg.requesterEmail,
                note: "Reopened by requester reply",
              },
            },
          },
          include: { assignedAgent: true, team: true },
        });
        reopened = true;
        // Unified trail: the requester is a string actor (an email, not an
        // Agent row), so actorId stays null on purpose.
        await auditService.record(prisma, {
          action: "ticket.reopened",
          entityType: "Ticket",
          entityId: thread.id,
          entityLabel: thread.ticketNumber,
          ticketId: thread.id,
          actor: msg.requesterEmail,
          from: { state: thread.state },
          to: { state: "IN_PROGRESS" },
          description: `${thread.ticketNumber} reopened by requester reply`,
          metadata: { via: "email", ...(channel ? { channel } : {}) },
        });
        // Approved policy 7: reopening preserves the previous SLA cycle and
        // starts the next one, with fresh targets from the reopen instant.
        current = await slaService.restartCycle(current, {
          actor: msg.requesterEmail,
          reason: "Reopened by requester reply",
          include: {
            assignedAgent: true,
            team: true,
            slaCycles: { orderBy: { cycleNumber: "asc" } },
          },
        });
      } else {
        current = await prisma.ticket.findUnique({
          where: { id: thread.id },
          include: { assignedAgent: true, team: true },
        });
      }

      await mailer.notifyReplyReceived(current, {
        fromName: msg.requesterName
          ? `${msg.requesterName} <${msg.requesterEmail}>`
          : msg.requesterEmail,
        reopened,
      });

      logger.log(
        `[intake] ${reopened ? "reopened" : "reply appended to"} ${current.ticketNumber}`,
      );
      return {
        status: reopened ? "reopened" : "comment_added",
        ticket: current,
        comment,
        assignment: null,
      };
    }
  }
  // when allowThreading is false, fall through to brand-new ticket creation

  // Admin-configurable parsing rules run first. They influence ONLY the
  // fields their rules explicitly set — everything else falls back to the
  // existing keyword classifier and the default priority. Fail-open: a broken
  // rule configuration can never block inbound mail.
  let ruleResult = { matches: [], effective: {} };
  try {
    const evaluated = await ruleEvaluator({
      subject: msg.subject,
      body: msg.body,
    });
    if (evaluated) ruleResult = evaluated;
  } catch (err) {
    logger.warn(
      `[intake] parsing-rule evaluation failed, continuing without rules: ${err.message}`,
    );
  }

  // New ticket: classify category via configurable keyword rules. A parsing
  // rule that sets a category wins; otherwise the classifier decides.
  const classified = classify(`${msg.subject}\n${msg.body}`);
  const category = ruleResult.effective.category ?? classified.category;

  // Priority policy for inbound email: MODERATE until triaged otherwise.
  const priority = ruleResult.effective.priority ?? DEFAULT_PRIORITY;

  // A rule that names an assignment group forces that group; the assignment
  // engine still picks the agent inside it. An unknown or inactive group
  // falls back to normal routing with a warning.
  let forceTeamId = null;
  if (ruleResult.effective.teamKey) {
    const forced = await prisma.team.findUnique({
      where: { key: ruleResult.effective.teamKey },
    });
    if (forced && forced.isActive) forceTeamId = forced.id;
    else
      logger.warn(
        `[intake] parsing rule names unknown/inactive group "${ruleResult.effective.teamKey}" — normal routing applies`,
      );
  }

  // 2) assignment engine decides group + skill + best agent.
  // The routing rules match on the ticket text, so the engine needs it.
  const assignment = await assignmentEngine.assign(
    {
      category,
      priority,
      text: `${msg.subject}\n${msg.body}`,
      ...(forceTeamId ? { forceTeamId } : {}),
    },
    prisma,
    logger,
  );

  // 3) create atomically with the ticket-number sequence. If the transaction
  // rolls back, the already-uploaded binaries are removed best-effort so no
  // orphaned objects accumulate; the message stays unseen for a clean retry.
  let ticket;
  try {
    ticket = await prisma.$transaction(async (tx) => {
      const ticketNumber = await nextTicketNumber(tx);
      // The routing decision is part of the ticket's permanent history.
      const ruleNote = assignment.ruleName
        ? `rule "${assignment.ruleName}"` +
          (assignment.matchedKeywords && assignment.matchedKeywords.length
            ? ` (matched: ${assignment.matchedKeywords.join(", ")})`
            : "")
        : "no routing rule matched — default group";
      const auditNote = assignment.agent
        ? `Auto-routed to ${assignment.groupName} via ${ruleNote}; assigned to ${assignment.agent.name}` +
          (assignment.crossTeam ? " from another team (group unchanged)" : "") +
          `: ${assignment.reason}`
        : `Routed to ${assignment.groupName || "triage"} via ${ruleNote} — awaiting assignment (${assignment.reason})`;

      return tx.ticket
        .create({
          data: {
            ticketNumber,
            shortDescription: truncate(msg.subject, 160),
            body: msg.body,
            category,
            priority,
            state: "NEW",
            source: "email",
            requesterEmail: msg.requesterEmail,
            requesterName: msg.requesterName,
            graphMessageId: msg.messageId,
            internetMessageId: msg.internetMessageId,
            graphConversationId: msg.conversationId,
            teamId: assignment.teamId ?? null,
            // Recorded once at creation and never changed afterwards.
            originatingTeamId: assignment.teamId ?? null,
            assignedAgentId: assignment.agent ? assignment.agent.id : null,
            dueAt: computeDueAt(priority),
            auditLogs: {
              create: {
                fromState: null,
                toState: "NEW",
                actor: "system",
                note: auditNote,
              },
            },
          },
          include: { assignedAgent: true, team: true, auditLogs: true },
        })
        .then(async (row) => {
          await auditService.record(tx, {
            action: "ticket.created",
            entityType: "Ticket",
            entityId: row.id,
            entityLabel: row.ticketNumber,
            ticketId: row.id,
            // Intake is a system path: no Agent acts, so actorId stays null.
            actor: "system",
            to: { state: "NEW", priority, category, source: "email" },
            description: `${row.ticketNumber} created from inbound email`,
            metadata: {
              group: assignment.groupName ?? null,
              assignedAgent: assignment.agent ? assignment.agent.name : null,
              rule: assignment.ruleName ?? null,
              // Which ingestion channel delivered the message (graph | imap) —
              // diagnostics only; Ticket.source stays 'email' for every channel.
              ...(channel ? { channel } : {}),
              // Which admin parsing rules matched and which of them decided each
              // overridden field (structured metadata, never the message text).
              ...(ruleResult.matches.length
                ? { emailRules: ruleResult.matches.map((m) => m.name) }
                : {}),
              // How many attachments were persisted with the ticket (a count —
              // never names, keys or storage details).
              ...(plan.accepted.length
                ? { attachments: plan.accepted.length }
                : {}),
            },
          });
          // Attachment metadata rows commit with the ticket itself.
          await createRows(
            plan.accepted,
            { ticketId: row.id, messageId: msg.messageId, source: channel },
            tx,
          );
          return row;
        });
    });
  } catch (err) {
    await deleteUploaded(plan.accepted, storageClient);
    throw err;
  }

  // SLA cycle 1, same policy as the portal path (startCycle also syncs the
  // Ticket.dueAt / responseDueAt mirrors to the working-calendar targets).
  await slaService.startCycle(ticket, {
    cycleNumber: 1,
    startedAt: ticket.createdAt,
  });
  ticket = await prisma.ticket.findUnique({
    where: { id: ticket.id },
    include: {
      assignedAgent: true,
      team: true,
      auditLogs: true,
      slaCycles: { orderBy: { cycleNumber: "asc" } },
    },
  });

  // 4) notifications (development mode: logged, not sent).
  await mailer.notifyNewTicketToDl(ticket);
  await mailer.notifyRequesterAck(ticket);
  if (assignment.agent) {
    await mailer.notifyAssignment(ticket, assignment.agent);
  }

  logger.log(
    `[intake] created ${ticket.ticketNumber} from message ${msg.messageId} ` +
      `(category=${category}, group=${assignment.groupName || "none"}, ` +
      `agent=${assignment.agent ? assignment.agent.email : "awaiting assignment"})`,
  );

  return { status: "created", ticket, assignment };
}

module.exports = {
  intakeEmailMessage,
  IntakeValidationError,
  normalizeMessage,
  validate,
};
