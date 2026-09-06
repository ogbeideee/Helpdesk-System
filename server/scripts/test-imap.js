/* IMAP ingestion tests — no real mail server required.

   A minimal IMAP4rev1 server is implemented on a raw TCP socket and the REAL
   ImapFlow client is pointed at it, so connection, login, mailbox selection,
   UID SEARCH/FETCH and \Seen STORE are exercised end to end. Parsed messages
   run through the shared ticket-intake pipeline against the isolated database.

   Parts:
     A. configuration (enabled/disabled derivation, defaults, no secrets in logs)
     B. MIME mapping (sender, recipients, subject, text/HTML bodies, Message-ID,
        In-Reply-To, References, received date) and malformed-message behavior
     C. end-to-end polling against the mock server: new tickets, threading,
        reopen, duplicate polling, self-addressed exclusion, malformed mail
     D. failure containment: authentication failure, connection failure
     E. scheduler wiring

   Usage: npm run test:imap  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4216';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('imap');

const net = require('net');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');
const imapStatus = require('../src/imap/imapStatus');

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

const CRLF = '\r\n';
const PASSWORD = 'ImapSuite!123';
const DOMAIN = 'imap.test';
const IMAP_USER = 'helpdesk@imap.test';
const IMAP_PASS = 'imap-secret-pass';

/* ====================================================================== */
/* Minimal IMAP mock server                                                */
/* ====================================================================== */

/**
 * A permissive IMAP4rev1 server speaking just enough of the protocol for
 * ImapFlow: greeting, CAPABILITY, ID, LOGIN, SELECT, UID SEARCH, UID FETCH
 * (with a literal), UID STORE and LOGOUT. Everything else gets a tagged OK.
 */
function createMockImapServer({ messages = [], rejectAuth = false, failStoreFor = null } = {}) {
  const state = {
    logins: [],
    authFailures: 0,
    selects: 0,
    searches: 0,
    fetches: [],
    seenUids: [],
    storeFailures: 0,
    connections: 0,
  };

  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.write(`* OK Mock IMAP4rev1 ready${CRLF}`);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary');
      let idx;
      while ((idx = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    socket.on('error', () => {});

    function send(line) {
      socket.write(line + CRLF, 'binary');
    }

    function handle(line) {
      const match = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) return;
      const [, tag, command, rest] = match;
      const cmd = command.toUpperCase();

      if (cmd === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1 IDLE');
        send(`${tag} OK CAPABILITY completed`);
      } else if (cmd === 'ID') {
        send('* ID nil');
        send(`${tag} OK ID completed`);
      } else if (cmd === 'LOGIN') {
        const creds = rest.match(/"([^"]*)"\s+"([^"]*)"/) || rest.match(/^(\S+)\s+(\S+)$/);
        const user = creds ? creds[1] : '';
        const pass = creds ? creds[2] : '';
        state.logins.push(user);
        if (rejectAuth) {
          state.authFailures += 1;
          send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        } else if (user === IMAP_USER && pass === IMAP_PASS) {
          send(`${tag} OK [CAPABILITY IMAP4rev1] logged in`);
        } else {
          state.authFailures += 1;
          send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        }
      } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        state.selects += 1;
        send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
        send(`* ${messages.length} EXISTS`);
        send('* 0 RECENT');
        send('* OK [UIDVALIDITY 1111] UIDs valid');
        send(`* OK [UIDNEXT ${messages.length + 1}] next uid`);
        send(`${tag} OK [READ-WRITE] SELECT completed`);
      } else if (cmd === 'UID' && /\bSEARCH\b/i.test(rest)) {
        state.searches += 1;
        const unseen = messages.filter((m) => !state.seenUids.includes(m.uid)).map((m) => m.uid);
        send(`* SEARCH ${unseen.join(' ')}`.trimEnd());
        send(`${tag} OK SEARCH completed`);
      } else if (cmd === 'UID' && /\bFETCH\b/i.test(rest)) {
        // rest looks like "FETCH <uid> (...)": pull the uid out of it.
        const uid = parseInt((rest.match(/FETCH\s+(\d+)/i) || [])[1], 10);
        const message = messages.find((m) => m.uid === uid);
        state.fetches.push(uid);
        if (!message) {
          send(`${tag} OK FETCH completed`);
          return;
        }
        const body = Buffer.from(message.raw, 'utf8');
        // Literal framing: the {n} octets are followed IMMEDIATELY by the rest
        // of the response line — no CRLF before the closing parenthesis.
        socket.write(`* 1 FETCH (UID ${uid} INTERNALDATE "01-Sep-2026 09:00:00 +0000" BODY[] {${body.length}}${CRLF}`, 'binary');
        socket.write(body, 'binary');
        socket.write(`)${CRLF}`, 'binary');
        send(`${tag} OK FETCH completed`);
      } else if (cmd === 'UID' && /\bSTORE\b/i.test(rest)) {
        const uid = parseInt((rest.match(/STORE\s+(\d+)/i) || [])[1], 10);
        if (failStoreFor === uid) {
          state.storeFailures += 1;
          send(`${tag} NO STORE failed`);
        } else {
          if (/^\+/.test(rest.split(/\s+/)[2] || '')) state.seenUids.push(uid);
          send(`${tag} OK STORE completed`);
        }
      } else if (cmd === 'LOGOUT') {
        send('* BYE mock server closing');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
      } else if (cmd === 'NOOP' || cmd === 'CHECK' || cmd === 'CLOSE' || cmd === 'UNSELECT') {
        send(`${tag} OK ${cmd} completed`);
      } else {
        // Permissive: imapflow probes optional extensions; unknown commands
        // answer OK so the happy path is exercised.
        send(`${tag} OK ${cmd} completed`);
      }
    }
  });

  // Port 0 -> the OS picks a free port.
  server.listen(0, '127.0.0.1');
  return { server, state, ready: new Promise((resolve) => server.once('listening', resolve)) };
}

