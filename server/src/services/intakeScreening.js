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
// Four deterministic signals, no LLM, consistent with the routing rules. They
// are applied in this order, and the first one to match wins:
//
//   1. A permitted subject (isPermittedSubject) OPENS a ticket — the induction
//      notices the helpdesk is copied on deliberately. Checked first, so no
//      rule below can ever suppress them.
//
//   2. A recalled message. Microsoft marks a recall with the message class
//      IPM.Outlook.Recall and the subject "Recall: <original subject>"; neither
//      ingestion channel carries the class, so the subject prefix is the signal.
//      A recall is not a request, and it looks like the original human sender —
//      so a sender-based rule could never separate it from their real mail.
//
//   3. Auto-generated headers (RFC 3834 and de-facto bulk markers):
//        Auto-Submitted: <anything but "no">
//        Precedence: bulk | list | junk
//        List-Id / List-Unsubscribe present
//      Adapters carry them on the normalized email; the parser transports
//      them; only this module interprets them.
//
//   4. Two administrator lists, matched against what the sender actually wrote:
//      a. An ignored-subject list (`intakeIgnoredSubjects` setting, env
//         INTAKE_IGNORED_SUBJECTS). Case-insensitive, spacing-insensitive
//         SUBSTRING of the subject — so "independence day" catches
//         "INDEPENDENCE   DAY ANNOUNCEMENT". This is the deterministic answer
//         to a standing announcement that is not an IT request: no model, no
//         per-message judgement.
//      b. An ignored-sender list (`intakeIgnoredSenders` setting, env
//         INTAKE_IGNORED_SENDERS). Entry grammar:
//           "noreply"                            -> local-part prefix match
//           "quarantine@messaging.microsoft.com" -> exact address match
//           "@alerts.example.com"                -> whole domain
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
  // Recall *reports* — the status mail Microsoft sends back to the person who
  // recalled a message — arrive from this address, not from a human. The recall
  // *notification* other recipients may receive is matched by subject below.
  'office365reports@microsoft.com',
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

// Built-in ignored subjects are empty on purpose: only the organisation can
// name its own standing notices. Mirrored as the fallback of the
// intakeIgnoredSubjects setting in settingsService.js — keep the two in sync
// (neither module imports the other; importing would create a require cycle).
const DEFAULT_IGNORED_SUBJECTS = [];

// Microsoft's recall marker. Cloud recall stamps the message class
// IPM.Outlook.Recall and rewrites the subject to "Recall: <original subject>";
// the recall *report* back to the sender is caught by the sender list instead.
// Neither ingestion channel carries the message class, so the subject is the
// only signal available. Anchored to the start, tolerant of the separators a
// mail client may emit.
const RECALL_SUBJECT_RE = /^\s*recall\s*[:\-–—]\s*\S/i;

