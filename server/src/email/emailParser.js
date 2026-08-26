// Email parser: raw provider data -> NormalizedEmail.
//
// Deterministic string handling only. No LLM, no network, no database.
//
// Scope boundary — this module does NOT do any of the following, by design:
//   category classification · priority · assignment · agent selection
//   ticket creation · notifications · Microsoft Graph communication
//   deciding whether an email is a new ticket or a reply
//
// It converts one email into the shape described in ./types.d.ts and stops.
// See src/services/ticketIntake.js for the business logic that consumes it.
//
/** @typedef {import('./types').NormalizedEmail} NormalizedEmail */
/** @typedef {import('./types').RawEmailInput} RawEmailInput */
/** @typedef {import('./types').EmailAttachment} EmailAttachment */

const { htmlToPlainText, looksLikeHtml } = require('./htmlToText');

// Deliberately permissive: enough to reject obvious rubbish, not so strict it
// drops mail a real person sent. Ticket intake applies the stricter rules.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "John Doe <john@x.com>" / "<john@x.com>" / "john@x.com"
const ADDRESS_WITH_NAME_RE = /^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^>\s]+)\s*>\s*$/;

class EmailParseError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(list.join('; '));
    this.name = 'EmailParseError';
    this.errors = list;
  }
}

/* ------------------------------------------------------------------ */
/* Field extraction                                                    */
/* ------------------------------------------------------------------ */

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Pull a name/address pair out of the several shapes providers use.
 * @returns {{ name: string|null, email: string }}
 */
function extractSender(raw) {
  const candidate =
    raw.from !== undefined && raw.from !== null ? raw.from : raw.sender;

  if (candidate === undefined || candidate === null) {
    return { name: null, email: '' };
  }

  // "John Doe <john@x.com>" or a bare address
  if (typeof candidate === 'string') {
    const withName = candidate.match(ADDRESS_WITH_NAME_RE);
    if (withName) {
      return {
        name: withName[1] && withName[1].trim() ? withName[1].trim() : null,
        email: withName[2].trim(),
      };
    }
    return { name: null, email: candidate.trim() };
  }

  if (typeof candidate === 'object') {
    // Graph-style { emailAddress: { name, address } } is handled here rather
    // than leaking Graph shapes further into the system.
    const nested =
      candidate.emailAddress && typeof candidate.emailAddress === 'object'
        ? candidate.emailAddress
        : null;

    const email = firstString(
      candidate.email,
      candidate.address,
      nested && nested.address,
      nested && nested.email
    );
    const name = firstString(candidate.name, nested && nested.name);

    // A display name that is just the address adds nothing.
    const cleanName = name && name.toLowerCase() !== email.toLowerCase() ? name : null;
    return { name: cleanName || null, email };
  }

  return { name: null, email: '' };
}

/**
 * Resolve the body and whether it arrived as HTML.
 * @returns {{ text: string, isHtml: boolean }}
 */
function extractBody(raw) {
  // 1) Explicit dedicated fields win.
  if (typeof raw.bodyHtml === 'string' && raw.bodyHtml.trim()) {
    return { text: htmlToPlainText(raw.bodyHtml), isHtml: true };
  }
  if (typeof raw.bodyText === 'string' && raw.bodyText.trim()) {
    return { text: normalizePlainText(raw.bodyText), isHtml: false };
  }

  const body = raw.body;

  // 2) { contentType, content }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const content = typeof body.content === 'string' ? body.content : '';
    const declared = String(body.contentType || '').toLowerCase();
    const isHtml = declared.includes('html') || (!declared && looksLikeHtml(content));
    return {
      text: isHtml ? htmlToPlainText(content) : normalizePlainText(content),
      isHtml: Boolean(isHtml && content),
    };
  }

  // 3) String body + an explicit type hint, else sniff the markup.
  if (typeof body === 'string') {
    const declared = String(raw.bodyType || raw.contentType || '').toLowerCase();
    let isHtml;
    if (declared.includes('html')) isHtml = true;
    else if (declared.includes('text') || declared.includes('plain')) isHtml = false;
    else isHtml = looksLikeHtml(body);

    return {
      text: isHtml ? htmlToPlainText(body) : normalizePlainText(body),
      isHtml: Boolean(isHtml && body.trim()),
    };
  }

  // 4) Last resort: a preview line, which providers give as plain text.
  if (typeof raw.bodyPreview === 'string' && raw.bodyPreview.trim()) {
    return { text: normalizePlainText(raw.bodyPreview), isHtml: false };
  }

  return { text: '', isHtml: false };
}

