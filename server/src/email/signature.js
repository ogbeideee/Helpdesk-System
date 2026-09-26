// Deterministic signature and legal-footer detection.
//
// The parser separates what the sender actually WROTE from everything their
// mail client dragged along. Quoted reply blocks have unambiguous markers
// (`>`, "On … wrote:", "-----Original Message-----"); signatures mostly do
// not — Outlook, Exchange and mobile clients emit a free-form block of
// name / job title / company / phone / email lines followed by a social-media
// line and a legal disclaimer. `-- ` (RFC 3676) is the only standard marker and
// real corporate mail almost never uses it, which is exactly why signatures
// used to survive into `cleanBody` and decide classification, routing and the
// relevance gate.
//
// This module recognises the two shapes that ARE unambiguous, and nothing else:
//   1. a footer marker — the legal/social boilerplate that only ever appears at
//      the end of a message ("This email is sent on behalf of …",
//      "The contents of this e-mail … confidential", "We are on Social Media");
//   2. a TRAILING run of signature-shaped lines (contact / company / role /
//      URL) — never a line in the middle of a request, and never a single line
//      on its own.
//
// Everything here is pure: no clock, no IO, no network, no LLM. Callers get an
// index; nothing is deleted from the normalized body by this module.
'use strict';

/** A quoted line can never be the sender's signature. */
const QUOTED_LINE_RE = /^\s{0,3}>/;

/**
 * Closing salutations that occupy a line by themselves. Anchored at both ends
 * on purpose: "Thanks, that worked." is a sentence, "Thanks," is a salutation.
 */
const SALUTATION_RE = new RegExp(
  '^(?:' +
    '(?:warm|kind|best|many|sincere|friendly)\\s+(?:regards|wishes)' +
    '|regards' +
    '|best' +
    '|cheers' +
    '|thanks(?:\\s+(?:and|&)\\s+(?:kind\\s+|best\\s+)?regards)?' +
    '|thank\\s+you(?:\\s+(?:and|&)\\s+(?:kind\\s+|best\\s+)?regards)?' +
    '|with\\s+(?:best|kind|warm)\\s+(?:regards|wishes)' +
    '|yours?\\s+(?:sincerely|faithfully|truly)' +
    '|sincerely(?:\\s+yours)?' +
    '|cordially' +
    '|respectfully' +
  ')[,.!:]*$',
  'i'
);

/**
 * Legal / marketing boilerplate and social footers. Anchored at the start of
 * the line so a sentence that merely mentions confidentiality cannot match.
 */
const FOOTER_LINE_RE = new RegExp(
  '^(?:' +
    'we\\s+are\\s+on\\s+social\\s+media' +
    '|the\\s+contents\\s+of\\s+this\\s+(?:e-?mail|message)' +
    '|this\\s+(?:e-?mail|message|transmission)\\b[^\\n]{0,200}?' +
      '(?:confidential|sent\\s+on\\s+behalf\\s+of|intended\\s+recipient)' +
  ')',
  'i'
);

