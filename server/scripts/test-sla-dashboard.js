/* Dashboard SLA KPIs: the slaService.dashboardSlaStats aggregate and its
   exposure on GET /api/dashboard.

   Part A drives the service directly on PostgreSQL with fixed instants and an
   injected `now`, so every expected figure is deterministic: outcomes of
   completed cycles are frozen, and the open-cycle fixtures are far enough in
   the past that they stay breached/approaching on any later run. Part B
   drives the real route over HTTP and asserts the KPI deltas around a
   create → resolve round trip, which are deterministic because a freshly
   started cycle is always 45 working minutes away from its approach instants
   and one working hour from its response target — longer than any test run.

   Calendar under test: Mon–Fri 08:00–17:00 Africa/Lagos (UTC+01:00 all year).
   Week of the fixtures: Mon 2026-09-07 … Fri 2026-09-11.

   Usage: npm run test:sla-dashboard  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4191';
// Background workers are off; this suite drives everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-dashboard');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const sla = require('../src/slaService');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'SlaDashPass!123';
const DOMAIN = 'sladash.example';

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

// Lagos wall-clock instants, written with the +01:00 offset so the calendar
// arithmetic reads directly off the approved working day.
const T = (s) => new Date(s);
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';
const THU = '2026-09-10';
const MIN = 60 * 1000;
const H = 60 * MIN;

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

const loadCycles = (ticketId) =>
  prisma.ticketSlaCycle.findMany({ where: { ticketId }, orderBy: { cycleNumber: 'asc' } });

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'SLA dashboard fixture',
      body: 'SLA dashboard fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const team = await prisma.team.create({ data: { key: 'sla-dash-test', name: 'SLA Dash Team' } });
  await prisma.agent.create({
    data: {
      name: 'SLA Dash Tester',
      email: `tester@${DOMAIN}`,
      teamId: team.id,
      role: 'admin',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });

  /* ---- Part A: the aggregate, on PostgreSQL ----------------------------- */
  console.log('\n--- A. dashboardSlaStats (service, PostgreSQL) ---');
  const LATER = T('2027-03-01T09:00:00+01:00'); // any instant after the fixtures

  // A1 — an empty database: no applicable cycles, no invented figures.
  {
    const s = await sla.dashboardSlaStats({ now: LATER });
    eq('A1 compliance rate null when nothing completed', s.compliance.rate, null);
    eq('A1 compliance total 0', s.compliance.total, 0);
    eq('A1 compliance met 0', s.compliance.met, 0);
    eq('A1 no response breaches', s.breaches.response, 0);
    eq('A1 no resolution breaches', s.breaches.resolution, 0);
    eq('A1 no applicable response cycles', s.breaches.responseApplicable, 0);
    eq('A1 no applicable resolution cycles', s.breaches.resolutionApplicable, 0);
    eq('A1 nothing approaching', s.approachingTickets, 0);
    eq('A1 no average first response', s.avgFirstResponseMs, null);
    eq('A1 no average resolution', s.avgResolutionMs, null);
    eq('A1 no average resolution target', s.avgResolutionTargetMs, null);
    eq('A1 approved response target exposed', s.responseTargetMs, 60 * MIN);
  }

  // A2 — one completed cycle: answered on time, resolved inside the target.
  {
    const ticket = await mkTicket({ priority: 'moderate' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T(`${MON}T09:00:00+01:00`) });
    await sla.recordFirstResponse(ticket, { at: T(`${MON}T09:30:00+01:00`) });
    await sla.finalizeOpenCycle(ticket, { at: T(`${MON}T14:00:00+01:00`) });

    const s = await sla.dashboardSlaStats({ now: LATER });
    eq('A2 met', s.compliance.met, 1);
    eq('A2 total counts only completed cycles', s.compliance.total, 1);
    eq('A2 rate 100%', s.compliance.rate, 100);
    eq('A2 no response breach', s.breaches.response, 0);
    eq('A2 no resolution breach', s.breaches.resolution, 0);
    eq('A2 response applicable', s.breaches.responseApplicable, 1);
    eq('A2 resolution applicable', s.breaches.resolutionApplicable, 1);
    eq('A2 nothing approaching once completed', s.approachingTickets, 0);
    eq('A2 avg first response = 30m working time', s.avgFirstResponseMs, 30 * MIN);
    eq('A2 avg resolution = 5 working hours', s.avgResolutionMs, 5 * H);
    eq('A2 avg resolution target = 24 working hours', s.avgResolutionTargetMs, 24 * H);
    eq('A2 one resolution sample', s.resolutionCount, 1);
  }

  // A3 — completed cycle with a late first response: compliance drops, the
  // response breach is counted, the (met) resolution is unaffected.
  {
    const ticket = await mkTicket({ priority: 'high' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T(`${TUE}T09:00:00+01:00`) });
    await sla.recordFirstResponse(ticket, { at: T(`${TUE}T10:10:00+01:00`) }); // 70m > 1h target
    await sla.finalizeOpenCycle(ticket, { at: T(`${TUE}T12:00:00+01:00`) }); // 3h < 8h target

    const s = await sla.dashboardSlaStats({ now: LATER });
    eq('A3 total grows', s.compliance.total, 2);
    eq('A3 met unchanged', s.compliance.met, 1);
    eq('A3 rate 50%', s.compliance.rate, 50);
    eq('A3 response breach counted', s.breaches.response, 1);
    eq('A3 resolution still met', s.breaches.resolution, 0);
    eq('A3 avg first response = mean(30m, 70m)', s.avgFirstResponseMs, 50 * MIN);
    eq('A3 avg resolution = mean(5h, 3h)', s.avgResolutionMs, 4 * H);
    eq('A3 avg target = mean(24h, 8h)', s.avgResolutionTargetMs, 16 * H);
  }

  // A4 — open, never answered, past both targets: live breaches are counted
  // (matching the red SLA badge), but the open cycle never joins compliance.
  {
    const ticket = await mkTicket({ priority: 'moderate' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T(`${WED}T09:00:00+01:00`) });
    // Left open. Response clock ran out Wed 10:00, resolution Fri 15:00.

    const s = await sla.dashboardSlaStats({ now: T('2026-09-14T09:00:00+01:00') });
    eq('A4 open cycle excluded from compliance total', s.compliance.total, 2);
    eq('A4 open cycle excluded from compliance met', s.compliance.met, 1);
    eq('A4 live response breach on the open cycle', s.breaches.response, 2);
    eq('A4 live resolution breach on the open cycle', s.breaches.resolution, 1);
    eq('A4 breached clocks are not approaching', s.approachingTickets, 0);
    eq('A4 averages unchanged by duration-less cycles', s.avgResolutionMs, 4 * H);
    eq('A4 resolution sample count unchanged', s.resolutionCount, 2);
  }

  // A5 — open, answered, resolution inside its 25%-remaining window: the
  // ticket is approaching breach while both outcomes stay unbreached.
  {
    const ticket = await mkTicket({ priority: 'high' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T(`${THU}T09:00:00+01:00`) });
    await sla.recordFirstResponse(ticket, { at: T(`${THU}T09:30:00+01:00`) });
    // High target: 8 working hours → due Thu 17:00, approaching from Thu 15:00.

    const s = await sla.dashboardSlaStats({ now: T(`${THU}T15:30:00+01:00`) });
    eq('A5 approaching ticket counted', s.approachingTickets, 1);
    // A4's resolution target (Fri 15:00) is still in the future at this
    // earlier `now` — live states are relative to the instant asked.
    eq('A5 no resolution breached yet at this instant', s.breaches.resolution, 0);
    eq('A5 answered on time, no new response breach', s.breaches.response, 2);
    eq('A5 open cycle still excluded from compliance', s.compliance.total, 2);
  }

  // A6 — a cycle without targets (a backfill stub) is applicable to nothing.
  {
    const ticket = await mkTicket({});
    await prisma.ticketSlaCycle.create({
      data: {
        ticketId: ticket.id,
        cycleNumber: 1,
        startedAt: T(`${MON}T09:00:00+01:00`),
        endedAt: T(`${MON}T10:00:00+01:00`),
        source: 'backfill',
      },
    });

    const s = await sla.dashboardSlaStats({ now: LATER });
    eq('A6 target-less cycle excluded from compliance', s.compliance.total, 2);
    eq('A6 no new applicable cycles', s.breaches.responseApplicable, 4); // A2, A3, A4, A5
    eq('A6 no new response breaches', s.breaches.response, 2);
    // At LATER both open cycles (A4, A5) sit far past their resolution
    // targets, so both count as live breaches and neither is approaching.
    eq('A6 open cycles past their targets breach live', s.breaches.resolution, 2);
    eq('A6 averages include every recorded response', s.avgFirstResponseMs, Math.round((30 + 70 + 30) * MIN / 3));
    eq('A6 breached or answered clocks never approach', s.approachingTickets, 0);
  }

  /* ---- Part B: the dashboard route over HTTP ----------------------------- */
  console.log('\n--- B. GET /api/dashboard (live server) ---');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `tester@${DOMAIN}`, password: PASSWORD },
    });
    eq('B0 login', login.status, 200);
    const token = login.data.token;

    const dash = await req('/api/dashboard', { token });
    eq('B1 dashboard loads', dash.status, 200);
    // Existing dashboard sections keep working alongside the SLA block.
    check('B1 existing sections intact', Number.isInteger(dash.data.totalOpen) && typeof dash.data.counts === 'object' && Array.isArray(dash.data.ticketsPerAgent) && Array.isArray(dash.data.recentlyCreated));
    check('B1 sla block present', dash.data.sla && typeof dash.data.sla === 'object');
    const before = dash.data.sla;
    check('B1 compliance shape', before.compliance && Number.isInteger(before.compliance.met) && Number.isInteger(before.compliance.total) && (before.compliance.rate === null || Number.isInteger(before.compliance.rate)));
    check('B1 breach counts are integers', Number.isInteger(before.breaches.response) && Number.isInteger(before.breaches.resolution) && Number.isInteger(before.breaches.responseApplicable) && Number.isInteger(before.breaches.resolutionApplicable));
    check('B1 averages null or numbers', (before.avgFirstResponseMs === null || Number.isInteger(before.avgFirstResponseMs)) && (before.avgResolutionMs === null || Number.isInteger(before.avgResolutionMs)));

    // B2 — a fresh open ticket: its cycle is applicable but neither completed
    // nor breached nor approaching (a new cycle is ≥45 working minutes from
    // its approach instants), so only the applicable counters move.
    const created = await req('/api/tickets', {
      method: 'POST',
      token,
      body: { shortDescription: 'Dashboard KPI ticket', requesterEmail: `kpi@${DOMAIN}`, priority: 'moderate', autoAssign: false },
    });
    eq('B2 create', created.status, 201);
    const afterCreate = (await req('/api/dashboard', { token })).data.sla;
    eq('B2 open ticket not counted as completed', afterCreate.compliance.total, before.compliance.total);
    eq('B2 open ticket not counted as met', afterCreate.compliance.met, before.compliance.met);
    eq('B2 no breach within one working hour of creation', afterCreate.breaches.response, before.breaches.response);
    eq('B2 nothing new approaching', afterCreate.approachingTickets, before.approachingTickets);
    eq('B2 response cycle now applicable', afterCreate.breaches.responseApplicable, before.breaches.responseApplicable + 1);
    eq('B2 resolution cycle now applicable', afterCreate.breaches.resolutionApplicable, before.breaches.resolutionApplicable + 1);

    // B3 — resolve it: the completed cycle joins compliance (and only there).
    const started = await req(`/api/tickets/${created.data.id}/start`, { method: 'POST', token, body: {} });
    eq('B3 start', started.status, 200);
    const resolved = await req(`/api/tickets/${created.data.id}/resolve`, {
      method: 'POST', token, body: { resolution: 'Fixed and verified.' },
    });
    eq('B3 resolve', resolved.status, 200);
    const afterResolve = (await req('/api/dashboard', { token })).data.sla;
    eq('B3 completed cycle joins compliance', afterResolve.compliance.total, before.compliance.total + 1);
    eq('B3 on-time resolution counts as met', afterResolve.compliance.met, before.compliance.met + 1);
    eq('B3 no resolution breach on a fast resolve', afterResolve.breaches.resolution, before.breaches.resolution);
    eq('B3 unresolved response clock ended inside its window — no breach', afterResolve.breaches.response, before.breaches.response);
    eq('B3 resolution sample recorded', afterResolve.resolutionCount, before.resolutionCount + 1);
    check('B3 average resolution present', afterResolve.avgResolutionMs !== null);
    eq('B3 no first response was ever recorded', afterResolve.firstResponseCount, before.firstResponseCount);
    eq('B3 response average unchanged', afterResolve.avgFirstResponseMs, before.avgFirstResponseMs);
    const cycle = (await loadCycles(created.data.id))[0];
    check('B3 cycle completed', cycle.endedAt !== null && cycle.resolutionDurationMs !== null && !cycle.resolutionBreached && !cycle.responseBreached);
  } finally {
    server.kill();
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    testdb.drop();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('SUITE ERROR:', err);
    await prisma.$disconnect().catch(() => {});
    testdb.drop();
    process.exit(1);
  });
