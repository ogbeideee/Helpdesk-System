// IMAP incoming-email service — the counterpart of graph/mailService.js.
//
// Orchestration only. The pipeline is deliberately the SAME one Graph uses:
//
//   IMAP message (raw RFC 822 source)
//     -> imapMailAdapter  (mailparser decode -> RawEmailInput)
//     -> emailParser      (RawEmailInput -> NormalizedEmail)
//     -> emailIngestion   (NormalizedEmail -> intake payload)
//     -> ticketIntake     dedupe -> thread match -> classify -> number
//                         -> route -> assign -> audit -> notify
//
// No ticket business logic lives here. Reply-vs-new, threading, classification,
// priority, assignment and reopening are decided by the shared ingestion path.
//
// Seen-flag discipline mirrors the Graph mark-as-read design exactly, which is
// the safest IMAP pattern: messages are fetched with BODY.PEEK (imapflow never
// sets \Seen implicitly), and \Seen is STOREd only after a definitive outcome.
// Failures stay unseen so the next cycle retries them naturally — and because
// intake idempotency comes from the unique graphMessageId/internetMessageId on
// Ticket and Comment, retrying can never duplicate a ticket or a comment.
// Nothing is ever deleted from the mailbox.
const { imapConfig } = require('./config');
const imapStatus = require('./imapStatus');
const { getAccessToken } = require('./oauth2');
const { extractMessage } = require('./imapMailAdapter');
const { parseEmail, EmailParseError } = require('../email/emailParser');
const { ingestNormalizedEmail } = require('../services/emailIngestion');
const { IntakeValidationError } = require('../services/ticketIntake');

/**
 * Builds the ImapFlow client for one polling cycle.
 *
 * Two authentication modes, selected purely by configuration:
 *   - authMode 'oauth2': Gmail XOAUTH2. The access token is exchanged from the
 *     configured refresh token BEFORE the connection is created (served from
 *     the in-memory cache on later cycles), then handed to ImapFlow as
 *     auth: { user, accessToken } — ImapFlow performs AUTHENTICATE XOAUTH2.
 *     Resolves asynchronously; callers await the factory either way.
 *   - anything else: the classic username/password path
 *     (auth: { user, pass }), unchanged for every non-Gmail provider.
 *
 * Exported for tests, which assert on the exact auth shape handed to ImapFlow.
 */
function defaultClientFactory(config) {
  // Lazy require so the IMAP client never loads when the integration is off.
  const { ImapFlow } = require('imapflow');
  const options = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    // imapflow's own logger would echo protocol traffic; keep it off. Our
    // logging below never includes credentials or bodies.
    logger: false,
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
    connectTimeout: 30 * 1000,
    greetingTimeout: 30 * 1000,
  };
  if (config.authMode === 'oauth2') {
    return getAccessToken().then((accessToken) =>
      new ImapFlow({ ...options, auth: { user: config.user, accessToken } })
    );
  }
  return new ImapFlow({ ...options, auth: { user: config.user, pass: config.password } });
}

