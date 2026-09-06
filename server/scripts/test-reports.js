/* Operational reports foundation: GET /api/reports (admin, read-only).

   Part A drives authorization on the live server (401 unauthenticated, 403
   for a non-admin). Part B proves the empty-range shape (zeros, nulls, empty
   arrays — never NaN). Part C pins date filtering on both series (created by
   createdAt, resolved by resolvedAt). Parts D–F pin the status / priority /
   group / agent aggregations and the resolution / first-response math against
   fixed fixtures. Part G covers the current-queue snapshot (state mix, open,
   unassigned, overdue) and the volume series. Part H proves the SLA section
   is delegated to the existing SLA reporting service byte-for-byte rather
   than recomputed. Part I proves read-only behaviour: no ticket row, audit
   event or domain log changes across report reads.

   Fixtures are seeded directly with explicit timestamps so the math is exact;
   the operational metrics work off Ticket columns alone and do not require
   SLA cycles (only the Part H ticket goes through the live API and has one).

   Usage: npm run test:reports  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4198';
// Background workers are off; this suite drives everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('reports');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const reports = require('../src/reports');
const { slaReport } = require('../src/slaReport');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'ReportsSuite!123';
const DOMAIN = 'reports.test';
const ADMIN_EMAIL = `admin@${DOMAIN}`;

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

const T = (s) => new Date(s);
const HOUR = 3600 * 1000;

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitForServer(proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

/** A ticket fixture with fully controlled timestamps. */
async function mkTicket({ created, state, priority, teamId, agentId, dueAt, firstResponseAt, resolvedAt, closedAt }) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'Reports fixture',
      body: 'Reports fixture body',
      category: 'Inquiry / Help',
      priority,
      state,
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      createdAt: created,
      ...(teamId !== undefined ? { teamId } : {}),
      ...(agentId !== undefined ? { assignedAgentId: agentId } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(firstResponseAt !== undefined ? { firstResponseAt } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
    },
  });
}

const RANGE = 'from=2026-09-01T00:00:00Z&to=2026-09-04T00:00:00Z';
const statusCount = (data, state) => data.byStatus.find((r) => r.state === state)?.count;
const priorityCount = (data, priority) => data.byPriority.find((r) => r.priority === priority)?.count;
const volumeFor = (data, day) => data.volume.find((r) => r.day === day);

