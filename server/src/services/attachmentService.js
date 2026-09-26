// Attachment persistence — the ONE path both IMAP and Microsoft Graph use to
// store inbound email attachments.
//
// Sequence contract with ticket intake (so ticket/comment state and attachment
// state can never be misleadingly inconsistent):
//   1. prepareForStorage  — pure planning: sanitize display names, generate
//                           server-side keys, enforce the size/count limits.
//                           Rejected attachments are reported with a reason,
//                           never silently dropped.
//   2. uploadAll          — binaries go to object storage BEFORE the database
//                           transaction starts. A storage failure throws here,
//                           so no ticket, no comment and no attachment rows
//                           are created and the email stays unseen for retry.
//   3. createRows         — metadata rows are created INSIDE the caller's
//                           transaction, together with the ticket/comment.
//   4. deleteUploaded     — best-effort cleanup if the transaction rolls back
//                           afterwards, so no orphaned binaries accumulate.
//
// Idempotency rides the email deduplication: a retried message collapses to
// 'duplicate' before persistence runs, and a (messageId, filename, size) guard
// inside createRows makes a same-message double-persist impossible even if a
// caller retries the persistence step itself.
//
// Storage keys are generated server-side and never logged; the display
// filename never reaches a storage path.
const { sanitizeFilename, generateStorageKey, LIMITS } = require('./attachmentStorage');

class AttachmentStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttachmentStorageError';
  }
}

const INLINE_IMAGE_RE = /^image\//i;

/**
 * Is this a decorative image the mail client embedded in the body rather than a
 * file the sender attached?
 *
 * Every corporate signature carries its logo, the social footer its icons, and
 * a pasted screenshot arrives the same way: a `multipart/related` part with
 * `Content-Disposition: inline` (or Graph's `isInline`). The ticket body is
 * stored and shown as text, so those bytes are never rendered from the ticket —
 * persisting them is pure storage growth (in one live mailbox: 277 of 308
 * stored objects, ~8.8 MB, were exactly that).
 *
 * Only *images* are affected: an inline text/calendar part is still stored, and
 * a real attached image (`Content-Disposition: attachment`) is always stored.
 * Set `ATTACHMENT_SKIP_INLINE_IMAGES=false` to keep the old behaviour.
 */
function isInlineImage(att) {
  if (!att || typeof att !== 'object') return false;
  const mime = String(att.contentType || att.mimeType || '').trim();
  if (!INLINE_IMAGE_RE.test(mime)) return false;
  const disposition = String(att.contentDisposition || '').trim().toLowerCase();
  return Boolean(att.isInline) || disposition === 'inline';
}

/** Env-configured default for the inline-image policy (default: skip). */
function skipInlineImages() {
  const raw = process.env.ATTACHMENT_SKIP_INLINE_IMAGES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !/^(?:0|false|no|off)$/i.test(String(raw).trim());
}

/**
 * Plan the persistence of one message's attachments.
 *
 * Three outcomes, and nothing is ever silently dropped:
 *   - `accepted` : stored (binaries uploaded, metadata rows created)
 *   - `skipped`  : deliberately not stored — decorative inline images
 *   - `rejected` : could not be stored — no content, or over a limit
 *
 * @param {Array<{filename?: string, contentType?: string, size?: number, content?: Buffer, isInline?: boolean, contentDisposition?: string|null}>} attachments
 * @param {{ limits?: Partial<typeof LIMITS>, skipInlineImages?: boolean }} [options]
 * @returns {{ accepted: Array, skipped: Array<{filename, reason, code}>, rejected: Array<{filename, reason}> }}
 */
function prepareForStorage(attachments, options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };
  const dropInlineImages =
    options.skipInlineImages === undefined ? skipInlineImages() : Boolean(options.skipInlineImages);
  const accepted = [];
  const skipped = [];
  const rejected = [];
  const list = Array.isArray(attachments) ? attachments : [];

  let total = 0;
  for (const att of list) {
    const display = sanitizeFilename(att && att.filename);
    const content = att && att.content;
    const size = content ? content.length : Number(att && att.size) || 0;

    if (dropInlineImages && isInlineImage(att)) {
      skipped.push({
        filename: display,
        reason: 'inline image embedded in the message body (signature/decoration)',
        code: 'inline_image',
      });
      continue;
    }
    if (!Buffer.isBuffer(content) || content.length === 0) {
      rejected.push({ filename: display, reason: 'no content' });
      continue;
    }
    if (size > limits.maxBytes) {
      rejected.push({ filename: display, reason: `exceeds the ${limits.maxBytes}-byte attachment limit` });
      continue;
    }
    if (accepted.length >= limits.maxPerMessage) {
      rejected.push({ filename: display, reason: `more than ${limits.maxPerMessage} attachments on one message` });
      continue;
    }
    if (total + size > limits.maxTotalBytes) {
      rejected.push({ filename: display, reason: `exceeds the ${limits.maxTotalBytes}-byte total attachment limit` });
      continue;
    }

    total += size;
    accepted.push({
      filename: display,
      mimeType: String(att.contentType || '').trim() || 'application/octet-stream',
      size,
      content,
      storageKey: generateStorageKey(),
    });
  }
  return { accepted, skipped, rejected };
}

/**
 * Upload every accepted attachment. Throws on the first storage failure — the
 * caller must not create any database rows when this throws.
 */
async function uploadAll(accepted, storage) {
  for (const att of accepted) {
    await storage.put(att.storageKey, att.content, att.mimeType);
  }
}

/** Best-effort cleanup of already-uploaded objects (transaction rolled back). */
async function deleteUploaded(accepted, storage) {
  for (const att of accepted) {
    await storage.delete(att.storageKey).catch(() => {});
  }
}

/**
 * Create the metadata rows inside the caller's transaction. `messageId` is the
 * source identity the rows carry for idempotency and diagnostics; keys and
 * credentials never enter audit or log output.
 */
async function createRows(
  accepted,
  { ticketId, commentId = null, messageId = null, source = null },
  client
) {
  if (!accepted.length) return [];
  // Idempotency guard: the same message replayed against the same ticket
  // cannot create a second record for the same (name, size) pair.
  const existing = await client.attachment.findMany({
    where: { ticketId, messageId: messageId || undefined },
    select: { filename: true, size: true },
  });
  const seen = new Set(existing.map((row) => `${row.filename}::${row.size}`));

  const rows = [];
  for (const att of accepted) {
    const fingerprint = `${att.filename}::${att.size}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const row = await client.attachment.create({
      data: {
        ticketId,
        commentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        messageId: messageId || null,
        source: source || null,
        storageKey: att.storageKey,
      },
    });
    rows.push(row);
  }
  return rows;
}

module.exports = {
  AttachmentStorageError,
  prepareForStorage,
  uploadAll,
  deleteUploaded,
  createRows,
  isInlineImage,
  skipInlineImages,
  LIMITS,
};
