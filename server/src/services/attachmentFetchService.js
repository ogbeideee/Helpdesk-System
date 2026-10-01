// Attachment bytes: cache first, source message second.
//
// POLICY (design decision, 2026-10): storing inbound attachment binaries
// forever serves no purpose here. Nobody archives them, they only have to be
// *viewable*, and the message they arrived with stays in the shared mailbox
// for good — the poller never moves, deletes or expunges mail, it only flags
// `\Seen`. So the mailbox is the archive and the local directory is a cache:
//
//   readAttachmentContent()
//     1. cache hit            -> serve (the normal case)
//     2. cache miss           -> re-read the SOURCE message by the identity the
//                                Attachment row already carries, parse it with
//                                the same adapter that parsed it on intake, and
//                                take the part whose sanitized name AND byte
//                                size match the row
//     3. no source / no match -> "no longer available" (404, as before)
//
// Consequences worth stating out loud:
//   - A deploy, a machine replacement or a TTL eviction costs a re-read, not
//     data. That is why the cache can live on an ephemeral disk.
//   - A cache WRITE failure must never cost the ticket either — intake logs it
//     and carries on with the metadata row (see ticketIntake).
//   - Re-reading needs the mailbox to be healthy. If the ingestion credential
//     is dead, an uncached attachment reports "no longer available" — the same
//     message a lost blob used to produce, so no behaviour regresses.
//
// Nothing here decides who may read an attachment; that is the route's
// authorization, unchanged.
const { sanitizeFilename } = require('./attachmentStorage');

/**
 * Image types the ticket screen may render in place.
 *
 * An ALLOWLIST, not a prefix test, and deliberately narrow: SVG and HTML are
 * script-carrying formats that must never be rendered, and `image/*` as a
 * whole would let a declared type decide how the browser treats the bytes.
 * Anything not listed here stays an inert download, exactly as before.
 */
const PREVIEW_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** May this attachment be rendered inline by the ticket screen? */
function isPreviewableImage(mimeType) {
  return PREVIEW_IMAGE_TYPES.has(String(mimeType || '').trim().toLowerCase());
}

/**
 * Find the part of a re-read message that IS this attachment.
 *
 * Strict on purpose: same sanitized display name AND same byte size. A size
 * mismatch means the message changed under us, or the fetch was truncated at
 * IMAP_MAX_SOURCE_BYTES — either way serving those bytes would be serving the
 * wrong file, so a miss is reported instead. Size 0 is treated as unknown and
 * never matches.
 *
 * Injectable and pure, so the whole matching rule is testable without a
 * mailbox.
 */
function matchSourcePart(parts, attachment) {
  const wantName = sanitizeFilename(attachment && attachment.filename);
  const wantSize = Number(attachment && attachment.size);
  if (!Number.isInteger(wantSize) || wantSize <= 0) return null;
  const list = Array.isArray(parts) ? parts : [];
  for (const part of list) {
    if (!part || !Buffer.isBuffer(part.content) || part.content.length === 0) continue;
    if (sanitizeFilename(part.filename) !== wantName) continue;
    const size = part.content.length;
    if (size !== wantSize) continue;
    return part;
  }
  return null;
}

/** A miss that the route already knows how to answer (404, message unchanged). */
function unavailable(reason) {
  const err = new Error('attachment not found');
  err.code = 'NOT_FOUND';
  err.reason = reason;
  return err;
}

/**
 * Source fetchers, keyed by the channel the attachment arrived through
 * (`Attachment.source`: 'imap' | 'graph' | 'dev'). Each returns the message's
 * attachment parts WITH content, or null when the source cannot answer.
 *
 * Lazily required and memoised: a deployment on the IMAP path must not load the
 * Graph SDK (or vice versa) merely because the download route exists.
 */
let sourceFetchers = null;
function defaultSourceFetchers() {
  if (sourceFetchers) return sourceFetchers;
  const imap = () => {
    const { createImapSourceFetcher } = require('../imap/sourceFetch');
    return createImapSourceFetcher();
  };
  const graph = () => {
    const { createGraphSourceFetcher } = require('../graph/sourceFetch');
    return createGraphSourceFetcher();
  };
  sourceFetchers = {
    imap: (...args) => imap()(...args),
    graph: (...args) => graph()(...args),
  };
  return sourceFetchers;
}

/**
 * Resolve an attachment's bytes.
 *
 * @returns {Promise<{content: Buffer, origin: 'cache'|'source'}>}
 * @throws {Error} code NOT_FOUND when neither the cache nor the source can
 *   produce them (the route answers 404 with a fixed message).
 */
async function readAttachmentContent({
  attachment,
  storage,
  fetchers = null,
  logger = console,
} = {}) {
  if (!attachment || !attachment.storageKey || !storage) throw unavailable('no-storage-key');

  try {
    return { content: await storage.get(attachment.storageKey), origin: 'cache' };
  } catch (err) {
    // A missing object is the expected miss. Anything else (a permissions
    // error, a broken provider) is a real failure and must not be disguised as
    // "the attachment is gone".
    if (!err || err.code !== 'NOT_FOUND') throw err;
  }

  const fetcher = (fetchers || defaultSourceFetchers())[String(attachment.source || '')];
  if (typeof fetcher !== 'function' || !attachment.messageId) throw unavailable('no-source-fetcher');

  let parts = null;
  try {
    parts = await fetcher({ attachment, logger });
  } catch (err) {
    // The mailbox is unreachable, the credential is dead, the message is gone.
    // All the agent can be told is that the content is unavailable.
    logger.warn(
      `[attachments] re-read failed for "${attachment.filename}" (${attachment.source}): ${err.message}`
    );
    throw unavailable('source-error');
  }

  const match = matchSourcePart(parts, attachment);
  if (!match) throw unavailable('no-match');

  // Best effort: a failed re-cache still serves the bytes we just read.
  try {
    await storage.put(attachment.storageKey, match.content, attachment.mimeType);
  } catch (err) {
    logger.warn(
      `[attachments] could not re-cache "${attachment.filename}": ${err.message} — serving without caching`
    );
  }

  return { content: match.content, origin: 'source' };
}

module.exports = {
  PREVIEW_IMAGE_TYPES,
  isPreviewableImage,
  matchSourcePart,
  readAttachmentContent,
  defaultSourceFetchers,
};
