// Microsoft Graph incoming-email service.
//
// Responsibility boundary (per architecture):
//   - authenticate via MSAL (see msalToken.js, used through graphClient.js)
//   - list unread shared-mailbox messages
//   - normalize each message (sender / subject / body / ids)
//   - guard against self-addressed mail and ticket-reply subjects
//   - hand NORMALIZED data to the existing ticket intake service
//   - mark messages read only after a definitive outcome
//
// No ticket creation/assignment logic lives here — everything flows through
// src/services/ticketIntake.js, the same service the simulated endpoint uses.
const prisma = require('../lib/prisma');
const { graphConfig } = require('./config');
const graphStatus = require('./graphStatus');
const { extractText } = require('./htmlToText');
const { extractTicketRef } = require('../ticketNumbers');
const {
  intakeEmailMessage,
  IntakeValidationError,
} = require('../services/ticketIntake');

function getDefaultOps() {
  // Lazy require so the Graph SDK + MSAL never load when integration is off.
  const { graphOps } = require('./graphClient');
  return graphOps;
}

function createMailService(options = {}) {
  const logger = options.logger || console;
  const ops = options.ops || null; // resolved lazily unless injected (tests)
  const intakeOverride = options.intake || null;

  function transport() {
    return ops || getDefaultOps();
  }

  async function runIntake(payload) {
    if (intakeOverride) return intakeOverride(payload);
    // allowThreading:false — full reply handling is a later phase.
    return intakeEmailMessage(payload, { logger, allowThreading: false });
  }

  /**
   * Normalize a raw Graph message into the canonical intake shape.
   * Exported for unit testing.
   */
  function normalizeMessage(raw) {
    const isHtml = raw.body && raw.body.contentType === 'html';
    return {
      messageId: String(raw.id || ''),
      conversationId: raw.conversationId || null,
      subject: String(raw.subject || '').trim(),
      body: isHtml
        ? extractText((raw.body && raw.body.content) || '')
        : String((raw.body && raw.body.content) || ''),
      from:
        ((raw.from && raw.from.emailAddress && raw.from.emailAddress.address) || '')
          .trim(),
      name: (raw.from && raw.from.emailAddress && raw.from.emailAddress.name) || null,
      receivedDateTime: raw.receivedDateTime || null,
    };
  }

  async function safeMarkRead(messageId, why) {
    try {
      await transport().markAsRead(messageId);
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
      graphConfig.sharedMailbox &&
        fromEmail.toLowerCase() === String(graphConfig.sharedMailbox).toLowerCase()
    );
  }

  /** True when the subject/body references an existing ticket number. */
  async function referencesExistingTicket(subject, body) {
    const ref = extractTicketRef(subject, body);
    if (!ref) return false;
    const existing = await prisma.ticket.findUnique({
      where: { ticketNumber: ref },
      select: { id: true },
    });
    return Boolean(existing);
  }

  /**
   * Process one normalized message. Returns an outcome bucket:
   * created | duplicate | skipped_self | skipped_reply | rejected | failed
   */
  async function processOneInner(raw) {
    const msg = normalizeMessage(raw);

    try {
      if (!msg.messageId) {
        logger.warn('[graph] message without id skipped');
        return 'rejected';
      }
      if (isSelfAddressed(msg.from)) {
        logger.log(`[graph] skipping self-addressed message ${msg.messageId}`);
        await safeMarkRead(msg.messageId, 'self-addressed');
        return 'skipped_self';
      }
      // Phase guard: replies referencing an existing ticket number are
      // deliberately ignored until proper thread handling ships.
      if (await referencesExistingTicket(msg.subject, msg.body)) {
        logger.log(
          `[graph] skipping reply-referencing message ${msg.messageId} (existing ticket referenced in subject)`
        );
        await safeMarkRead(msg.messageId, 'ticket reply');
        return 'skipped_reply';
      }

      const result = await runIntake({
        messageId: msg.messageId,
        conversationId: msg.conversationId,
        from: msg.from,
        name: msg.name,
        subject: msg.subject,
        body: msg.body,
      });

      switch (result.status) {
        case 'created':
          await safeMarkRead(msg.messageId, 'ticket created');
          logger.log(`[graph] ticket ${result.ticket.ticketNumber} created from message ${msg.messageId}`);
          return 'created';
        case 'duplicate':
          await safeMarkRead(msg.messageId, 'already processed');
          return 'duplicate';
        case 'comment_added':
        case 'reopened':
          // Unreachable with allowThreading:false; kept for safety.
          await safeMarkRead(msg.messageId, result.status);
          return 'created';
        case 'skipped_self':
          await safeMarkRead(msg.messageId, 'self-addressed');
          return 'skipped_self';
        default:
          await safeMarkRead(msg.messageId, `unhandled status ${result.status}`);
          return 'duplicate';
      }
    } catch (err) {
      if (err instanceof IntakeValidationError) {
        // Permanently invalid input would fail on every retry — acknowledge it.
        logger.warn(`[graph] message ${msg.messageId} rejected: ${err.errors.join('; ')}`);
        await safeMarkRead(msg.messageId, 'validation rejection');
        return 'rejected';
      }
      // Transient failure: leave unread so the next poll retries.
      graphStatus.recordError('graph-process', err);
      logger.error(
        `[graph] processing failed for ${msg.messageId}: ${err.message} — left unread for retry`
      );
      return 'failed';
    }
  }

  /**
   * Process one raw Graph message. Shared by the poller and the webhook —
   * `source` only labels health reporting, it never changes behaviour.
   *
   * Any outcome other than 'failed' is a definitive result, so it counts as a
   * successful pass through the pipeline.
   */
  async function processOne(raw, { source = 'poller' } = {}) {
    const outcome = await processOneInner(raw);
    if (outcome !== 'failed') {
      graphStatus.recordProcessingSuccess({
        source,
        messageId: raw && raw.id ? String(raw.id) : null,
        outcome,
      });
    }
    return outcome;
  }

  /**
   * One polling cycle over the shared mailbox inbox.
   * Returns a summary of what happened.
   */
  async function pollUnread({ batchSize = 25 } = {}) {
    const messages = await transport().listUnreadMessages(batchSize);
    const summary = {
      fetched: messages.length,
      created: 0,
      duplicate: 0,
      skipped_self: 0,
      skipped_reply: 0,
      rejected: 0,
      failed: 0,
    };
    for (const raw of messages) {
      const outcome = await processOne(raw, { source: 'poller' });
      if (summary[outcome] !== undefined) summary[outcome] += 1;
    }
    return summary;
  }

  return { pollUnread, processOne, normalizeMessage };
}

module.exports = { createMailService };
