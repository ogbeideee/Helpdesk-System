// Ticket intake pipeline — turns an inbound message into a ticket.
//
// Used by POST /api/tickets/from-email today and designed to back the future
// Microsoft Graph ingestion without changing business logic:
//   validate -> dedupe -> thread -> screen -> relevance triage
//            -> classify -> number -> route -> assign -> audit
//
// No real email is sent from here; notifications go through the isolated
// notification service which logs them in development mode.
const prisma = require("../lib/prisma");
const { classify } = require("../graph/categoryRules");
const { nextTicketNumber } = require("../ticketNumbers");
const { computeDueAt } = require("../sla");
const slaService = require("../slaService");
const assignmentEngine = require("./assignmentEngine");
const intakeScreening = require("./intakeScreening");
const emailTriageService = require("./emailTriageService");
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
    // The quote/signature-stripped view of the body, when the source could
    // compute one (the email parser does; the portal and dev endpoints do
    // not). Only the classifier and relevance gate consume it — never stored.
    cleanBody: String(payload.cleanBody || ""),
    hasAttachments: Boolean(
      payload.hasAttachments ||
      (Array.isArray(payload.attachments) && payload.attachments.length > 0),
    ),
    requesterEmail: String(payload.from || "").trim(),
    requesterName: payload.name ? String(payload.name).trim() : null,
    // Automated-mail signals (RFC 3834 + bulk markers) for the screening
    // gate. Bounded — they are diagnostic header values, never stored.
    autoSubmitted: truncate(payload.autoSubmitted, 100) || null,
    precedence: truncate(payload.precedence, 100) || null,
    listId: truncate(payload.listId, 200) || null,
    listUnsubscribe: truncate(payload.listUnsubscribe, 200) || null,
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
 * True when a Prisma error is a unique-constraint violation on one of the two
 * message-identity columns.
 *
 * The dedupe pre-checks below are a check-then-act pair, so two ingestion
 * channels (or two processes polling the same mailbox) can both pass the check
 * and then race to the insert. The database is the authority: the loser of that
 * race gets P2002 here, which proves a winner already recorded this message.
 * Any other P2002 — a ticket-number collision, say — is a real fault and keeps
 * propagating.
 */
function isMessageIdentityConflict(err) {
  if (!err || err.code !== "P2002") return false;
  const target = err.meta && err.meta.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some(
    (f) => f === "graphMessageId" || f === "internetMessageId",
  );
}

/**
 * The row a lost race lost to: the ticket that now owns this message identity,
 * whether it was recorded as a ticket or as a comment. Null when the insert
 * failed for some other reason and no winner exists.
 */
