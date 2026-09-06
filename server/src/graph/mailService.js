// Microsoft Graph incoming-email service.
//
// Orchestration only. The pipeline is:
//
//   Graph message
//     -> graphMailAdapter   (Graph shape -> RawEmailInput)
//     -> emailParser        (RawEmailInput -> NormalizedEmail)
//     -> emailIngestion     (NormalizedEmail -> intake payload)
//     -> ticketIntake       dedupe -> reply match -> classify -> number
//                           -> route -> assign -> audit -> notify
//
// No ticket business logic lives here or in the adapter. Reply-vs-new,
// classification, priority, assignment and reopening are all decided by the
// shared ingestion path — the same one the simulated-email endpoint uses.
//
// Read/unread is a delivery concern, never an idempotency mechanism: the
// unique graphMessageId on Ticket and Comment is what makes reprocessing safe.
// A message is marked read only after a definitive outcome; failures stay
// unread so the next cycle retries them.
const { graphConfig, ingestCutoff } = require('./config');
const graphStatus = require('./graphStatus');
const { toRawEmail, hasAttachments } = require('./graphMailAdapter');
const { parseEmail, EmailParseError } = require('../email/emailParser');
const { ingestNormalizedEmail } = require('../services/emailIngestion');
const { IntakeValidationError } = require('../services/ticketIntake');

function getDefaultOps() {
  // Lazy require so the Graph SDK + MSAL never load when integration is off.
  const { graphOps } = require('./graphClient');
  return graphOps;
}

