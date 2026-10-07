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
// Six deterministic signals, no LLM, consistent with the routing rules. They
// are applied in this order, and the first one to match wins:
//
//   1. A permitted subject (isPermittedSubject) OPENS a ticket — the induction
//      notices the helpdesk is copied on deliberately. Checked first, so no
//      rule below can ever suppress them.
//
//   2. Internal mail that merely COPIED this mailbox (screenInternalCopy). One
//      of the team writes to somebody else, copies the department for
//      visibility, and the shared mailbox receives it — so the helpdesk parses
//      its own people's outbound mail and opens a ticket about a conversation
//      it was only shown. Read from the To/Cc headers, not from the words.
//
//   3. A recalled message. Microsoft marks a recall with the message class
//      IPM.Outlook.Recall and the subject "Recall: <original subject>"; neither
//      ingestion channel carries the class, so the subject prefix is the signal.
//      A recall is not a request, and it looks like the original human sender —
//      so a sender-based rule could never separate it from their real mail.
//
//   4. A greeting banner — a birthday notice, a farewell, a thank-you. A notice
//      whose whole purpose is to greet somebody is not an IT request, and it
//      arrives on a schedule nobody configured in the ignored-subject list, so
//      its SHAPE is screened here: the subject must open with a known banner,
//      carry almost nothing after it, and contain no request word at all
//      (matchBannerSubject). "Happy birthday — please reset Ngozi's password"
//      stays a ticket.
//
//   5. Auto-generated headers (RFC 3834 and de-facto bulk markers):
//        Auto-Submitted: <anything but "no">
//        Precedence: bulk | list | junk
//        List-Id / List-Unsubscribe present
//      Adapters carry them on the normalized email; the parser transports
//      them; only this module interprets them.
//
//   6. Two administrator lists, matched against what the sender actually wrote:
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

// ---------------------------------------------------------------------------
// Internal mail that only COPIED this mailbox.
//
// The problem this closes is not spam, it is the helpdesk reading its own
// people's mail. An IT lead mails a station manager about a downed link and
// copies the department for visibility; the shared mailbox receives it, so
// intake sees a human sender, a real-looking subject and words that read like
// a request — and files a ticket against a conversation the helpdesk was shown
// but never addressed on. INC-001838 was exactly that: a "V.I. Station OFFLINE"
// mail from an agent, addressed to a vendor contact, helpdesk in Cc.
//
// The evidence is a HEADER, not a judgement about the words, which is what
// makes it deterministic and checkable by eye:
//
//   - the sender is one of our own accounts (an Agent row — any role, active or
//     not, because a leaver's last mail still must not open a ticket);
//   - a mailbox this installation ingests from appears on Cc or Bcc;
//   - and that same mailbox does NOT appear on To.
//
// The last clause is the whole rule. Addressed to us = a request, whatever it
// looks like; copied to us = FYI. So an agent emailing the helpdesk directly
// still opens a ticket, a requester who CCs us still opens a ticket, and only
// the copied-internal case is dropped.
//
// Fail-open everywhere, deliberately, because this is the one signal that can
// drop a real message:
//   - no recipient headers at all (the portal and dev intake paths compute
//     none) -> no evidence, no skip;
//   - no configured ingestion address -> the rule is inert;
//   - an agent-table read failure -> inert;
//   - off via `intakeInternalCopies`.
// And the sender must be a KNOWN account: an outsider who copies the helpdesk
// is somebody asking, and nothing about it is speculative.
// ---------------------------------------------------------------------------

/** Enough of an address to compare one, without pretending to validate it. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The addresses this installation ingests mail for, when nobody has said
 * otherwise. Both are, by construction, an account the helpdesk reads FROM —
 * never a guess about which mailbox is "the" one.
 */
function defaultMailboxAddresses() {
  return [process.env.GRAPH_SHARED_MAILBOX, process.env.IMAP_USER]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => ADDRESS_RE.test(value));
}

/**
 * Pull the address out of anything a caller may hold a recipient as: an object
 * from the parser (`{email}`), a bare address, or the raw display-name form a
 * header carries ("Helpdesk Platform <ithelpdesk@example.com>"). The parser
 * already splits those, but this rule must not depend on which caller reached
 * it — a display name that failed to split would silently read as "not us".
 */
function addressOf(item) {
  if (item === null || item === undefined) return '';
  const raw =
    item && typeof item === 'object' ? item.email || item.address || item.mailbox : item;
  const text = String(raw).trim();
  const angled = /<([^>]+)>\s*$/.exec(text);
  return (angled ? angled[1] : text).trim().toLowerCase();
}

/** Any list shape the parser emits, normalized to bare addresses. */
function addressList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const value = addressOf(item);
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

/**
 * Comma-separated address list -> lowercase addresses, keeping only entries
 * that look like addresses. A typo must narrow the rule, never widen it.
 */