async function resolveRaceWinner(identityFilter) {
  const ticket = await prisma.ticket.findFirst({
    where: { OR: identityFilter },
  });
  if (ticket) return ticket;
  const comment = await prisma.comment.findFirst({
    where: { OR: identityFilter },
    include: { ticket: true },
  });
  return comment ? comment.ticket : null;
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
 *   { status: 'created',           ticket, assignment }
 *   { status: 'duplicate',         ticket }
 *   { status: 'comment_added',     ticket, comment }
 *   { status: 'reopened',          ticket, comment, assignment: null }
 *   { status: 'skipped_self',      ticket: null }
 *   { status: 'skipped_automated', ticket: null, reason }
 *   { status: 'skipped_non_ticket', ticket: null, reason }
 *
 * options.mailer (default: the shared notification mailer) is injectable so
 * tests can capture exactly which emails a message produces.
 *
 * options.ruleEvaluator (default: the stored admin-configurable email parsing
 * rules) decides keyword-rule overrides; it may return {matches, effective}
 * or null. It influences ONLY the fields its rules explicitly set.
 *
 * options.classifier (default: the keyword classifier in
 * graph/categoryRules.js) decides the category when no parsing rule does. It
 * receives {subject, body, cleanBody, text} and returns {category}.
 *
 * options.triageService (default: emailTriageService) runs only after thread
 * resolution and deterministic screening. Its only authoritative output is
 * skipped_non_ticket; every other result continues to normal ticket intake.
 * options.hasAttachments is a safety signal from the normalized email parser;
 * any attachment vetoes auto-skip.
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

/**
 * The default classifier: the deterministic keyword rules in
 * graph/categoryRules.js. Injectable via options.classifier so a future
 * AI-assisted classifier can replace it without touching this pipeline — the
 * seam only, no provider is wired up here.
 *
 * Receives the subject, the full body, the quote/signature-stripped cleanBody
 * and the pre-joined text; returns { category } (priority and group stay with
 * the parsing rules, routing rules and intake defaults).
 */
async function defaultClassifier({ subject, body, cleanBody }) {
  // Classify the sender's own words. The full body is kept for storage and
  // threading, but quoted history and signatures are noise for classification:
  // they are exactly what used to pull tickets into the wrong category.
  return classify(`${subject}\n${cleanBody || body}`);
}

async function intakeEmailMessage(
  payload,
  {
    logger = console,
    allowThreading = true,
    mailer = notificationService,
    channel = null,
    ruleEvaluator = defaultRuleEvaluator,
    classifier = defaultClassifier,
    triageService = emailTriageService,
    hasAttachments = false,
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
  // Graph, dev endpoint). Planning is pure; binaries cache only after the
  // dedupe gates, so a replayed message never stores anything twice.
  //
  // The cached bytes are NOT the record (see services/attachmentStorage.js and
  // services/attachmentFetchService.js): the source message in the mailbox is,
  // and a cache miss re-reads it. So a cache write failure is logged and the
  // ticket is created anyway — losing the ticket because a disk filled up
  // would be the wrong way round. The attachment row keeps its key and
  // metadata, and the first view re-reads and re-caches the bytes.
  const storageClient = storage || getAttachmentStorage();
  const plan = prepareForStorage(attachments);
  if (plan.skipped.length) {
    // Deliberate, not silent: decorative inline images (signature logos, social
    // icons, pasted pictures) are never persisted — the ticket body is text, so
    // storing them only grows the object store. Reported by name, once per
    // message.
    logger.log(
      `[intake] ${plan.skipped.length} inline image(s) not stored: ` +
        plan.skipped.map((s) => s.filename).join("; "),
    );
  }
  if (plan.rejected.length) {
    logger.warn(
      `[intake] ${plan.rejected.length} attachment(s) rejected: ` +
        plan.rejected.map((r) => `${r.filename} (${r.reason})`).join("; "),
    );
  }
  if (plan.accepted.length) {
    try {
      await uploadAll(plan.accepted, storageClient);
    } catch (err) {
      // Degrade to metadata-only. The message is not left unseen for a retry:
      // a retry would re-race the dedupe gates for the same outcome.
      logger.warn(
        `[intake] ${plan.accepted.length} attachment(s) could not be cached: ${err.message} — ` +
          'the ticket is created with attachment metadata; the bytes are re-read on first view'
      );
    }
  }

  // Requester reply on an existing ticket?
  if (allowThreading) {
    const thread = await resolveThread(msg);
    if (thread) {
      // Comment + attachment rows commit together; if the transaction fails
      // the already-uploaded binaries are cleaned up and the error propagates
      // (the message stays unseen, so the retry is a clean replay).
      let comment;
      // The reply lost the insert race to a concurrent poller that saw the same
      // unseen message. The winner's activity is authoritative, so this call
      // reports the replay as a duplicate instead of failing the message and
      // leaving it unseen for a retry that would only race again. The guard sits
      // OUTSIDE the branch so it covers the transactional and the plain insert
      // alike — the unique message identity is the only arbiter of both.
      let raced = null;
      try {
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
      } catch (err) {
        // Only a lost race is recoverable here; anything else is a real fault.
        if (isMessageIdentityConflict(err)) raced = err;
        else throw err;
      }
      if (raced) {
        const winner = await resolveRaceWinner(identityFilter);
        if (winner) {
          logger.log(
            `[intake] reply ${msg.messageId} lost an insert race and already exists (${winner.ticketNumber}) — treating as duplicate`,
          );
          return { status: "duplicate", ticket: winner };
        }
        throw raced;
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

  // Automated-mail screening. Deliberately AFTER thread resolution: an
  // automated reply that references an existing ticket still attaches as a
  // comment — only NEW-ticket creation is blocked. This is what keeps Google
  // security alerts, quarantine digests, bounces and noreply notifications
  // out of the queue (and stops the ack-to-noreply bounce loop at the root).
  // Definitive outcome, handled exactly like skipped_self by both channels.
  const screening = await intakeScreening.screenMessage(msg);
  if (screening) {
    // Attachment binaries were uploaded before thread resolution; remove
    // them best-effort so a screened message never orphans objects.
    await deleteUploaded(plan.accepted, storageClient);
    logger.log(
      `[intake] skipped automated message ${msg.messageId} (${screening.reason})`,
    );
    return { status: "skipped_automated", ticket: null, reason: screening.reason };
  }

  // Groq relevance triage is deliberately after deterministic screening and
  // thread resolution. It can only choose whether a NEW-ticket candidate is
  // safe to suppress; category, priority, routing and assignment remain the
  // existing deterministic pipeline below.
  let triageResult;
  try {
    triageResult = await triageService.screenMessage(msg, {
      client: prisma,
      logger,
      channel,
      hasAttachments:
        msg.hasAttachments ||
        hasAttachments ||
        (Array.isArray(attachments) && attachments.length > 0),
    });
  } catch {
    // The service is designed to fail open, but intake keeps its own guard so
    // an unexpected programming/database failure can never drop a message.
    triageResult = { action: "ticket_candidate", errorCode: "triage_exception" };
  }
  if (triageResult && triageResult.action === "skipped_non_ticket") {
    // Attachments are uploaded before the current screening seam; remove them
    // best-effort so a triage skip never leaves orphaned binaries.
    await deleteUploaded(plan.accepted, storageClient);
    logger.log(
      `[intake] skipped non-ticket message ${msg.messageId} ` +
        `(reason=${triageResult.reasonCode || "policy"})`,
    );
    return {
      status: "skipped_non_ticket",
      ticket: null,
      reason: triageResult.reasonCode || "policy",
    };
  }

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

  // New ticket: classify category. A parsing rule that sets a category wins;
  // otherwise the classifier decides. The classifier is injectable
  // (options.classifier); if an injected one returns no usable category the
  // default keyword classifier answers instead, so intake can never stall on
  // a bad classifier.
  const classifierInput = {
    subject: msg.subject,
    body: msg.body,
    cleanBody: msg.cleanBody,
    text: `${msg.subject}\n${msg.body}`,
  };
  let classified = (await classifier(classifierInput)) || {};
  if (typeof classified.category !== "string" || !classified.category.trim()) {
    logger.warn(
      "[intake] classifier returned no usable category — falling back to the keyword classifier",
    );
    classified = await defaultClassifier(classifierInput);
  }
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
  // The routing rules match on the ticket text, so the engine needs it — the
  // sender's own words rather than an entire mail thread, so a keyword in
  // quoted history or a signature cannot decide routing. The subject is passed
  // explicitly: a keyword the sender wrote in the subject outranks body-only
  // matches (see routingService's precedence).
  const routingText = `${msg.subject}\n${msg.cleanBody || msg.body}`;
  const assignment = await assignmentEngine.assign(
    {
      category,
      priority,
      subject: msg.subject,
      text: routingText,
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
              // Decorative inline images (signature logos and the like) are
              // deliberately not stored; the count is part of the trail.
              ...(plan.skipped.length
                ? { inlineImagesSkipped: plan.skipped.length }
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
    // Lost the insert race to a concurrent poller that listed the same unseen
    // message. Both passed the dedupe pre-check, and the unique message
    // identity decided: the winner's ticket is the real one. Returning
    // 'duplicate' makes the loser a no-op and stops the message being left
    // unseen for a retry that would only race again.
    if (isMessageIdentityConflict(err)) {
      const winner = await resolveRaceWinner(identityFilter);
      if (winner) {
        logger.log(
          `[intake] message ${msg.messageId} lost an insert race and already exists (${winner.ticketNumber}) — treating as duplicate`,
        );
        return { status: "duplicate", ticket: winner };
      }
    }
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