/* ====================================================================== */
/* Raw RFC 822 message builders                                            */
/* ====================================================================== */

function rawMessage({ from, to, subject, messageId, inReplyTo, references, text, html, date, multipart }) {
  const lines = [
    `From: ${from}`,
    `To: ${to || 'IT Helpdesk <helpdesk@imap.test>'}`,
    'Cc: cc.person@imap.test',
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${date || 'Tue, 01 Sep 2026 09:00:00 +0000'}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);

  if (multipart) {
    const boundary = 'bnd-42';
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '');
    // quoted-printable: encode the body crudely (no = signs in the test text).
    lines.push(text, '');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '');
    lines.push(Buffer.from(`<p>${html}</p>`, 'utf8').toString('base64'), '');
    lines.push(`--${boundary}--`, '');
    return lines.join(CRLF);
  }

  if (html && !text) {
    lines.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '');
    lines.push(Buffer.from(html, 'utf8').toString('base64'), '');
    return lines.join(CRLF);
  }

  lines.push('Content-Type: text/plain; charset=utf-8', '');
  lines.push(text || '', '');
  return lines.join(CRLF);
}

/* ====================================================================== */
/* Helpers                                                                 */
/* ====================================================================== */

function imapConfigFor(port, overrides = {}) {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: IMAP_USER,
    password: IMAP_PASS,
    mailbox: 'INBOX',
    pollIntervalMs: 120000,
    pollBatchSize: 25,
    tlsRejectUnauthorized: true,
    enabled: true,
    ...overrides,
  };
}