function parseAddressEntries(value) {
  return addressList(
    String(value === null || value === undefined ? '' : value)
      .split(',')
      .map((entry) => entry.trim()),
  ).filter((entry) => ADDRESS_RE.test(entry));
}

/**
 * The ingestion address this message only copied, or null.
 *
 * Pure, so the intake gate and `db:purge-automated` answer from one rule.
 *
 * @param {{requesterEmail?: string, recipients?: {to?: any[], cc?: any[], bcc?: any[]}}} msg
 * @param {{mailboxAddresses?: string[], staffSenders?: string[]}} context
 * @returns {string|null} the copied mailbox address, or null to let the ticket open
 */
function copiedInboxAddress(msg, context = {}) {
  const mailboxes = addressList(context.mailboxAddresses).filter((a) => ADDRESS_RE.test(a));
  if (!mailboxes.length) return null;

  const senders = new Set(addressList(context.staffSenders));
  if (!senders.size) return null;
  const sender = String((msg && msg.requesterEmail) || '').trim().toLowerCase();
  if (!sender || !senders.has(sender)) return null;

  // No recipient headers means no evidence at all. The portal and dev intake
  // paths never compute them, so this stays inert there rather than guessing.
  const recipients = msg && msg.recipients;
  if (!recipients) return null;

  const to = addressList(recipients.to);
  const copied = [...addressList(recipients.cc), ...addressList(recipients.bcc)];
  const mailbox = mailboxes.find((candidate) => copied.includes(candidate));
  if (!mailbox) return null;
  // Addressed to us directly is a request, however internal the sender is.
  if (to.includes(mailbox)) return null;
  return mailbox;
}

// ---------------------------------------------------------------------------
// Greeting banners — celebrations, condolences, thanks.
//
// The mailbox receives mail whose entire purpose is to greet somebody: HR's
// birthday notice, a farewell note to a leaver, a "congratulations" for a
// promotion. Nobody wrote it to the helpdesk, nothing in it can be done, and
// yet it opens a ticket, takes an agent's attention and lands an SLA on the
// queue. The organisation's own ignored-subject list is the general answer to
// standing notices, but a celebration arrives on a schedule nobody configured,
// and the relevance gate may never get a vote (its sender is not on the
// approved list, or the flyer is an attachment, which always vetoes a skip).
//
// So the SHAPE is screened here, deterministically, on two signals that must
// BOTH hold:
//
//   1. The subject, after collapsing whitespace and peeling a Re:/Fw:/Fwd:
//      chain, must BEGIN with a greeting banner — "happy birthday",
//      "congratulations", "farewell". A banner is how such mail opens.
//   2. Whatever follows it must be SHORT (a name, a title, an audience — see
//      MAX_BANNER_TAIL_WORDS), the subject must carry no request word, and
//      neither may the sender's OWN WORDS (`cleanBody`, when the channel
//      produced one).
//
// That second half is what keeps a real request out of it: "Happy birthday —
// kindly reset Ngozi's account" opens with a banner and stays a ticket, and so
// does a forwarded flyer with "please add her to the staff DL" under it. The
// veto reads `cleanBody`, never the raw body: the corporate footer an HR notice
// carries says "please contact us", and a footer is not a request — reading it
// as one would keep every celebration a ticket forever.
//
// The asymmetry is deliberate, and it is the same one the recall rule uses: an
// extra ticket is recoverable by a human who reads the queue, a dropped request
// is not.
const SUBJECT_PREFIX_RE = /^\s*(?:(?:re|fw|fwd|fyi|tr|res)\s*[:\-–—]\s*)+/i;

/** How many words may follow a banner before it stops looking like one. */
const MAX_BANNER_TAIL_WORDS = 5;

