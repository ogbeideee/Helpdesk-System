// Normalized email -> ticket pipeline.
//
// This is the seam between the provider-independent parsing layer and the
// existing ticket business logic:
//
//   Raw email
//     -> Email Parser            (src/email/emailParser.js)
//     -> NormalizedEmail
//     -> THIS MODULE             (maps the model onto the intake payload)
//     -> intakeEmailMessage()    (src/services/ticketIntake.js)
//          dedupe -> thread match -> classify -> number -> route -> assign
//          -> audit -> notify
//
// It contains no ticket rules of its own. Classification, priority, ticket
// numbering, assignment, reopening and audit all stay in ticketIntake.js and
// the assignment engine — this module only translates field names and hands
// over. That is what keeps the parser reusable for Graph, IMAP or the dev
// endpoint later.
//
/** @typedef {import('../email/types').NormalizedEmail} NormalizedEmail */

const prisma = require('../lib/prisma');
const { parseEmail } = require('../email/emailParser');
const { intakeEmailMessage, IntakeValidationError } = require('./ticketIntake');

/**
 * Map the normalized email model onto the payload intakeEmailMessage expects.
 *
 * The two shapes differ only in field names; keeping the translation in one
 * place means the ticket layer never learns about email-provider vocabulary.
 *
 * @param {NormalizedEmail} email
 */
function toIntakePayload(email) {
  return {
    messageId: email.messageId,
    internetMessageId: email.internetMessageId,
    conversationId: email.conversationId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    from: email.senderEmail,
    name: email.senderName,
    subject: email.subject,
    body: email.body,
    // The sender's own words without quoted history or signature — the
    // classifier's input, not a stored field. Null when the source could not
    // compute one.
    cleanBody: email.cleanBody || null,
  };
}

/**
 * Run one already-normalized email through the ticket pipeline.
 *
 * Threading is enabled: intake decides new-ticket vs reply by ticket number
 * in the subject/body first, then by In-Reply-To/References, then by
 * conversation id from the same requester. Idempotency comes from the unique
 * graphMessageId / internetMessageId on Ticket and Comment, so replaying the
 * same message is a no-op — whichever channel it arrives through.
 *
 * options.channel (default: none) names the ingestion channel for the audit
 * trail. options.attachments carries decoded binaries for the shared
 * attachment persistence path; the parser never sees them. options.classifier
 * (default: none — intake uses its keyword classifier) forwards an alternative
 * classifier into the ticket pipeline.
 *
 * @param {NormalizedEmail} email
 * @param {{ logger?: Console, channel?: string, attachments?: Array, storage?: object, classifier?: Function }} [options]
 */
async function ingestNormalizedEmail(email, options = {}) {
  const logger = options.logger || console;
  const result = await intakeEmailMessage(toIntakePayload(email), {
    logger,
    allowThreading: true,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.classifier ? { classifier: options.classifier } : {}),
    ...(Array.isArray(options.attachments) && options.attachments.length
      ? { attachments: options.attachments }
      : {}),
    ...(options.storage ? { storage: options.storage } : {}),
  });

  return {
    ...result,
    ticket: await hydrateTicket(result.ticket),
    // Attachment metadata is carried through for visibility. Nothing is
    // stored or uploaded — persistent attachment storage is a later phase.
    attachments: email.attachments,
  };
}

/**
 * Parse raw provider data and ingest it in one step.
 * Throws EmailParseError for unusable input, IntakeValidationError when the
 * parsed email cannot become a ticket.
 *
 * @param {import('../email/types').RawEmailInput} raw
 * @param {{ logger?: Console }} [options]
 */
async function ingestRawEmail(raw, options = {}) {
  const email = parseEmail(raw);
  const result = await ingestNormalizedEmail(email, options);
  return { email, result };
}

/**
 * Ensure the returned ticket carries its team/agent relations.
 *
 * Intake's duplicate path resolves a ticket by graphMessageId without
 * includes, so a replayed message would otherwise look unassigned to a caller
 * even though it is routed. Read-only: this changes what is reported, never
 * what is stored.
 */
async function hydrateTicket(ticket) {
  if (!ticket) return ticket;
  if ('team' in ticket && 'assignedAgent' in ticket) return ticket;
  const full = await prisma.ticket.findUnique({
    where: { id: ticket.id },
    include: { team: true, assignedAgent: true },
  });
  return full || ticket;
}

module.exports = {
  ingestRawEmail,
  ingestNormalizedEmail,
  toIntakePayload,
  IntakeValidationError,
};
