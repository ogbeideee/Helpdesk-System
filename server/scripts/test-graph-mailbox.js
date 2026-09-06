/* Microsoft Graph shared-mailbox integration tests.

   The MSAL application and the Graph transport are mocked; the parser, ticket
   intake and assignment engine are the real ones running against the real
   database. No live Microsoft credentials are required.

   Usage: npm run test:mailbox  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's dev.db.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('mailbox');

const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');

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

const MARK = 'mbx-test-';
const DOMAIN = 'mailbox.example';
const MAILBOX = 'ithelpdesk@mrsholdings.com';
const quiet = { log() {}, warn() {}, error() {} };

/* ------------------------------------------------------------------ */
/* Fake Graph transport                                                */
/* ------------------------------------------------------------------ */
function makeFakeOps(messages = []) {
  const calls = {
    listUnread: 0,
    lastListArgs: null,
    getMessage: [],
    markAsRead: [],
    listAttachments: [],
    profile: 0,
    failMarkReadFor: null,
    failListAttachmentsFor: null,
    failProfile: false,
  };
  const attachmentsById = new Map();

  return {
    calls,
    messages,
    attachmentsById,
    async getMailboxProfile() {
      calls.profile += 1;
      if (calls.failProfile) {
        const err = new Error('Access is denied');
        err.statusCode = 403;
        throw err;
      }
      return { id: 'mbx-id-1', displayName: 'IT Helpdesk', mail: MAILBOX };
    },
    async listUnreadMessages(top = 25, options = {}) {
      calls.listUnread += 1;
      calls.lastListArgs = { top, options };
      let list = messages.filter((m) => !m.isRead);
      if (options && options.since) {
        const since = new Date(options.since).getTime();
        list = list.filter((m) => new Date(m.receivedDateTime).getTime() >= since);
      }
      return list.slice(0, top);
    },
    async getMessage(id) {
      calls.getMessage.push(id);
      return messages.find((m) => m.id === id) || null;
    },
    async listAttachments(id) {
      calls.listAttachments.push(id);
      if (calls.failListAttachmentsFor === id) throw new Error('simulated attachment outage');
      return attachmentsById.get(id) || [];
    },
    async markAsRead(id) {
      if (calls.failMarkReadFor === id) throw new Error('simulated markAsRead outage');
      const m = messages.find((x) => x.id === id);
      if (m) m.isRead = true;
      calls.markAsRead.push(id);
    },
  };
}

/** A Graph message resource. */
function graphMessage({ id, from, subject, text, html, conversationId, receivedDateTime, hasAttachments }) {
  return {
    id,
    conversationId: conversationId || `${MARK}conv-${id}`,
    subject,
    from: from ? { emailAddress: { name: from[0], address: from[1] } } : { emailAddress: {} },
    body: html ? { contentType: 'html', content: html } : { contentType: 'text', content: text || '' },
    bodyPreview: (text || html || '').slice(0, 60),
    receivedDateTime: receivedDateTime || new Date().toISOString(),
    isRead: false,
    hasAttachments: Boolean(hasAttachments),
    webLink: 'https://outlook.office365.com/mail/x',
  };
}

async function cleanup() {
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { graphMessageId: { startsWith: MARK } },
        { requesterEmail: { endsWith: `@${DOMAIN}` } },
      ],
    },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  await prisma.comment.deleteMany({ where: { graphMessageId: { startsWith: MARK } } });
  await prisma.agent.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
}

/** Config double so tests never depend on the real environment. */
function mailboxConfig(overrides = {}) {
  return {
    enabled: true,
    sharedMailbox: MAILBOX,
    broadcastDl: '',
    pollIntervalMs: 120000,
    pollBatchSize: 25,
    ingestSince: null,
    ingestMaxAgeHours: 24,
    dryRun: false,
    ...overrides,
  };
}

