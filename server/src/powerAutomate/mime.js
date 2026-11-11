// Export email (V2) supplies the original MIME: sender names, thread headers,
// recipients and attachment bytes reach the same parser as IMAP.
const { extractMessage } = require('../imap/imapMailAdapter');
const { parseEmail } = require('../email/emailParser');
const MAX_MIME_BYTES = 25 * 1024 * 1024;
class PayloadError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function decodeMime(value) {
  if (typeof value !== 'string' || !value.length) throw new PayloadError('mimeBase64 is required');
  if (value.length > Math.ceil(MAX_MIME_BYTES / 3) * 4) throw new PayloadError('Email exceeds 25 MiB', 413);
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new PayloadError('mimeBase64 must be padded base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new PayloadError('mimeBase64 must be canonical base64');
  if (bytes.length > MAX_MIME_BYTES) throw new PayloadError('Email exceeds 25 MiB', 413);
  return bytes;
}
async function parseExport(payload) {
  if (!payload || typeof payload.messageId !== 'string' || !payload.messageId.trim() || payload.messageId.length > 2048) {
    throw new PayloadError('messageId is required and must be at most 2048 characters');
  }
  const result = await extractMessage({ source: decodeMime(payload.mimeBase64) });
  if (result.truncated) throw new PayloadError('Email exceeds the configured MIME limit', 413);
  // Keep the Outlook id for later re-export; the MIME RFC identity remains
  // authoritative for cross-source dedupe and reply references.
  result.rawEmail.messageId = payload.messageId.trim();
  return { email: parseEmail(result.rawEmail), attachments: result.attachments };
}
module.exports = { parseExport, decodeMime, PayloadError, MAX_MIME_BYTES };