function createImapMailService(options = {}) {
  const logger = options.logger || console;
  const config = options.config || imapConfig;
  const clientFactory = options.clientFactory || defaultClientFactory;
  const intakeOverride = options.intake || null;

  /** True when the sender address is the helpdesk mailbox itself. */
  function isSelfAddressed(fromEmail) {
    return Boolean(
      config.user &&
        String(fromEmail || '').toLowerCase() === String(config.user).toLowerCase()
    );
  }

  /**
   * Mark one message as seen. A failed STORE is not fatal: the message stays
   * unseen, the next cycle reprocesses it, and intake's dedupe collapses the
   * replay to 'duplicate'. Without a live client (direct processOne calls in
   * tests) marking is skipped the same way.
   */
  async function safeMarkSeen(client, uid, why) {
    if (!client) return false;
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      logger.log(`[imap] marked uid ${uid} as seen (${why})`);
      return true;
    } catch (err) {
      logger.error(`[imap] could not mark uid ${uid} as seen (${why}): ${err.message} — it may be reprocessed next cycle`);
      return false;
    }
  }

  /**
   * Process one fetched message.
   *
   * Outcomes: created | comment_added | reopened | duplicate | skipped_self
   *           | rejected | failed
   * Anything other than 'failed' is definitive and marks the message seen.
   *
   * @param {{ uid: number, source: Buffer|string, internalDate?: Date }} message
   * @param {{ client?: object }} [ctx] the live IMAP connection for \Seen marks
   */
  async function processOne(message, { client = null } = {}) {
    const uid = message && message.uid;

    let decoded;
    try {
      decoded = await extractMessage(message);
    } catch (err) {
      // mailparser degrades rather than throws; reaching this means the bytes
      // are unusable at the transport level (e.g. truncated fetch). Leave
      // unseen so the next cycle retries rather than silently dropping mail.
      imapStatus.recordError('imap-parse', err);
      logger.error(`[imap] decoding failed for uid ${uid}: ${err.message} — left unseen for retry`);
      return 'failed';
    }

    const { rawEmail: raw, attachments } = decoded;
    const identity = raw.messageId || `uid-${uid}`;
    logger.log(`[imap] Processing message ${identity} (uid ${uid})`);

    let email;
    try {
      email = parseEmail(raw);
    } catch (err) {
      if (err instanceof EmailParseError) {
        // Structurally unusable and identical on every retry — acknowledge it.
        logger.warn(`[imap] message ${identity} rejected: ${err.errors.join('; ')}`);
        await safeMarkSeen(client, uid, 'unparseable');
        imapStatus.recordProcessingSuccess({ messageId: identity, outcome: 'rejected' });
        return 'rejected';
      }
      imapStatus.recordError('imap-parse', err);
      logger.error(`[imap] parsing failed for ${identity}: ${err.message} — left unseen for retry`);
      return 'failed';
    }

    // Never let the helpdesk mailbox raise tickets about its own mail: outbound
    // helpdesk mail carries the mailbox address as its sender.
    if (isSelfAddressed(email.senderEmail)) {
      logger.log(`[imap] skipping self-addressed message ${identity}`);
      await safeMarkSeen(client, uid, 'self-addressed');
      imapStatus.recordProcessingSuccess({ messageId: identity, outcome: 'skipped_self' });
      return 'skipped_self';
    }

    logger.log(
      `[email] Parsed message from ${email.senderEmail}` +
        ` (${email.isHtml ? 'html' : 'text'}, ${email.attachments.length} attachment(s))`
    );

    let result;
    try {
      if (intakeOverride) {
        result = await intakeOverride(email);
      } else {
        result = await ingestNormalizedEmail(email, { logger, channel: 'imap', attachments });
      }
    } catch (err) {
      if (err instanceof IntakeValidationError) {
        logger.warn(`[imap] message ${identity} rejected: ${err.errors.join('; ')}`);
        await safeMarkSeen(client, uid, 'validation rejection');
        imapStatus.recordProcessingSuccess({ messageId: identity, outcome: 'rejected' });
        return 'rejected';
      }
      // Transient: leave unseen so the next cycle retries.
      imapStatus.recordError('imap-process', err);
      logger.error(`[imap] processing failed for ${identity}: ${err.message} — left unseen for retry`);
      return 'failed';
    }

    const ticket = result.ticket;
    switch (result.status) {
      case 'created':
        logger.log(`[ticket] Created ${ticket.ticketNumber} (via IMAP)`);
        break;
      case 'comment_added':
        logger.log(`[ticket] Activity added to ${ticket.ticketNumber}`);
        break;
      case 'reopened':
        logger.log(`[ticket] Reopened ${ticket.ticketNumber} from requester reply (via IMAP)`);
        break;
      case 'duplicate':
        logger.log(`[imap] message ${identity} already processed (${ticket.ticketNumber})`);
        break;
      default:
        logger.warn(`[imap] unhandled intake status ${result.status} for ${identity}`);
        break;
    }

    await safeMarkSeen(client, uid, result.status);
    imapStatus.recordProcessingSuccess({ messageId: identity, outcome: result.status });
    return result.status;
  }

  /**
   * One polling cycle over the configured mailbox.
   *
   * Connection/authentication failures propagate to the caller (the poller
   * timer catches them and logs — the server never crashes, the next tick
   * simply retries). Per-message failures are contained inside processOne.
   */
  async function pollUnread({ batchSize } = {}) {
    const limit = batchSize || config.pollBatchSize || 25;

    const summary = {
      fetched: 0,
      created: 0,
      comment_added: 0,
      reopened: 0,
      duplicate: 0,
      skipped_self: 0,
      rejected: 0,
      failed: 0,
    };

    // The factory resolves to an ImapFlow client in both auth modes: it
    // returns the client directly for password auth and a promise (token
    // exchange first) for OAuth2 — awaiting covers both.
    const client = await clientFactory(config);
    await client.connect();

    try {
      const lock = await client.getMailboxLock(config.mailbox);
      try {
        const found = await client.search({ seen: false }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).slice(0, limit);
        summary.fetched = uids.length;
        if (uids.length > 0) {
          logger.log(`[imap] Found ${uids.length} unseen message(s) in ${config.mailbox}`);
        }

        for (const uid of uids) {
          let message;
          try {
            // BODY.PEEK[] — reading never sets \Seen on its own.
            message = await client.fetchOne(String(uid), { uid: true, source: true, internalDate: true }, { uid: true });
          } catch (err) {
            imapStatus.recordError('imap-fetch', err);
            logger.error(`[imap] fetch failed for uid ${uid}: ${err.message} — left unseen for retry`);
            summary.failed += 1;
            continue;
          }

          if (!message || !message.source) {
            logger.warn(`[imap] empty fetch result for uid ${uid} — left unseen for retry`);
            summary.failed += 1;
            continue;
          }

          const outcome = await processOne(
            { uid, source: message.source, internalDate: message.internalDate },
            { client }
          );
          if (summary[outcome] !== undefined) summary[outcome] += 1;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }

    return summary;
  }

  return { pollUnread, processOne };
}

module.exports = { createImapMailService, defaultClientFactory };
