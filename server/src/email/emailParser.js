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

// ---------------------------------------------------------------------------
// Configurable limits — read once at module load, per the server's env
// conventions. They bound the work one hostile message can make the parser do
// and keep every downstream consumer (database rows, outbound mail, the UI)
// well inside sane sizes.
// ---------------------------------------------------------------------------
const lim = (name, fallback, min) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.trunc(raw) : fallback;
};
const LIMITS = {
  // Ticket bodies are stored truncated anyway; this bounds decode/convert work.
  bodyChars: lim('PARSER_MAX_BODY_CHARS', 200000, 1000),
  // RFC 5322 practical line length is 998 characters.
  subjectChars: lim('PARSER_MAX_SUBJECT_CHARS', 998, 20),
  // Recipient lists on real mail are small; a flood of them is hostile.
  recipientsPerList: lim('PARSER_MAX_RECIPIENTS', 50, 1),
  // Thread chains beyond this depth add nothing to resolution.
  threadIds: lim('PARSER_MAX_THREAD_IDS', 50, 1),
  // Attachment METADATA entries kept; binary storage is a later phase.
  attachments: lim('PARSER_MAX_ATTACHMENTS', 25, 0),
};

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
/* RFC 2047 encoded-words ("=?utf-8?Q?...?=")                          */
/* ------------------------------------------------------------------ */

const ENCODED_WORD_RE = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

function decodeCharset(charset, bytes) {
  const cs = String(charset || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  try {
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
      return Buffer.from(bytes).toString('utf8');
    }
    if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'iso8859-1' || cs === 'windows-1252' || cs === 'cp1252') {
      return Buffer.from(bytes).toString('latin1');
    }
  } catch {
    return null;
  }
  return null; // unknown charset: leave the encoded word as-is
}

/**
 * Decode RFC 2047 encoded-words in a header value. Adapters that hand the
 * parser raw header strings (dev endpoint, fixtures) get the same decoded
 * text mailparser produces for IMAP and Graph supplies already decoded.
 * Unknown charsets are left untouched, so output is always deterministic.
 */
function decodeEncodedWords(value) {
  const str = String(value || '');
  if (!str.includes('=?')) return str;
  // Whitespace between two adjacent encoded words is an artifact of the
  // encoding (RFC 2047) and decodes away.
  const joined = str.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/gi, '$1');
  return joined.replace(ENCODED_WORD_RE, (whole, charset, encoding, data) => {
    let bytes = null;
    if (encoding.toLowerCase() === 'b') {
      // Tolerate missing padding, as real mail clients emit it.
      const b64 = data.replace(/[^A-Za-z0-9+/=]/g, '');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      bytes = Buffer.from(padded, 'base64');
      if (bytes.length === 0 && data) return whole;
    } else {
      const out = [];
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '=' && i + 2 < data.length && /[0-9a-fA-F]{2}/.test(data.slice(i + 1, i + 3))) {
          out.push(parseInt(data.slice(i + 1, i + 3), 16));
          i += 2;
        } else if (ch === '_') {
          out.push(0x20);
        } else {
          out.push(data.charCodeAt(i) & 0xff);
        }
      }
      bytes = Buffer.from(out);
    }
    return decodeCharset(charset, bytes) ?? whole;
  });
}

/* ------------------------------------------------------------------ */
/* Field hygiene                                                       */
/* ------------------------------------------------------------------ */

// Control characters must never reach stored ticket fields or outbound mail
// headers: a subject that survives decoding with an embedded CRLF could act as
// header injection further down the line. They collapse to plain spaces.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return null;
  let out = String(value)
    .replace(/\r\n?/g, ' ')
    .replace(/\n/g, ' ')
    // Control characters become spaces (not deletions) so glued words stay
    // readable, then whitespace collapses.
    .replace(CONTROL_CHARS_RE, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out || null;
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
    const decoded = decodeEncodedWords(candidate);
    const withName = decoded.match(ADDRESS_WITH_NAME_RE);
    if (withName) {
      return {
        name: withName[1] && withName[1].trim() ? sanitizeHeaderValue(withName[1]) : null,
        email: withName[2].trim(),
      };
    }
    return { name: null, email: decoded.trim() };
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

    // Encoded display names arrive raw when adapters pass header strings.
    const decodedName = name ? decodeEncodedWords(name) : '';
    // A display name that is just the address adds nothing.
    const cleanName =
      decodedName && decodedName.toLowerCase() !== email.toLowerCase()
        ? sanitizeHeaderValue(decodedName)
        : null;
    return { name: cleanName || null, email };
  }

  return { name: null, email: '' };
}