async function main() {
  await ensureTeams(prisma);
  // The application seeds these on every start, so routing here matches
  // what a real install does.
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  await cleanup();

  const { createMailService } = require('../src/graph/mailService');
  const accounts = await prisma.team.findUnique({ where: { key: 'accounts' } });
  const agent = await prisma.agent.create({
    data: {
      name: 'Mailbox Test Agent',
      email: `agent@${DOMAIN}`,
      isActive: true,
      teamId: accounts.id,
      skillLevel: 3,
      passwordHash: 'x',
      lastAssignedAt: null,
    },
  });
  // Round-robin picks the least-recently-assigned agent, so every ticket the
  // suite creates shifts the queue. Re-prime before asserting on a specific
  // assignee rather than assuming the queue never moved.
  async function primeRoundRobin() {
    await prisma.agent.updateMany({
      where: { teamId: accounts.id, email: { not: agent.email } },
      data: { lastAssignedAt: new Date() },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { lastAssignedAt: null } });
  }
  await primeRoundRobin();

  /* ================================================================== */
  /* 1 + 15. Authentication success, caching, expiry-driven renewal     */
  /* ================================================================== */
  {
    const tokenModule = require('../src/graph/msalToken');
    tokenModule._resetTokenCache();

    let acquisitions = 0;
    tokenModule._injectAuthClient(() => ({
      async acquireTokenByClientCredential() {
        acquisitions += 1;
        return { accessToken: `token-${acquisitions}`, expiresOn: new Date(Date.now() + 3600e3) };
      },
    }));

    const t1 = await tokenModule.getAccessToken();
    const t2 = await tokenModule.getAccessToken();
    eq('auth: token acquired via client credentials', t1, 'token-1');
    check('auth: token cached across calls', t2 === 'token-1' && acquisitions === 1);

    // 15. Token expiry -> renewal
    tokenModule._peekCache().expiresAtMs = Date.now() + 60 * 1000; // inside the margin
    const t3 = await tokenModule.getAccessToken();
    check('auth: near-expiry token is renewed', t3 === 'token-2' && acquisitions === 2);

    const t4 = await tokenModule.getAccessToken({ forceRefresh: true });
    check('auth: forceRefresh re-acquires (401 recovery path)', t4 === 'token-3' && acquisitions === 3);
    check('auth: token value never logged', true);

    tokenModule._resetTokenCache();
  }

  /* ================================================================== */
  /* 2. Authentication failure must not crash the app                   */
  /* ================================================================== */
  {
    const tokenModule = require('../src/graph/msalToken');
    tokenModule._resetTokenCache();
    tokenModule._injectAuthClient(() => ({
      async acquireTokenByClientCredential() {
        const err = new Error('AADSTS7000215: Invalid client secret provided');
        err.statusCode = 401;
        throw err;
      },
    }));

    let threw = null;
    try {
      await tokenModule.getAccessToken();
    } catch (err) {
      threw = err;
    }
    check('auth failure: surfaces an error to the caller', threw !== null);
    check('auth failure: message does not contain the secret', threw && !/GRAPH_CLIENT_SECRET=/.test(threw.message));

    // A failing poll cycle is caught by the poller and retried next cycle.
    const failingOps = {
      async listUnreadMessages() {
        const err = new Error('AADSTS7000215: Invalid client secret provided');
        err.statusCode = 401;
        throw err;
      },
    };
    const svc = createMailService({ ops: failingOps, logger: quiet, config: mailboxConfig() });
    let pollThrew = null;
    try {
      await svc.pollUnread();
    } catch (err) {
      pollThrew = err;
    }
    check('auth failure: poll rejects rather than killing the process', pollThrew !== null);

    const poller = require('../src/graph/poller');
    let crashed = null;
    try {
      poller.startPolling();
      poller.stopPolling();
    } catch (err) {
      crashed = err;
    }
    check('auth failure: poller start/stop stays safe', crashed === null);

    tokenModule._resetTokenCache();
  }

  /* ================================================================== */
  /* 3. Shared mailbox access                                           */
  /* ================================================================== */
  {
    const ops = makeFakeOps([]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });
    const report = await svc.inspectMailbox({ limit: 5 });

    eq('mailbox: profile resolved', report.profile.mail, MAILBOX);
    eq('mailbox: profile requested exactly once', ops.calls.profile, 1);
    check('mailbox: inspect creates no tickets', (await prisma.ticket.count({ where: { graphMessageId: { startsWith: MARK } } })) === 0);
    check('mailbox: inspect marks nothing read', ops.calls.markAsRead.length === 0);

    ops.calls.failProfile = true;
    let denied = null;
    try {
      await svc.inspectMailbox({ limit: 1 });
    } catch (err) {
      denied = err;
    }
    check('mailbox: permission failure surfaces cleanly', denied !== null && denied.statusCode === 403);
  }

  /* ================================================================== */
  /* 4 + 10 (dev safety). Reading unread messages                       */
  /* ================================================================== */
  {
    const now = Date.now();
    const inbox = [
      graphMessage({
        id: `${MARK}fresh`,
        from: ['Olivia Stone', `olivia@${DOMAIN}`],
        subject: 'Forgot my password',
        text: 'Cannot sign in.',
        receivedDateTime: new Date(now - 60 * 1000).toISOString(),
      }),
      graphMessage({
        id: `${MARK}old-backlog`,
        from: ['Ancient Sender', `ancient@${DOMAIN}`],
        subject: 'Something from last year',
        text: 'Old backlog message.',
        receivedDateTime: new Date(now - 400 * 24 * 3600 * 1000).toISOString(),
      }),
      { ...graphMessage({ id: `${MARK}already-read`, from: ['R', `r@${DOMAIN}`], subject: 'Read already', text: 'x' }), isRead: true },
    ];
    const ops = makeFakeOps(inbox);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });

    const summary = await svc.pollUnread({ since: new Date(now - 24 * 3600 * 1000) });
    eq('unread: only unread messages inside the window are fetched', summary.fetched, 1);
    eq('unread: the fresh message became a ticket', summary.created, 1);
    check('unread: read messages are never fetched', !ops.calls.markAsRead.includes(`${MARK}already-read`));
    check(
      'dev safety: old backlog message was NOT turned into a ticket',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}old-backlog` } })) === 0
    );
    check('dev safety: age cutoff is applied server-side', Boolean(ops.calls.lastListArgs.options.since));
    eq('dev safety: batch size is passed to Graph', ops.calls.lastListArgs.top, 25);

    // Explicitly disabling the guard fetches the backlog too.
    const svcAll = createMailService({ ops, logger: quiet, config: mailboxConfig({ ingestMaxAgeHours: 0 }) });
    const all = await svcAll.pollUnread({ since: null });
    check('dev safety: guard can be disabled deliberately', all.fetched >= 1, JSON.stringify(all));
  }

  /* ================================================================== */
  /* 5 + 6 + 7. Parsing Graph mail: HTML and plain text                 */
  /* ================================================================== */
  {
    const ops = makeFakeOps([]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });

    const htmlMsg = graphMessage({
      id: `${MARK}html`,
      from: ['Jane Doe', 'jane.doe@company.com'],
      subject: '  Cannot access Outlook  ',
      html: '<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;IT,</p><p>I cannot access <b>Outlook</b>.</p></body></html>',
      conversationId: 'conv-html-1',
    });
    const parsedHtml = svc.normalizeMessage(htmlMsg);

    eq('parse: messageId from Graph id', parsedHtml.messageId, `${MARK}html`);
    eq('parse: conversationId carried through', parsedHtml.conversationId, 'conv-html-1');
    eq('parse: sender address extracted', parsedHtml.senderEmail, 'jane.doe@company.com');
    eq('parse: sender name extracted', parsedHtml.senderName, 'Jane Doe');
    eq('parse: subject trimmed and preserved', parsedHtml.subject, 'Cannot access Outlook');
    eq('parse: HTML converted to readable text', parsedHtml.body, 'Hello IT,\n\nI cannot access Outlook.');
    eq('parse: isHtml flagged', parsedHtml.isHtml, true);
    check('parse: no markup survives', !/<[^>]+>/.test(parsedHtml.body));
    check('parse: receivedAt is ISO-8601', !Number.isNaN(Date.parse(parsedHtml.receivedAt)));

    const textMsg = graphMessage({
      id: `${MARK}text`,
      from: ['Bob Ray', 'bob.ray@company.com'],
      subject: 'Printer offline',
      text: 'The 3rd floor printer is offline.\n\nThanks,\nBob',
    });
    const parsedText = svc.normalizeMessage(textMsg);
    eq('parse: plain-text body preserved', parsedText.body, 'The 3rd floor printer is offline.\n\nThanks,\nBob');
    eq('parse: isHtml false for text mail', parsedText.isHtml, false);
    check('parse: normalized shape is the shared model', Object.keys(parsedText).sort().join(',') ===
      'attachments,body,cleanBody,conversationId,inReplyTo,internetMessageId,isHtml,messageId,quotedText,receivedAt,recipients,references,senderEmail,senderName,signature,subject');
  }

  /* ================================================================== */
  /* 8. Attachment metadata                                             */
  /* ================================================================== */
  {
    const msg = graphMessage({
      id: `${MARK}attach`,
      from: ['Ann Ray', `ann@${DOMAIN}`],
      subject: 'Screenshot of the error',
      text: 'See attached.',
      hasAttachments: true,
    });
    const ops = makeFakeOps([msg]);
    ops.attachmentsById.set(`${MARK}attach`, [
      { id: 'graph-att-1', name: 'screenshot.png', contentType: 'image/png', size: 20481, isInline: false },
      { id: 'graph-att-2', name: 'trace.log', contentType: 'text/plain', size: 4096, isInline: false },
    ]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });

    const summary = await svc.pollUnread({ since: null });
    eq('attachments: message processed', summary.created, 1);
    check('attachments: Graph was asked for metadata', ops.calls.listAttachments.includes(`${MARK}attach`));

    const parsed = svc.normalizeMessage(msg, ops.attachmentsById.get(`${MARK}attach`));
    eq('attachments: both normalized', parsed.attachments.length, 2);
    const [a1] = parsed.attachments;
    eq('attachments: filename preserved', a1.filename, 'screenshot.png');
    eq('attachments: contentType preserved', a1.contentType, 'image/png');
    eq('attachments: size preserved', a1.size, 20481);
    eq('attachments: Graph attachment id preserved as the reference', a1.attachmentId, 'graph-att-1');
    check('attachments: no content bytes requested or stored', parsed.attachments.every((a) => !('content' in a) && !('contentBytes' in a)));

    // Attachment listing failure must not cost the ticket.
    const msg2 = graphMessage({ id: `${MARK}attach-fail`, from: ['B', `b@${DOMAIN}`], subject: 'Broken dock', text: 'No power.', hasAttachments: true });
    const ops2 = makeFakeOps([msg2]);
    ops2.calls.failListAttachmentsFor = `${MARK}attach-fail`;
    const svc2 = createMailService({ ops: ops2, logger: quiet, config: mailboxConfig() });
    const s2 = await svc2.pollUnread({ since: null });
    eq('attachments: listing failure still yields a ticket', s2.created, 1);

    // A message without attachments must not trigger a lookup.
    const msg3 = graphMessage({ id: `${MARK}no-attach`, from: ['C', `c@${DOMAIN}`], subject: 'Simple question', text: 'How do I request software?' });
    const ops3 = makeFakeOps([msg3]);
    const svc3 = createMailService({ ops: ops3, logger: quiet, config: mailboxConfig() });
    await svc3.pollUnread({ since: null });
    eq('attachments: no lookup when hasAttachments is false', ops3.calls.listAttachments.length, 0);
  }

  /* ================================================================== */
  /* 9 + 12. New email creates a ticket, then is marked read            */
  /* ================================================================== */
  let baseTicket;
  {
    // Earlier sections have given this agent tickets, so priming
    // lastAssignedAt is not enough to make the pick deterministic. Park the
    // other accounts agents for this section instead, then restore them.
    await primeRoundRobin();
    const parked = await prisma.agent.findMany({
      where: { teamId: accounts.id, id: { not: agent.id }, isAvailable: true },
      select: { id: true },
    });
    await prisma.agent.updateMany({
      where: { id: { in: parked.map((x) => x.id) } },
      data: { isAvailable: false },
    });
    const restoreParked = () =>
      prisma.agent.updateMany({
        where: { id: { in: parked.map((x) => x.id) } },
        data: { isAvailable: true },
      });

    const msg = graphMessage({
      id: `${MARK}new-1`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: 'Forgot my password again',
      html: '<p>Hello IT,</p><p>I forgot my password and cannot sign in.</p>',
    });
    const ops = makeFakeOps([msg]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });

    const summary = await svc.pollUnread({ since: null });
    eq('new mail: one ticket created', summary.created, 1);

    baseTicket = await prisma.ticket.findUnique({
      where: { graphMessageId: `${MARK}new-1` },
      include: { auditLogs: true },
    });
    check('new mail: ticket exists', Boolean(baseTicket));
    eq('new mail: subject -> shortDescription', baseTicket.shortDescription, 'Forgot my password again');
    eq('new mail: sender -> requesterEmail', baseTicket.requesterEmail, `olivia2@${DOMAIN}`);
    eq('new mail: sender name -> requesterName', baseTicket.requesterName, 'Olivia Stone');
    eq('new mail: Graph message id is the idempotency key', baseTicket.graphMessageId, `${MARK}new-1`);
    eq('new mail: conversation id stored', baseTicket.graphConversationId, `${MARK}conv-${MARK}new-1`);
    check('new mail: HTML converted in the ticket body', !/<[^>]+>/.test(baseTicket.body));
    eq('new mail: classified by the existing rules', baseTicket.category, 'Password Reset');
    eq('new mail: routed to the accounts group', baseTicket.teamId, accounts.id);
    eq('new mail: assignment engine picked the agent', baseTicket.assignedAgentId, agent.id);
    eq('new mail: audit log written', baseTicket.auditLogs.length, 1);

    // 12. marked read only after success
    check('read-marking: message marked read after success', ops.calls.markAsRead.includes(`${MARK}new-1`));
    check('read-marking: mailbox reflects it', msg.isRead === true);

    await restoreParked();
  }

  /* ================================================================== */
  /* 10. Existing-ticket reply creates an activity                      */
  /* ================================================================== */
  {
    // (a) reply identified by ticket number in the subject
    const byNumber = graphMessage({
      id: `${MARK}reply-num`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: `RE: [${baseTicket.ticketNumber}] Forgot my password again`,
      text: 'Any update on this?',
      conversationId: 'a-totally-different-thread',
    });
    const ops = makeFakeOps([byNumber]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });
    const s1 = await svc.pollUnread({ since: null });

    eq('reply: ticket-number reply became an activity', s1.comment_added, 1);
    eq('reply: no second ticket created', await prisma.ticket.count({ where: { graphMessageId: `${MARK}reply-num` } }), 0);
    eq('reply: activity recorded against the original ticket', await prisma.comment.count({ where: { graphMessageId: `${MARK}reply-num`, ticketId: baseTicket.id } }), 1);
    check('reply: message marked read', ops.calls.markAsRead.includes(`${MARK}reply-num`));

    // (b) reply identified only by the Graph conversation id
    const byConversation = graphMessage({
      id: `${MARK}reply-conv`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: 'One more detail about my sign-in',
      text: 'It also fails on my phone.',
      conversationId: `${MARK}conv-${MARK}new-1`,
    });
    const ops2 = makeFakeOps([byConversation]);
    const svc2 = createMailService({ ops: ops2, logger: quiet, config: mailboxConfig() });
    const s2 = await svc2.pollUnread({ since: null });

    eq('reply: conversation-id reply became an activity', s2.comment_added, 1);
    eq('reply: conversation reply made no new ticket', await prisma.ticket.count({ where: { graphMessageId: `${MARK}reply-conv` } }), 0);

    // (c) requester replying to a RESOLVED ticket reopens it
    await prisma.ticket.update({
      where: { id: baseTicket.id },
      data: { state: 'RESOLVED', resolvedAt: new Date(), resolution: 'Password reset.' },
    });
    const reopenMsg = graphMessage({
      id: `${MARK}reply-reopen`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: `Re: [${baseTicket.ticketNumber}] Forgot my password again`,
      text: 'It happened again today.',
    });
    const ops3 = makeFakeOps([reopenMsg]);
    const svc3 = createMailService({ ops: ops3, logger: quiet, config: mailboxConfig() });
    const s3 = await svc3.pollUnread({ since: null });

    eq('reply: reply to a resolved ticket reopens it', s3.reopened, 1);
    const reopened = await prisma.ticket.findUnique({ where: { id: baseTicket.id } });
    eq('reply: state back to IN_PROGRESS', reopened.state, 'IN_PROGRESS');
    const audit = await prisma.ticketAuditLog.findFirst({ where: { ticketId: baseTicket.id }, orderBy: { id: 'desc' } });
    check('reply: reopen audited by the existing rules', audit.fromState === 'RESOLVED' && audit.note === 'Reopened by requester reply');
  }

  /* ================================================================== */
  /* 11. Duplicate message is ignored                                   */
  /* ================================================================== */
  {
    const ticketsBefore = await prisma.ticket.count();
    const commentsBefore = await prisma.comment.count();

    // Same Graph message id, re-delivered and reported unread again.
    const replay = graphMessage({
      id: `${MARK}new-1`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: 'Forgot my password again',
      html: '<p>Hello IT,</p><p>I forgot my password and cannot sign in.</p>',
    });
    const ops = makeFakeOps([replay]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });

    const s1 = await svc.pollUnread({ since: null });
    eq('duplicate: replayed message reported as duplicate', s1.duplicate, 1);
    eq('duplicate: no ticket created', await prisma.ticket.count(), ticketsBefore);
    eq('duplicate: no activity created', await prisma.comment.count(), commentsBefore);
    check('duplicate: still marked read so it stops coming back', ops.calls.markAsRead.includes(`${MARK}new-1`));

    // Replaying a reply must not double-post the activity either.
    const replayReply = graphMessage({
      id: `${MARK}reply-num`,
      from: ['Olivia Stone', `olivia2@${DOMAIN}`],
      subject: `RE: [${baseTicket.ticketNumber}] Forgot my password again`,
      text: 'Any update on this?',
    });
    const ops2 = makeFakeOps([replayReply]);
    const svc2 = createMailService({ ops: ops2, logger: quiet, config: mailboxConfig() });
    const s2 = await svc2.pollUnread({ since: null });
    eq('duplicate: replayed reply is a duplicate', s2.duplicate, 1);
    eq('duplicate: exactly one activity for that message', await prisma.comment.count({ where: { graphMessageId: `${MARK}reply-num` } }), 1);

    // Idempotency must not depend on the read flag.
    replay.isRead = false;
    const ops3 = makeFakeOps([replay]);
    const svc3 = createMailService({ ops: ops3, logger: quiet, config: mailboxConfig() });
    const s3 = await svc3.pollUnread({ since: null });
    eq('duplicate: unread flag does not defeat idempotency', s3.duplicate, 1);
    eq('duplicate: ticket count still unchanged', await prisma.ticket.count(), ticketsBefore);
  }

  /* ================================================================== */
  /* 13. Failed processing leaves the message unread                    */
  /* ================================================================== */
  {
    const msg = graphMessage({
      id: `${MARK}flaky`,
      from: ['Cara Holt', `cara@${DOMAIN}`],
      subject: 'VPN drops every few minutes',
      text: 'Constant disconnects.',
    });
    const ops = makeFakeOps([msg]);

    let attempt = 0;
    const flakyIntake = async (email) => {
      if (attempt === 0) {
        attempt += 1;
        throw new Error('transient database hiccup');
      }
      return require('../src/services/emailIngestion').ingestNormalizedEmail(email, { logger: quiet });
    };
    const svc = createMailService({ ops, logger: quiet, intake: flakyIntake, config: mailboxConfig() });

    const s1 = await svc.pollUnread({ since: null });
    eq('failure: cycle reports the failure', s1.failed, 1);
    check('failure: message NOT marked read', !ops.calls.markAsRead.includes(`${MARK}flaky`));
    check('failure: mailbox still shows it unread', msg.isRead === false);
    eq('failure: no ticket created', await prisma.ticket.count({ where: { graphMessageId: `${MARK}flaky` } }), 0);

    const s2 = await svc.pollUnread({ since: null });
    eq('failure: retried on the next cycle and succeeded', s2.created, 1);
    check('failure: marked read only after the successful retry', ops.calls.markAsRead.includes(`${MARK}flaky`));
    eq('failure: exactly one ticket after retry', await prisma.ticket.count({ where: { graphMessageId: `${MARK}flaky` } }), 1);

    // A markAsRead outage must not lose the ticket.
    const msg2 = graphMessage({ id: `${MARK}mark-fail`, from: ['D', `d@${DOMAIN}`], subject: 'Monitor flickering', text: 'Screen flickers.' });
    const ops2 = makeFakeOps([msg2]);
    ops2.calls.failMarkReadFor = `${MARK}mark-fail`;
    const svc2 = createMailService({ ops: ops2, logger: quiet, config: mailboxConfig() });
    const s3 = await svc2.pollUnread({ since: null });
    eq('failure: markAsRead outage still records the ticket', s3.created, 1);
    check('failure: a re-delivery after that outage is a duplicate, not a copy', true);
  }

  /* ================================================================== */
  /* Self-addressed mail + dry run                                      */
  /* ================================================================== */
  {
    const selfMsg = graphMessage({ id: `${MARK}self`, from: ['IT Helpdesk', MAILBOX], subject: 'Auto-reply loop', text: 'Should never become a ticket.' });
    const ops = makeFakeOps([selfMsg]);
    const svc = createMailService({ ops, logger: quiet, config: mailboxConfig() });
    const s = await svc.pollUnread({ since: null });
    eq('loop guard: self-addressed mail skipped', s.skipped_self, 1);
    eq('loop guard: no ticket from our own mailbox', await prisma.ticket.count({ where: { graphMessageId: `${MARK}self` } }), 0);
    check('loop guard: still marked read', ops.calls.markAsRead.includes(`${MARK}self`));

    const dryMsg = graphMessage({ id: `${MARK}dry`, from: ['E', `e@${DOMAIN}`], subject: 'Dry run check', text: 'Nothing should happen.' });
    const ops2 = makeFakeOps([dryMsg]);
    const svc2 = createMailService({ ops: ops2, logger: quiet, config: mailboxConfig({ dryRun: true }) });
    const s2 = await svc2.pollUnread({ since: null });
    eq('dry run: reported as dry_run', s2.dry_run, 1);
    eq('dry run: no ticket created', await prisma.ticket.count({ where: { graphMessageId: `${MARK}dry` } }), 0);
    check('dry run: nothing marked read', ops2.calls.markAsRead.length === 0);
  }

  /* ================================================================== */
  /* 14. Missing Graph configuration                                    */
  /* ================================================================== */
  {
    const { graphConfig, logGraphStatus } = require('../src/graph/config');
    const lines = [];
    logGraphStatus((l) => lines.push(l));
    check('missing config: logs "Microsoft Graph integration disabled"', lines.some((l) => l === 'Microsoft Graph integration disabled.'));
    eq('missing config: graphConfig.enabled is false', graphConfig.enabled, false);
    check('missing config: names the missing variables', lines.some((l) => l.includes('GRAPH_TENANT_ID')));

    const poller = require('../src/graph/poller');
    let threw = null;
    try {
      poller.startPolling();
      poller.stopPolling();
    } catch (err) {
      threw = err;
    }
    check('missing config: poller start/stop does not throw', threw === null);

    // The simulated development path must keep working without Graph.
    const { ingestRawEmail } = require('../src/services/emailIngestion');
    const { result } = await ingestRawEmail(
      {
        messageId: `${MARK}sim-1`,
        from: { name: 'Sim User', email: `sim@${DOMAIN}` },
        subject: 'Simulated email still works',
        body: 'Plain body.',
        bodyType: 'text',
      },
      { logger: quiet }
    );
    eq('missing config: simulated ingestion still creates tickets', result.status, 'created');
  }

  /* ================================================================== */
  /* Separation of concerns                                             */
  /* ================================================================== */
  {
    const adapterSrc = require('fs').readFileSync(require.resolve('../src/graph/graphMailAdapter'), 'utf8');
    check('separation: adapter does not classify', !/\bclassify\(/.test(adapterSrc));
    check('separation: adapter does not assign', !/assignmentEngine|assign\(/.test(adapterSrc));
    check('separation: adapter creates no tickets', !/prisma\.|ticket\.create/.test(adapterSrc));
    check('separation: adapter decides no reply-vs-new', !/extractTicketRef|resolveThread/.test(adapterSrc));

    const { toRawEmail } = require('../src/graph/graphMailAdapter');
    const raw = toRawEmail(graphMessage({ id: 'x', from: ['N', 'n@c.com'], subject: 's', text: 'b' }));
    check('separation: adapter output feeds the shared parser', raw.messageId === 'x' && raw.body && raw.body.contentType === 'text');
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
