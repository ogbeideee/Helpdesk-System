// Re-read one message's attachments from Microsoft Graph.
//
// The Graph counterpart of imap/sourceFetch.js, for tickets that arrived
// through the Graph source: an attachment evicted from the byte cache (or never
// cached) is re-read from the mailbox by the message id the Attachment row
// stores.
//
// Read-only, and strictly bounded by what the transport exposes: list the
// message's attachment metadata, then fetch each part's content by its own id.
// A part that vanished or is too large to deliver is skipped, which surfaces to
// the caller as "that attachment is unavailable" — never as a different file.
//
// NOTE: this path has never run against live Microsoft credentials (see
// AGENTS.md, "Intentionally NOT implemented"); it exists so the cache policy
// holds on both ingestion paths, and it is exercised only with mocks.
function createGraphSourceFetcher({ opsProvider } = {}) {
  return async function fetchGraphAttachmentParts({ attachment, logger = console } = {}) {
    const messageId = String((attachment && attachment.messageId) || '').trim();
    if (!messageId) return null;

    const ops = opsProvider
      ? opsProvider()
      : (() => {
          // Lazy require: the Graph SDK + MSAL must not load on the IMAP path.
          const { graphOps } = require('./graphClient');
          return graphOps;
        })();
    if (!ops || typeof ops.listAttachments !== 'function') return null;

    const listed = await ops.listAttachments(messageId);
    const parts = [];
    for (const att of Array.isArray(listed) ? listed : []) {
      const providerId = att && (att.attachmentId || att.id);
      if (!providerId) continue;
      try {
        const content = await ops.getAttachmentContent(messageId, providerId);
        if (!Buffer.isBuffer(content) || content.length === 0) continue;
        parts.push({
          filename: att.filename || att.name || 'attachment.bin',
          contentType: att.contentType || 'application/octet-stream',
          // Graph metadata size is authoritative when present; the fetched
          // length is the fallback, exactly as on the intake path.
          size: typeof att.size === 'number' && att.size > 0 ? att.size : content.length,
          content,
        });
      } catch (err) {
        logger.warn(
          `[graph] re-read of attachment "${att.filename || att.name || providerId}" failed: ${err.message}`
        );
      }
    }
    return parts;
  };
}

module.exports = { createGraphSourceFetcher };
