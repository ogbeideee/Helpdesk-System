// Automated-mail screening — decides whether an inbound message may open a
// ticket at all.
//
// The problem: a helpdesk mailbox receives mail no person wrote — Google
// security alerts, quarantine digests, bounce messages, mailing lists. Before
// this gate existed every one of them became a ticket (valid sender, valid
// subject), got assigned to an agent, entered workload and SLA, and — worse —
// received a requester acknowledgement addressed to a noreply mailbox, whose
// bounce arrived back and became ANOTHER ticket.
//
// Two deterministic signals, no LLM, consistent with the routing rules:
//
//   1. Auto-generated headers (RFC 3834 and de-facto bulk markers):
//        Auto-Submitted: <anything but "no">
//        Precedence: bulk | list | junk
//        List-Id / List-Unsubscribe present
//      Adapters carry them on the normalized email; the parser transports
//      them; only this module interprets them.
//
//   2. An ignored-sender list. Administrator-configurable through the
//      `intakeIgnoredSenders` setting (env INTAKE_IGNORED_SENDERS supplies the
//      default, the Setting table holds overrides). Entry grammar:
//        "noreply"                          -> local-part prefix match
//        "quarantine@messaging.microsoft.com" -> exact address match
//        "@alerts.example.com"              -> whole domain
//      Matching is case-insensitive.
//
// Where it runs: inside ticketIntake.intakeEmailMessage, AFTER dedupe and
// thread resolution, so only NEW-ticket creation is blocked — an automated
// reply that references an existing ticket still attaches as a comment.
// The result is the definitive status 'skipped_automated', handled exactly
// like 'skipped_self' by both ingestion channels (marked seen/read, counted
// in the poll summary, never retried).
//
// Fail-open: a broken settings read falls back to the built-in list, so a
// configuration problem can never block inbound mail.
const settingsService = require('./settingsService');

// The built-in list. Mirrored as the fallback of the intakeIgnoredSenders
// setting in settingsService.js — keep the two in sync (neither module
// imports the other; importing would create a require cycle).
const DEFAULT_IGNORED_SENDERS = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'quarantine@messaging.microsoft.com',
];

/** Comma-separated setting value -> lowercased, deduplicated entry list. */
function parseSenderEntries(value) {
  const seen = new Set();
  for (const entry of String(value === null || value === undefined ? '' : value).split(',')) {
    const normalized = entry.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Match a sender address against the ignored-sender entries.
 * Returns the matching entry, or null.
 */
function matchIgnoredSender(senderEmail, entries) {
  const address = String(senderEmail || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const localPart = address.slice(0, at);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    if (entry.startsWith('@')) {
      if (address.endsWith(entry)) return entry;
    } else if (entry.includes('@')) {
      if (address === entry) return entry;
    } else if (localPart.startsWith(entry)) {
      return entry;
    }
  }
  return null;
}

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/**
 * The header half of screening. Returns a short reason string when the
 * message declares itself automated, null otherwise.
 */
function screenHeaders(msg) {
  const autoSubmitted = String((msg && msg.autoSubmitted) || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return `auto-submitted: ${autoSubmitted}`;
  }
  const precedence = String((msg && msg.precedence) || '').trim().toLowerCase();
  if (BULK_PRECEDENCE.has(precedence)) {
    return `precedence: ${precedence}`;
  }
  if (String((msg && msg.listId) || '').trim()) return 'list-id header present';
  if (String((msg && msg.listUnsubscribe) || '').trim()) return 'list-unsubscribe header present';
  return null;
}

/**
 * Screen one normalized intake message.
 *
 * @param {{ requesterEmail: string, autoSubmitted?: string|null, precedence?: string|null,
 *           listId?: string|null, listUnsubscribe?: string|null }} msg
 * @param {{ ignoredSenders?: string[], client?: object }} [options]
 *        ignoredSenders bypasses the settings lookup (tests); client is an
 *        optional Prisma transaction/client for the settings read.
 * @returns {Promise<null | { reason: string }>} null = the message may open a ticket
 */
async function screenMessage(msg, options = {}) {
  const headerHit = screenHeaders(msg);
  if (headerHit) return { reason: headerHit };

  let entries;
  if (Array.isArray(options.ignoredSenders)) {
    entries = options.ignoredSenders;
  } else {
    try {
      const raw = await settingsService.get('intakeIgnoredSenders', options.client);
      entries = parseSenderEntries(raw);
    } catch {
      // Fail-open onto the built-in list — never block inbound mail on a
      // settings problem.
      entries = DEFAULT_IGNORED_SENDERS;
    }
  }

  const senderHit = matchIgnoredSender(msg && msg.requesterEmail, entries);
  return senderHit ? { reason: `ignored sender (${senderHit})` } : null;
}

module.exports = {
  DEFAULT_IGNORED_SENDERS,
  parseSenderEntries,
  matchIgnoredSender,
  screenHeaders,
  screenMessage,
};
