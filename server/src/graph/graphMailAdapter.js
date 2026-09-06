// Microsoft Graph -> normalized email adapter.
//
//   Microsoft Graph
//     -> THIS ADAPTER        (Graph message shape -> RawEmailInput)
//     -> Email Parser        (src/email/emailParser.js)
//     -> Ticket Ingestion    (src/services/emailIngestion.js)
//     -> Ticket / Activity   -> Assignment Engine
//
// Responsibility boundary: translate Graph's vocabulary into the provider-
// independent model, and nothing else. There is deliberately no ticket logic
// here — no classification, no priority, no assignment, no reply-vs-new
// decision, no ticket creation. Those live downstream and are shared with the
// simulated-email path.
//
// This module performs no network calls of its own; it takes already-fetched
// Graph objects. Fetching lives in graphClient.js.
//
/** @typedef {import('../email/types').RawEmailInput} RawEmailInput */
/** @typedef {import('../email/types').NormalizedEmail} NormalizedEmail */

const { parseEmail } = require('../email/emailParser');

/**
 * Graph attachment -> the parser's raw attachment shape.
 * Metadata and references only: no bytes are read, nothing is stored.
 */
function toRawAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  return {
    filename: att.name || att.filename || null,
    contentType: att.contentType || null,
    size: att.size,
    // Graph's attachment id is the reference we would use to fetch content
    // later, once attachment storage is designed.
    attachmentId: att.id || null,
    contentId: att.contentId || null,
    isInline: Boolean(att.isInline),
  };
}

/**
 * Graph message -> RawEmailInput.
 *
 * @param {object} message  a Graph message resource
 * @param {object[]} [attachments]  Graph attachment resources, when fetched
 * @returns {RawEmailInput}
 */
function toRawEmail(message, attachments = []) {
  const msg = message && typeof message === 'object' ? message : {};

  return {
    messageId: msg.id || null,
    // Graph's copy of the RFC 5322 Message-ID — the identity shared with the
    // IMAP channel, so cross-source dedupe and threading match on it.
    internetMessageId: msg.internetMessageId || null,
    conversationId: msg.conversationId || null,
    // Graph exposes the direct reply target; the full References chain is not
    // a Graph property (IMAP supplies it — Graph threads natively).
    inReplyTo: msg.inReplyTo || null,
    // Recipient metadata, parsed for the normalized model (Graph's
    // { emailAddress: { name, address } } shape is understood downstream).
    to: msg.toRecipients || null,
    cc: msg.ccRecipients || null,
    replyTo: msg.replyTo || null,
    // The parser understands Graph's { emailAddress: { name, address } } shape,
    // so this stays a direct hand-off rather than a second name/address parser.
    from: msg.from || msg.sender || null,
    subject: msg.subject || null,
    // { contentType, content } tells the parser whether to convert HTML.
    body: msg.body || null,
    bodyPreview: msg.bodyPreview || null,
    receivedAt: msg.receivedDateTime || null,
    attachments: (Array.isArray(attachments) ? attachments : [])
      .map(toRawAttachment)
      .filter(Boolean),
  };
}

/**
 * Graph message -> NormalizedEmail, via the existing parser.
 *
 * @param {object} message
 * @param {object[]} [attachments]
 * @returns {NormalizedEmail}
 */
function toNormalizedEmail(message, attachments = []) {
  return parseEmail(toRawEmail(message, attachments));
}

/** True when Graph says the message carries attachments worth fetching. */
function hasAttachments(message) {
  return Boolean(message && message.hasAttachments);
}

module.exports = {
  toRawEmail,
  toNormalizedEmail,
  toRawAttachment,
  hasAttachments,
};
