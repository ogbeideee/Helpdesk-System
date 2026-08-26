// Subject-line utilities.
//
// These only *read* a subject. Deciding what a match means — new ticket vs.
// reply vs. reopen — is ticket ingestion's job, not the parser's.
//
// The ticket-number pattern itself is owned by src/ticketNumbers.js, which
// defines the numbering scheme. Reusing it keeps one regex in the codebase
// instead of two that can drift apart.
const { extractTicketRef } = require('../ticketNumbers');

// Reply/forward prefixes across the locales an internal helpdesk actually
// sees: English, German (AW/WG), Dutch (Antw), French (Rép/TR), Spanish/
// Italian (RE/RV/I), Nordic (SV/VS/VB).
const REPLY_PREFIX_RE =
  /^\s*(?:(?:re|aw|antw|ref|r|sv|vs|vb|rép|rep|fw|fwd|wg|tr|rv|i|enc)\s*(?:\[\d+\])?\s*:\s*)+/i;

/**
 * Remove leading Re:/Fwd:/AW:/… prefixes, including stacked ones
 * ("Re: Fwd: Re: ..."). The parser never stores this — the original subject
 * is preserved — but ingestion and tests find it useful.
 *
 * @param {string} subject
 * @returns {string}
 */
function stripReplyPrefixes(subject) {
  let out = String(subject === null || subject === undefined ? '' : subject);
  // Applied repeatedly: some clients emit "RE: RE : FW:" with odd spacing.
  for (let i = 0; i < 10; i++) {
    const next = out.replace(REPLY_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * Identify a ticket number referenced by a subject line.
 *
 * "[INC-000123] Cannot connect to WiFi"      -> "INC-000123"
 * "Re: [INC-000123] Cannot connect to WiFi"  -> "INC-000123"
 * "Cannot connect to WiFi"                   -> null
 *
 * @param {string} subject
 * @returns {string|null} upper-cased ticket number, or null
 */
function extractTicketNumberFromSubject(subject) {
  // extractTicketRef scans the subject first; passing an empty body keeps this
  // strictly subject-scoped.
  return extractTicketRef(subject, '');
}

/** True when the subject carries a reply/forward prefix. */
function hasReplyPrefix(subject) {
  return REPLY_PREFIX_RE.test(String(subject || ''));
}

module.exports = {
  stripReplyPrefixes,
  extractTicketNumberFromSubject,
  hasReplyPrefix,
};
