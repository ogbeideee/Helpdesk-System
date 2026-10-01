/* Intake screening tests: automated mail must never open a ticket.

   Covers the whole signal path:
     A. parser carries the automated-mail headers onto the normalized model
     B. ignored-sender matching semantics (prefix / exact / domain)
     C. header screening reasons
     D. intake gate: noreply / quarantine / auto-submitted messages are
        skipped_automated; human mail is created; threading beats screening;
        the ignored-sender list is settings-driven
     E. IMAP adapter extracts the headers from raw RFC 822 source
     F. Graph adapter extracts them from internetMessageHeaders
     G. permitted subjects (induction notices) survive every gate
     H. the relevance gate honours permitted subjects
     I. recalled mail, and the administrator ignored-subject list

   Usage: node scripts/test-intake-screening.js  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's database.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('intake-screening');

const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { parseEmail } = require('../src/email/emailParser');
const { intakeEmailMessage } = require('../src/services/ticketIntake');
const screening = require('../src/services/intakeScreening');
const settingsService = require('../src/services/settingsService');
const { extractMessage } = require('../src/imap/imapMailAdapter');
const { toRawEmail } = require('../src/graph/graphMailAdapter');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MARK = 'screen-test-';
const DOMAIN = 'screen.example';
const quiet = { log() {}, warn() {}, error() {} };

/** Capturing mailer — proves a screened message sends no notifications. */
function captureMailer() {
  const calls = [];
  const record = (name) => async () => { calls.push(name); };
  return {
    calls,
    notifyNewTicketToDl: record('dl'),
    notifyRequesterAck: record('ack'),
    notifyAssignment: record('assignment'),
    notifyReplyReceived: record('reply'),
  };
}

function intakePayload(overrides = {}) {
  return {
    messageId: `${MARK}${Math.random().toString(36).slice(2, 10)}`,
    from: `user@${DOMAIN}`,
    subject: 'Cannot connect to the VPN',
    body: 'Since this morning the VPN drops every few minutes.',
    ...overrides,
  };
}

async function cleanup() {
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { graphMessageId: { startsWith: MARK } },
        { internetMessageId: { startsWith: MARK } },
        { requesterEmail: { endsWith: `@${DOMAIN}` } },
      ],
    },
    select: { id: true },
  });
  const ids = tickets.map((t) => t.id);
  await prisma.comment.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketAuditLog.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketSlaEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketSlaCycle.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
  await prisma.setting.deleteMany({
    where: { key: { in: ['intakeIgnoredSenders', 'intakeIgnoredSubjects'] } },
  });
}