/**
 * RFC 5322 Message-IDs are conventionally written with angle brackets
 * ("<a@b>"); providers and header parsers disagree about whether to keep
 * them. Stripping them gives every source (Graph, IMAP, dev endpoint) one
 * comparable identity space, which is what cross-source dedupe and
 * reference-thread matching rely on.
 */
function normalizeMessageId(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  return str.replace(/^<+/, '').replace(/>+$/, '') || null;
}

/** An In-Reply-To/References header: one string (space-separated) or a list. */
function extractMessageIdList(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    // A single header may carry several ids separated by whitespace.
    for (const token of item.split(/\s+/)) {
      const id = normalizeMessageId(token);
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * Recipients (to/cc) in any of the shapes providers use. Parsed for the
 * normalized model and diagnostics; nothing downstream stores them yet.
 * @returns {{ name: string|null, email: string }[]}
 */
function extractAddressList(raw, key) {
  const value = raw[key];
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      // "A <a@x>, B <b@y>" — split on commas that are not inside quotes/<>.
      for (const part of item.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        const { name, email } = extractSender({ from: part });
        if (email) out.push({ name: name || null, email: email.toLowerCase() });
      }
    } else if (item && typeof item === 'object') {
      // extractSender reads a raw wrapper, so hand it a synthetic one.
      const { name, email } = extractSender({ from: item });
      if (email) out.push({ name: name || null, email: email.toLowerCase() });
    }
  }
  // A hostile or broken message can carry hundreds of recipients; the parser
  // keeps the first N deterministically and drops the rest.
  return out.slice(0, LIMITS.recipientsPerList);
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

/* ------------------------------------------------------------------ */
/* Quoted replies, forwarded blocks and signatures                     */
/* ------------------------------------------------------------------ */

const QUOTE_LINE_RE = /^\s{0,3}>/;
// "On 1 Sep 2026, Rita wrote:" in the locales an internal helpdesk sees.
const QUOTE_INTRO_RE =
  /^\s*(?:on\s.{0,120}?wrote:|am\s.{0,120}?schrieb:|op\s.{0,120}?schreef:|le\s.{0,120}?a\s*écrit\s*:|el\s.{0,120}?escribió:|den\s.{0,120}?schrieb:)\s*$/i;
const FORWARD_DIVIDER_RE =
  /^\s*-{2,}\s*(original message|forwarded message|forwarded by.{0,80}|vidarebefordrat meddelande)\s*-{2,}\s*:?\s*$/i;
const FORWARDED_HEADER_LINE_RE = /^\s*(from|sent|to|cc|subject|date|betreff|van|onderwerp)\s*:/i;
const SIGNATURE_DELIMITER_RE = /^-- ?$/;

/**
 * Separate what the SENDER actually wrote from what their mail client dragged
 * along: quoted reply blocks, forwarded-message headers and the signature.
 *
 * Deterministic and conservative — only unambiguous markers are separated:
 *   - a standard signature delimiter line ("-- " / "--") starts the signature
 *   - lines beginning with ">" are quoted content
 *   - "On ... wrote:" / "Am ... schrieb:" / … intro lines are quoted content
 *     when quoted (or forwarded) content follows them
 *   - "-----Original Message-----" / "---------- Forwarded message ----------"
 *     and the From/Sent/To/Subject header run that follows are quoted content
 *
 * Nothing is removed from the normalized body — the full text stays intact —
 * this only exposes a clean view for consumers that want one.
 * @returns {{ cleanBody: string, quotedText: string|null, signature: string|null }}
 */
function separateQuotedContent(text) {
  const empty = { cleanBody: '', quotedText: null, signature: null };
  if (typeof text !== 'string' || !text.trim()) return empty;

  const lines = text.split('\n');

  // 1) Signature: the FIRST unquoted standard delimiter claims the tail.
  let signature = null;
  let bodyLines = lines;
  for (let i = 0; i < lines.length; i++) {
    if (SIGNATURE_DELIMITER_RE.test(lines[i]) && !QUOTE_LINE_RE.test(lines[i])) {
      const tail = lines.slice(i + 1).join('\n').trim();
      if (tail) signature = tail;
      bodyLines = lines.slice(0, i);
      break;
    }
  }

  // 2) Quoted / forwarded content: everything with a quote or forward marker.
  // Once a forward divider appears, the REST of the message is the forwarded
  // mail — its body is plain text and cannot be told apart from the author's
  // own words, so it all belongs to the quoted part.
  const own = [];
  const quoted = [];
  let inForward = false;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (inForward) {
      quoted.push(line);
      continue;
    }
    if (QUOTE_LINE_RE.test(line)) {
      quoted.push(line);
      continue;
    }
    if (FORWARD_DIVIDER_RE.test(line)) {
      quoted.push(line);
      inForward = true;
      continue;
    }
    if (FORWARDED_HEADER_LINE_RE.test(line) && quoted.length > 0) {
      // A forwarded header run only counts as forwarded content after a
      // forward divider or quoted block — a standalone "From:" line in a
      // plain email is body text.
      quoted.push(line);
      continue;
    }
    if (QUOTE_INTRO_RE.test(line)) {
      const nextMeaningful = bodyLines.slice(i + 1).find((l) => l.trim());
      if (nextMeaningful && (QUOTE_LINE_RE.test(nextMeaningful) || FORWARD_DIVIDER_RE.test(nextMeaningful))) {
        quoted.push(line);
        continue;
      }
    }
    own.push(line);
  }

  const cleanBody = own.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const quotedText = quoted.length ? quoted.join('\n').trim() || null : null;
  return { cleanBody, quotedText, signature };
}