async function seedHelpdesk() {
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  return prisma.agent.create({
    data: {
      name: 'Imap Agent', email: `agent@${DOMAIN}`, role: 'agent',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  /* ---- A. configuration ------------------------------------------------- */
  console.log('\n--- A. configuration ---');
  const { readImapEnv, logImapStatus } = require('../src/imap/config');
  const withEnv = (env, fn) => {
    const saved = {};
    for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
    try { return fn(); } finally { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  };

  const disabled = withEnv({ IMAP_HOST: '', IMAP_USER: '', IMAP_PASSWORD: '' }, () => readImapEnv());
  eq('A1 disabled without credentials', disabled.enabled, false);
  const minimal = withEnv({ IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: 'p' }, () => readImapEnv());
  eq('A2 enabled with host/user/password', minimal.enabled, true);
  eq('A3 TLS on by default', minimal.secure, true);
  eq('A4 default port 993 when secure', minimal.port, 993);
  const legacy = withEnv({ IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: 'p', IMAP_SECURE: 'false' }, () => readImapEnv());
  eq('A5 plaintext mode drops to port 143', legacy.port, 143);
  const explicit = withEnv({ IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: 'p', IMAP_PORT: '2010', IMAP_MAILBOX: 'Tickets', IMAP_POLL_INTERVAL_MS: '0' }, () => readImapEnv());
  eq('A6 explicit port honored', explicit.port, 2010);
  eq('A7 mailbox configurable', explicit.mailbox, 'Tickets');
  eq('A8 explicit zero disables the timer', explicit.pollIntervalMs, 0);
  const defaulted = withEnv({}, () => readImapEnv());
  eq('A9 unset interval defaults to 120000', defaulted.pollIntervalMs, 120000);
  eq('A10 default batch is 25', defaulted.pollBatchSize, 25);
  const batched = withEnv({ IMAP_POLL_BATCH_SIZE: '500' }, () => readImapEnv());
  eq('A11 batch is capped at 100', batched.pollBatchSize, 100);

  const logLines = [];
  withEnv({ IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: 'super-secret-pass' }, () => logImapStatus((l) => logLines.push(l), readImapEnv()));
  check('A12 status log never contains the password', !logLines.join('\n').includes('super-secret-pass'));
  check('A13 status log names the host', logLines.join('\n').includes('mail.x'));

  /* ---- B. MIME mapping ---------------------------------------------------- */
  console.log('\n--- B. MIME mapping ---');
  const { toRawEmail } = require('../src/imap/imapMailAdapter');
  const { parseEmail } = require('../src/email/emailParser');

  const rich = rawMessage({
    from: 'Rita Requester <rita@imap.test>',
    subject: 'Printer jams on duplex',
    messageId: '<printer-1@imap.test>',
    text: 'The tray 2 jams every time.',
    html: 'The tray 2 jams <b>every time</b>.',
    multipart: true,
  });
  const mapped = await toRawEmail({ uid: 7, source: Buffer.from(rich, 'utf8'), internalDate: new Date('2026-09-01T09:00:00Z') });
  const parsedRich = parseEmail(mapped);
  eq('B1 Message-ID parsed, brackets stripped', parsedRich.messageId, 'printer-1@imap.test');
  eq('B2 internetMessageId mirrors the header', parsedRich.internetMessageId, 'printer-1@imap.test');
  eq('B3 sender address', parsedRich.senderEmail, 'rita@imap.test');
  eq('B4 sender display name', parsedRich.senderName, 'Rita Requester');
  eq('B5 subject preserved verbatim', parsedRich.subject, 'Printer jams on duplex');
  check('B6 the HTML part is converted to the same readable text',
    parsedRich.body.includes('The tray 2 jams every time.') && !parsedRich.body.includes('<b>'));
  eq('B7 an HTML part is reported as html', parsedRich.isHtml, true);
  eq('B8 recipients parsed (to)', parsedRich.recipients.to.map((a) => a.email).join(','), 'helpdesk@imap.test');
  eq('B9 recipients parsed (cc)', parsedRich.recipients.cc.map((a) => a.email).join(','), 'cc.person@imap.test');
  eq('B10 received date from INTERNALDATE', parsedRich.receivedAt, new Date('2026-09-01T09:00:00Z').toISOString());

  const htmlOnly = rawMessage({
    from: 'rita@imap.test',
    subject: 'Only HTML',
    messageId: '<html-only@imap.test>',
    html: 'Line one.<br>Line <b>two</b>.',
  });
  const parsedHtml = parseEmail(await toRawEmail({ uid: 8, source: Buffer.from(htmlOnly, 'utf8') }));
  check('B11 HTML-only body is converted to readable text',
    parsedHtml.body.includes('Line one.') && parsedHtml.body.includes('Line two.'));
  eq('B12 HTML-only message is flagged as html', parsedHtml.isHtml, true);

  const threaded = rawMessage({
    from: 'rita@imap.test',
    subject: 'Re: Printer jams on duplex',
    messageId: '<printer-2@imap.test>',
    inReplyTo: '<printer-1@imap.test>',
    references: '<printer-1@imap.test> <printer-0@imap.test>',
    text: 'It happened again.',
  });
  const parsedThread = parseEmail(await toRawEmail({ uid: 9, source: Buffer.from(threaded, 'utf8') }));
  eq('B13 In-Reply-To extracted, brackets stripped', parsedThread.inReplyTo.join(','), 'printer-1@imap.test');
  check('B14 References chain extracted in order',
    JSON.stringify(parsedThread.references) === JSON.stringify(['printer-1@imap.test', 'printer-0@imap.test']));

  const junk = Buffer.from([0x00, 0xff, 0x13, 0x7f, 0x99, 0x03, 0xde, 0xad]);
  const junkMapped = await toRawEmail({ uid: 10, source: junk });
  let junkRejected = false;
  try { parseEmail(junkMapped); } catch (err) { junkRejected = err.name === 'EmailParseError'; }
  check('B15 malformed bytes degrade to a clean rejection, never a crash', junkRejected);

  /* ---- C. end-to-end polling against the mock server ---------------------- */
  console.log('\n--- C. polling (mock server, real ImapFlow client) ---');
  const agent = await seedHelpdesk();
  const quiet = { log() {}, error() {}, warn() {} };
  const { createImapMailService } = require('../src/imap/mailService');

  const mock1 = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: 'Rita Requester <rita@imap.test>', subject: 'VPN drops every hour', messageId: '<m1@imap.test>', text: 'The VPN client disconnects on its own.' }) },
      { uid: 2, raw: rawMessage({ from: 'Sam Sender <sam@imap.test>', subject: 'Mouse not working', messageId: '<m2@imap.test>', html: 'The cursor is frozen.' }) },
    ],
  });
  await mock1.ready;
  await new Promise((r) => setTimeout(r, 50));
  const port1 = mock1.server.address().port;

  const svc1 = createImapMailService({ logger: quiet, config: imapConfigFor(port1) });
  const summary1 = await svc1.pollUnread();
  eq('C1 two unseen messages fetched', summary1.fetched, 2);
  eq('C2 both became tickets', summary1.created, 2);
  eq('C3 nothing failed', summary1.failed, 0);
  const tickets = await prisma.ticket.findMany({ orderBy: { id: 'asc' } });
  eq('C4 tickets stored with the RFC identity',
    tickets.map((t) => t.internetMessageId).sort().join(','), 'm1@imap.test,m2@imap.test');
  check('C5 requester identification kept (name + email)',
    tickets.some((t) => t.requesterEmail === 'rita@imap.test' && t.requesterName === 'Rita Requester'));
  check('C6 HTML-only mail became readable ticket text', tickets.some((t) => t.body.includes('cursor is frozen')));
  check('C7 processed messages were marked seen', JSON.stringify(mock1.state.seenUids) === JSON.stringify([1, 2]));
  const audit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityLabel: tickets[0].ticketNumber } });
  const auditMeta = audit ? (typeof audit.metadata === 'string' ? JSON.parse(audit.metadata) : audit.metadata) : null;
  eq('C8 audit metadata names the imap channel', auditMeta ? auditMeta.channel : undefined, 'imap');

  // C9: polling the same mailbox again (messages now seen) fetches nothing.
  const summaryAgain = await svc1.pollUnread();
  eq('C9 re-poll of a seen mailbox fetches nothing', summaryAgain.fetched, 0);

  // C10-C12: duplicate protection when \Seen marking failed earlier — the
  // message is re-fetched, but the unique identity collapses it to a duplicate.
  const mock2 = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: 'Rita Requester <rita@imap.test>', subject: 'VPN drops every hour', messageId: '<m1@imap.test>', text: 'The VPN client disconnects on its own.' }) },
    ],
    failStoreFor: 1,
  });
  await mock2.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svc2 = createImapMailService({ logger: quiet, config: imapConfigFor(mock2.server.address().port) });
  const summary2 = await svc2.pollUnread();
  eq('C10 the replay is a duplicate, not a second ticket', summary2.duplicate, 1);
  eq('C11 no ticket was created', summary2.created, 0);
  eq('C12 still exactly one VPN ticket in the database',
    await prisma.ticket.count({ where: { internetMessageId: 'm1@imap.test' } }), 1);

  // C13-C15: threading — a reply with In-Reply-To rides the existing ticket;
  // a reply on a RESOLVED ticket reopens it.
  const vpnTicket = await prisma.ticket.findFirst({ where: { internetMessageId: 'm1@imap.test' } });
  const mock3 = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: 'rita@imap.test', subject: 'Re: VPN drops every hour', messageId: '<m3@imap.test>', inReplyTo: '<m1@imap.test>', references: '<m1@imap.test>', text: 'It happened again just now.' }) },
    ],
  });
  await mock3.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svc3 = createImapMailService({ logger: quiet, config: imapConfigFor(mock3.server.address().port) });
  const summary3 = await svc3.pollUnread();
  eq('C13 reply threaded onto the existing ticket', summary3.comment_added, 1);
  const comments = await prisma.comment.findMany({ where: { ticketId: vpnTicket.id, isRequester: true } });
  eq('C14 exactly one requester comment exists', comments.length, 1);
  eq('C15 the comment carries the RFC identity', comments[0].internetMessageId, 'm3@imap.test');

  await prisma.ticket.update({
    where: { id: vpnTicket.id },
    data: { state: 'RESOLVED', resolvedAt: new Date(), resolution: 'Reinstalled the client.' },
  });
  const mock4 = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: 'rita@imap.test', subject: 'Re: VPN drops every hour', messageId: '<m4@imap.test>', inReplyTo: '<m1@imap.test>', text: 'Still broken.' }) },
    ],
  });
  await mock4.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svc4 = createImapMailService({ logger: quiet, config: imapConfigFor(mock4.server.address().port) });
  const summary4 = await svc4.pollUnread();
  eq('C16 reply on a resolved ticket reopens it', summary4.reopened, 1);
  eq('C17 ticket is IN_PROGRESS again', (await prisma.ticket.findUnique({ where: { id: vpnTicket.id } })).state, 'IN_PROGRESS');

  // C18-C20: self-addressed exclusion and malformed mail never stop the batch.
  const mock5 = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: `IT Helpdesk <${IMAP_USER}>`, subject: 'Your ticket was resolved', messageId: '<outbound-1@imap.test>', text: 'Automated helpdesk notification.' }) },
      { uid: 2, raw: Buffer.from([0x00, 0xff, 0x13, 0x7f, 0x99, 0x03]) },
      { uid: 3, raw: rawMessage({ from: 'rita@imap.test', subject: 'Laptop battery swelling', messageId: '<m5@imap.test>', text: 'The battery is bulging.' }) },
    ],
  });
  await mock5.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svc5 = createImapMailService({ logger: quiet, config: imapConfigFor(mock5.server.address().port) });
  const summary5 = await svc5.pollUnread();
  eq('C18 internal outbound mail is skipped, never ticketed', summary5.skipped_self, 1);
  eq('C19 malformed mail is rejected without killing the batch', summary5.rejected, 1);
  eq('C20 the healthy message after them still became a ticket', summary5.created, 1);
  eq('C21 no ticket for the outbound notification',
    await prisma.ticket.count({ where: { internetMessageId: 'outbound-1@imap.test' } }), 0);
  eq('C22 all three messages ended marked seen',
    JSON.stringify([...mock5.state.seenUids].sort()), JSON.stringify([1, 2, 3]));
  mock1.server.close(); mock2.server.close(); mock3.server.close(); mock4.server.close(); mock5.server.close();
  void agent;

  /* ---- D. failure containment -------------------------------------------- */
  console.log('\n--- D. failures ---');
  const mockAuth = createMockImapServer({ rejectAuth: true });
  await mockAuth.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svcAuth = createImapMailService({ logger: quiet, config: imapConfigFor(mockAuth.server.address().port) });
  let authFailed = false;
  try { await svcAuth.pollUnread(); } catch (err) {
    // imapflow flags rejected logins with authenticationFailed; the mock's
    // [AUTHENTICATIONFAILED] code is the server-side counterpart.
    authFailed = err.authenticationFailed === true || /auth/i.test(String(err.responseText || '')) || /auth/i.test(err.message);
  }
  check('D1 authentication failure surfaces as a clean error', authFailed);
  eq('D2 the mock saw exactly one failed login', mockAuth.state.authFailures, 1);
  mockAuth.server.close();

  const closedPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const svcDead = createImapMailService({ logger: quiet, config: imapConfigFor(closedPort) });
  let connectFailed = false;
  try { await svcDead.pollUnread(); } catch { connectFailed = true; }
  check('D3 connection failure surfaces as a clean error, no crash', connectFailed);

  // After both failures, a healthy poll still works (the timer keeps retrying).
  const mockHealthy = createMockImapServer({
    messages: [
      { uid: 1, raw: rawMessage({ from: 'rita@imap.test', subject: 'Monitor flickers', messageId: '<m6@imap.test>', text: 'Screen flickers on HDMI.' }) },
    ],
  });
  await mockHealthy.ready;
  await new Promise((r) => setTimeout(r, 50));
  const svcHealthy = createImapMailService({ logger: quiet, config: imapConfigFor(mockHealthy.server.address().port) });
  eq('D4 polling recovers after failures', (await svcHealthy.pollUnread()).created, 1);
  mockHealthy.server.close();

  /* ---- E. scheduler wiring ------------------------------------------------- */
  console.log('\n--- E. scheduler wiring ---');
  const imapPoller = require('../src/imap/poller');
  const startedOff = imapPoller.startImapPoller({ config: imapConfigFor(1, { enabled: false }) });
  eq('E1 poller is a no-op when IMAP is not configured', startedOff, false);
  const zeroTimer = imapPoller.startImapPoller({ config: imapConfigFor(1, { pollIntervalMs: 0 }) });
  eq('E2 poller is a no-op with the timer disabled', zeroTimer, false);
  imapPoller.stopImapPoller();
  eq('E3 stop clears the running flag', imapStatus.snapshot().pollingRunning, false);
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