async function main() {
  await ensureTeams(prisma);
  await cleanup();

  /* ---- A. the parser carries the signals ---------------------------- */
  {
    const bare = parseEmail({ messageId: 'a1', from: 'a@b.com', subject: 's', body: 'b' });
    eq('A1 absent headers normalize to null', bare.autoSubmitted, null);
    eq('A2 absent precedence normalizes to null', bare.precedence, null);
    eq('A3 absent list-id normalizes to null', bare.listId, null);

    const flagged = parseEmail({
      messageId: 'a2',
      from: 'a@b.com',
      subject: 's',
      body: 'b',
      autoSubmitted: 'auto-generated',
      precedence: 'Bulk',
      listId: '<alerts.lists.example>',
      listUnsubscribe: '<mailto:unsub@example>',
    });
    eq('A4 auto-submitted carried', flagged.autoSubmitted, 'auto-generated');
    eq('A5 precedence carried verbatim-case', flagged.precedence, 'Bulk');
    eq('A6 list-id carried', flagged.listId, '<alerts.lists.example>');
    eq('A7 list-unsubscribe carried', flagged.listUnsubscribe, '<mailto:unsub@example>');

    const injected = parseEmail({
      messageId: 'a3',
      from: 'a@b.com',
      subject: 's',
      body: 'b',
      autoSubmitted: 'auto-generated\r\nX-Evil: yes',
    });
    eq('A8 header injection collapses to spaces', injected.autoSubmitted, 'auto-generated X-Evil: yes');
  }

  /* ---- B. ignored-sender matching ------------------------------------ */
  {
    const entries = screening.parseSenderEntries(
      ' Noreply, quarantine@messaging.microsoft.com, @alerts.example.com , noreply'
    );
    eq('B1 entries canonicalized + deduped', entries.join(','),
      'noreply,quarantine@messaging.microsoft.com,@alerts.example.com');

    eq('B2 local-part prefix', screening.matchIgnoredSender('NoReply@accounts.google.com', entries), 'noreply');
    eq('B3 prefix with tag', screening.matchIgnoredSender('noreply+123@x.com', entries), 'noreply');
    eq('B4 exact address', screening.matchIgnoredSender('Quarantine@Messaging.Microsoft.com', entries),
      'quarantine@messaging.microsoft.com');
    eq('B5 exact does not prefix-match full addresses',
      screening.matchIgnoredSender('quarantine@evil-messaging.microsoft.com', entries), null);
    eq('B6 domain entry', screening.matchIgnoredSender('anything@alerts.example.com', entries), '@alerts.example.com');
    eq('B7 human not matched', screening.matchIgnoredSender(`user@${DOMAIN}`, entries), null);
    eq('B8 garbage not matched', screening.matchIgnoredSender('not-an-address', entries), null);
    eq('B9 empty entries match nothing', screening.matchIgnoredSender('noreply@x.com', []), null);
  }

  /* ---- C. header screening ------------------------------------------- */
  {
    eq('C1 auto-generated screened', screening.screenHeaders({ autoSubmitted: 'auto-generated' }),
      'auto-submitted: auto-generated');
    eq('C2 explicit "no" passes', screening.screenHeaders({ autoSubmitted: 'no' }), null);
    eq('C3 precedence bulk screened', screening.screenHeaders({ precedence: 'Bulk' }), 'precedence: bulk');
    eq('C4 precedence junk screened', screening.screenHeaders({ precedence: 'junk' }), 'precedence: junk');
    eq('C5 list-id screened', screening.screenHeaders({ listId: '<x.y>' }), 'list-id header present');
    eq('C6 list-unsubscribe screened', screening.screenHeaders({ listUnsubscribe: 'present' }),
      'list-unsubscribe header present');
    eq('C7 plain message passes', screening.screenHeaders({}), null);
  }

  /* ---- D. the intake gate --------------------------------------------- */
  const ticketsBefore = await prisma.ticket.count();

  // D1: a noreply sender never opens a ticket and triggers no mail.
  {
    const mailer = captureMailer();
    const result = await intakeEmailMessage(
      intakePayload({ from: 'no-reply@accounts.google.com', subject: 'Security alert' }),
      { logger: quiet, mailer }
    );
    eq('D1 noreply sender is skipped_automated', result.status, 'skipped_automated');
    check('D1 reason names the sender rule', /ignored sender/.test(result.reason || ''), result.reason);
    eq('D1 no ticket created', await prisma.ticket.count(), ticketsBefore);
    eq('D1 no notifications sent', mailer.calls.length, 0);
  }

  // D2: the Microsoft quarantine mailbox, exact-address entry.
  {
    const result = await intakeEmailMessage(
      intakePayload({ from: 'quarantine@messaging.microsoft.com', subject: 'You have quarantined messages' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D2 quarantine sender is skipped_automated', result.status, 'skipped_automated');
  }

  // D3: automated headers screen even a human-looking sender.
  {
    const result = await intakeEmailMessage(
      intakePayload({ from: `colleague@${DOMAIN}`, autoSubmitted: 'auto-replied' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D3 auto-submitted header screens', result.status, 'skipped_automated');
    eq('D3 reason names the header', result.reason, 'auto-submitted: auto-replied');
  }

  // D4: an explicit Auto-Submitted: no is human mail.
  {
    const result = await intakeEmailMessage(
      intakePayload({ autoSubmitted: 'no' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D4 auto-submitted "no" creates a ticket', result.status, 'created');
  }

  // D5: ordinary human mail is untouched.
  {
    const mailer = captureMailer();
    const result = await intakeEmailMessage(intakePayload(), { logger: quiet, mailer });
    eq('D5 human mail creates a ticket', result.status, 'created');
    check('D5 requester ack still sent', mailer.calls.includes('ack'));
  }

  // D6: threading beats screening — an automated REPLY on an existing ticket
  // attaches as a comment instead of being dropped.
  {
    const original = await intakeEmailMessage(
      intakePayload({ internetMessageId: `${MARK}orig-1` }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D6 setup ticket created', original.status, 'created');

    const reply = await intakeEmailMessage(
      intakePayload({
        from: 'noreply@monitoring.example',
        inReplyTo: `${MARK}orig-1`,
        autoSubmitted: 'auto-generated',
        subject: 'Re: Cannot connect to the VPN',
        body: 'Automated status update from the monitoring system.',
      }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D6 threaded automated reply attaches as comment', reply.status, 'comment_added');
    eq('D6 comment landed on the original ticket', reply.ticket.id, original.ticket.id);
  }

  // D7: the ignored-sender list is settings-driven.
  {
    const updated = await settingsService.update(
      { intakeIgnoredSenders: 'alerts@monitoring.example, noreply' },
      'screening-test'
    );
    check('D7 settings update accepted', updated.ok === true, JSON.stringify(updated.errors || []));

    const custom = await intakeEmailMessage(
      intakePayload({ from: 'alerts@monitoring.example' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D7 custom sender now screened', custom.status, 'skipped_automated');

    // The override REPLACES the list: a built-in entry no longer listed now passes.
    const postmaster = await intakeEmailMessage(
      intakePayload({ from: 'postmaster@mail.example' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D7 override replaces the built-in list', postmaster.status, 'created');

    await prisma.setting.deleteMany({ where: { key: 'intakeIgnoredSenders' } });
    const backToDefault = await intakeEmailMessage(
      intakePayload({ from: 'mailer-daemon@mail.example' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('D7 defaults return when the override is removed', backToDefault.status, 'skipped_automated');
  }

  // D8: settings validation guards the list.
  {
    const bad = await settingsService.update({ intakeIgnoredSenders: 'has space@x.com' }, 'screening-test');
    eq('D8 entries with spaces rejected', bad.ok, false);
    const empty = await settingsService.update({ intakeIgnoredSenders: '' }, 'screening-test');
    check('D8 empty list allowed', empty.ok === true && empty.settings.intakeIgnoredSenders === '');
    await prisma.setting.deleteMany({ where: { key: 'intakeIgnoredSenders' } });
  }

  /* ---- E. IMAP adapter extracts the headers --------------------------- */
  {
    const raw = [
      'From: Google <no-reply@accounts.google.com>',
      'To: helpdesk@screen.example',
      'Subject: Security alert',
      'Message-ID: <screen-imap-1@mail.gmail.com>',
      'Auto-Submitted: auto-generated',
      'Precedence: bulk',
      'List-Unsubscribe: <mailto:unsub@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'A new sign-in was detected on your account.',
    ].join('\r\n');
    const { rawEmail } = await extractMessage({ uid: 1, source: raw, internalDate: new Date() });
    eq('E1 auto-submitted extracted', rawEmail.autoSubmitted, 'auto-generated');
    eq('E2 precedence extracted', rawEmail.precedence, 'bulk');
    check('E3 list-unsubscribe extracted', Boolean(rawEmail.listUnsubscribe));

    const parsed = parseEmail(rawEmail);
    eq('E4 parsed email carries auto-submitted', parsed.autoSubmitted, 'auto-generated');
  }

  /* ---- F. Graph adapter extracts internetMessageHeaders ---------------- */
  {
    const message = {
      id: 'graph-1',
      subject: 'Security alert',
      body: { contentType: 'text', content: 'body' },
      from: { emailAddress: { name: 'Google', address: 'no-reply@accounts.google.com' } },
      receivedDateTime: new Date().toISOString(),
      internetMessageHeaders: [
        { name: 'Auto-Submitted', value: 'auto-generated' },
        { name: 'precedence', value: 'bulk' },
      ],
    };
    const raw = toRawEmail(message);
    eq('F1 auto-submitted read case-insensitively', raw.autoSubmitted, 'auto-generated');
    eq('F2 precedence read case-insensitively', raw.precedence, 'bulk');
    eq('F3 missing list-id is null', raw.listId, null);

    const noHeaders = toRawEmail({ ...message, internetMessageHeaders: undefined });
    eq('F4 absent header collection degrades to null', noHeaders.autoSubmitted, null);
  }

  /* ---- G. permitted subjects: HR notices that must survive every gate ---- */
  console.log('\n--- G. permitted subjects ---');
  {
    // The organisation decided an induction plan is kept as a ticket: it is the
    // schedule for the account-creation work that follows.
    eq('G1 an induction plan is a permitted subject',
      screening.isPermittedSubject('NEW EMPLOYEE INDUCTION PLAN - MONDAY 5TH OCTOBER 2026'), true);
    eq('G2 a new-starter variant is permitted too',
      screening.isPermittedSubject('New starter induction - Monday'), true);
    eq('G3 unrelated subjects are not permitted',
      screening.isPermittedSubject('Laptop will not start'), false);
    eq('G4 a passing mention is not enough',
      screening.isPermittedSubject('RE: agenda for the induction day'), false);
    eq('G5 an empty subject is not permitted', screening.isPermittedSubject(''), false);
    eq('G6 a null subject is not permitted', screening.isPermittedSubject(null), false);

    // The exemption must survive the automated-mail gate too: an HR notice sent
    // with Precedence: bulk would otherwise be screened out before triage runs.
    const hrMail = {
      requesterEmail: 'hr@hr-notices.test',
      subject: 'NEW EMPLOYEE INDUCTION PLAN - MONDAY 5TH OCTOBER 2026',
      precedence: 'bulk',
      autoSubmitted: 'auto-generated',
    };
    eq('G7 a bulk induction notice still opens a ticket',
      await screening.screenMessage(hrMail), null);
    const newsletter = { ...hrMail, subject: 'Weekly newsletter' };
    check('G8 a bulk newsletter is still screened out',
      Boolean(await screening.screenMessage(newsletter)));
  }

  /* ---- H. the relevance gate cannot suppress a permitted subject -------- */
  console.log('\n--- H. the relevance gate honours permitted subjects ---');
  {
    const policy = require('../src/services/emailTriagePolicy');
    eq('H1 the policy module exports the same predicate',
      policy.isPermittedSubject('INDUCTION PLAN'), true);
    const verdict = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: 'hr@hr-notices.test',
      subject: 'NEW EMPLOYEE INDUCTION PLAN - MONDAY 5TH OCTOBER 2026',
      body: 'Please find the induction programme attached.',
      approvedSenders: ['@hr-notices.test'],
      requireApprovedSender: false,
      threshold: 95,
      hasAttachments: false,
    });
    eq('H2 a confident skip is refused for a permitted subject',
      verdict.policyCode, 'permitted_subject');
    eq('H3 and it is therefore never suppressed', verdict.allowed, false);

    // The exemption must not leak: a genuine newsletter is still suppressible.
    const newsletterVerdict = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: 'news@hr-notices.test',
      subject: 'Weekly newsletter',
      body: 'Read our latest stories.',
      approvedSenders: ['@hr-notices.test'],
      requireApprovedSender: false,
      threshold: 95,
      hasAttachments: false,
    });
    eq('H4 a newsletter is still suppressible', newsletterVerdict.allowed, true);
  }

  /* ---- I. recalled mail, and the ignored-subject list ------------------ */
  console.log('\n--- I. recalled mail and administrator subject list ---');
  {
    // Built-in recall detection. Microsoft marks a recall with the message
    // class IPM.Outlook.Recall and the subject "Recall: <original subject>";
    // neither ingestion channel carries the class, so the prefix is the signal.
    eq('I1 a recall notification is recognised',
      screening.isRecallSubject('Recall: REQUEST FOR REPLACEMENT OF OFFICIAL PHONE'), true);
    eq('I2 a hyphen separator is tolerated', screening.isRecallSubject('Recall - Weekly update'), true);
    eq('I3 a subject that merely mentions recall is not one',
      screening.isRecallSubject('Cannot recall my password'), false);
    eq('I4 an empty subject is not a recall', screening.isRecallSubject(''), false);

    const recallVerdict = await screening.screenMessage({
      requesterEmail: `colleague@${DOMAIN}`,
      subject: 'Recall: REQUEST FOR REPLACEMENT OF OFFICIAL PHONE',
    });
    eq('I5 a recall is screened out', Boolean(recallVerdict), true);
    eq('I5 the reason names the recall', recallVerdict && recallVerdict.reason, 'recalled message');

    // The ignored-subject list: case- and spacing-insensitive substring.
    const entries = screening.parseSubjectEntries(' Independence   Day , PUBLIC HOLIDAY NOTICE ');
    eq('I6 entries normalized + deduped', entries.join('|'), 'independence day|public holiday notice');
    eq('I7 matched case/space-insensitively',
      screening.matchIgnoredSubject('FWD:  INDEPENDENCE   DAY ANNOUNCEMENT', entries), 'independence day');
    eq('I8 no match returns null', screening.matchIgnoredSubject('My laptop will not start', entries), null);
    eq('I9 an empty subject never matches', screening.matchIgnoredSubject('', entries), null);

    // End to end: a recall opens no ticket with no configuration at all.
    const recallTicket = await intakeEmailMessage(
      intakePayload({ from: `colleague@${DOMAIN}`, subject: 'Recall: VPN maintenance window' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('I10 a recall creates no ticket end to end', recallTicket.status, 'skipped_automated');

    const updated = await settingsService.update(
      { intakeIgnoredSubjects: 'independence day, public holiday notice' },
      'screening-test'
    );
    check('I11 settings update accepted', updated.ok === true, JSON.stringify(updated.errors || []));

    const announcement = await intakeEmailMessage(
      intakePayload({
        from: `hr@${DOMAIN}`,
        subject: 'INDEPENDENCE DAY ANNOUNCEMENT',
        body: 'The office will be closed on Monday.',
      }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('I12 a configured announcement creates no ticket', announcement.status, 'skipped_automated');

    const humanMail = await intakeEmailMessage(
      intakePayload({ from: `user@${DOMAIN}`, subject: 'My laptop will not start' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('I13 unrelated human mail still creates a ticket', humanMail.status, 'created');

    // A permitted subject outranks the ignored-subject list.
    await settingsService.update({ intakeIgnoredSubjects: 'induction' }, 'screening-test');
    const induction = await intakeEmailMessage(
      intakePayload({ from: `hr@${DOMAIN}`, subject: 'NEW EMPLOYEE INDUCTION PLAN - MONDAY' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('I14 a permitted subject beats the ignored-subject list', induction.status, 'created');

    const tooShort = await settingsService.update({ intakeIgnoredSubjects: 'x' }, 'screening-test');
    eq('I15 a one-character entry is rejected', tooShort.ok, false);

    await prisma.setting.deleteMany({ where: { key: 'intakeIgnoredSubjects' } });
    const backToDefault = await intakeEmailMessage(
      intakePayload({ from: `hr@${DOMAIN}`, subject: 'INDEPENDENCE DAY ANNOUNCEMENT' }),
      { logger: quiet, mailer: captureMailer() }
    );
    eq('I16 defaults return when the override is removed', backToDefault.status, 'created');
  }

  await cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