async function ticketSnapshot() {
  const rows = await prisma.ticket.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true, createdAt: true, updatedAt: true, state: true, priority: true,
      teamId: true, assignedAgentId: true, dueAt: true, firstResponseAt: true,
      resolvedAt: true, closedAt: true,
    },
  });
  return JSON.stringify(rows);
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const alpha = await prisma.team.create({ data: { key: 'alpha', name: 'Alpha Team' } });
  const beta = await prisma.team.create({ data: { key: 'beta', name: 'Beta Team' } });
  const mkAgent = (name, email, role, teamId) =>
    prisma.agent.create({
      data: {
        name, email, role, ...(teamId ? { teamId } : {}),
        isActive: true, isAvailable: true, passwordHash: bcrypt.hashSync(PASSWORD, 4),
      },
    });
  const adminUser = await mkAgent('Reports Admin', ADMIN_EMAIL, 'admin', null);
  const agent1 = await mkAgent('Agent One', `one@${DOMAIN}`, 'agent', alpha.id);
  const agent2 = await mkAgent('Agent Two', `two@${DOMAIN}`, 'agent', beta.id);

  const now = Date.now();
  // In-range fixtures (Sep 1–3 2026, daytime UTC so the configured
  // Africa/Lagos day keys land on the same calendar day).
  await mkTicket({ created: T('2026-09-01T09:00Z'), state: 'NEW', priority: 'low',
    teamId: alpha.id, agentId: agent1.id, dueAt: new Date(now + 30 * 24 * HOUR) });
  await mkTicket({ created: T('2026-09-01T10:00Z'), state: 'IN_PROGRESS', priority: 'high',
    teamId: alpha.id, agentId: agent1.id, dueAt: new Date(now - HOUR) }); // overdue
  await mkTicket({ created: T('2026-09-02T09:00Z'), state: 'RESOLVED', priority: 'moderate',
    teamId: beta.id, agentId: agent2.id,
    firstResponseAt: T('2026-09-02T12:00Z'), resolvedAt: T('2026-09-03T15:00Z') }); // +30h
  await mkTicket({ created: T('2026-09-02T08:00Z'), state: 'RESOLVED', priority: 'moderate',
    teamId: alpha.id, agentId: agent1.id,
    firstResponseAt: T('2026-09-02T10:00Z'), resolvedAt: T('2026-09-02T20:00Z') }); // +12h
  await mkTicket({ created: T('2026-09-03T09:00Z'), state: 'CLOSED', priority: 'critical',
    teamId: beta.id, agentId: agent2.id,
    resolvedAt: T('2026-09-03T15:00Z'), closedAt: T('2026-09-03T17:00Z') }); // +6h, no response
  await mkTicket({ created: T('2026-09-02T11:00Z'), state: 'IN_PROGRESS', priority: 'medium',
    teamId: beta.id, agentId: agent2.id }); // legacy priority value
  // Out-of-range fixtures.
  await mkTicket({ created: T('2026-09-20T09:00Z'), state: 'NEW', priority: 'low' }); // no group/agent
  await mkTicket({ created: T('2026-08-01T09:00Z'), state: 'RESOLVED', priority: 'moderate',
    teamId: alpha.id, agentId: agent1.id, resolvedAt: T('2026-09-25T12:00Z') });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    const adminLogin = await req('/api/auth/login', {
      method: 'POST', body: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    eq('login admin', adminLogin.status, 200);
    const admin = adminLogin.data.token;
    const agentLogin = await req('/api/auth/login', {
      method: 'POST', body: { email: `one@${DOMAIN}`, password: PASSWORD },
    });
    eq('login agent', agentLogin.status, 200);
    const agent = agentLogin.data.token;

    /* ---- A. authorization ------------------------------------------------ */
    console.log('\n--- A. authorization ---');
    eq('A1 unauthenticated read is 401', (await req('/api/reports')).status, 401);
    eq('A2 agent cannot read reports', (await req('/api/reports', { token: agent })).status, 403);
    eq('A3 admin reads reports', (await req('/api/reports', { token: admin })).status, 200);
    eq('A4 invalid from is rejected',
      (await req('/api/reports?from=not-a-date', { token: admin })).status, 400);
    eq('A5 reversed range is rejected',
      (await req('/api/reports?from=2026-09-04T00:00:00Z&to=2026-09-01T00:00:00Z', { token: admin })).status, 400);

    /* ---- B. empty range --------------------------------------------------- */
    console.log('\n--- B. empty dataset ---');
    const empty = (await req('/api/reports?from=2026-08-10T00:00:00Z&to=2026-08-11T00:00:00Z', { token: admin })).data;
    eq('B1 no created volume', empty.totals.created, 0);
    eq('B2 no resolved volume', empty.totals.resolved, 0);
    eq('B3 volume series empty', empty.volume.length, 0);
    eq('B4 first-response averages are null, never NaN',
      empty.totals.firstResponse.avgMs === null && empty.totals.firstResponse.rate === null, true);
    eq('B5 resolution average is null', empty.totals.resolution.avgMs, null);
    eq('B6 status buckets are all zero', empty.byStatus.every((r) => r.count === 0), true);
    eq('B7 priority buckets are all zero', empty.byPriority.every((r) => r.count === 0), true);
    eq('B8 group/agent buckets empty', empty.byGroup.length === 0 && empty.byAgent.length === 0, true);
    eq('B9 SLA section reports an empty window too',
      empty.sla.totals.total === 0 && empty.sla.totals.rate === null, true);

    /* ---- C. date filtering ------------------------------------------------ */
    console.log('\n--- C. date filtering ---');
    const ranged = (await req(`/api/reports?${RANGE}`, { token: admin })).data;
    eq('C1 created counts only in-range tickets', ranged.totals.created, 6);
    eq('C2 resolved counts only in-range resolutions', ranged.totals.resolved, 3);
    check('C3 range echoed back',
      ranged.range.from === '2026-09-01T00:00:00.000Z' && ranged.range.to === '2026-09-04T00:00:00.000Z');
    const resolutionOnly = (await req('/api/reports?from=2026-09-24T00:00:00Z&to=2026-09-26T00:00:00Z', { token: admin })).data;
    eq('C4 a resolution-only window has no created volume', resolutionOnly.totals.created, 0);
    eq('C5 but counts the ticket resolved there', resolutionOnly.totals.resolution.count, 1);
    eq('C6 and its resolved day row appears', resolutionOnly.volume.length, 1);

    /* ---- D. status / priority / group / agent ------------------------------ */
    console.log('\n--- D. aggregations ---');
    eq('D1 NEW count', statusCount(ranged, 'NEW'), 1);
    eq('D2 IN_PROGRESS count', statusCount(ranged, 'IN_PROGRESS'), 2);
    eq('D3 RESOLVED count', statusCount(ranged, 'RESOLVED'), 2);
    eq('D4 CLOSED count', statusCount(ranged, 'CLOSED'), 1);
    eq('D5 every canonical status bucket is present', ranged.byStatus.length, 4);
    eq('D6 low', priorityCount(ranged, 'low'), 1);
    eq('D7 moderate includes the legacy medium value', priorityCount(ranged, 'moderate'), 3);
    eq('D8 high', priorityCount(ranged, 'high'), 1);
    eq('D9 critical', priorityCount(ranged, 'critical'), 1);
    eq('D10 no stray priority bucket', ranged.byPriority.length, 4);

    eq('D11 alpha group tickets', ranged.byGroup.find((g) => g.teamId === alpha.id).count, 3);
    eq('D12 beta group tickets', ranged.byGroup.find((g) => g.teamId === beta.id).count, 3);
    eq('D13 group open counts tracked',
      ranged.byGroup.find((g) => g.teamId === alpha.id).open === 2 &&
      ranged.byGroup.find((g) => g.teamId === beta.id).open === 1, true);
    eq('D14 ungrouped in-range tickets are absent from the group buckets', ranged.byGroup.length, 2);
    eq('D15 agent One tickets', ranged.byAgent.find((a) => a.agentId === agent1.id).count, 3);
    eq('D16 agent buckets name their agent',
      ranged.byAgent.find((a) => a.agentId === agent1.id).agent, 'Agent One');

    /* ---- E. resolution / first-response metrics ---------------------------- */
    console.log('\n--- E. resolution and first response ---');
    eq('E1 resolution count', ranged.totals.resolution.count, 3);
    // (30h + 12h + 6h) / 3 = 16h wall clock.
    eq('E2 average resolution is 16h', ranged.totals.resolution.avgMs, 16 * HOUR);
    eq('E3 first-response eligible is every created ticket', ranged.totals.firstResponse.eligible, 6);
    eq('E4 responded count', ranged.totals.firstResponse.responded, 2);
    eq('E5 response rate', ranged.totals.firstResponse.rate, 33);
    // (3h + 2h) / 2 = 2.5h wall clock.
    eq('E6 average first response is 2.5h', ranged.totals.firstResponse.avgMs, 2.5 * HOUR);

    /* ---- F. volume series -------------------------------------------------- */
    console.log('\n--- F. volume over time ---');
    eq('F1 Sep 1 created', volumeFor(ranged, '2026-09-01').created, 2);
    eq('F2 Sep 2 created', volumeFor(ranged, '2026-09-02').created, 3);
    eq('F3 Sep 3 resolved', volumeFor(ranged, '2026-09-03').resolved, 2);
    eq('F4 Sep 2 resolved (t4)', volumeFor(ranged, '2026-09-02').resolved, 1);
    check('F5 only days with activity appear',
      ranged.volume.length === 3 && ranged.volume.every((r) => r.created + r.resolved > 0));

    /* ---- G. current snapshot ----------------------------------------------- */
    console.log('\n--- G. current queue snapshot ---');
    eq('G1 open (NEW + IN_PROGRESS), unfiltered by range', ranged.current.open, 4);
    eq('G2 unassigned open tickets', ranged.current.unassigned, 1);
    eq('G3 overdue open tickets', ranged.current.overdue, 1);
    const stateSum = ranged.current.byState.reduce((n, r) => n + r.count, 0);
    eq('G4 state distribution covers the whole table', stateSum, 8);
    eq('G5 the snapshot is present in the empty-range call too',
      (await req('/api/reports?from=2026-08-10T00:00:00Z&to=2026-08-11T00:00:00Z', { token: admin })).data.current.open, 4);

    /* ---- H. SLA section is delegated, not recomputed ------------------------ */
    console.log('\n--- H. SLA delegation ---');
    // One ticket through the live API so it carries a real SLA cycle.
    const created = await req('/api/tickets', {
      method: 'POST', token: admin,
      body: { shortDescription: 'SLA delegation fixture', requesterEmail: `req@${DOMAIN}`, autoAssign: false },
    });
    eq('H1 fixture ticket created', created.status, 201);
    const fid = created.data.id;
    await req(`/api/tickets/${fid}/start`, { method: 'POST', token: admin, body: {} });
    await req(`/api/tickets/${fid}/notes`, { method: 'POST', token: admin, body: { body: 'first response' } });
    await req(`/api/tickets/${fid}/resolve`, { method: 'POST', token: admin, body: { resolution: 'done' } });

    const allTime = (await req('/api/reports', { token: admin })).data;
    check('H2 SLA totals come through', allTime.sla.totals.total >= 1 && allTime.sla.totals.response.applicable >= 1);
    const direct = await slaReport({ from: null, to: null });
    const strip = (r) => {
      const { range, ...rest } = JSON.parse(JSON.stringify(r));
      return rest; // range.generatedAt is a per-call timestamp
    };
    eq('H3 SLA section equals a direct slaReport() call exactly',
      JSON.stringify(strip(allTime.sla)), JSON.stringify(strip(direct)));
    eq('H4 the endpoint exists separately from the SLA report',
      (await req('/api/sla/report', { token: admin })).status, 200);

    /* ---- I. read-only behaviour --------------------------------------------- */
    console.log('\n--- I. read-only ---');
    const beforeTickets = await ticketSnapshot();
    const beforeAudit = await prisma.auditEvent.count();
    const beforeTicketAudit = await prisma.ticketAuditLog.count();
    const beforeCycles = await prisma.ticketSlaCycle.count();
    for (const qs of ['', `?${RANGE}`, '?from=2026-08-10T00:00:00Z&to=2026-08-11T00:00:00Z']) {
      await req(`/api/reports${qs}`, { token: admin });
    }
    eq('I1 no ticket row changed', await ticketSnapshot(), beforeTickets);
    eq('I2 no audit events written', await prisma.auditEvent.count(), beforeAudit);
    eq('I3 no domain ticket-audit rows written', await prisma.ticketAuditLog.count(), beforeTicketAudit);
    eq('I4 no SLA cycles written', await prisma.ticketSlaCycle.count(), beforeCycles);

    /* ---- J. service-level date filtering ------------------------------------ */
    console.log('\n--- J. service level ---');
    const svc = await reports.reportsOverview({ from: T('2026-09-01T00:00Z'), to: T('2026-09-04T00:00Z') });
    eq('J1 service and API agree on the same window',
      JSON.stringify(svc.totals), JSON.stringify(ranged.totals));
    const svcEmpty = await reports.reportsOverview({ from: T('2026-08-10T00:00Z'), to: T('2026-08-11T00:00Z') });
    eq('J2 service handles an empty window', svcEmpty.totals.created, 0);
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
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
