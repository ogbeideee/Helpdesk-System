const fixture = require('./lib/testdb').use('read_performance');
const assert = require('assert/strict');
const { PrismaClient } = require('@prisma/client');
const raw = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const prisma = require('../src/lib/membershipClient').wrap(raw);
require.cache[require.resolve('../src/lib/prisma')] = { exports: prisma };
const { app } = require('../server');
const { signToken } = require('../src/authMiddleware');
let queries = [];
raw.$on('query', event => queries.push(event.query));
async function main() {
  const team = await prisma.team.create({ data: { key: 'read-test', name: 'Read group' } });
  const agent = await prisma.agent.create({ data: { name: 'Read admin', email: 'read@example.com', role: 'admin', teamId: team.id } });
  await prisma.ticket.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ ticketNumber: `READ-${i}`, shortDescription: `Request ${i}`, body: 'performance-body-search ' + 'x'.repeat(8000), priority: ['critical', 'high', 'moderate', 'low'][i % 4], requesterEmail: 'requester@example.com', assignedAgentId: agent.id, teamId: team.id })) });
  await prisma.ticket.createMany({ data: ['CLOSED', 'RESOLVED', 'IN_PROGRESS', 'NEW'].map(state => ({
    ticketNumber: `EXTRA-${state}`, shortDescription: state, requesterEmail: 'requester@example.com', state,
    assignedAgentId: state === 'NEW' ? null : agent.id, teamId: state === 'NEW' ? null : team.id,
    priority: state === 'NEW' ? 'critical' : 'low',
  })) });
  queries = [];
  const scalar = await prisma.agent.findUnique({ where: { id: agent.id }, select: { id: true, name: true } });
  assert.equal(scalar.id, agent.id);
  assert.equal(queries.filter(q => /^SELECT/i.test(q)).length, 1);
  assert(!queries.join('\n').includes('TeamMembership'));
  queries = [];
  const primary = await prisma.agent.findUnique({ where: { id: agent.id }, include: { team: true } });
  assert.equal(primary.teamId, team.id);
  assert.equal(primary.team.name, team.name);
  assert.equal(queries.filter(q => /^SELECT/i.test(q)).length, 1, 'primary membership must join in one round trip');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { Authorization: `Bearer ${signToken(agent)}` };
  try {
    const missingAsset = await fetch(base.replace('/api', '') + '/assets/retired-page.js');
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
    assert.equal(await missingAsset.text(), '');
    const entry = await fetch(base.replace('/api', '') + '/');
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('cache-control'), 'no-cache');
    queries = [];
    const response = await fetch(base + '/tickets?limit=100', { headers });
    assert.equal(response.status, 200);
    const tickets = await response.json();
    assert.equal(tickets.length, 100);
    assert.equal(tickets[0].assignedAgent.name, agent.name);
    const selects = queries.filter(q => /^SELECT/i.test(q));
    const sessionChecks = selects.filter(query => query.includes('RevokedSession'));
    assert.equal(sessionChecks.length, 1, 'durable session revocation is checked once per request, never per ticket');
    assert(selects.length - sessionChecks.length <= 5, `ticket list used ${selects.length - sessionChecks.length} non-session SELECT round trips`);
    assert.equal(selects.filter(q => q.includes('TeamMembership')).length, 1, 'only authentication needs primary membership');
    const get = async path => {
      const result = await fetch(base + path, { headers });
      assert.equal(result.status, 200, path);
      return result.json();
    };
    queries = [];
    const queue = await get('/tickets/queue?page=1&sort=priority&direction=asc');
    assert.equal(queue.total, 104);
    assert.equal(queue.pageSize, 25);
    assert.equal(queue.tickets.length, 25);
    assert(queue.tickets.every(ticket => ticket.priority === 'critical'), 'priority ordering applies before pagination');
    assert(queue.tickets.every(ticket => !('body' in ticket) && !('graphMessageId' in ticket) && !('resolution' in ticket)), 'queue excludes email bodies and detail-only fields');
    assert.equal(queries.filter(q => /^SELECT/i.test(q) && q.includes('RevokedSession')).length, 1);
    assert(queries.filter(q => /^SELECT/i.test(q) && !q.includes('RevokedSession')).length <= 7, 'queue reads stay bounded regardless of ticket volume, apart from the fixed session check');
    assert(Buffer.byteLength(JSON.stringify(queue)) < Buffer.byteLength(JSON.stringify(tickets)) / 10, 'page payload is at least 90% smaller for long email fixtures');
    const nextPage = await get('/tickets/queue?page=2&sort=priority&direction=asc');
    assert(nextPage.tickets.some(ticket => ticket.priority === 'high'));
    assert(nextPage.tickets.every(ticket => !queue.tickets.some(first => first.id === ticket.id)), 'stable pages do not overlap');
    const lastPage = await get('/tickets/queue?page=5');
    assert.equal(lastPage.tickets.length, 4);
    const unassigned = await get('/tickets/queue?agentId=unassigned');
    assert.equal(unassigned.total, 1);
    assert.equal(unassigned.tickets[0].assignedAgentId, null);
    const closed = await get('/tickets/queue?status=CLOSED&group=read-test');
    assert.equal(closed.total, 1);
    assert.equal(closed.tickets[0].awaitingConfirmation, false);
    const resolved = await get('/tickets/queue?status=RESOLVED');
    assert.equal(resolved.tickets[0].awaitingConfirmation, true);
    assert.equal((await get('/tickets/queue?group=missing')).total, 0);
    assert.equal((await get('/tickets/queue?group=read-test%27%20OR%20TRUE--')).total, 0, 'filter values are parameterized');
    const invalidSort = await get('/tickets/queue?sort=__proto__&direction=DROP');
    assert.equal(invalidSort.tickets.length, 25, 'invalid sort/direction use safe defaults');
    const summarySearch = await get('/tickets?summary=1&q=performance-body-search&limit=6');
    assert.equal(summarySearch.length, 6, 'body search still works without transmitting the body');
    assert(summarySearch.every(ticket => !('body' in ticket)));
    const people = await get('/tickets/people');
    assert.deepEqual(Object.keys(people[0]).sort(), ['email', 'id', 'name']);
    const detail = await get(`/tickets/${queue.tickets.find(ticket => ticket.shortDescription.startsWith('Request'))?.id}`);
    assert(detail.body.includes('performance-body-search'), 'full email remains available on details');
    for (const path of ['/dashboard', '/assignment-groups', '/workload/me']) {
      queries = [];
      const result = await fetch(base + path, { headers });
      assert.equal(result.status, 200);
      const data = await result.json();
      if (path === '/dashboard') {
        assert.equal(data.totalOpen, 102);
        assert.deepEqual(data.counts, { new: 101, inProgress: 1, resolved: 1, closed: 1 });
        assert.equal(data.ticketsPerAgent[0].openTickets, 101);
        assert.equal(data.unassigned, 1);
        assert.equal(data.critical, 26);
        assert.equal(data.ticketsPerGroup['Read group'], 101);
        assert.equal(data.ticketsPerGroup['Unassigned / Triage'], 1);
        assert.equal(data.myWorkload.openTickets, 101);
        assert.equal(data.myWorkload.newTickets, 100);
        assert.equal(data.myWorkload.inProgressTickets, 1);
        assert.equal(data.recentlyCreated.length, 8);
        assert.equal(queries.filter(q => /^SELECT/i.test(q) && q.includes('RevokedSession')).length, 1);
        assert(queries.filter(q => /^SELECT/i.test(q) && !q.includes('RevokedSession')).length <= 7, 'dashboard needs at most seven non-session SELECTs');
      }
    }
    console.log('Read performance passed: queue bounded to five SELECTs plus one durable session check; scalar agents skip membership; primary group joins in one query.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await raw.$disconnect(); fixture.cleanup(); });