function createMailService(options = {}) {
  const logger = options.logger || console;
  const ops = options.ops || null; // resolved lazily unless injected (tests)
  const intakeOverride = options.intake || null;
  // Object-storage override for the attachment persistence path (tests).
  const storage = options.storage || null;
  const config = options.config || graphConfig;

  function transport() {
    return ops || getDefaultOps();
  }

  /** Hand the normalized email to the shared ticket pipeline. */
  async function runIntake(email, attachments = []) {
    if (intakeOverride) return intakeOverride(email, attachments);
    return ingestNormalizedEmail(email, {
      logger,
      channel: 'graph',
      attachments,
      ...(storage ? { storage } : {}),
    });
  }

  /**
   * Graph message -> NormalizedEmail.
   * Exposed for tests and for the read-only connectivity check.
   */
  function normalizeMessage(raw, attachments = []) {
    return parseEmail(toRawEmail(raw, attachments));
  }

  /** Attachment metadata, when Graph says there is any. Never fatal. */
  async function fetchAttachments(raw) {
    if (!hasAttachments(raw)) return [];
    try {
      return await transport().listAttachments(raw.id);
    } catch (err) {
      // Losing metadata must not cost us the ticket.
      logger.warn(
        `[graph] could not list attachments for ${raw.id}: ${err.message} — continuing without them`
      );
      return [];
    }
  }

  /**
   * Fetch the binaries for already-listed attachment metadata, for the shared
   * attachment persistence path. A per-attachment failure (e.g. content too
   * large for inline delivery, or the item vanished mid-flight) is a safe
   * rejection of THAT attachment — logged, never silent, and never fatal to
   * the message.
   */
  async function fetchAttachmentContents(messageId, metadata) {
    const out = [];
    for (const att of metadata) {
      // Graph metadata rows carry the attachment id in `id`; the parser's
      // metadata shape uses `attachmentId` — accept both.
      const providerId = att.attachmentId || att.id;
      if (!att || !providerId) continue;
      try {
        const content = await transport().getAttachmentContent(messageId, providerId);
        out.push({
          // Graph metadata names attachments `name`; the parser's shape uses
          // `filename` — accept both, and keep the display name sanitized
          // downstream at persistence time.
          filename: att.filename || att.name || 'attachment.bin',
          contentType: att.contentType || 'application/octet-stream',
          size: typeof att.size === 'number' && att.size > 0 ? att.size : content.length,
          content,
        });
      } catch (err) {
        logger.warn(
          `[graph] attachment "${att.filename || att.name || providerId}" on ${messageId} could not be fetched: ${err.message} — continuing without it`
        );
      }
    }
    return out;
  }

  async function safeMarkRead(messageId, why) {
    try {
      await transport().markAsRead(messageId);
      logger.log(`[graph] Marked message as read (${why})`);
      return true;
    } catch (err) {
      logger.error(
        `[graph] markAsRead failed for ${messageId} (${why}): ${err.message} — it may be reprocessed next cycle`
      );
      return false;
    }
  }

  /** True when the sender address is the helpdesk mailbox itself. */
  function isSelfAddressed(fromEmail) {
    return Boolean(
      config.sharedMailbox &&
        String(fromEmail || '').toLowerCase() === String(config.sharedMailbox).toLowerCase()
    );
  }

  /**
   * Process one raw Graph message.
   *
   * Outcomes: created | comment_added | reopened | duplicate | skipped_self
   *           | rejected | failed
   * Anything other than 'failed' is definitive and marks the message read.
   *
   * @param {object} raw          Graph message
   * @param {{ source?: string }} [opts]
   */
  async function processOne(raw, opts = {}) {
    const source = opts.source || 'poller';
    const messageId = raw && raw.id ? String(raw.id) : '';

    if (!messageId) {
      logger.warn('[graph] message without id skipped');
      return 'rejected';
    }

    logger.log(`[graph] Processing message ${messageId}`);

    let email;
    let attachmentsWithContent = [];
    try {
      const attachmentMeta = await fetchAttachments(raw);
      email = normalizeMessage(raw, attachmentMeta);
      // Binaries for the shared attachment persistence path — fetched only
      // when there is something to fetch, never fatal per attachment.
      if (attachmentMeta.length > 0) {
        attachmentsWithContent = await fetchAttachmentContents(messageId, attachmentMeta);
      }
    } catch (err) {
      if (err instanceof EmailParseError) {
        // Structurally unusable and identical on every retry — acknowledge it.
        logger.warn(`[graph] message ${messageId} rejected: ${err.errors.join('; ')}`);
        await safeMarkRead(messageId, 'unparseable');
        graphStatus.recordProcessingSuccess({ source, messageId, outcome: 'rejected' });
        return 'rejected';
      }
      graphStatus.recordError('graph-parse', err);
      logger.error(`[graph] parsing failed for ${messageId}: ${err.message} — left unread for retry`);
      return 'failed';
    }

    // Never let the helpdesk mailbox raise tickets about its own mail.
    if (isSelfAddressed(email.senderEmail)) {
      logger.log(`[graph] skipping self-addressed message ${messageId}`);
      await safeMarkRead(messageId, 'self-addressed');
      graphStatus.recordProcessingSuccess({ source, messageId, outcome: 'skipped_self' });
      return 'skipped_self';
    }

    logger.log(
      `[email] Parsed message from ${email.senderEmail}` +
        ` (${email.isHtml ? 'html' : 'text'}, ${email.attachments.length} attachment(s))`
    );

    if (config.dryRun) {
      logger.log(`[graph] DRY RUN — no ticket created for ${messageId}, message left unread`);
      return 'dry_run';
    }

    let result;
    try {
      result = await runIntake(email, attachmentsWithContent);
    } catch (err) {
      if (err instanceof IntakeValidationError) {
        logger.warn(`[graph] message ${messageId} rejected: ${err.errors.join('; ')}`);
        await safeMarkRead(messageId, 'validation rejection');
        graphStatus.recordProcessingSuccess({ source, messageId, outcome: 'rejected' });
        return 'rejected';
      }
      // Transient: leave unread so the next cycle retries.
      graphStatus.recordError('graph-process', err);
      logger.error(
        `[graph] processing failed for ${messageId}: ${err.message} — left unread for retry`
      );
      return 'failed';
    }

    const ticket = result.ticket;
    switch (result.status) {
      case 'created':
        logger.log(`[ticket] Created ${ticket.ticketNumber}`);
        if (ticket.assignedAgent) {
          logger.log(`[assignment] Assigned ${ticket.ticketNumber} to ${ticket.assignedAgent.name}`);
        } else {
          logger.log(`[assignment] ${ticket.ticketNumber} awaiting assignment`);
        }
        await safeMarkRead(messageId, 'ticket created');
        break;

      case 'comment_added':
        logger.log(`[ticket] Activity added to ${ticket.ticketNumber}`);
        await safeMarkRead(messageId, 'reply recorded');
        break;

      case 'reopened':
        logger.log(`[ticket] Reopened ${ticket.ticketNumber} from requester reply`);
        await safeMarkRead(messageId, 'ticket reopened');
        break;

      case 'duplicate':
        logger.log(`[graph] message ${messageId} already processed (${ticket.ticketNumber})`);
        await safeMarkRead(messageId, 'already processed');
        break;

      case 'skipped_self':
        await safeMarkRead(messageId, 'self-addressed');
        break;

      default:
        logger.warn(`[graph] unhandled intake status ${result.status} for ${messageId}`);
        await safeMarkRead(messageId, `unhandled status ${result.status}`);
        break;
    }

    graphStatus.recordProcessingSuccess({ source, messageId, outcome: result.status });
    return result.status;
  }

  /**
   * One polling cycle over the shared mailbox inbox.
   *
   * The batch size and the age cutoff are applied server-side by
   * listUnreadMessages, so an old backlog is never even fetched.
   */
  async function pollUnread({ batchSize, since } = {}) {
    const limit = batchSize || config.pollBatchSize || 25;
    const cutoff = since !== undefined ? since : ingestCutoff();

    const messages = await transport().listUnreadMessages(limit, { since: cutoff });

    const summary = {
      fetched: messages.length,
      created: 0,
      comment_added: 0,
      reopened: 0,
      duplicate: 0,
      skipped_self: 0,
      rejected: 0,
      failed: 0,
      dry_run: 0,
    };

    if (messages.length > 0) {
      logger.log(`[graph] Found ${messages.length} unread message(s)`);
    }

    for (const raw of messages) {
      const outcome = await processOne(raw, { source: 'poller' });
      if (summary[outcome] !== undefined) summary[outcome] += 1;
    }
    return summary;
  }

  /**
   * Read-only connectivity check for the test-mode command.
   * Authenticates, confirms the shared mailbox resolves, and returns safe
   * metadata for a few messages. Creates nothing and marks nothing read.
   */
  async function inspectMailbox({ limit = 5, since = null } = {}) {
    const profile = await transport().getMailboxProfile();
    logger.log(`[graph] Connected to shared mailbox ${profile.mail || config.sharedMailbox}`);

    const messages = await transport().listUnreadMessages(limit, { since });
    logger.log(`[graph] Found ${messages.length} unread message(s)`);

    const previews = [];
    for (const raw of messages) {
      try {
        const attachments = await fetchAttachments(raw);
        const email = normalizeMessage(raw, attachments);
        previews.push({
          messageId: email.messageId,
          conversationId: email.conversationId,
          senderEmail: email.senderEmail,
          senderName: email.senderName,
          subject: email.subject,
          receivedAt: email.receivedAt,
          isHtml: email.isHtml,
          bodyLength: email.body.length,
          // A short excerpt only — never the complete body.
          bodyExcerpt: email.body.slice(0, 120),
          attachments: email.attachments,
        });
      } catch (err) {
        previews.push({
          messageId: raw && raw.id ? raw.id : null,
          error: err.message,
        });
      }
    }

    return { profile, unreadCount: messages.length, previews };
  }

  return { pollUnread, processOne, normalizeMessage, inspectMailbox };
}

module.exports = { createMailService };
