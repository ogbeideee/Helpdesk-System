const { spawn } = require('child_process');
/* Attachment handling and object storage.

   Parts:
     A. display-filename sanitization + server-side storage keys (pure)
     B. storage providers: memory + private local directory (roundtrip,
        missing objects, path containment)
     C. the persistence service: limits (size / count / total), rejection
        reasons, dedupe guard, upload-failure contract
     D. IMAP flow through intake: ticket + comment attachments, duplicate
        replay idempotency, and a cache-write failure that still keeps the
        ticket (the bytes are a cache; the source message is the record)
     E. Graph flow: content fetch, per-attachment failure containment,
        oversized rejection
     F. live API: authorized download, unauthorized access, MIME-type
        spoofing served inert, the inline allowlist (an image renders, an SVG
        never does), cross-ticket access, missing storage object, zero
        attachments, and no storage keys or credentials in any response
     G. the cache miss path: strict name+size matching, "unavailable" for
        every way the source can fail, the preview allowlist, and eviction
     H. the IMAP re-read (the live path): search by Message-ID, read-only
        (nothing is marked seen), and an answer of nothing for every reason it
        cannot answer

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

  /* ---- C16+. inline (signature) images are never stored -------------------- */
  const { isInlineImage, skipInlineImages } = require('../src/services/attachmentService');
  const inlinePlan = prepareForStorage([
    // Outlook/Exchange signature logo: a related part, Content-Disposition inline.
    { filename: 'image001.png', contentType: 'image/png', size: 4942, content: BUF('png-bytes'), isInline: true },
    // The same part as Graph reports it (isInline, no disposition field).
    { filename: 'image002.png', contentType: 'image/jpeg', content: BUF('jpeg-bytes'), isInline: true },
    // A social-footer icon the adapter flagged by disposition alone.
    { filename: 'icon.png', contentType: 'image/png', content: BUF('icon'), contentDisposition: 'inline' },
    // Real work: a file the sender actually attached.
    { filename: 'app.log', contentType: 'text/plain', content: BUF('log line') },
    // An image the sender ATTACHED (not inline) is still stored.
    { filename: 'screenshot.png', contentType: 'image/png', content: BUF('screenshot'), contentDisposition: 'attachment' },
  ]);
  eq('C16 only the real attachments are accepted',
    inlinePlan.accepted.map((a) => a.filename).join(','), 'app.log,screenshot.png');
  eq('C17 the three decorative images are skipped, not rejected',
    inlinePlan.skipped.map((s) => s.filename).join(','), 'image001.png,image002.png,icon.png');
  check('C18 every skip carries the inline_image code and a reason',
    inlinePlan.skipped.every((s) => s.code === 'inline_image' && /inline image/.test(s.reason)));
  eq('C19 skipped parts never reach the size/count/rejection buckets', inlinePlan.rejected.length, 0);
  check('C20 the rule is narrow: images only, inline only',
    isInlineImage({ contentType: 'image/png', isInline: true }) === true
    && isInlineImage({ contentType: 'text/calendar', isInline: true }) === false
    && isInlineImage({ contentType: 'image/png', isInline: false }) === false
    && isInlineImage({ contentType: 'image/png', contentDisposition: 'attachment' }) === false);
  const optedIn = prepareForStorage([
    { filename: 'image001.png', contentType: 'image/png', content: BUF('png-bytes'), isInline: true },
  ], { skipInlineImages: false });
  eq('C21 the policy can be turned off (previous behaviour)', optedIn.accepted.length, 1);
  eq('C22 the env default is to skip', skipInlineImages(), true);

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

  // D11-D14: a CACHE write failure must never cost the ticket.
  //
  // The bytes are a cache and the source message is the record (see
  // attachmentFetchService.js), so a cache that cannot be written to degrades
  // to metadata-only: the ticket — and the attachment row — are created, and
  // the first view re-reads the source message (section G). This deliberately
  // replaces the old contract, where a storage failure threw before any row
  // existed and the message stayed unseen for a retry: losing a real request
  // because a disk filled up is the wrong way round.
  const failing = {
    kind: 'failing',
    async put() { throw new Error('object storage down'); },
    async get() { throw new Error('object storage down'); },
    async delete() {},
  };
  const cacheDown = await intakeEmailMessage({
    messageId: 'att-imap-fail@attach.test',
    subject: 'Cache down', body: 'x', from: 'rita@attach.test',
  }, { logger: QUIET, mailer, channel: 'imap', storage: failing, attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', content: BUF('x') }] });
  eq('D11 the ticket is created even though the cache refused the bytes', cacheDown.status, 'created');
  const cacheDownRow = await prisma.attachment.findFirst({ where: { messageId: 'att-imap-fail@attach.test' } });
  check('D12 the attachment row survives as metadata (name and size intact)',
    Boolean(cacheDownRow) && cacheDownRow.filename === 'a.bin' && cacheDownRow.size === 1);
  check('D13 no byte was cached for it',
    Boolean(cacheDownRow) && !fs.existsSync(path.join(STORAGE_DIR, cacheDownRow.storageKey)));
  const cacheDownReplay = await intakeEmailMessage({
    messageId: 'att-imap-fail@attach.test',
    subject: 'Cache down', body: 'x', from: 'rita@attach.test',
  }, { logger: QUIET, mailer, channel: 'imap', storage: imapStorage });
  eq('D14 the replay is still a duplicate — dedupe rides identity, not storage',
    cacheDownReplay.status, 'duplicate');

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

  // D18: a message carrying a signature logo (inline, related) plus a real
  // attachment stores only the real one — end to end through intake.
  const withSignature = await intakeEmailMessage({
    messageId: 'att-imap-sig@attach.test',
    subject: 'Signature image probe',
    body: 'Here is the log.',
    from: 'rita@attach.test',
  }, {
    logger: QUIET, mailer, channel: 'imap', storage: imapStorage,
    attachments: [
      { filename: 'image001.png', contentType: 'image/png', content: BUF('logo'), isInline: true },
      { filename: 'image002.png', contentType: 'image/png', content: BUF('icon'), isInline: true },
      { filename: 'diagnostics.log', contentType: 'text/plain', content: BUF('only real file') },
    ],
  });
  eq('D18 the ticket is created', withSignature.status, 'created');
  const sigRows = await prisma.attachment.findMany({ where: { ticketId: withSignature.ticket.id } });
  eq('D19 only the real attachment has a row', sigRows.map((r) => r.filename).join(','), 'diagnostics.log');
  eq('D20 nothing was uploaded for the signature images',
    (await prisma.attachment.count({ where: { messageId: 'att-imap-sig@attach.test' } })), 1);
  const sigAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: withSignature.ticket.id } });
  const sigMeta = typeof sigAudit.metadata === 'string' ? JSON.parse(sigAudit.metadata) : sigAudit.metadata;
  eq('D21 the audit trail counts the stored attachments', sigMeta.attachments, 1);
  eq('D22 and records how many inline images were skipped', sigMeta.inlineImagesSkipped, 2);
  check('D23 no skip detail (name or key) reaches the audit trail',
    !JSON.stringify(sigAudit.metadata).includes('image001') && !JSON.stringify(sigAudit.metadata).includes('att/'));

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

    // F8a-F8f: the inline policy is a server-side ALLOWLIST.
    //
    // An image on the allowlist is served with its real type and an inline
    // disposition so the ticket screen can render it; everything else — SVG
    // and HTML included — stays an inert octet-stream download even though a
    // browser could be talked into rendering those. `nosniff` is always set,
    // and the payload's own `previewable` flag is what the client follows, so
    // the client never owns a copy of this rule.
    const pngRow = await prisma.attachment.create({
      data: {
        ticketId: created.ticket.id, filename: 'screenshot.png', mimeType: 'image/png',
        size: 3, messageId: 'att-imap-1@attach.test', source: 'imap',
        storageKey: generateStorageKey(),
      },
    });
    await imapStorage.put(pngRow.storageKey, Buffer.from([0x89, 0x50, 0x4e]));
    const svgRow = await prisma.attachment.create({
      data: {
        ticketId: created.ticket.id, filename: 'logo.svg', mimeType: 'image/svg+xml',
        size: 5, messageId: 'att-imap-1@attach.test', source: 'imap',
        storageKey: generateStorageKey(),
      },
    });
    await imapStorage.put(svgRow.storageKey, BUF('<svg>'));

    const pngDown = await fetch(`${BASE}/api/tickets/${created.ticket.id}/attachments/${pngRow.id}`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    eq('F8a an allowlisted image keeps its real content type', pngDown.headers.get('content-type'), 'image/png');
    check('F8b ...and is inline, so the ticket screen may render it',
      (pngDown.headers.get('content-disposition') || '').startsWith('inline;'));
    eq('F8c nosniff still guards it', pngDown.headers.get('x-content-type-options'), 'nosniff');
    const svgDown = await fetch(`${BASE}/api/tickets/${created.ticket.id}/attachments/${svgRow.id}`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    eq('F8d an SVG is NOT previewable (script-carrying format)',
      svgDown.headers.get('content-type'), 'application/octet-stream');
    check('F8e ...and stays a forced download',
      (svgDown.headers.get('content-disposition') || '').startsWith('attachment;'));
    const withImages = await req(BASE, `/api/tickets/${created.ticket.id}`, { token: admin });
    eq('F8f the payload marks the png previewable',
      (withImages.data.attachments || []).find((a) => a.id === pngRow.id)?.previewable, true);
    eq('F8g ...and the SVG not previewable',
      (withImages.data.attachments || []).find((a) => a.id === svgRow.id)?.previewable, false);

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

  /* ---- G. cache miss: re-read the source message ------------------------------- */
  console.log('\n--- G. cache miss, matching and eviction ---');
  const {
    readAttachmentContent,
    matchSourcePart,
    isPreviewableImage,
    PREVIEW_IMAGE_TYPES,
  } = require('../src/services/attachmentFetchService');
  const {
    sweepAttachmentCache,
    resolveAttachmentRootDir,
  } = require('../src/services/attachmentStorage');
  const { runAttachmentCacheSweep } = require('../src/attachmentCacheSweeper');

  const row = {
    filename: 'shot.png', mimeType: 'image/png', size: 4,
    storageKey: 'att/2026/10/g1', source: 'imap', messageId: 'g1@attach.test',
  };
  const sourceParts = [{ filename: 'shot.png', contentType: 'image/png', size: 4, content: BUF('PNG!') }];
  let fetches = 0;

  // G1-G2: a cached byte is served without touching the mail server.
  const cacheStore = createMemoryStorage();
  await cacheStore.put(row.storageKey, BUF('PNG!'));
  const hit = await readAttachmentContent({
    attachment: row, storage: cacheStore, logger: QUIET,
    fetchers: { imap: async () => { fetches += 1; return null; } },
  });
  eq('G1 a cached attachment is served from the cache', hit.origin, 'cache');
  eq('G2 ...and the source message is never asked', fetches, 0);

  // G3-G6: a miss re-reads the source message and re-caches what it read.
  const missRow = { ...row, storageKey: 'att/2026/10/g3' };
  const miss = await readAttachmentContent({
    attachment: missRow, storage: cacheStore, logger: QUIET,
    fetchers: { imap: async () => { fetches += 1; return sourceParts; } },
  });
  eq('G3 a cache miss is served from the source message', miss.origin, 'source');
  eq('G4 the served bytes are the source bytes', miss.content.toString(), 'PNG!');
  eq('G5 the re-read is written back to the cache',
    (await cacheStore.get(missRow.storageKey)).toString(), 'PNG!');
  const again = await readAttachmentContent({
    attachment: missRow, storage: cacheStore, logger: QUIET,
    fetchers: { imap: async () => { throw new Error('the cache should have answered'); } },
  });
  eq('G6 ...so the next view is a cache hit again', again.origin, 'cache');

  // G7-G10: the match is strict, because the wrong bytes are worse than none.
  eq('G7 the right name with the wrong size never matches',
    matchSourcePart([{ filename: 'shot.png', content: BUF('PNG!!') }], row), null);
  eq('G8 a different name never matches',
    matchSourcePart([{ filename: 'other.png', content: BUF('PNG!') }], row), null);
  check('G9 the exact part matches', matchSourcePart(sourceParts, row) === sourceParts[0]);
  eq('G10 an unknown size never matches',
    matchSourcePart(sourceParts, { filename: 'shot.png', size: 0 }), null);

  // G11-G14: every way the source can fail ends as "unavailable", and a broken
  // cache provider is NOT one of them — that is a real error, not a miss.
  async function unavailable(attachment, fetcher) {
    try {
      await readAttachmentContent({
        attachment, storage: cacheStore, logger: QUIET, fetchers: { imap: fetcher },
      });
      return null;
    } catch (err) {
      return err && err.code === 'NOT_FOUND' ? err : null;
    }
  }
  check('G11 a source that cannot answer is "unavailable", not an error',
    (await unavailable({ ...row, storageKey: 'att/2026/10/g11' }, async () => null)) !== null);
  check('G12 a source that throws is "unavailable" too',
    (await unavailable({ ...row, storageKey: 'att/2026/10/g12' }, async () => { throw new Error('mailbox unreachable'); })) !== null);
  check('G13 an unknown channel (dev/simulated) is "unavailable"',
    (await unavailable({ ...row, source: 'dev', storageKey: 'att/2026/10/g13' }, async () => sourceParts)) !== null);
  check('G14 no message identity is "unavailable"',
    (await unavailable({ ...row, messageId: null, storageKey: 'att/2026/10/g14' }, async () => sourceParts)) !== null);
  const brokenCache = {
    async get() { throw new Error('cache disk on fire'); },
    async put() {},
    async delete() {},
  };
  let brokenSurfaced = false;
  try {
    await readAttachmentContent({
      attachment: row, storage: brokenCache, logger: QUIET,
      fetchers: { imap: async () => sourceParts },
    });
  } catch (err) {
    brokenSurfaced = /cache disk on fire/.test(err.message);
  }
  check('G15 a broken cache provider is a real failure, never disguised as "gone"', brokenSurfaced);

  // G16-G22: the preview allowlist is the security boundary, so it is pinned
  // as a set: image types a browser renders harmlessly yes; SVG, HTML and
  // everything else no.
  eq('G16 a png is previewable', isPreviewableImage('image/png'), true);
  eq('G17 a jpeg is previewable, case-insensitively', isPreviewableImage('IMAGE/JPEG'), true);
  eq('G18 an SVG is NOT previewable (script-carrying)', isPreviewableImage('image/svg+xml'), false);
  eq('G19 HTML is not previewable', isPreviewableImage('text/html'), false);
  eq('G20 a pdf is not previewable', isPreviewableImage('application/pdf'), false);
  eq('G21 an empty type is not previewable', isPreviewableImage(''), false);
  check('G22 the allowlist holds nothing but renderable image types',
    [...PREVIEW_IMAGE_TYPES].every((t) => t.startsWith('image/'))
    && !PREVIEW_IMAGE_TYPES.has('image/svg+xml'));

  // G23-G28: eviction is retention, not data loss.
  const cacheDir = path.join(os.tmpdir(), `ticketing-att-cache-${Date.now()}`);
  fs.mkdirSync(path.join(cacheDir, 'att', '2026', '01'), { recursive: true });
  const oldFile = path.join(cacheDir, 'att', '2026', '01', 'old');
  const newFile = path.join(cacheDir, 'att', '2026', '01', 'new');
  fs.writeFileSync(oldFile, 'old bytes');
  fs.writeFileSync(newFile, 'new bytes');
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, longAgo, longAgo);

  const swept = await runAttachmentCacheSweep({ rootDir: cacheDir, ttlDays: 30, logger: QUIET });
  eq('G23 an expired cached file is evicted', fs.existsSync(oldFile), false);
  eq('G24 a fresh one is kept', fs.existsSync(newFile), true);
  eq('G25 the sweep reports what it scanned and removed', `${swept.removed}/${swept.scanned}`, '1/2');
  eq('G26 the freed size is reported', swept.freedBytes, BUF('old bytes').length);
  const kept = await runAttachmentCacheSweep({ rootDir: cacheDir, ttlDays: 0, logger: QUIET });
  check('G27 TTL 0 disables eviction (a cache may be kept on purpose)',
    kept.disabled === true && fs.existsSync(newFile));
  eq('G28 a missing cache directory is not an error',
    (await sweepAttachmentCache({ rootDir: path.join(cacheDir, 'nope'), ttlDays: 30, logger: QUIET })).scanned, 0);
  eq('G29 the cache root resolves from ATTACHMENT_STORAGE_DIR (one source of the path)',
    resolveAttachmentRootDir(), STORAGE_DIR);

  /* ---- H. the IMAP re-read (the live path) -------------------------------- */
  console.log('\n--- H. IMAP source fetcher ---');
  const { createImapSourceFetcher } = require('../src/imap/sourceFetch');

  // A real (small) RFC 822 multipart message, so the adapter, mailparser and
  // the matcher all run for real; only the mailbox is fake.
  const PNG_BYTES = BUF('PNG!');
  const RAW_MESSAGE = [
    'From: Rita <rita@attach.test>',
    'To: helpdesk@example.com',
    'Subject: Screenshot',
    'Message-ID: <h1@attach.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain',
    '',
    'see attached',
    '--BOUND',
    'Content-Type: image/png; name="shot.png"',
    'Content-Disposition: attachment; filename="shot.png"',
    'Content-Transfer-Encoding: base64',
    '',
    PNG_BYTES.toString('base64'),
    '--BOUND--',
    '',
  ].join('\r\n');

  const calls = [];
  const fakeClient = {
    async connect() { calls.push('connect'); },
    async getMailboxLock(mailbox) {
      calls.push(`lock:${mailbox}`);
      return { release() { calls.push('release'); } };
    },
    async search(query, options) {
      calls.push(`search:${query.header['message-id']}:${options.uid}`);
      return [7];
    },
    async fetchOne(uid, fields, options) {
      calls.push(`fetch:${uid}:source=${fields.source}:uid=${options.uid}`);
      return { uid: Number(uid), source: Buffer.from(RAW_MESSAGE) };
    },
    async logout() { calls.push('logout'); },
    // The read-only invariant: nothing on a re-read may touch the flags.
    async messageFlagsAdd() { calls.push('FLAGS-ADD'); },
  };
  const fetchFrom = (overrides = {}) => createImapSourceFetcher({
    config: { enabled: true, mailbox: 'INBOX', ...(overrides.config || {}) },
    clientFactory: overrides.clientFactory || (async () => fakeClient),
  });

  const parts = await fetchFrom()({ attachment: { messageId: 'h1@attach.test', filename: 'shot.png', size: 4 } });
  eq('H1 the re-read searches the configured mailbox by Message-ID',
    calls.includes('search:h1@attach.test:true'), true);
  eq('H2 ...and fetches the source with an explicit uid fetch',
    calls.includes('fetch:7:source=true:uid=true'), true);
  const hMatch = matchSourcePart(parts, { filename: 'shot.png', size: 4 });
  check('H3 the re-read yields the part the row describes', Boolean(hMatch));
  eq('H4 ...with the message bytes', hMatch && hMatch.content.toString(), 'PNG!');
  check('H5 a re-read never marks the message seen', !calls.includes('FLAGS-ADD'));
  check('H6 the connection is released and closed',
    calls.includes('release') && calls.includes('logout'));
  eq('H7 the fetcher answers nothing when IMAP is not configured',
    await fetchFrom({ config: { enabled: false }, clientFactory: async () => { throw new Error('must not connect'); } })({ attachment: { messageId: 'h1@attach.test' } }),
    null);
  eq('H8 ...or when the row has no message identity',
    await fetchFrom({ clientFactory: async () => { throw new Error('must not connect'); } })({ attachment: {} }),
    null);
  eq('H9 a message that is no longer in the mailbox answers nothing',
    await fetchFrom({ clientFactory: async () => ({ ...fakeClient, async search() { return []; } }) })({ attachment: { messageId: 'gone@attach.test' } }),
    null);
  eq('H10 an empty fetch result answers nothing',
    await fetchFrom({ clientFactory: async () => ({ ...fakeClient, async fetchOne() { return null; } }) })({ attachment: { messageId: 'h1@attach.test' } }),
    null);
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
