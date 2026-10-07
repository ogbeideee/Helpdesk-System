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
  await prisma.ticket.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ ticketNumber: `READ-${i}`, shortDescription: `Request ${i}`, requesterEmail: 'requester@example.com', assignedAgentId: agent.id, teamId: team.id })) });
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
    assert(selects.length <= 5, `ticket list used ${selects.length} SELECT round trips`);
    assert.equal(selects.filter(q => q.includes('TeamMembership')).length, 1, 'only authentication needs primary membership');
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
        assert.equal(data.critical, 1);
        assert.equal(data.ticketsPerGroup['Read group'], 101);
        assert.equal(data.ticketsPerGroup['Unassigned / Triage'], 1);
        assert(queries.filter(q => /^SELECT/i.test(q)).length <= 7, 'dashboard needs at most seven SELECTs');
      }
    }
    console.log('Read performance passed: 100-ticket queue bounded to five SELECTs; scalar agents skip membership; primary group joins in one query.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await raw.$disconnect(); fixture.cleanup(); });