/** Lowercase and collapse whitespace so subject matching is stable. */
function normalizeSubject(subject) {
  return String(subject === null || subject === undefined ? '' : subject)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when the subject declares a message recall, not a request. */
function isRecallSubject(subject) {
  return RECALL_SUBJECT_RE.test(String(subject === null || subject === undefined ? '' : subject));
}

/** Comma-separated setting value -> normalized, deduplicated subject entries. */
function parseSubjectEntries(value) {
  const seen = new Set();
  for (const entry of String(value === null || value === undefined ? '' : value).split(',')) {
    const normalized = normalizeSubject(entry);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Match a subject against the ignored-subject entries (case-insensitive
 * substring of the whitespace-collapsed subject). Returns the matching entry,
 * or null.
 */
function matchIgnoredSubject(subject, entries) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const needle = normalizeSubject(entry);
    if (needle && normalized.includes(needle)) return needle;
  }
  return null;
}

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/*
 * HR notices the helpdesk is expected to KEEP as a ticket.
 *
 * This looks like the opposite of an ignore-list, so it earns its own note.
 * Everything else in this file removes mail; these subjects are the exception.
 * A new-employee induction plan is not an IT request, but it is a standing
 * operational notice the helpdesk is copied on deliberately — it is the
 * schedule for the account-creation work that follows, and losing it silently
 * means a new starter has no laptop on day one. The relevance gate would
 * otherwise suppress it as a pure `informational_announcement`, which is
 * exactly right for a newsletter and exactly wrong for this.
 *
 * Matching is on the SUBJECT only, and only as a whole word: a mail that merely
 * mentions induction in passing is not caught. If HR renames the notice, say so
 * here rather than widening the pattern.
 */
const PERMITTED_SUBJECT_PATTERNS = [
  /\binduction\s+plan\b/i,
  /\bnew\s+employee\s+induction\b/i,
  /\bnew\s+starter\s+induction\b/i,
];

/**
 * A subject the organisation has explicitly decided to keep as a ticket,
 * whatever the relevance model concludes about it.
 */
function isPermittedSubject(subject) {
  const value = String(subject === null || subject === undefined ? '' : subject).trim();
  if (!value) return false;
  return PERMITTED_SUBJECT_PATTERNS.some((re) => re.test(value));
}

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
 * @param {{ requesterEmail: string, subject?: string|null, autoSubmitted?: string|null,
 *           precedence?: string|null, listId?: string|null, listUnsubscribe?: string|null }} msg
 * @param {{ ignoredSubjects?: string[], ignoredSenders?: string[], client?: object }} [options]
 *        ignoredSubjects / ignoredSenders bypass the settings lookup (tests);
 *        client is an optional Prisma transaction/client for the settings read.
 * @returns {Promise<null | { reason: string }>} null = the message may open a ticket
 */
async function screenMessage(msg, options = {}) {
  // 1) An explicitly permitted notice opens a ticket whatever else says so.
  // Checked first, and only for its subject: an induction plan is the schedule
  // for the account-creation work, and suppressing it means a new starter has
  // no laptop. Nothing below may override it.
  if (isPermittedSubject(msg && msg.subject)) return null;

  // 2) A recalled message is not a request. Deterministic, so the relevance
  // model never has to judge it and never gets a vote.
  if (isRecallSubject(msg && msg.subject)) return { reason: 'recalled message' };

  // 3) Automated-mail headers (RFC 3834 + bulk markers).
  const headerHit = screenHeaders(msg);
  if (headerHit) return { reason: headerHit };

  // 4) Administrator lists. Both are read in one settings pass; an injected list
  // bypasses the read (tests). A settings failure fails open onto the built-in
  // lists — never block inbound mail on a configuration problem.
  let subjectEntries;
  let senderEntries;
  if (Array.isArray(options.ignoredSubjects) || Array.isArray(options.ignoredSenders)) {
    subjectEntries = Array.isArray(options.ignoredSubjects) ? options.ignoredSubjects : DEFAULT_IGNORED_SUBJECTS;
    senderEntries = Array.isArray(options.ignoredSenders) ? options.ignoredSenders : DEFAULT_IGNORED_SENDERS;
  } else {
    try {
      const all = await settingsService.getAll(options.client, 'intake');
      subjectEntries = parseSubjectEntries(all.intakeIgnoredSubjects);
      senderEntries = parseSenderEntries(all.intakeIgnoredSenders);
    } catch {
      subjectEntries = DEFAULT_IGNORED_SUBJECTS;
      senderEntries = DEFAULT_IGNORED_SENDERS;
    }
  }

  const subjectHit = matchIgnoredSubject(msg && msg.subject, subjectEntries);
  if (subjectHit) return { reason: `ignored subject (${subjectHit})` };

  const senderHit = matchIgnoredSender(msg && msg.requesterEmail, senderEntries);
  return senderHit ? { reason: `ignored sender (${senderHit})` } : null;
}

module.exports = {
  DEFAULT_IGNORED_SENDERS,
  DEFAULT_IGNORED_SUBJECTS,
  PERMITTED_SUBJECT_PATTERNS,
  RECALL_SUBJECT_RE,
  isPermittedSubject,
  isRecallSubject,
  parseSenderEntries,
  parseSubjectEntries,
  matchIgnoredSender,
  matchIgnoredSubject,
  normalizeSubject,
  screenHeaders,
  screenMessage,
};
