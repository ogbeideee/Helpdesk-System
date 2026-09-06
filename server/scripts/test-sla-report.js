/* SLA reporting API: the slaReport aggregate and GET /api/sla/report.
 *
 * Part A–H drive the service directly on PostgreSQL with fixed instants and
 * an injected `now`; cycle rows are created with explicit stored values so
 * every expected figure is exact. Part I drives the real route over HTTP.
 * Calendar under test: Mon–Fri 08:00–17:00 Africa/Lagos (UTC+01:00); the
 * fixture week is Mon 2026-09-07 … Fri 2026-09-11.
 *
 * Usage: npm run test:sla-report  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4194';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-report');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { slaReport } = require('../src/slaReport');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'SlaReport!123';
const DOMAIN = 'slareport.example';

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
const iso = (d) => new Date(d).toISOString();
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';
const THU = '2026-09-10';
const LATER = T('2027-03-01T09:00:00+01:00');
const MIN = 60000;
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

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await (async () => {
        const row = await prisma.ticketSequence.upsert({
          where: { year: 0 },
          create: { year: 0, last: 1 },
          update: { last: { increment: 1 } },
        });
        return `HD-2026-${String(row.last).padStart(5, '0')}`;
      })(),
      shortDescription: 'Report fixture',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

/**
 * Cycle row with explicit stored values (the report reads stored instants and
 * durations; breach flags are recomputed from instants, exactly like the
 * dashboard).
 */
function mkCycle(ticketId, cycleNumber, f) {
  return prisma.ticketSlaCycle.create({
    data: {
      ticketId,
      cycleNumber,
      startedAt: f.startedAt,
      endedAt: f.endedAt ?? null,
      resolvedAt: f.endedAt ?? null,
      responseDueAt: f.responseDueAt ?? null,
      resolutionDueAt: f.resolutionDueAt ?? null,
      responseApproachAt: f.responseApproachAt ?? null,
      resolutionApproachAt: f.resolutionApproachAt ?? null,
      firstResponseAt: f.firstResponseAt ?? null,
      responseDurationMs: f.responseDurationMs ?? null,
      resolutionDurationMs: f.resolutionDurationMs ?? null,
      source: f.source ?? 'live',
    },
  });
}