/** Contact and identity markers that only a signature block carries. */
const EMAIL_MARKER_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const CONTACT_LABEL_RE =
  /(?:^|[\s|(/])(?:d|c|t|m|o|p|f|tel|telephone|phone|mobile|cell|direct|ext|extension|fax|email|e-mail|web|website|www)\s*[:.]\s*\S/i;
const PHONE_RUN_RE = /\+?\d[\d\s()\-.]{6,}\d/;
const COMPANY_RE = /\b(?:ltd|limited|plc|inc|llc|gmbh|sarl|pte)\b/i;
const ROLE_RE =
  /\b(?:manager|director|specialist|engineer|officer|supervisor|analyst|coordinator|administrator|consultant|executive|technician|head\s+of|team\s+lead|department|dept\.?)\b/i;
const URL_RE = /https?:\/\/\S+|www\.\S+/i;

const MARKERS = [
  EMAIL_MARKER_RE,
  CONTACT_LABEL_RE,
  PHONE_RUN_RE,
  COMPANY_RE,
  ROLE_RE,
  URL_RE,
];

/** Longest line still treated as a signature/contact line. */
const MAX_LINE_CHARS = 120;

function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** True when a line is a closing salutation and nothing else. */
function isSalutationLine(line) {
  const text = normalize(line);
  return Boolean(text) && SALUTATION_RE.test(text);
}

/** True when a line is the start of the legal / social footer. */
function isFooterLine(line) {
  const text = normalize(line);
  return Boolean(text) && FOOTER_LINE_RE.test(text);
}

/**
 * True for a short line that carries a contact/identity marker — the core of a
 * signature block. Long prose is never one, whatever it mentions.
 */
function isSignatureLine(line) {
  const text = normalize(line);
  if (!text || text.length > MAX_LINE_CHARS) return false;
  if (QUOTED_LINE_RE.test(text)) return false;
  return MARKERS.some((re) => re.test(text));
}

/**
 * True for a short line that looks like a name, address or department line:
 * few words, no sentence structure. Only used to extend a block upwards that a
 * marker already anchored.
 */
function isIdentityLine(line) {
  const text = normalize(line);
  if (!text || text.length > 70) return false;
  if (QUOTED_LINE_RE.test(text)) return false;
  if (/[!?;]/.test(text)) return false;
  // Initials ("Bashir A. Oladipo") are not sentence structure.
  if (/\.\s/.test(text.replace(/\b[A-Za-z]\./g, 'X'))) return false;
  return text.split(/\s+/).length <= 8;
}


/** Index of the first footer line, or -1. */
function firstFooterIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (isFooterLine(lines[i])) return i;
  }
  return -1;
}

/** Index of the last signature-marked line, or -1. */
function lastSignatureLineIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSignatureLine(lines[i])) return i;
  }
  return -1;
}

/**
 * Walk up from an anchor while the lines still belong to the signature: blank
 * separators, contact lines and the sender's name, title or address lines.
 *
 * The closing salutation is the TOP boundary of the signature: it is included,
 * and the walk stops there. That is what keeps the sentence above it — the
 * sender's own words — out of the signature, however short that sentence is.
 */
function walkUp(lines, anchor) {
  let start = anchor;
  while (start - 1 >= 0) {
    const prev = lines[start - 1];
    if (!prev.trim()) {
      start -= 1;
      continue;
    }
    if (isSalutationLine(prev)) return start - 1;
    if (isSignatureLine(prev) || isIdentityLine(prev)) {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

/**
 * Where does this message's signature block begin?
 *
 * `lines` must be the sender's own lines — quoted/forwarded content is
 * separated first, so a signature can never swallow a quoted block.
 *
 * @param {string[]} lines
 * @returns {number} index of the first signature line, or -1 when the message
 *   carries nothing a signature can be recognised from.
 */
function findSignatureStart(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;

  const footer = firstFooterIndex(lines);
  const anchor = footer >= 0 ? footer : lastSignatureLineIndex(lines);
  if (anchor < 0) return -1;

  const start = walkUp(lines, anchor);
  // Evidence: a real signature block always carries at least two marked lines
  // or salutations (how to reach the sender, plus a name/company/footer). A
  // single stray contact line inside a request is never a signature — and a
  // short body paragraph followed by one footer marker is not one either.
  const evidence = lines
    .slice(start)
    .filter((line) => isSignatureLine(line) || isSalutationLine(line)).length;
  if (evidence < 2) return -1;
  return start;
}

/**
 * Split a (sender-owned) text into its body and its signature block.
 * The salutation and footer lines are part of `signature`.
 *
 * @returns {{ own: string, signature: string|null }}
 */
function splitSignature(text) {
  if (typeof text !== 'string' || !text.trim()) return { own: '', signature: null };
  const lines = text.split('\n');
  const start = findSignatureStart(lines);
  if (start < 0) return { own: text.trim(), signature: null };
  const signature = lines.slice(start).join('\n').trim() || null;
  return { own: lines.slice(0, start).join('\n').trim(), signature };
}

module.exports = {
  findSignatureStart,
  splitSignature,
  isSalutationLine,
  isSignatureLine,
  isIdentityLine,
  isFooterLine,
  SALUTATION_RE,
  FOOTER_LINE_RE,
  MAX_LINE_CHARS,
};