/** Tidy a plain-text body without destroying its structure. */
function normalizePlainText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n');
  text = text.replace(/[ ​‌‍﻿]/g, ' ');
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** ISO-8601 string, falling back to "now" when absent or unparseable. */
function extractReceivedAt(raw) {
  const candidate =
    raw.receivedAt !== undefined && raw.receivedAt !== null
      ? raw.receivedAt
      : raw.receivedDateTime;

  if (candidate instanceof Date) {
    return Number.isNaN(candidate.getTime())
      ? new Date().toISOString()
      : candidate.toISOString();
  }
  if (typeof candidate === 'string' && candidate.trim()) {
    const d = new Date(candidate.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Normalize attachment metadata. Metadata only — no bytes are read and
 * nothing is stored or uploaded anywhere.
 * @returns {EmailAttachment[]}
 */
function extractAttachments(raw) {
  const list = Array.isArray(raw.attachments) ? raw.attachments : [];
  const out = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const filename = firstString(item.filename, item.name, item.fileName) || 'unnamed';
    const contentType = firstString(item.contentType, item.mimeType);

    let size = 0;
    const rawSize = item.size;
    if (typeof rawSize === 'number' && Number.isFinite(rawSize)) size = Math.max(0, Math.trunc(rawSize));
    else if (typeof rawSize === 'string' && rawSize.trim() && Number.isFinite(Number(rawSize))) {
      size = Math.max(0, Math.trunc(Number(rawSize)));
    }

    const attachmentId = firstString(item.attachmentId, item.id, item.contentId) || null;

    out.push({
      filename,
      contentType,
      size,
      attachmentId,
      isInline: Boolean(item.isInline),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Convert raw provider data into the normalized model.
 *
 * @param {RawEmailInput} raw
 * @returns {NormalizedEmail}
 * @throws {EmailParseError} when the input cannot yield a usable email
 */
function parseEmail(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EmailParseError(['raw email must be an object']);
  }

  const errors = [];

  const messageId = firstString(raw.messageId, raw.id, raw.internetMessageId);
  if (!messageId) errors.push('messageId is required');

  const { name: senderName, email: senderEmailRaw } = extractSender(raw);
  const senderEmail = senderEmailRaw.toLowerCase();
  if (!senderEmail) errors.push('sender email is required');
  else if (!EMAIL_RE.test(senderEmail)) {
    errors.push(`sender email is not a valid address: ${senderEmailRaw}`);
  }

  if (errors.length) throw new EmailParseError(errors);

  // Subject is preserved exactly as received (minus surrounding whitespace);
  // reply prefixes are NOT stripped here.
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';

  const { text: body, isHtml } = extractBody(raw);
  const conversationId = firstString(raw.conversationId, raw.threadId) || null;

  return {
    messageId,
    conversationId,
    senderEmail,
    senderName: senderName || null,
    subject,
    body,
    receivedAt: extractReceivedAt(raw),
    isHtml,
    attachments: extractAttachments(raw),
  };
}

/**
 * Non-throwing variant for callers that prefer a result object.
 * @param {RawEmailInput} raw
 */
function tryParseEmail(raw) {
  try {
    return { ok: true, email: parseEmail(raw) };
  } catch (err) {
    if (err instanceof EmailParseError) return { ok: false, errors: err.errors };
    return { ok: false, errors: [err.message] };
  }
}

module.exports = {
  parseEmail,
  tryParseEmail,
  EmailParseError,
  // re-exported so consumers need only this module
  htmlToPlainText,
  ...require('./subjectUtils'),
};
