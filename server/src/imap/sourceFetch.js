// Re-read one message from the helpdesk mailbox.
//
// This is the "source message" half of the attachment cache policy (see
// services/attachmentFetchService.js): the mailbox is the archive, so an
// evicted or never-cached attachment is fetched again here rather than kept
// forever on disk.
//
// Reads only. Nothing here marks the message seen, moves it, or expunges
// anything — the poller's unread discipline is untouched, and a re-read must
// never make a message look processed.
//
// Identity is the RFC Message-ID the Attachment row already stores. IMAP's
// SEARCH HEADER is a substring match, so the angle brackets the adapter strips
// on the way in do not matter on the way out. The message must still live in
// the configured mailbox (IMAP_MAILBOX, default INBOX): mail a human archived
// elsewhere is reported unavailable rather than hunted for.
const { imapConfig } = require('./config');
const { defaultClientFactory } = require('./mailService');
const { extractMessage } = require('./imapMailAdapter');

/**
 * @returns {(ctx: {attachment: object, logger?: object}) => Promise<Array|null>}
 *   Attachment parts with content, or null when this source cannot answer.
 */
function createImapSourceFetcher({ config = imapConfig, clientFactory = defaultClientFactory } = {}) {
  return async function fetchImapAttachmentParts({ attachment } = {}) {
    if (!config || !config.enabled) return null;
    const messageId = String((attachment && attachment.messageId) || '').trim();
    if (!messageId) return null;

    // A short-lived connection, mirroring the poller: connect, read, log out.
    // Background jobs are single-instance by design and a re-read is a rare,
    // human-initiated event, so holding a persistent client open would cost
    // more than it saves.
    const client = await clientFactory(config);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(config.mailbox);
      try {
        const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        const uid = (Array.isArray(found) ? found : [])[0];
        if (!uid) return null;

        // BODY.PEEK[] — reading never sets \Seen on its own.
        const message = await client.fetchOne(
          String(uid),
          { uid: true, source: true, internalDate: true },
          { uid: true }
        );
        if (!message || !message.source) return null;

        // The same adapter the poller uses, so a re-read and the original
        // intake cannot disagree about what the message contains. A truncated
        // source (IMAP_MAX_SOURCE_BYTES) is left to the strict size match in
        // attachmentFetchService.matchSourcePart: a partial attachment never
        // matches, so it is reported unavailable instead of served short.
        const { attachments } = await extractMessage({
          uid,
          source: message.source,
          internalDate: message.internalDate,
        });
        return attachments;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  };
}

module.exports = { createImapSourceFetcher };