/**
 * Cap a text body deterministically. The marker makes the truncation visible
 * instead of silently losing the tail mid-sentence.
 */
function limitBody(text) {
  const str = String(text || '');
  if (str.length <= LIMITS.bodyChars) return str;
  return `${str.slice(0, LIMITS.bodyChars)}\n[message truncated]`;
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

  // Subject: decoded, control-character free and bounded. The subject flows
  // into outbound mail subjects and ticket fields, so raw CRLF can never be
  // allowed through (header injection further down the line).
  let subject = sanitizeHeaderValue(decodeEncodedWords(raw.subject));
  if (subject && subject.length > LIMITS.subjectChars) {
    subject = subject.slice(0, LIMITS.subjectChars);
  }

  const { text: body, isHtml } = extractBody(raw);
  const boundedBody = limitBody(body);
  const conversationId = firstString(raw.conversationId, raw.threadId) || null;
  const internetMessageId = normalizeMessageId(raw.internetMessageId) ||
    // An RFC Message-ID header supplied directly by an adapter.
    normalizeMessageId(raw.messageIdHeader);

  return {
    messageId,
    // The RFC 5322 identity, when the provider supplies it. This is the one
    // identifier Graph and IMAP share, so it is what cross-source duplicate
    // prevention and reference threading match on.
    internetMessageId,
    conversationId,
    inReplyTo: extractMessageIdList(raw.inReplyTo).slice(0, LIMITS.threadIds),
    references: extractMessageIdList(raw.references).slice(0, LIMITS.threadIds),
    recipients: {
      to: extractAddressList(raw, 'to'),
      cc: extractAddressList(raw, 'cc'),
      replyTo: extractAddressList(raw, 'replyTo'),
    },
    senderEmail,
    senderName: senderName || null,
    subject: subject || '',
    // The full readable text — nothing is ever removed from `body`.
    body: boundedBody,
    // The same text with quoted replies, forwarded blocks and the signature
    // separated out, for consumers that want the sender's own words only.
    ...separateQuotedContent(boundedBody),
    receivedAt: extractReceivedAt(raw),
    isHtml,
    attachments: extractAttachments(raw).slice(0, LIMITS.attachments),
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
  // exposed for tests and rule evaluation — all pure functions
  decodeEncodedWords,
  sanitizeHeaderValue,
  separateQuotedContent,
  LIMITS,
  // re-exported so consumers need only this module
  htmlToPlainText,
  ...require('./subjectUtils'),
};