async function main() {
  const teamA = await prisma.team.create({ data: { key: 'report-a', name: 'Service Desk' } });
  const teamB = await prisma.team.create({ data: { key: 'report-b', name: 'Network Ops' } });
  const agentA = await prisma.agent.create({
    data: { name: 'Ada Report', email: `ada@${DOMAIN}`, role: 'admin', isActive: true, passwordHash: bcrypt.hashSync(PASSWORD, 4) },
  });
  const agentB = await prisma.agent.create({
    data: { name: 'Ben Report', email: `ben@${DOMAIN}`, role: 'agent', isActive: true, passwordHash: bcrypt.hashSync(PASSWORD, 4) },
  });
  const plain = await prisma.agent.create({
    data: { name: 'Plain Agent', email: `plain@${DOMAIN}`, role: 'agent', isActive: true, passwordHash: bcrypt.hashSync(PASSWORD, 4) },
  });

  /* ---- A. empty data ----------------------------------------------------- */
  console.log('\n--- A. empty data ---');
  {
    const r = await slaReport({ now: LATER });
    eq('A1 compliance rate null', r.totals.rate, null);
    eq('A1 compliance total 0', r.totals.total, 0);
    eq('A1 response avg null', r.totals.response.avgMs, null);
    eq('A1 resolution avg target null', r.totals.resolution.avgTargetMs, null);
    eq('A1 live open 0', r.totals.live.openCycles, 0);
    eq('A1 no sources', Object.keys(r.totals.sources).length, 0);
    eq('A1 byPriority carries all four canonical rows', r.byPriority.map((b) => b.priority).join(','), 'low,moderate,high,critical');
    eq('A1 no groups', r.byGroup.length, 0);
    eq('A1 no agents', r.byAgent.length, 0);
    eq('A1 no overTime rows', r.overTime.length, 0);
    eq('A1 response target from the configured policy', r.totals.response.targetMs, 3600000);
  }

  /* ---- B. completed cycles: compliant, breached, sources ----------------- */
  console.log('\n--- B. completed compliant + breached cycles ---');
  // t1 — compliant moderate cycle, Service Desk / Ada, ended Mon.
  const t1 = await mkTicket({ priority: 'moderate', teamId: teamA.id, assignedAgentId: agentA.id });
  await mkCycle(t1.id, 1, {
    startedAt: T(`${MON}T09:00:00+01:00`),
    endedAt: T(`${MON}T13:00:00+01:00`),
    responseDueAt: T(`${MON}T10:00:00+01:00`),
    resolutionDueAt: T(`${WED}T15:00:00+01:00`),
    firstResponseAt: T(`${MON}T09:30:00+01:00`),
    responseDurationMs: 30 * MIN,
    resolutionDurationMs: 4 * H,
  });
  // t2 — breached moderate cycle, backfilled, ended Thu.
  const t2 = await mkTicket({ priority: 'moderate', teamId: teamA.id, assignedAgentId: agentA.id });
  await mkCycle(t2.id, 1, {
    startedAt: T(`${MON}T09:00:00+01:00`),
    endedAt: T(`${THU}T09:00:00+01:00`),
    responseDueAt: T(`${MON}T10:00:00+01:00`),
    resolutionDueAt: T(`${WED}T15:00:00+01:00`),
    firstResponseAt: T(`${MON}T10:30:00+01:00`),
    responseDurationMs: 90 * MIN,
    resolutionDurationMs: 27 * H,
    source: 'backfill',
  });

  {
    const r = await slaReport({ now: LATER });
    eq('B1 compliance total 2', r.totals.total, 2);
    eq('B1 compliance met 1', r.totals.met, 1);
    eq('B1 compliance rate 50', r.totals.rate, 50);
    eq('B1 response applicable 2', r.totals.response.applicable, 2);
    eq('B1 response breached 1', r.totals.response.breached, 1);
    eq('B1 avg first response 60m', r.totals.response.avgMs, 60 * MIN);
    eq('B1 resolution breached 1', r.totals.resolution.breached, 1);
    eq('B1 avg resolution 15.5h', r.totals.resolution.avgMs, Math.round((4 + 27) * H / 2));
    eq('B1 avg resolution target 24h (recovered, not configured)', r.totals.resolution.avgTargetMs, 24 * H);
    eq('B1 sources: live compliant', JSON.stringify(r.totals.sources.live), JSON.stringify({ total: 1, met: 1, rate: 100 }));
    eq('B1 sources: backfill breached', JSON.stringify(r.totals.sources.backfill), JSON.stringify({ total: 1, met: 0, rate: 0 }));
    eq('B2 moderate bucket carries both cycles', JSON.stringify([r.byPriority[1].total, r.byPriority[1].met, r.byPriority[1].rate]), JSON.stringify([2, 1, 50]));
    eq('B2 critical bucket empty with null rate', r.byPriority[3].total, 0);
    eq('B2 group bucket attributed', r.byGroup.length, 1);
    eq('B2 group named', r.byGroup[0].team, 'Service Desk');
    eq('B2 agent bucket attributed', r.byAgent.length, 1);
    eq('B2 agent named', r.byAgent[0].agent, 'Ada Report');
    const mon = r.overTime.find((d) => d.day === MON);
    const thu = r.overTime.find((d) => d.day === THU);
    eq('B3 Monday: 2 started, 1 completed met', JSON.stringify([mon.started, mon.completed, mon.met, mon.breached]), JSON.stringify([2, 1, 1, 0]));
    eq('B3 Thursday: 1 completed breached', JSON.stringify([thu.completed, thu.met, thu.breached]), JSON.stringify([1, 0, 1]));
  }

  /* ---- C. multiple cycles on one ticket ---------------------------------- */
  console.log('\n--- C. multiple cycles on one ticket ---');
  await mkCycle(t2.id, 2, {
    startedAt: T(`${TUE}T10:00:00+01:00`),
    endedAt: T(`${WED}T16:00:00+01:00`),
    responseDueAt: T(`${TUE}T11:00:00+01:00`),
    resolutionDueAt: T(`${THU}T09:00:00+01:00`),
    firstResponseAt: T(`${TUE}T10:20:00+01:00`),
    responseDurationMs: 20 * MIN,
    resolutionDurationMs: 15 * H,
  });
  // A critical cycle for the critical bucket, Network Ops / Ben, ended Mon.
  const t6 = await mkTicket({ priority: 'critical', teamId: teamB.id, assignedAgentId: agentB.id });
  await mkCycle(t6.id, 1, {
    startedAt: T(`${MON}T10:00:00+01:00`),
    endedAt: T(`${MON}T12:00:00+01:00`),
    responseDueAt: T(`${MON}T11:00:00+01:00`),
    resolutionDueAt: T(`${MON}T14:00:00+01:00`),
    firstResponseAt: T(`${MON}T10:20:00+01:00`),
    responseDurationMs: 20 * MIN,
    resolutionDurationMs: 2 * H,
  });
  {
    const r = await slaReport({ now: LATER });
    eq('C1 ticket t2 counts twice (two cycles)', r.totals.total, 4);
    eq('C1 met 3 of 4', r.totals.met, 3);
    eq('C1 rate 75', r.totals.rate, 75);
    eq('C1 avg first response 40m', r.totals.response.avgMs, 40 * MIN);
    eq('C1 avg resolution 12h', r.totals.resolution.avgMs, 12 * H);
    eq('C1 avg resolution target ((24+24+17+4)/4 — cycle 2 spans Tue→Thu mornings)',
      r.totals.resolution.avgTargetMs, Math.round((24 + 24 + 17 + 4) * H / 4));
    eq('C1 moderate bucket total 3', r.byPriority[1].total, 3);
    eq('C1 critical bucket met', JSON.stringify([r.byPriority[3].total, r.byPriority[3].met, r.byPriority[3].rate]), JSON.stringify([1, 1, 100]));
    eq('C1 both groups present, largest first', r.byGroup.map((g) => g.team).join(','), 'Service Desk,Network Ops');
    eq('C1 both agents present', r.byAgent.map((a) => a.agent).join(','), 'Ada Report,Ben Report');
    const tue = r.overTime.find((d) => d.day === TUE);
    eq('C1 Tuesday volume row from the second cycle start', tue.started, 1);
  }

  /* ---- D. open/live breaches + approaching ------------------------------- */
  console.log('\n--- D. open cycles: live breaches and approaching ---');
  // t3 — open, unanswered, long past both targets (moderate, opened Mon).
  const t3 = await mkTicket({ priority: 'moderate', teamId: teamA.id, assignedAgentId: agentA.id });
  await mkCycle(t3.id, 1, {
    startedAt: T(`${MON}T09:00:00+01:00`),
    responseDueAt: T(`${MON}T10:00:00+01:00`),
    resolutionDueAt: T(`${WED}T15:00:00+01:00`),
  });
  // t4 — open critical, answered, inside the 25% resolution window at
  // Thu 12:30 (target Thu 13:00, approach Thu 12:00).
  const t4 = await mkTicket({ priority: 'critical' });
  await mkCycle(t4.id, 1, {
    startedAt: T(`${THU}T09:00:00+01:00`),
    responseDueAt: T(`${THU}T10:00:00+01:00`),
    resolutionDueAt: T(`${THU}T13:00:00+01:00`),
    resolutionApproachAt: T(`${THU}T12:00:00+01:00`),
    firstResponseAt: T(`${THU}T09:20:00+01:00`),
  });
  {
    const r = await slaReport({ now: T(`${THU}T12:30:00+01:00`) });
    eq('D1 live breaches stay out of compliance', r.totals.total, 4);
    eq('D1 compliance unchanged', r.totals.met, 3);
    eq('D2 two open cycles', r.totals.live.openCycles, 2);
    eq('D2 one live response breach (t3)', r.totals.live.responseBreaches, 1);
    eq('D2 one live resolution breach (t3)', r.totals.live.resolutionBreaches, 1);
    eq('D2 one approaching clock (t4)', r.totals.live.approaching, 1);
  }

  /* ---- E. date filtering -------------------------------------------------- */
  console.log('\n--- E. date range filter ---');
  {
    const r = await slaReport({
      from: T(`${MON}T00:00:00+01:00`),
      to: T(`${WED}T23:59:59+01:00`),
      now: LATER,
    });
    eq('E1 completed-in-range only (t2 cycle 1 ended Thu excluded)', r.totals.total, 3);
    eq('E1 all three in-range cycles met', r.totals.met, 3);
    eq('E1 rate 100', r.totals.rate, 100);
    check('E2 overTime days all inside the range',
      r.overTime.every((d) => d.day >= MON && d.day <= WED));
    eq('E2 Thursday row excluded', r.overTime.some((d) => d.day === THU), false);
    const mon = r.overTime.find((d) => d.day === MON);
    // Started Monday: t1c1, t2c1, t6 (completed) and t3 (still open).
    eq('E2 Monday started volume includes open t3', mon.started, 4);
    check('E3 the live section ignores the range by contract', r.totals.live.openCycles === 2);
    eq('E4 range echoed back', r.range.from, iso(T(`${MON}T00:00:00+01:00`)));
  }

  /* ---- F. target-less cycles ---------------------------------------------- */
  console.log('\n--- F. cycles without applicable targets ---');
  const t5 = await mkTicket({ priority: 'low' });
  await mkCycle(t5.id, 1, {
    startedAt: T(`${THU}T09:00:00+01:00`),
    endedAt: T(`${THU}T16:00:00+01:00`),
  });
  {
    const r = await slaReport({ now: LATER });
    eq('F1 target-less cycle never enters the compliance denominator', r.totals.total, 4);
    eq('F1 compliance met unchanged', r.totals.met, 3);
    eq('F1 response applicable unchanged', r.totals.response.applicable, 4);
    eq('F1 resolution applicable unchanged', r.totals.resolution.applicable, 4);
    eq('F1 low-priority bucket stays empty', r.byPriority[0].total, 0);
    const thu = r.overTime.find((d) => d.day === THU);
    eq('F1 target-less cycle still counts as volume only',
      JSON.stringify([thu.started, thu.completed, thu.met, thu.breached]), JSON.stringify([2, 1, 0, 1]));
  }

  /* ---- G. source attribution ---------------------------------------------- */
  console.log('\n--- G. source attribution ---');
  {
    const r = await slaReport({ now: LATER });
    eq('G1 live total 3', r.totals.sources.live.total, 3);
    eq('G1 live all met', r.totals.sources.live.rate, 100);
    eq('G1 backfill total 1', r.totals.sources.backfill.total, 1);
    eq('G1 backfill breached', r.totals.sources.backfill.rate, 0);
    eq('G2 buckets reconcile with totals', r.byPriority.reduce((n, b) => n + b.total, 0), r.totals.total);
    eq('G2 group buckets reconcile with attributed cycles', r.byGroup.reduce((n, b) => n + b.total, 0), 4);
  }

  /* ---- H. read-only guarantee (service level) ----------------------------- */
  const countsBefore = {
    cycles: await prisma.ticketSlaCycle.count(),
    events: await prisma.ticketSlaEvent.count(),
    notifications: await prisma.notification.count(),
  };
  await slaReport({ now: LATER });

  /* ---- I. HTTP: authorization, shape, filters, read-only ------------------ */
  console.log('\n--- I. GET /api/sla/report over HTTP ---');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    eq('I1 no token is 401', (await req('/api/sla/report')).status, 401);
    const agentLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `plain@${DOMAIN}`, password: PASSWORD },
    });
    const agent = agentLogin.data.token;
    eq('I2 agent is 403', (await req('/api/sla/report', { token: agent })).status, 403);
    const adminLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `ada@${DOMAIN}`, password: PASSWORD },
    });
    eq('I3 admin login', adminLogin.status, 200);
    const admin = adminLogin.data.token;

    const r = await req('/api/sla/report', { token: admin });
    eq('I4 admin reads the report', r.status, 200);
    check('I5 report shape',
      r.data.totals && Array.isArray(r.data.byPriority) && Array.isArray(r.data.byGroup) &&
      Array.isArray(r.data.byAgent) && Array.isArray(r.data.overTime) && r.data.range);
    eq('I5 totals match the service aggregate', r.data.totals.total, 4);
    eq('I5 response target exposed for the UI', r.data.totals.response.targetMs, 3600000);

    const filtered = await req(`/api/sla/report?from=${encodeURIComponent(`${MON}T00:00:00+01:00`)}&to=${encodeURIComponent(`${WED}T23:59:59+01:00`)}`, { token: admin });
    eq('I6 date filter works over HTTP', filtered.data.totals.total, 3);
    eq('I6 range echoed', filtered.data.range.to, iso(T(`${WED}T23:59:59+01:00`)));

    eq('I7 invalid from is 400', (await req('/api/sla/report?from=garbage', { token: admin })).status, 400);
    eq('I7 from after to is 400',
      (await req(`/api/sla/report?from=${encodeURIComponent(`${WED}T00:00:00+01:00`)}&to=${encodeURIComponent(`${MON}T00:00:00+01:00`)}`, { token: admin })).status, 400);

    const countsAfter = {
      cycles: await prisma.ticketSlaCycle.count(),
      events: await prisma.ticketSlaEvent.count(),
      notifications: await prisma.notification.count(),
    };
    eq('I8 read-only: cycle rows unchanged', countsAfter.cycles, countsBefore.cycles);
    eq('I8 read-only: event rows unchanged', countsAfter.events, countsBefore.events);
    eq('I8 read-only: no notifications generated', countsAfter.notifications, 0);
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
