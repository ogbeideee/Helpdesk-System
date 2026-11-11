const fixture = require('./lib/testdb').use('operations');
const assert = require('assert/strict');
const prisma = require('../src/lib/prisma');
const delivery = require('../src/services/emailDeliveryService');
const operations = require('../src/services/operationsService');
const memberships = require('../src/services/groupMembershipService');
const { createMailer } = require('../src/mailer');
const { signToken } = require('../src/authMiddleware');
const { app } = require('../server');
async function main() {
  const admin = await prisma.agent.create({ data: { name: 'Operations admin', email: 'admin@operations.test', role: 'admin' } });
  const agent = await prisma.agent.create({ data: { name: 'Bashir Example', email: 'agent@operations.test' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, account, data, method = 'GET') {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: `Bearer ${signToken(account)}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  try {
    assert.deepEqual((await request('/health')).data, { ok: true });
    for (const route of ['/admin/diagnostics', '/admin/operations']) {
      assert.equal((await request(route)).status, 401);
      assert.equal((await request(route, agent)).status, 403);
      assert.equal((await request(route, admin)).status, 200);
    }
    assert.equal((await request('/admin/operations/settings', agent, { intakeAddressedAliases: 'bash = Bashir Example' }, 'PATCH')).status, 403);
    assert.equal((await request('/admin/operations/settings', admin, { intakeAddressedAliases: 'bash = Missing person' }, 'PATCH')).status, 400);
    assert.equal((await request('/admin/operations/settings', admin, { intakeAddressedAliases: 'bash = Bashir Example' }, 'PATCH')).status, 200);
    const preview = await request('/admin/operations/greeting-preview', admin, { greeting: 'Dear Bash,' }, 'POST');
    assert.equal(preview.data.match.agentId, agent.id);
    assert.equal(preview.data.match.tier, 'alias');
    assert.equal(await prisma.ticket.count(), 0);
    const mail = { subject: '[INC-123] Assignment', body: 'Private requester content', toRecipients: [{ emailAddress: { address: 'recipient@operations.test' } }] };
    const row = await delivery.enqueue(mail, 'direct');
    assert(!row.emailPayload.includes(mail.body));
    assert(!row.emailPayload.includes('recipient@'));
    assert.equal(await delivery.deliver(row, async () => { throw Error('provider-secret-value'); }), false);
    let persisted = await prisma.notification.findUnique({ where: { id: row.id } });
    assert.equal(persisted.emailStatus, 'pending');
    assert.equal(persisted.emailAttempts, 1);
    assert(!persisted.emailError.includes('provider-secret-value'));
    let sends = 0;
    await delivery.retryDue(async () => { sends++; });
    assert.equal(sends, 0); // backoff must be respected
    await prisma.notification.update({ where: { id: row.id }, data: { emailNextAttemptAt: new Date(0) } });
    await delivery.retryDue(async payload => { assert.equal(payload.body, mail.body); sends++; });
    persisted = await prisma.notification.findUnique({ where: { id: row.id } });
    assert.equal(persisted.emailStatus, 'delivered');
    assert.equal(persisted.emailPayload, null);
    assert.equal(sends, 1);
    const raced = await delivery.enqueue(mail, 'direct');
    await Promise.all([delivery.deliver(raced, async () => { sends++; }), delivery.deliver(raced, async () => { sends++; })]);
    assert.equal(sends, 2); // only one worker acquired the lease
    for (const reopened of [false, true]) {
      const retired = await delivery.enqueue({ ...require('../src/email/outbound').replyAlertMail({ ticketNumber: 'INC-900001', shortDescription: 'Retired alert', requesterEmail: 'requester@example.com' }, { reopened }), toRecipients: [] }, 'direct');
      assert.equal(await delivery.deliver(retired, async () => { throw new Error('Retired alerts must never reach transport'); }), false);
      const suppressed = await prisma.notification.findUnique({ where: { id: retired.id } });
      assert.equal(suppressed.emailStatus, 'expired'); assert.equal(suppressed.emailPayload, null);
    }
    const failed = await delivery.enqueue(mail, 'direct');
    for (let i = 0; i < 5; i++) await delivery.deliver(failed, async () => { throw Error('offline'); });
    persisted = await prisma.notification.findUnique({ where: { id: failed.id } });
    assert.equal(persisted.emailStatus, 'failed');
    assert.equal(persisted.emailAttempts, 5);
    assert.equal((await request(`/admin/operations/deliveries/${failed.id}/retry`, agent, {}, 'POST')).status, 403);
    assert.equal((await request(`/admin/operations/deliveries/${failed.id}/retry`, admin, {}, 'POST')).status, 200);
    assert.equal(await prisma.auditEvent.count({ where: { action: 'email.retry_requested' } }), 1);
    const management = await operations.management();
    assert(!JSON.stringify(management).includes('Private requester content'));
    assert(!JSON.stringify(management).includes('emailPayload'));
    const capturing = { sendMail: async () => {}, sendBroadcastMail: async () => {} };
    assert.equal(await createMailer({ transport: capturing, durable: true }).sendMailSafe(mail), true);
    const group = await prisma.team.create({ data: { key: 'operations-primary', name: 'Primary group' } });
    const updated = await prisma.agent.update({ where: { id: agent.id }, data: { teamId: group.id } });
    assert.equal(updated.teamId, group.id);
    const canonical = await prisma.teamMembership.findUnique({ where: { agentId_teamId: { agentId: agent.id, teamId: group.id } } });
    assert(canonical.isPrimary);
    const columns = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'Agent' AND column_name = 'teamId'`;
    assert.equal(columns.length, 0);
    const extra = await Promise.all([1, 2, 3].map(i => prisma.team.create({ data: { key: `operations-extra-${i}`, name: `Extra ${i}` } })));
    const concurrent = await Promise.allSettled(extra.map(g => memberships.addMember({ agentId: agent.id, teamId: g.id })));
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(await memberships.countGroupsForAgent(agent.id), 3);
    const audit = require('../src/services/auditService');
    await audit.record(prisma, { action: 'intake.skipped_automated', entityType: 'EmailIntake', description: 'Screened out', metadata: { outcome: 'skipped_automated', reason: 'Copied by internal account' } });
    assert((await operations.management()).decisions.some(d => d.metadata.reason === 'Copied by internal account'));
    console.log('Operations checks passed: access control, alias validation, encrypted delivery, backoff, lease concurrency, retries, primary membership storage and concurrent membership limits.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); fixture.cleanup(); });
