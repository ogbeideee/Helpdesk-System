// Real intake and attachment persistence on a disposable PostgreSQL database.
const testdb = require('./lib/testdb').use('power_automate');
process.env.JWT_SECRET = 'power-automate-test-only';
process.env.POWER_AUTOMATE_INTAKE_KEY = 'i'.repeat(48);
const assert = require('assert/strict');
const express = require('express');
const prisma = require('../src/lib/prisma');
const { parseExport, decodeMime } = require('../src/powerAutomate/mime');
const { createGateway, createTransport, createSourceFetcher } = require('../src/powerAutomate/gateway');
const { ingestNormalizedEmail } = require('../src/services/emailIngestion');
const { readAttachmentContent } = require('../src/services/attachmentFetchService');
const quiet = { log() {}, warn() {}, error() {} };
const files = new Map();
const storage = { put: async (key, bytes) => files.set(key, bytes), get: async key => {
  if (!files.has(key)) { const err = new Error('cache miss'); err.code = 'NOT_FOUND'; throw err; } return files.get(key);
}, delete: async key => files.delete(key) };
let server;
function mime(id, extra = '', text = 'Please reset my password.', subject = 'Account access', attachment = false) {
  const headers = `From: Test Requester <requester@example.com>\r\nTo: helpdesk@example.com\r\nMessage-ID: <${id}@example.com>\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n${extra}`;
  const content = attachment
    ? 'Content-Type: multipart/mixed; boundary="test-boundary"\r\n\r\n--test-boundary\r\nContent-Type: text/html\r\n\r\n' + text + '\r\n--test-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="proof.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--test-boundary--\r\n'
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
  return { messageId: `outlook-${id}`, mimeBase64: Buffer.from(headers + content).toString('base64') };
}
async function ingest(payload) {
  const parsed = await parseExport(payload);
  return ingestNormalizedEmail(parsed.email, { attachments: parsed.attachments, channel: 'power_automate', storage, logger: quiet });
}
async function main() {
  await require('../src/teams').ensureTeams(prisma);
  await require('../src/services/defaultRoutingRules').ensureDefaultRoutingRules({ client: prisma, logger: quiet });
  assert.throws(() => decodeMime('bad!'), /base64/);
  assert.throws(() => decodeMime(''), /required/);
  const initial = mime('first', '', '<p>Please reset my password.</p>', 'Account access', true);
  const parsed = await parseExport(initial);
  assert.equal(parsed.email.senderName, 'Test Requester');
  assert.equal(parsed.email.internetMessageId, 'first@example.com');
  assert.equal(parsed.email.messageId, 'outlook-first');
  assert.ok(!parsed.email.body.includes('<p>'));
  assert.equal(parsed.attachments[0].content.toString(), 'hello');
  const created = await ingest(initial);
  assert.equal(created.status, 'created');
  const ticketId = created.ticket.id;
  assert.equal((await ingest(initial)).status, 'duplicate');
  // IMAP's message id differs, but the original RFC id is shared.
  assert.equal((await ingest({ ...initial, messageId: 'imap-first' })).status, 'duplicate');
  const rows = await prisma.attachment.findMany({ where: { ticketId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'power_automate');
  assert.equal(rows[0].messageId, 'outlook-first');
  const reply = mime('reply', 'In-Reply-To: <first@example.com>\r\nReferences: <first@example.com>\r\n', 'Still unable to sign in', 'Following up');
  assert.equal((await ingest(reply)).status, 'comment_added');
  assert.equal(await prisma.ticket.count(), 1);
  assert.equal(await prisma.comment.count({ where: { ticketId } }), 1);
  assert.equal((await ingest(reply)).status, 'duplicate');
  await prisma.ticket.update({ where: { id: ticketId }, data: { state: 'CLOSED' } });
  assert.equal((await ingest(mime('reopen', 'In-Reply-To: <first@example.com>\r\n', 'Still broken', 'Following up'))).status, 'reopened');
  assert.equal((await ingest(mime('automatic', 'Auto-Submitted: auto-replied\r\n', 'Out of office', 'Automatic reply'))).status, 'skipped_automated');
  process.env.POWER_AUTOMATE_MAILBOX = 'requester@example.com';
  assert.equal((await ingest(mime('self'))).status, 'skipped_self');
  process.env.POWER_AUTOMATE_MAILBOX = 'helpdesk@example.com';
  // Concurrent deliveries: unique identity, not a check-then-act gate.
  const race = mime('race');
  const outcomes = await Promise.all([ingest(race), ingest(race)]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), ['created', 'duplicate']);
  console.log('PASS MIME sender, attachments, screening, RFC dedupe, reply, reopen and concurrent delivery');

  const { outlookConversationId } = require('../src/imap/imapMailAdapter');
  const root = Buffer.alloc(22, 7); root[0] = 1;
  const child = Buffer.concat([root, Buffer.alloc(5, 9)]);
  assert.equal(outlookConversationId(root.toString('base64')), outlookConversationId(child.toString('base64')));
  for (const invalid of [null, '', 'not base64!', Buffer.alloc(21, 1).toString('base64'), Buffer.alloc(23, 1).toString('base64'), Buffer.alloc(22, 0).toString('base64')]) assert.equal(outlookConversationId(invalid), null);
  const original = await ingest(mime('outlook-root', `Thread-Index: ${root.toString('base64')}\r\n`, 'The workstation is broken', 'Station'));
  assert.equal(original.status, 'created');
  const followup = await ingest(mime('outlook-child', `Thread-Index: ${child.toString('base64')}\r\n`, 'Still broken', 'RE: Station'));
  assert.equal(followup.status, 'comment_added');
  assert.equal(followup.ticket.id, original.ticket.id);
  const unrelated = Buffer.from(root); unrelated[21] = 8;
  assert.equal((await ingest(mime('different-root', `Thread-Index: ${unrelated.toString('base64')}\r\n`, 'New problem', 'RE: Station'))).status, 'created');
  const stranger = mime('different-requester', `Thread-Index: ${child.toString('base64')}\r\n`, 'New problem', 'RE: Station');
  stranger.mimeBase64 = Buffer.from(Buffer.from(stranger.mimeBase64, 'base64').toString().replace('requester@example.com', 'other@example.com')).toString('base64');
  assert.equal((await ingest(stranger)).status, 'created');
  console.log('PASS Outlook conversation identity, reply grouping, malformed headers, separate threads and requester isolation');

  const config = { flowUrl: 'https://flow.example.com/invoke?sig=private', flowKey: 'k'.repeat(48), broadcastDl: 'team@example.com' };
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ ok: true, operation: request.payload.operation, mimeBase64: initial.mimeBase64 }), { status: 200 });
  };
  const call = createGateway({ config, fetchImpl });
  const transport = createTransport({ config, call });
  await transport.sendMail({ subject: 'Test', body: 'hello', toRecipients: [{ emailAddress: { address: 'requester@example.com' } }] });
  assert.equal(request.payload.operation, 'sendMail');
  assert.equal(request.options.headers['x-ticketdesk-key'], config.flowKey);
  assert.equal(request.options.redirect, 'error');
  await transport.sendBroadcastMail({ subject: 'Broadcast', body: 'hello' });
  assert.equal(request.payload.mail.to, 'team@example.com');
  assert.equal(request.payload.mail.cc, '');
  const fetcher = createSourceFetcher({ call });
  files.clear();
  const content = await readAttachmentContent({ attachment: rows[0], storage, fetchers: { power_automate: fetcher }, logger: quiet });
  assert.equal(content.content.toString(), 'hello');
  assert.equal(content.origin, 'source');
  assert.equal(request.payload.messageId, 'outlook-first');
  files.clear();
  await assert.rejects(readAttachmentContent({ attachment: { ...rows[0], size: rows[0].size + 1 }, storage, fetchers: { power_automate: fetcher }, logger: quiet }), err => err.reason === 'no-match');
  await assert.rejects(createGateway({ config, fetchImpl: async () => new Response('', { status: 202 }) })('sendMail', {}), /confirm/);
  await assert.rejects(createGateway({ config, fetchImpl: async () => { throw new Error('secret URL and token'); } })('sendMail', {}), err => !err.message.includes('token'));
  await assert.rejects(createGateway({ config: { ...config, flowUrl: 'http://flow.example.com' }, fetchImpl })('sendMail', {}), /invalid/);
  await assert.rejects(createGateway({ config, fetchImpl: async () => new Response('{"ok":true,"operation":"wrong"}') })('sendMail', {}), /failure/);
  process.env.POWER_AUTOMATE_OUTBOUND_ENABLED = 'true';
  assert.equal(require('../src/mailer').createMailer({ durable: false }).transport.name, 'power_automate');
  process.env.POWER_AUTOMATE_OUTBOUND_ENABLED = '';
  console.log('PASS sending, broadcasts, strict completion acknowledgement, safe errors and attachment source re-export');

  const app = express();
  app.use('/api/integrations/power-automate', require('../routes/powerAutomate').buildRouter({ ingest: (email, options) => ingestNormalizedEmail(email, { ...options, storage, logger: quiet }) }));
  app.use(require('../src/errorHandler').errorHandler(quiet));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/power-automate/email`;
  const post = (payload, key = process.env.POWER_AUTOMATE_INTAKE_KEY) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ticketdesk-key': key }, body: JSON.stringify(payload) });
  assert.equal((await post(initial, '')).status, 401);
  assert.equal((await post({ messageId: 'bad', mimeBase64: 'bad!' })).status, 400);
  const replay = await post(initial); assert.equal(replay.status, 200);
  const replayBody = await replay.json(); assert.equal(replayBody.status, 'duplicate');
  assert.deepEqual(Object.keys(replayBody).sort(), ['duplicate','status','ticket']);
  assert.equal((await post(mime('http'))).status, 201);
  process.env.POWER_AUTOMATE_INTAKE_KEY = '';
  assert.equal((await post(initial)).status, 503);
  console.log('PASS authenticated HTTP intake, disabled-by-default behavior and minimal response');
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect(); await testdb.cleanup();
});
