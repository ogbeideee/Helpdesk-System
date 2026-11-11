const fixture = require('./lib/testdb').use('review-hardening');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { app } = require('../server');
const { signToken } = require('../src/authMiddleware');
const { intakeEmailMessage } = require('../src/services/ticketIntake');
const sla = require('../src/slaService');
async function main() {
  const admin = await prisma.agent.create({ data: { name: 'Review admin', email: 'review@example.com', role: 'admin', passwordHash: await bcrypt.hash('local-test-password', 10) } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: admin.email, password: 'local-test-password', session: 'cookie' }) });
  try {
    const response = await login();
    const data = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(response.status, 200); assert(!data.token); assert.equal(data.session, 'cookie');
    assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200);
    const mutation = (origin, extra = {}) => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, ...extra } });
    assert.equal((await mutation('https://foreign.example.com')).status, 403);
    assert.equal((await mutation('https://foreign.example.com', { Authorization: 'nonsense' })).status, 403);
    const second = await login(), cookie2 = second.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, cookie2);
    const bearer = decodeURIComponent(cookie.split('=')[1]);
    assert.equal((await mutation(base)).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${bearer}` } })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie2 } })).status, 200);
    assert.equal(await prisma.revokedSession.count(), 1);
    const priorEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const policyHeaders = {};
    require('../src/securityHeaders').securityHeaders()({}, { setHeader: (key, value) => { policyHeaders[key] = value; } }, () => {});
    const policy = policyHeaders['Content-Security-Policy'];
    assert.match(policy, /script-src 'self' 'sha256-/); assert.match(policy, /object-src 'none'/);
    assert(!policy.split('script-src ')[1].split(';')[0].includes('unsafe-inline'));
    let cookieOptions;
    require('../src/services/sessionService').setCookie({ cookie: (_name, _token, options) => { cookieOptions = options; } }, 'test');
    assert(cookieOptions.secure && cookieOptions.httpOnly);
    process.env.NODE_ENV = priorEnv;
    const token = signToken(admin), headers = { Authorization: `Bearer ${token}` };
    const converted = await fetch(`${base}/api/auth/session`, { method: 'POST', headers });
    assert.equal(converted.status, 200); assert.equal((await converted.json()).session, 'cookie');
    assert.match(converted.headers.get('set-cookie'), /HttpOnly/);
    const refusedLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example.com' }, body: JSON.stringify({ email: admin.email, password: 'local-test-password', session: 'cookie' }) });
    assert.equal(refusedLogin.status, 403);
    const ticket = await prisma.ticket.create({ data: { ticketNumber: 'INC-009001', shortDescription: 'Review thread', requesterEmail: 'requester@example.com', body: 'Please repair the device.' } });
    await sla.startCycle(ticket, { cycleNumber: 1 });
    const ingest = (id, from, body, attachments) => intakeEmailMessage({ messageId: id, internetMessageId: `${id}@example.com`, from, subject: `Re: ${ticket.ticketNumber}`, body }, { logger: { log() {}, warn() {} }, ...(attachments ? { attachments } : {}) });
    await ingest('review-requester', 'requester@example.com', 'Still broken');
    await ingest('review-vendor', 'vendor@example.com', 'Checking our system');
    assert.equal((await prisma.ticket.findUnique({ where: { id: ticket.id } })).firstResponseAt, null);
    const recordEmailResponse = require('../src/services/emailResponseService').recordEmailResponse;
    const received = { createdAt: new Date() };
    await recordEmailResponse(ticket, { requesterEmail: admin.email, body: 'Automatic reply', autoSubmitted: 'auto-replied' }, received, prisma);
    await recordEmailResponse(ticket, { requesterEmail: admin.email, body: 'On Monday, Person wrote:\n> Old text' }, received, prisma);
    const disabled = await prisma.agent.create({ data: { name: 'Disabled staff', email: 'disabled@example.com', role: 'agent', isActive: false } });
    const user = await prisma.agent.create({ data: { name: 'User account', email: 'user@example.com', role: 'user' } });
    const userHeaders = { Authorization: `Bearer ${signToken(user)}` };
    for (const route of ['/tickets', '/tickets?limit=25', '/dashboard', '/stats', '/weekly-reports', '/remote-access/ticket/1', '/workload', '/handovers/inbox']) {
      assert.equal((await fetch(`${base}/api${route}`, { headers: userHeaders })).status, 403, `non-staff cannot read ${route}`);
    }
    for (const account of [disabled, user]) await recordEmailResponse(ticket, { requesterEmail: account.email, body: 'A reply' }, received, prisma);
    assert.equal((await prisma.ticket.findUnique({ where: { id: ticket.id } })).firstResponseAt, null, 'automated/quoted-only/disabled/non-staff messages do not stop SLA');
    await ingest('review-staff', admin.email, 'Please restart the device and try again.');
    const cycle = await sla.latestCycleFor(ticket.id); assert(cycle.firstResponseAt); assert.equal(cycle.firstResponderId, admin.id);
    await ingest('review-staff', admin.email, 'Please restart the device and try again.');
    assert.equal(await prisma.ticketSlaEvent.count({ where: { ticketId: ticket.id, type: 'response_recorded' } }), 1);
    await prisma.comment.createMany({ data: Array.from({ length: 30 }, (_, index) => ({ ticketId: ticket.id, authorEmail: 'requester@example.com', viaEmail: true, body: `Historical reply ${index}` })) });
    const recent = await (await fetch(`${base}/api/tickets/${ticket.id}?history=recent`, { headers })).json();
    assert.equal(recent.comments.length, 20); assert.equal(recent.history.olderReplyCount, 13);
    assert(recent.comments.every((row, index, rows) => index === 0 || new Date(row.createdAt) >= new Date(rows[index - 1].createdAt)));
    const full = await (await fetch(`${base}/api/tickets/${ticket.id}`, { headers })).json();
    assert.equal(full.comments.length, 33); assert.equal(full.history.olderReplyCount, 0);
    const original = prisma.team.findMany;
    prisma.team.findMany = async () => { throw new Error('private-driver-error'); };
    try { const failed = await fetch(`${base}/api/teams`, { headers }); assert.equal(failed.status, 500); assert(!JSON.stringify(await failed.json()).includes('private-driver')); }
    finally { prisma.team.findMany = original; }
    for (let index = 0; index < 101; index++) {
      const result = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `unknown-${index}@example.com`, password: 'wrong' }) });
      if (index === 100) assert.equal(result.status, 429, 'rotating target emails must hit the IP cap');
    }
    console.log('Review hardening passed: cookie sessions, CSRF, durable individual revocation, SLA replies/dedupe, bounded history, safe errors and aggregate login limit.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); fixture.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