/** Banner phrases, anchored at the start of the subject. */
const GREETING_BANNERS = [
  {
    label: 'birthday greeting',
    re: /^(?:a\s+|very\s+|belated\s+)*happy\s+birthday\b|^birthday\s+(?:greetings?|wishes|message|celebration|shout[\s-]?out)s?\b|^many\s+happy\s+returns\b/,
  },
  { label: 'congratulations', re: /^congratulations?\b|^congrats\b|^felicitations?\b/ },
  { label: 'new-month greeting', re: /^happy\s+new\s+month\b|^new\s+month\s+greetings?\b/ },
  { label: 'new-year greeting', re: /^happy\s+new\s+year\b|^new\s+year\s+greetings?\b/ },
  {
    label: 'seasonal greeting',
    re: /^(?:merry|happy)\s+christmas\b|^season'?s\s+greetings?\b|^festive\s+greetings?\b|^happy\s+(?:holidays|easter|valentine'?s?\s+day)\b/,
  },
  { label: 'anniversary greeting', re: /^happy\s+(?:work\s+)?anniversary\b|^anniversary\s+greetings?\b/ },
  {
    label: 'farewell note',
    re: /^(?:a\s+)?(?:fond|warm)\s+farewell\b|^farewell\b|^send[\s-]?(?:off|forth)\b|^bon\s+voyage\b/,
  },
  {
    label: 'get-well note',
    re: /^get\s+well\s+soon\b|^speedy\s+recovery\b|^wishing\s+(?:you|him|her|them)\s+a\s+speedy\b/,
  },
  { label: 'condolence note', re: /^(?:heartfelt|our|deepest|sincere)?\s*condolences?\b/ },
  {
    label: 'welcome note',
    re: /^(?:a\s+)?(?:warm\s+|hearty\s+)?welcome\s+(?:aboard|on[\s-]?board|to\s+the\s+(?:team|company|fold))\b/,
  },
  { label: 'best wishes', re: /^(?:best|warm|good|well)\s+wishes\b|^wishing\s+(?:you|him|her|them)\s+well\b/ },
  { label: 'thank-you note', re: /^(?:a\s+)?(?:big\s+|heartfelt\s+)?thank\s?you\b|^thanks\b|^many\s+thanks\b/ },
  {
    label: 'appreciation note',
    re: /^kudos\b|^shout[\s-]?out\b|^well\s+done\b|^appreciation\b|^a\s+word\s+of\s+appreciation\b/,
  },
];

/**
 * Words that turn a greeting into work. If any of these follows the banner the
 * subject is a request, not an announcement — and it opens a ticket like any
 * other mail. Deliberately over-inclusive: missing a banner costs an agent one
 * glance at the queue; suppressing a request costs somebody their problem.
 */
const REQUEST_WORDS = new Set([
  'add', 'access', 'account', 'approve', 'asap', 'assist', 'assistance', 'backup',
  'broken', 'cannot', "can't", 'change', 'check', 'clearance', 'confirm', 'create',
  'delete', 'disable', 'email', 'enable', 'error', 'exit', 'failed', 'failing',
  'fault', 'faulty', 'fix', 'forward', 'get', 'help', 'install', 'internet',
  'issue', 'kindly', 'laptop', 'licence', 'license', 'login', 'mailbox', 'migrate',
  'mobile', 'need', 'needs', 'network', 'offboard', 'onboard', 'password', 'passcode',
  'permission', 'phone', 'please', 'printer', 'problem', 'provide', 'provision',
  'recover', 'remove', 'renew', 'request', 'requested', 'requesting', 'reset',
  'restore', 'review', 'scanner', 'send', 'share', 'sign', 'sim', 'subscription',
  'supply', 'support', 'unable', 'unlock', 'update', 'upgrade', 'urgent', 'vpn',
]);

