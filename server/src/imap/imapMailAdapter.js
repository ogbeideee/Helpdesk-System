// IMAP raw message -> RawEmailInput (the imapMailAdapter counterpart of
// graph/graphMailAdapter.js).
//
// Responsibility boundary: translate a fetched IMAP message (the full RFC 822
// source, decoded by mailparser) into the provider-independent raw model, and
// nothing else. No ticket logic, no classification, no reply-vs-new decision —
// those live downstream and are shared with the Graph pipeline.
//
// mailparser is deliberately chosen for the MIME layer: it never throws on
// malformed input (it degrades field by field), which is exactly the failure
// mode IMAP servers produce in the wild. Anything it cannot make sense of
// simply arrives as null and is rejected further down by the parser.
//
/** @typedef {import('../email/types').RawEmailInput} RawEmailInput */

const { simpleParser } = require('mailparser');

// A pathological message (hundreds of MB) must never be handed to the MIME
// decoder whole. The cap is generous — every mainstream provider rejects mail
// well below it — and truncation degrades the parse instead of exhausting the
// process. Configurable per the server's env conventions; 0 disables the cap.
const MAX_SOURCE_BYTES = (() => {
  const raw = Number(process.env.IMAP_MAX_MESSAGE_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 26214400;
})();

function stripAngleBrackets(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  return str.replace(/^<+/, '').replace(/>+$/, '') || null;
}

/** mailparser address object(s) -> the { name, address } list the parser reads. */
function toAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const group of list) {
    for (const entry of (group && group.value) || []) {
      if (entry && entry.address) out.push({ name: entry.name || null, address: entry.address });
    }
  }
  return out;
}

function firstFrom(list) {
  return list.length ? list[0] : null;
}

/**
 * One fetched IMAP message -> RawEmailInput (the parser's input shape).
 * Decodes the source exactly once.
 *
 * @param {{ uid: number, source: Buffer|string, internalDate?: Date }} message
 * @returns {Promise<RawEmailInput>}
 */
async function toRawEmail(message) {
  const { rawEmail } = await extractMessage(message);
  return rawEmail;
}

/**
 * One fetched IMAP message -> { rawEmail, attachments, truncated }.
 *
 * Decodes the raw RFC 822 source exactly once and returns BOTH the parser's
 * input model AND the attachments with their decoded binary content — which
 * the attachment persistence path needs and the shared parser deliberately
 * never sees. simpleParser is deterministic for identical bytes, so this is
 * the single decode point for the IMAP channel.
 *
 * @param {{ uid: number, source: Buffer|string, internalDate?: Date }} message
 * @returns {Promise<{ rawEmail: RawEmailInput, attachments: Array<{filename: string, contentType: string, size: number, content: Buffer}>, truncated: boolean }>}
 */
async function extractMessage({ uid, source, internalDate }) {
  let bytes = Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''), 'utf8');
  let truncated = false;
  if (MAX_SOURCE_BYTES > 0 && bytes.length > MAX_SOURCE_BYTES) {
    bytes = bytes.subarray(0, MAX_SOURCE_BYTES);
    truncated = true;
  }

  // simpleParser consumes the raw RFC 822 bytes: headers, MIME structure,
  // transfer encodings and charsets. It degrades field by field instead of
  // throwing on malformed input.
  const parsed = await simpleParser(bytes);

  // Attachment binaries. Metadata mirrors the parser's whitelist; content is
  // extra and never flows into the shared parser. Empty-content entries
  // (e.g. linked resources a server did not inline) are dropped here and are
  // reported neither as stored nor as rejected.
  const attachments = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
    .filter((a) => a && Buffer.isBuffer(a.content) && a.content.length > 0)
    .map((a) => ({
      filename: a.filename || 'attachment.bin',
      contentType: a.contentType || 'application/octet-stream',
      size: typeof a.size === 'number' && a.size > 0 ? a.size : a.content.length,
      content: a.content,
    }));

  const messageId = stripAngleBrackets(parsed.messageId);
  // When an HTML part exists it is authoritative and the shared parser does
  // the conversion (one conversion path for both sources, isHtml reported
  // true). The plain-text part is used only when there is no HTML part.
  // (mailparser always populates ‘text’ — generated from the HTML when no
  // plain part exists — so its presence proves nothing.)
  const hasHtml = typeof parsed.html === 'string' && parsed.html.trim();
  const text = !hasHtml && typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text : null;
  const html = hasHtml ? parsed.html : null;
  const from = firstFrom(toAddressList(parsed.from));

  const rawEmail = {
    // Graph and IMAP share this identity space (angle brackets stripped), so
    // the same physical message is one ticket no matter which source sees it.
    messageId,
    internetMessageId: messageId,
    // IMAP has no native conversation id — threading runs through
    // In-Reply-To/References, which the shared intake resolves.
    conversationId: null,
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
    from: from ? { name: from.name, address: from.address } : null,
    to: toAddressList(parsed.to),
    cc: toAddressList(parsed.cc),
    replyTo: toAddressList(parsed.replyTo),
    subject: typeof parsed.subject === 'string' ? parsed.subject : null,
    bodyText: text,
    bodyHtml: html,
    // The server's INTERNALDATE is authoritative for polling; the Date header
    // is a reasonable fallback when a server omits it.
    receivedAt: internalDate || parsed.date || null,
    // Parser metadata (no content field) — the whitelist the parser expects.
    attachments: (Array.isArray(parsed.attachments) ? parsed.attachments : []).map((a) => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      size: typeof a.size === 'number' ? a.size : 0,
      attachmentId: a.contentId || null,
      isInline: Boolean(a.related),
    })),
    // Carried for diagnostics; the uid is the IMAP-side identity of the fetch.
    uid,
  };

  return { rawEmail, attachments, truncated };
}

module.exports = { toRawEmail, extractMessage, stripAngleBrackets };
