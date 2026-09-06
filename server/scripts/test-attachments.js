const { spawn } = require('child_process');
/* Attachment handling and object storage.

   Parts:
     A. display-filename sanitization + server-side storage keys (pure)
     B. storage providers: memory + private local directory (roundtrip,
        missing objects, path containment)
     C. the persistence service: limits (size / count / total), rejection
        reasons, dedupe guard, upload-failure contract
     D. IMAP flow through intake: ticket + comment attachments, duplicate
        replay idempotency, storage failure + retry
     E. Graph flow: content fetch, per-attachment failure containment,
        oversized rejection
     F. live API: authorized download, unauthorized access, MIME-type
        spoofing served inert, cross-ticket access, missing storage object,
        zero attachments, and no storage keys or credentials in any response

   Usage: npm run test:attachments  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4222';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';
// The spawned server and this suite share an isolated storage directory.
// os.tmpdir keeps it out of the repository entirely.
const os = require('os');
const path = require('path');
const STORAGE_DIR = path.join(os.tmpdir(), `ticketing-att-test-${Date.now()}`);
process.env.ATTACHMENT_STORAGE_DIR = STORAGE_DIR;

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('attachments');

const fs = require('fs');
const bcrypt = require('bcryptjs');
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

const PASSWORD = 'AttachSuite!123';
const DOMAIN = 'attach.test';
const QUIET = { log() {}, error() {}, warn() {} };
const BUF = (s) => Buffer.from(s, 'utf8');

async function req(base, pathname, { method = 'GET', token, raw = false } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (raw) return { status: res.status, headers: res.headers, body: res };
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function quietMailer() {
  const { createMailer } = require('../src/mailer');
  return createMailer({
    logger: QUIET,
    transport: { hasBroadcastTarget: () => false, async sendMail() {}, async sendBroadcastMail() {} },
  });
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  /* ---- A. filename sanitization + storage keys --------------------------- */
  console.log('\n--- A. filenames and keys ---');
  const { sanitizeFilename, generateStorageKey } = require('../src/services/attachmentStorage');

  eq('A1 traversal collapses to the last segment', sanitizeFilename('../../etc/passwd'), 'passwd');
  eq('A2 windows traversal collapses too', sanitizeFilename('..\\..\\win32\\evil.exe'), 'evil.exe');
  eq('A3 control characters are stripped', sanitizeFilename('re\x00port\x1f.pdf'), 'report.pdf');
  eq('A4 reserved device names are prefixed', sanitizeFilename('CON'), '_CON');
  eq('A5 empty names fall back safely', sanitizeFilename(''), 'attachment.bin');
  eq('A6 null falls back safely', sanitizeFilename(null), 'attachment.bin');
  const long = `${'a'.repeat(260)}.pdf`;
  check('A7 oversized names are bounded and keep the extension',
    sanitizeFilename(long).length <= 200 && sanitizeFilename(long).endsWith('.pdf'));
  const k1 = generateStorageKey();
  const k2 = generateStorageKey();
  check('A8 keys are unique', k1 !== k2);
  check('A9 keys carry no user input', k1.startsWith('att/') && !k1.includes('.pdf') && !k1.includes('..'));

  /* ---- B. storage providers ---------------------------------------------- */
  console.log('\n--- B. storage providers ---');
  const { createMemoryStorage, createLocalStorage, createAttachmentStorage } = require('../src/services/attachmentStorage');

  const mem = createMemoryStorage();
  await mem.put('att/x/1', BUF('hello attachment'));
  eq('B1 memory roundtrip', (await mem.get('att/x/1')).toString(), 'hello attachment');
  let memMissing = false;
  try { await mem.get('att/x/missing'); } catch (err) { memMissing = err.code === 'NOT_FOUND'; }
  check('B2 memory missing object is a clean NOT_FOUND', memMissing);

  const localDir = path.join(os.tmpdir(), `ticketing-att-local-${Date.now()}`);
  const local = createLocalStorage({ rootDir: localDir });
  await local.put('att/2026/09/abc', BUF('local bytes'));
  eq('B3 local roundtrip', (await local.get('att/2026/09/abc')).toString(), 'local bytes');
  check('B4 local objects stay inside the private root',
    fs.existsSync(path.join(localDir, 'att/2026/09/abc')));
  let localMissing = false;
  try { await local.get('att/2026/09/nope'); } catch (err) { localMissing = err.code === 'NOT_FOUND'; }
  check('B5 local missing object is a clean NOT_FOUND', localMissing);
  let escaped = false;
  try { await local.get('../../../outside'); } catch (err) { escaped = err.code === 'NOT_FOUND'; }
  check('B6 a crafted escaping key never reads outside the root', escaped);

  // The factory: injectable storage wins; env/var default builds local.
  const injected = createAttachmentStorage({ storage: mem });
  eq('B7 an injected provider is used verbatim', injected.kind, 'memory');
  const envLocal = createAttachmentStorage({ rootDir: localDir });
  eq('B8 the default provider is the private local one', envLocal.kind, 'local');

  /* ---- shared seed -------------------------------------------------------- */
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  await prisma.agent.create({
    data: {
      name: 'Attach Admin', email: `admin@${DOMAIN}`, role: 'admin',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
  const mailer = quietMailer();
  const { intakeEmailMessage } = require('../src/services/ticketIntake');

  /* ---- C. persistence service --------------------------------------------- */
  console.log('\n--- C. persistence service ---');
  const {
    prepareForStorage, uploadAll, createRows, deleteUploaded, LIMITS,
  } = require('../src/services/attachmentService');

  const plan = prepareForStorage([
    { filename: 'report.pdf', contentType: 'application/pdf', content: BUF('a'.repeat(1000)) },
    { filename: '../../evil.exe', contentType: 'application/x-msdownload', content: BUF('mal') },
    { filename: 'empty.txt', content: Buffer.alloc(0) },
    { filename: 'no-content.bin', size: 500 },
  ]);
  eq('C1 valid attachments are accepted (traversal names defused, not dropped)', plan.accepted.length, 2);
  eq('C2 the display names are sanitized in the plan',
    plan.accepted.map((a) => a.filename).sort().join(','), 'evil.exe,report.pdf');
  eq('C3 empty-content attachments are rejected', plan.rejected.some((r) => r.filename === 'empty.txt'), true);
  eq('C4 content-less metadata is rejected', plan.rejected.some((r) => r.filename === 'no-content.bin'), true);
  check('C5 every accepted plan entry carries a server-generated key',
    plan.accepted.every((a) => a.storageKey.startsWith('att/'))
    && plan.accepted.every((a) => !a.storageKey.includes('report') && !a.storageKey.includes('evil')));
  eq('C6 stored size comes from the actual bytes', plan.accepted.find((a) => a.filename === 'report.pdf').size, 1000);

  const tiny = { ...LIMITS, maxBytes: 10, maxPerMessage: 2, maxTotalBytes: 15 };
  const limited = prepareForStorage([
    { filename: 'big.bin', content: BUF('12345678901') },
    { filename: 'one.bin', content: BUF('12345') },
    { filename: 'two.bin', content: BUF('67890') },
    { filename: 'over-total.bin', content: BUF('12345') },
    { filename: 'over-count.bin', content: BUF('1') },
  ], { limits: tiny });
  eq('C7 the oversized attachment is rejected with a reason', limited.rejected[0].reason.includes('limit'), true);
  eq('C8 the count cap rejects the fifth attachment', limited.rejected.some((r) => r.filename === 'over-count.bin'), true);
  eq('C9 the total cap rejects the fourth attachment', limited.rejected.some((r) => r.filename === 'over-total.bin'), true);
  eq('C10 exactly the in-limit attachments are accepted', limited.accepted.map((a) => a.filename).join(','), 'one.bin,two.bin');

  const ticketC = await prisma.ticket.create({
    data: {
      ticketNumber: 'TK-ATT-C', shortDescription: 'Attachment persistence probe', body: 'probe',
      requesterEmail: `requester@${DOMAIN}`, source: 'email', teamId: defaultTeam.id,
    },
  });
  const accepted = prepareForStorage([
    { filename: 'dup.bin', contentType: 'application/pdf', content: BUF('same') },
  ]).accepted;
  await uploadAll(accepted, mem);
  const rows1 = await createRows(accepted, { ticketId: ticketC.id, messageId: 'msg-c1', source: 'imap' }, prisma);
  eq('C11 rows are created with the source identity', rows1.length === 1 && rows1[0].source === 'imap' && rows1[0].messageId === 'msg-c1', true);
  eq('C12 the row stores metadata + key only', rows1[0].storageKey.startsWith('att/'), true);
  const rows2 = await createRows(accepted, { ticketId: ticketC.id, messageId: 'msg-c1', source: 'imap' }, prisma);
  eq('C13 replaying the persistence step creates no duplicates', rows2.length, 0);
  eq('C14 still exactly one attachment row', await prisma.attachment.count({ where: { ticketId: ticketC.id } }), 1);

  const failingStorage = {
    kind: 'failing',
    async put() { throw new Error('bucket unavailable'); },
    async get() { throw new Error('bucket unavailable'); },
    async delete() {},
  };
  let uploadFailed = false;
  try { await uploadAll(accepted, failingStorage); } catch { uploadFailed = true; }
  check('C15 a storage failure surfaces as an error, never silent success', uploadFailed);

  /* ---- D. IMAP flow through intake ---------------------------------------- */
  console.log('\n--- D. IMAP flow ---');
  // The D-part flow uses the SAME private local directory the spawned
  // server reads from, so the F-part downloads exercise the real path.
  const imapStorage = createLocalStorage({ rootDir: STORAGE_DIR });
  const created = await intakeEmailMessage({
    messageId: 'att-imap-1@attach.test',
    subject: 'Logs attached',
    body: 'Please find the logs.',
    from: 'rita@attach.test',
  }, {
    logger: QUIET, mailer, channel: 'imap', storage: imapStorage,
    attachments: [
      { filename: 'app.log', contentType: 'text/plain', content: BUF('log line 1\nlog line 2') },
      { filename: 'trace.zip', contentType: 'application/zip', content: BUF('PK\x03\x04data') },
    ],
  });
  eq('D1 the ticket is created', created.status, 'created');
  eq('D2 both attachments are persisted', await prisma.attachment.count({ where: { ticketId: created.ticket.id } }), 2);
  const dRow = await prisma.attachment.findFirst({ where: { ticketId: created.ticket.id, filename: 'app.log' } });
  eq('D3 the stored object roundtrips', (await imapStorage.get(dRow.storageKey)).toString().includes('log line 2'), true);
  eq('D4 rows reference the ticket (commentId null on creation)', dRow.commentId, null);
  check('D5 the stored objects exist in the private directory',
    fs.existsSync(path.join(STORAGE_DIR, dRow.storageKey)));
  const createdAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: created.ticket.id } });
  const dMeta = typeof createdAudit.metadata === 'string' ? JSON.parse(createdAudit.metadata) : createdAudit.metadata;
  eq('D6 the audit trail records only the attachment COUNT', dMeta.attachments, 2);
  check('D7 no storage key ever reaches the audit trail', !JSON.stringify(createdAudit.metadata).includes('att/'));

  const replay = await intakeEmailMessage({
    messageId: 'att-imap-1@attach.test',
    subject: 'Logs attached', body: 'Please find the logs.', from: 'rita@attach.test',
  }, { logger: QUIET, mailer, channel: 'imap', storage: imapStorage });
  eq('D8 the replayed email is a duplicate', replay.status, 'duplicate');
  eq('D9 no duplicate attachment rows', await prisma.attachment.count({ where: { ticketId: created.ticket.id } }), 2);
  eq('D10 no duplicate attachment rows', await prisma.attachment.count({ where: { ticketId: created.ticket.id } }), 2);

  // D11-D13: a storage failure must not leave ticket or attachment state behind.
  const failing = {
    kind: 'failing',
    async put() { throw new Error('object storage down'); },
    async get() { throw new Error('object storage down'); },
    async delete() {},
  };
  let storageFailureSurfaced = false;
  try {
    await intakeEmailMessage({
      messageId: 'att-imap-fail@attach.test',
      subject: 'Will fail', body: 'x', from: 'rita@attach.test',
    }, { logger: QUIET, mailer, channel: 'imap', storage: failing, attachments: [{ filename: 'a.bin', content: BUF('x') }] });
  } catch (err) {
    storageFailureSurfaced = /object storage down/.test(err.message);
  }
  check('D11 the storage failure propagates (message stays unseen for retry)', storageFailureSurfaced);
  eq('D12 no ticket was created by the failed attempt',
    await prisma.ticket.count({ where: { graphMessageId: 'att-imap-fail@attach.test' } }), 0);
  eq('D13 no attachment rows exist for it',
    await prisma.attachment.count({ where: { messageId: 'att-imap-fail@attach.test' } }), 0);

  // D14: after recovery, the retry creates everything exactly once.
  const retried = await intakeEmailMessage({
    messageId: 'att-imap-fail@attach.test',
    subject: 'Will fail', body: 'x', from: 'rita@attach.test',
  }, { logger: QUIET, mailer, channel: 'imap', storage: imapStorage, attachments: [{ filename: 'a.bin', content: BUF('x') }] });
  eq('D14 the retry succeeds with its attachment', await prisma.attachment.count({ where: { ticketId: retried.ticket.id } }), 1);

  // D15: a requester reply carries attachments onto the comment.
  const reply = await intakeEmailMessage({
    messageId: 'att-imap-reply@attach.test',
    subject: `Re: ${created.ticket.ticketNumber} Logs attached`,
    body: 'Here is the missing file.',
    from: 'rita@attach.test',
  }, {
    logger: QUIET, mailer, channel: 'imap', storage: imapStorage,
    attachments: [{ filename: 'missing.cfg', contentType: 'text/plain', content: BUF('key=value') }],
  });
  eq('D15 the reply is appended', reply.status, 'comment_added');
  const replyRow = await prisma.attachment.findFirst({ where: { messageId: 'att-imap-reply@attach.test' } });
  check('D16 the attachment is bound to the comment', replyRow.commentId === reply.comment.id);
  eq('D17 the ticket binding is intact too', replyRow.ticketId, created.ticket.id);

  /* ---- E. Graph flow -------------------------------------------------------- */
  console.log('\n--- E. Graph flow ---');
  const { createMailService } = require('../src/graph/mailService');
  const graphStorage = createMemoryStorage();
  const content = { 'g-att-1': BUF('graph bytes one'), 'g-att-2': BUF('graph bytes two') };
  let failContentFor = null;
  const graphOps = {
    async listAttachments() {
      return [
        { id: 'g-att-1', name: 'chart.xlsx', contentType: 'application/vnd.ms-excel', size: 15, isInline: false },
        { id: 'g-att-2', name: 'notes.txt', contentType: 'text/plain', size: 15, isInline: false },
        { id: 'g-att-3', name: 'huge.zip', contentType: 'application/zip', size: LIMITS.maxBytes + 100, isInline: false },
      ];
    },
    async getAttachmentContent(messageId, attachmentId) {
      if (failContentFor === attachmentId) throw new Error('content unavailable');
      const buf = content[attachmentId];
      if (!buf) { const e = new Error('no inline content'); e.code = 'CONTENT_UNAVAILABLE'; throw e; }
      return buf;
    },
    async markAsRead() {},
  };
  const graphSvc = createMailService({ logger: QUIET, ops: graphOps, storage: graphStorage });
  const graphMsgId = 'graph-att-1';
  const graphStatus = await graphSvc.processOne({
    id: graphMsgId,
    internetMessageId: `<${graphMsgId}@attach.test>`,
    conversationId: 'conv-att',
    subject: 'Spreadsheet attached',
    from: { emailAddress: { name: 'Gina', address: 'gina@attach.test' } },
    body: { contentType: 'text', content: 'See the spreadsheet.' },
    hasAttachments: true,
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  }, { source: 'poller' });
  eq('E1 the Graph email creates its ticket', graphStatus, 'created');
  const graphTicket = await prisma.ticket.findUnique({ where: { graphMessageId: graphMsgId } });
  eq('E2 fetchable attachments are persisted', await prisma.attachment.count({ where: { ticketId: graphTicket.id } }), 2);
  const graphRow = await prisma.attachment.findFirst({ where: { ticketId: graphTicket.id, filename: 'chart.xlsx' } });
  eq('E3 Graph content roundtrips through storage', (await graphStorage.get(graphRow.storageKey)).toString(), 'graph bytes one');
  eq('E4 rows carry the graph source', graphRow.source, 'graph');
  const hugeRow = await prisma.attachment.findFirst({ where: { ticketId: graphTicket.id, filename: 'huge.zip' } });
  eq('E5 the oversized attachment is safely rejected, not stored', hugeRow, null);

  // E6: one attachment's content failing mid-flight must not sink the ticket.
  const graphOpsFail = { ...graphOps, async listAttachments() { return [{ id: 'g-att-x', name: 'broken.bin', contentType: 'application/octet-stream', size: 4, isInline: false }]; } };
  const graphSvcFail = createMailService({ logger: QUIET, ops: graphOpsFail, storage: graphStorage });
  failContentFor = 'g-att-x';
  const partialStatus = await graphSvcFail.processOne({
    id: 'graph-att-2',
    internetMessageId: '<graph-att-2@attach.test>',
    subject: 'Broken attachment',
    from: { emailAddress: { address: 'gina@attach.test' } },
    body: { contentType: 'text', content: 'attachment broken' },
    hasAttachments: true,
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  }, { source: 'poller' });
  eq('E6 a content-fetch failure still processes the message', partialStatus, 'created');
  eq('E7 the broken attachment left no row',
    await prisma.attachment.count({ where: { messageId: 'graph-att-2@attach.test' } }), 0);

  /* ---- F. live API ------------------------------------------------------------ */
  console.log('\n--- F. live API ---');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  const BASE = `http://localhost:${process.env.PORT}`;
  try {
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const login = await req(BASE, '/api/auth/login', { method: 'POST', token: undefined, body: undefined });
    void login;
    const adminLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `admin@${DOMAIN}`, password: PASSWORD }),
    });
    const admin = (await adminLogin.json()).token;

    // F1: the ticket detail carries attachment metadata, never storage keys.
    const detail = await req(BASE, `/api/tickets/${created.ticket.id}`, { token: admin });
    eq('F1 the detail response lists the attachments (2 from creation + 1 from the reply)',
      (detail.data.attachments || []).length, 3);
    const detailJson = JSON.stringify(detail.data);
    check('F2 no storage key appears in the response', !detailJson.includes('att/'));
    check('F3 no message identity leak beyond what tickets already carry', !detailJson.includes('storageKey'));

    // F4: authorized download works and is served inert.
    const appLog = (detail.data.attachments || []).find((a) => a.filename === 'app.log');
    const down = await fetch(`${BASE}/api/tickets/${created.ticket.id}/attachments/${appLog.id}`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    eq('F4 the authorized download succeeds', down.status, 200);
    eq('F5 content is always an inert octet-stream (MIME spoofing dead)',
      down.headers.get('content-type'), 'application/octet-stream');
    check('F6 the disposition forces a download with the sanitized name',
      (down.headers.get('content-disposition') || '').includes('attachment;')
      && (down.headers.get('content-disposition') || '').includes('app.log'));
    eq('F7 nosniff is set', down.headers.get('x-content-type-options'), 'nosniff');
    eq('F8 the bytes are the stored ones', (await down.text()).includes('log line 2'), true);

    // F9: no token, no attachment.
    eq('F9 unauthenticated download is 401', (await fetch(`${BASE}/api/tickets/${created.ticket.id}/attachments/${appLog.id}`)).status, 401);

    // F10: an attachment id from another ticket is not downloadable via this one.
    eq('F10 cross-ticket attachment access is 404',
      (await req(BASE, `/api/tickets/${graphTicket.id}/attachments/${appLog.id}`, { token: admin })).status, 404);
    eq('F11 an unknown attachment id is 404',
      (await req(BASE, `/api/tickets/${created.ticket.id}/attachments/999999`, { token: admin })).status, 404);

    // F12: a deleted storage object is reported honestly.
    const storedKey = dRow.storageKey;
    const onDisk = path.join(STORAGE_DIR, storedKey);
    fs.rmSync(onDisk, { force: true });
    const gone = await fetch(`${BASE}/api/tickets/${created.ticket.id}/attachments/${appLog.id}`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    eq('F12 a missing storage object is a clean 404', gone.status, 404);
    const goneBody = await gone.json().catch(() => ({}));
    check('F13 the error says the content is gone — and nothing more',
      (goneBody.error || '').includes('no longer available') && !JSON.stringify(goneBody).includes(storedKey));

    // F14: zero attachments → empty list, and the health endpoint carries
    // no storage configuration at all.
    const plainTicket = await prisma.ticket.create({
      data: {
        ticketNumber: 'TK-ATT-ZERO', shortDescription: 'No attachments', body: 'plain',
        requesterEmail: `requester@${DOMAIN}`, source: 'portal',
      },
    });
    const plainDetail = await req(BASE, `/api/tickets/${plainTicket.id}`, { token: admin });
    eq('F14 a ticket without attachments reports an empty list', (plainDetail.data.attachments || []).length, 0);
    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('F15 the health endpoint exposes no storage configuration',
      !JSON.stringify(health).includes(STORAGE_DIR) && !JSON.stringify(health).includes('attachment'));
  } finally {
    server.kill();
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
    // Clean the temp storage tree the suite created.
    try { fs.rmSync(STORAGE_DIR, { recursive: true, force: true }); } catch {}
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