/** Words of a free-text run, punctuation removed, lowercased. */
function words(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .split(/[^a-z0-9'@._-]+/)
    .filter(Boolean);
}

/** True when the text asks for something — see REQUEST_WORDS. */
function hasRequestWord(text) {
  return words(text).some((word) => REQUEST_WORDS.has(word));
}

/**
 * The greeting banner a subject opens with, or null.
 *
 * @param {string|null|undefined} subject
 * @param {string|null|undefined} [ownWords] the sender's own prose (`cleanBody`
 *   on the email channels). A request word in it defeats the banner: a
 *   forwarded flyer with "please add her to the staff DL" under it is work, not
 *   a celebration. Quoted history and the signature are already out of it, so a
 *   corporate footer can never veto a banner by accident.
 * @returns {{ label: string, tail: string }|null} `tail` is whatever followed
 *   the banner — the audience a human would read ("GCEO"), kept for the reason
 *   string so a screened message can be explained from the log alone.
 */
function matchBannerSubject(subject, ownWords) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return null;
  const bare = normalized.replace(SUBJECT_PREFIX_RE, '');
  for (const banner of GREETING_BANNERS) {
    const match = banner.re.exec(bare);
    if (!match) continue;
    const tail = bare.slice(match[0].length).trim();
    // Too much after the banner: that is a sentence, not a greeting.
    if (words(tail).length > MAX_BANNER_TAIL_WORDS) continue;
    // Any request word at all means somebody is asking for something.
    if (hasRequestWord(tail)) continue;
    if (hasRequestWord(ownWords)) continue;
    return { label: banner.label, tail };
  }
  return null;
}

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
 * Screen internal mail that only copied this mailbox. Returns a short reason
 * string when the message was copied in, null otherwise.
 *
 * Separate from screenMessage because it is the only signal that reads the
 * database for something other than settings (our own accounts), and because
 * the caller may inject either half of the context.
 *
 * @param {object} msg normalized intake message
 * @param {{ client?: object, staffSenders?: string[], mailboxAddresses?: string[],
 *           settings?: object }} [options]
 * @returns {Promise<string|null>}
 */
async function screenInternalCopy(msg, options = {}) {
  // Injected context short-circuits both reads (tests, and the purge script,
  // which already holds the agent list).
  let settings = options.settings;
  if (!settings && !Array.isArray(options.staffSenders) && !Array.isArray(options.mailboxAddresses)) {
    try {
      settings = await settingsService.getAll(options.client, 'intake');
    } catch {
      return null; // fail open — a configuration problem never drops mail
    }
  }
  settings = settings || {};

  // Off, and the whole signal is inert. An installation that copies the
  // department onto everything it wants a ticket for says so here.
  const enabled = settings.intakeInternalCopies;
  if (enabled !== undefined && String(enabled).trim() === '0') return null;

  let mailboxes = Array.isArray(options.mailboxAddresses)
    ? parseAddressEntries(options.mailboxAddresses)
    : parseAddressEntries(settings.intakeMailboxAddresses);
  if (!mailboxes.length) mailboxes = defaultMailboxAddresses();
  if (!mailboxes.length) return null;

  let senders = options.staffSenders;
  if (!Array.isArray(senders)) {
    try {
      const rows = await (options.client || require('../lib/prisma')).agent.findMany({
        select: { email: true },
      });
      senders = rows.map((row) => row.email);
    } catch {
      return null; // fail open — never drop mail because a read failed
    }
  }

  const mailbox = copiedInboxAddress(msg, { mailboxAddresses: mailboxes, staffSenders: senders });
  return mailbox ? `copied to this mailbox only (${mailbox} on Cc/Bcc, not on To)` : null;
}

/**
 * Screen one normalized intake message.
 *
 * @param {{ requesterEmail: string, subject?: string|null, autoSubmitted?: string|null,
 *           precedence?: string|null, listId?: string|null, listUnsubscribe?: string|null,
 *           cleanBody?: string|null, recipients?: {to?: any[], cc?: any[], bcc?: any[]}|null }} msg
 * @param {{ ignoredSubjects?: string[], ignoredSenders?: string[], client?: object,
 *           staffSenders?: string[], mailboxAddresses?: string[] }} [options]
 *        ignoredSubjects / ignoredSenders bypass the settings lookup (tests);
 *        client is an optional Prisma transaction/client for every read here.
 * @returns {Promise<null | { reason: string }>} null = the message may open a ticket
 */
async function screenMessage(msg, options = {}) {
  // 1) An explicitly permitted notice opens a ticket whatever else says so.
  // Checked first, and only for its subject: an induction plan is the schedule
  // for the account-creation work, and suppressing it means a new starter has
  // no laptop. Nothing below may override it.
  if (isPermittedSubject(msg && msg.subject)) return null;

  // 2) Internal mail that only copied this mailbox. Read from the To/Cc
  // headers, so it needs no judgement about the words: addressed to us is a
  // request, copied to us is FYI.
  const copyHit = await screenInternalCopy(msg, options);
  if (copyHit) return { reason: copyHit };

  // 3) A recalled message is not a request. Deterministic, so the relevance
  // model never has to judge it and never gets a vote.
  if (isRecallSubject(msg && msg.subject)) return { reason: 'recalled message' };

  // 4) A greeting banner — a birthday notice, a farewell, a thank-you — is not
  // a request. Shape-based and deterministic, so the relevance model never has
  // to judge it and never gets a vote.
  const bannerHit = matchBannerSubject(msg && msg.subject, msg && msg.cleanBody);
  if (bannerHit) {
    return {
      reason: `greeting announcement (${bannerHit.label}${bannerHit.tail ? `: ${bannerHit.tail}` : ''})`,
    };
  }

  // 5) Automated-mail headers (RFC 3834 + bulk markers).
  const headerHit = screenHeaders(msg);
  if (headerHit) return { reason: headerHit };

  // 6) Administrator lists. Both are read in one settings pass; an injected list
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
  ADDRESS_RE,
  DEFAULT_IGNORED_SENDERS,
  DEFAULT_IGNORED_SUBJECTS,
  GREETING_BANNERS,
  MAX_BANNER_TAIL_WORDS,
  PERMITTED_SUBJECT_PATTERNS,
  RECALL_SUBJECT_RE,
  REQUEST_WORDS,
  SUBJECT_PREFIX_RE,
  addressList,
  addressOf,
  copiedInboxAddress,
  defaultMailboxAddresses,
  hasRequestWord,
  isPermittedSubject,
  isRecallSubject,
  matchBannerSubject,
  parseAddressEntries,
  parseSenderEntries,
  parseSubjectEntries,
  matchIgnoredSender,
  matchIgnoredSubject,
  normalizeSubject,
  screenHeaders,
  screenInternalCopy,
  screenMessage,
};
