// Ticket intake pipeline — turns an inbound message into a ticket.
//
// Used by POST /api/tickets/from-email today and designed to back the future
// Microsoft Graph ingestion without changing business logic:
//   validate -> dedupe -> classify -> number -> route -> assign -> audit
//
// No real email is sent from here; notifications go through the isolated
// notification service which logs them in development mode.
const prisma = require('../lib/prisma');
const { classify } = require('../graph/categoryRules');
const { nextTicketNumber } = require('../ticketNumbers');
const { computeDueAt } = require('../sla');
const assignmentEngine = require('./assignmentEngine');
const notificationService = require('../mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMENT_MAX = 8000;
const DEFAULT_PRIORITY = 'moderate'; // per intake policy; rules may classify category only

class IntakeValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

function normalizeMessage(payload = {}) {
  return {
    messageId: String(payload.messageId || '').trim(),
    conversationId: payload.conversationId ? String(payload.conversationId).trim() : null,
    subject: String(payload.subject || '').trim(),
    body: String(payload.body || ''),
    requesterEmail: String(payload.from || '').trim(),
    requesterName: payload.name ? String(payload.name).trim() : null,
  };
}

function validate(msg) {
  const errors = [];
  if (!msg.messageId) errors.push('messageId is required');
  else if (msg.messageId.length > 256) errors.push('messageId must be <= 256 characters');
  if (!EMAIL_RE.test(msg.requesterEmail)) errors.push('from must be a valid email address');
  if (!msg.subject) errors.push('subject is required');
  else if (msg.subject.length > 200) errors.push('subject must be <= 200 characters');
  if (msg.requesterName && msg.requesterName.length > 120) errors.push('name must be <= 120 characters');
  if (msg.conversationId && msg.conversationId.length > 256) errors.push('conversationId must be <= 256 characters');
  if (errors.length) throw new IntakeValidationError(errors);
}

/**
 * Find an existing ticket this message belongs to:
 * explicit ticket-number reference first, then same-conversation reply from
 * the same requester.
 */
async function resolveThread(msg) {
  const { extractTicketRef } = require('../ticketNumbers');
  const ref = extractTicketRef(msg.subject, msg.body);
  if (ref) {
    const byRef = await prisma.ticket.findUnique({ where: { ticketNumber: ref } });
    if (byRef) return byRef;
  }
  if (msg.conversationId && msg.requesterEmail) {
    const candidates = await prisma.ticket.findMany({
      where: { graphConversationId: msg.conversationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const own = candidates.find(
      (t) => (t.requesterEmail || '').toLowerCase() === msg.requesterEmail.toLowerCase()
    );
    if (own) return own;
  }
  return null;
}

function truncate(value, max) {
  const str = String(value || '');
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
 */
async function intakeEmailMessage(payload, { logger = console, allowThreading = true } = {}) {
  const msg = normalizeMessage(payload);
  validate(msg);

  // Loop guard parity with the Graph pipeline: never process our own mailbox.
  const selfMailbox = (process.env.GRAPH_SHARED_MAILBOX || '').toLowerCase();
  if (selfMailbox && msg.requesterEmail.toLowerCase() === selfMailbox) {
    logger.log(`[intake] skipped self-addressed message ${msg.messageId}`);
    return { status: 'skipped_self', ticket: null };
  }

  // 1) messageId already processed? -> never duplicate
  const existingByMessage = await prisma.ticket.findUnique({
    where: { graphMessageId: msg.messageId },
  });
  if (existingByMessage) {
    logger.log(`[intake] message ${msg.messageId} already processed (${existingByMessage.ticketNumber})`);
    return { status: 'duplicate', ticket: existingByMessage };
  }

  // Same guarantee for activities: a redelivered reply (webhook retry, or the
  // poller racing the webhook) must not append the same comment twice.
  const existingByComment = await prisma.comment.findUnique({
    where: { graphMessageId: msg.messageId },
    include: { ticket: true },
  });
  if (existingByComment) {
    logger.log(
      `[intake] message ${msg.messageId} already recorded as activity on ${existingByComment.ticket.ticketNumber}`
    );
    return { status: 'duplicate', ticket: existingByComment.ticket };
  }

  // Requester reply on an existing ticket?
  if (allowThreading) {
    const thread = await resolveThread(msg);
    if (thread) {
      const comment = await prisma.comment.create({
        data: {
          ticketId: thread.id,
          authorName: truncate(msg.requesterName || '', 120),
          authorEmail: msg.requesterEmail,
          isRequester: true,
          viaEmail: true,
          graphMessageId: msg.messageId,
          body: truncate(msg.body.trim() || '(empty message)', COMMENT_MAX),
        },
      });

      let current = thread;
      let reopened = false;
      if (thread.state === 'RESOLVED' || thread.state === 'CLOSED') {
        current = await prisma.ticket.update({
          where: { id: thread.id },
          data: {
            state: 'IN_PROGRESS',
            resolvedAt: null,
            closedAt: null,
            resolution: null,
            auditLogs: {
              create: {
                fromState: thread.state,
                toState: 'IN_PROGRESS',
                actor: msg.requesterEmail,
                note: 'Reopened by requester reply',
              },
            },
          },
          include: { assignedAgent: true, team: true },
        });
        reopened = true;
      } else {
        current = await prisma.ticket.findUnique({
          where: { id: thread.id },
          include: { assignedAgent: true, team: true },
        });
      }

      await notificationService.notifyReplyReceived(current, {
        fromName: msg.requesterName ? `${msg.requesterName} <${msg.requesterEmail}>` : msg.requesterEmail,
        reopened,
      });

      logger.log(`[intake] ${reopened ? 'reopened' : 'reply appended to'} ${current.ticketNumber}`);
      return {
        status: reopened ? 'reopened' : 'comment_added',
        ticket: current,
        comment,
        assignment: null,
      };
    }
  }
  // when allowThreading is false, fall through to brand-new ticket creation

  // New ticket: classify category via configurable keyword rules.
  const { category } = classify(`${msg.subject}\n${msg.body}`);

  // Priority policy for inbound email: MODERATE until triaged otherwise.
  const priority = DEFAULT_PRIORITY;

  // 2) assignment engine decides group + skill + best agent.
  const assignment = await assignmentEngine.assign({ category, priority }, prisma, logger);

  // 3) create atomically with the ticket-number sequence.
  const ticket = await prisma.$transaction(async (tx) => {
    const ticketNumber = await nextTicketNumber(tx);
    const auditNote = assignment.agent
      ? `Auto-routed to ${assignment.groupName} and assigned to ${assignment.agent.name}: ${assignment.reason}`
      : `Routed to ${assignment.groupName || 'triage'} — awaiting assignment (${assignment.reason})`;

    return tx.ticket.create({
      data: {
        ticketNumber,
        shortDescription: truncate(msg.subject, 160),
        body: msg.body,
        category,
        priority,
        state: 'NEW',
        source: 'email',
        requesterEmail: msg.requesterEmail,
        requesterName: msg.requesterName,
        graphMessageId: msg.messageId,
        graphConversationId: msg.conversationId,
        teamId: assignment.groupName
          ? (await tx.team.findUnique({ where: { key: assignment.groupKey } }))?.id ?? null
          : null,
        assignedAgentId: assignment.agent ? assignment.agent.id : null,
        dueAt: computeDueAt(priority),
        auditLogs: {
          create: { fromState: null, toState: 'NEW', actor: 'system', note: auditNote },
        },
      },
      include: { assignedAgent: true, team: true, auditLogs: true },
    });
  });

  // 4) notifications (development mode: logged, not sent).
  await notificationService.notifyNewTicketToDl(ticket);
  await notificationService.notifyRequesterAck(ticket);
  if (assignment.agent) {
    await notificationService.notifyAssignment(ticket, assignment.agent);
  }

  logger.log(
    `[intake] created ${ticket.ticketNumber} from message ${msg.messageId} ` +
      `(category=${category}, group=${assignment.groupName || 'none'}, ` +
      `agent=${assignment.agent ? assignment.agent.email : 'awaiting assignment'})`
  );

  return { status: 'created', ticket, assignment };
}

module.exports = { intakeEmailMessage, IntakeValidationError, normalizeMessage, validate };
