/* SLA settings: the administrator-facing configuration of the SLA engine.

   Part A drives authorization on the live server (401 unauthenticated, 403
   for a non-admin, reading and writing alike). Part B pins the defaults and
   the group split (the handover settings surface must not leak SLA keys).
   Part C snapshots a cycle created under the OLD settings, saves new settings
   over HTTP, and proves the stored cycle is untouched while cycles started
   afterwards compute from the new policy (service path and live intake path).
   Part D proves the priority-change recalculation keeps its existing
   behaviour — recompute from the cycle start, now with the configured
   targets/calendar. Part E covers working-day/timezone configuration flow.
   Part F rejects invalid values (per-key and cross-key) without writing
   anything. Part G covers holiday management and that holiday rows affect
   only cycles started from then on.

   Expected due instants are computed with calendar instances built from the
   same configuration the tests save, so the suite pins the settings→engine
   FLOW; the calendar arithmetic itself is pinned by test-sla.js.

   Usage: npm run test:sla-settings  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4192';
// Background workers are off; this suite drives everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-settings');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const sla = require('../src/slaService');
const calendar = require('../src/slaClock');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'SlaSettings!123';
const DOMAIN = 'slasettings.example';
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

// Instants written with explicit offsets: +01:00 for Africa/Lagos wall time,
// Z for the UTC-configured calendar in Part E.
const T = (s) => new Date(s);
const iso = (d) => new Date(d).toISOString();

// A calendar built exactly like the engine builds it from the saved settings.
const calOf = (cfg) =>
  calendar.createCalendar({ timeZone: 'Africa/Lagos', workdayStartHour: 8, workdayEndHour: 17, workingDays: '1,2,3,4,5', ...cfg });

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

async function mkTicket(priority, overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'SLA settings fixture',
      body: 'SLA settings fixture body',
      category: 'Inquiry / Help',
      priority,
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

const loadCycle = async (ticketId) =>
  prisma.ticketSlaCycle.findFirst({ where: { ticketId }, orderBy: { cycleNumber: 'asc' } });

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  await prisma.team.create({ data: { key: 'sla-set-test', name: 'SLA Settings Team' } });
  await prisma.agent.create({
    data: {
      name: 'SLA Settings Admin',
      email: ADMIN_EMAIL,
      role: 'admin',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
  await prisma.agent.create({
    data: {
      name: 'SLA Settings Agent',
      email: `agent@${DOMAIN}`,
      role: 'agent',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    const adminLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    eq('login admin', adminLogin.status, 200);
    const admin = adminLogin.data.token;
    const agentLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `agent@${DOMAIN}`, password: PASSWORD },
    });
    eq('login agent', agentLogin.status, 200);
    const agent = agentLogin.data.token;

    /* ---- A. authorization ------------------------------------------------ */
    console.log('\n--- A. authorization ---');
    eq('A1 GET settings without a token is 401', (await req('/api/sla/settings')).status, 401);
    eq('A2 PATCH settings without a token is 401',
      (await req('/api/sla/settings', { method: 'PATCH', body: {} })).status, 401);
    eq('A3 agent cannot read the settings', (await req('/api/sla/settings', { token: agent })).status, 403);
    eq('A4 agent cannot change the settings',
      (await req('/api/sla/settings', { method: 'PATCH', token: agent, body: { slaResponseTargetMinutes: 90 } })).status, 403);
    eq('A5 agent cannot add a holiday',
      (await req('/api/sla/holidays', { method: 'POST', token: agent, body: { date: '2026-12-25' } })).status, 403);
    eq('A6 agent cannot remove a holiday',
      (await req('/api/sla/holidays/1', { method: 'DELETE', token: agent })).status, 403);
    eq('A7 admin reads the settings', (await req('/api/sla/settings', { token: admin })).status, 200);

    /* ---- B. reading the defaults + group split --------------------------- */
    console.log('\n--- B. reading settings ---');
    const initial = await req('/api/sla/settings', { token: admin });
    eq('B1 response target default is 60 minutes', initial.data.settings.slaResponseTargetMinutes, 60);
    eq('B1 critical default is 4h', initial.data.settings.slaResolutionHoursCritical, 4);
    eq('B1 high default is 8h', initial.data.settings.slaResolutionHoursHigh, 8);
    eq('B1 moderate default is 24h', initial.data.settings.slaResolutionHoursModerate, 24);
    eq('B1 low default is 72h', initial.data.settings.slaResolutionHoursLow, 72);
    eq('B1 workday starts at 8', initial.data.settings.slaWorkdayStartHour, 8);
    eq('B1 workday ends at 17', initial.data.settings.slaWorkdayEndHour, 17);
    eq('B1 working days default Mon–Fri', initial.data.settings.slaWorkingDays, '1,2,3,4,5');
    eq('B1 timezone default is Africa/Lagos', initial.data.settings.slaTimezone, 'Africa/Lagos');
    eq('B1 no holidays yet', initial.data.holidays.length, 0);
    eq('B2 definitions describe all 9 SLA keys', initial.data.definitions.length, 9);
    check('B2 definitions carry labels, help and defaults',
      initial.data.definitions.every((d) => d.label && d.help && d.default != null && d.group === 'sla'));

    // The handover settings surface stays scoped to its own group.
    const handover = await req('/api/handovers/settings', { token: agent });
    check('B3 handover settings endpoint still reads', handover.status, 200);
    check('B3 handover settings expose no SLA keys', !('slaResponseTargetMinutes' in handover.data.settings));
    eq('B3 handover definitions stay 2', handover.data.definitions.length, 2);
    const leaked = await req('/api/handovers/settings', {
      method: 'PATCH',
      token: admin,
      body: { slaResponseTargetMinutes: 9999 },
    });
    eq('B4 SLA keys sent to the handover endpoint do not write', leaked.status, 200);
    eq('B4 SLA settings unchanged by the handover endpoint',
      (await req('/api/sla/settings', { token: admin })).data.settings.slaResponseTargetMinutes, 60);

    /* ---- C. valid update; existing cycles untouched; new cycles follow ---- */
    console.log('\n--- C. saving settings, cycles before and after ---');

    // C0 — a cycle created under the DEFAULT settings, with deterministic
    // targets: +1h response, +4h critical resolution from Mon 08:00 Lagos.
    const t1 = await mkTicket('critical');
    await sla.startCycle(t1, { cycleNumber: 1, startedAt: T('2026-09-07T08:00:00+01:00') });
    const t1Cycle = await loadCycle(t1.id);
    const t1Before = JSON.parse(JSON.stringify(t1Cycle));
    const t1MirrorBefore = {
      dueAt: iso((await prisma.ticket.findUnique({ where: { id: t1.id } })).dueAt),
      responseDueAt: iso((await prisma.ticket.findUnique({ where: { id: t1.id } })).responseDueAt),
    };
    eq('C0 default response due is Mon 09:00', iso(t1Before.responseDueAt), iso(T('2026-09-07T09:00:00+01:00')));
    eq('C0 default resolution due is Mon 12:00', iso(t1Before.resolutionDueAt), iso(T('2026-09-07T12:00:00+01:00')));

    const saved = await req('/api/sla/settings', {
      method: 'PATCH',
      token: admin,
      body: {
        slaResponseTargetMinutes: 30,
        slaResolutionHoursCritical: 2,
        slaResolutionHoursHigh: 5,
        slaWorkdayStartHour: 9,
      },
    });
    eq('C1 admin saves new settings', saved.status, 200);
    eq('C1 response target now 30 minutes', saved.data.settings.slaResponseTargetMinutes, 30);
    eq('C1 critical target now 2h', saved.data.settings.slaResolutionHoursCritical, 2);
    eq('C1 high target now 5h', saved.data.settings.slaResolutionHoursHigh, 5);
    eq('C1 workday now starts at 9', saved.data.settings.slaWorkdayStartHour, 9);
    const stored = await prisma.setting.findUnique({ where: { key: 'slaResponseTargetMinutes' } });
    check('C2 the change is attributed to the admin', stored && stored.updatedBy && stored.updatedBy.includes(ADMIN_EMAIL));
    // Regression: a valid start/end pair sent TOGETHER must save — the
    // cross-rule compares numbers, never raw (possibly string) values.
    eq('C2b valid start/end pair saves',
      (await req('/api/sla/settings', {
        method: 'PATCH',
        token: admin,
        body: { slaWorkdayStartHour: 9, slaWorkdayEndHour: 17 },
      })).status, 200);

    // C3 — the existing cycle and its live mirrors are byte-identical.
    const t1After = JSON.parse(JSON.stringify(await loadCycle(t1.id)));
    const t1RowAfter = await prisma.ticket.findUnique({ where: { id: t1.id } });
    check('C3 existing cycle keeps every stored field', JSON.stringify(t1After) === JSON.stringify(t1Before));
    eq('C3 existing ticket dueAt mirror unchanged', iso(t1RowAfter.dueAt), t1MirrorBefore.dueAt);
    eq('C3 existing ticket responseDueAt mirror unchanged', iso(t1RowAfter.responseDueAt), t1MirrorBefore.responseDueAt);

    // C4 — a NEW cycle computes from the saved settings (service path). The
    // 09:00 start is the new opening hour; expectations use a calendar built
    // from the same configuration.
    const newPolicyCal = calOf({ workdayStartHour: 9 });
    const t2 = await mkTicket('critical');
    await sla.startCycle(t2, { cycleNumber: 1, startedAt: T('2026-09-07T09:00:00+01:00') });
    const t2Cycle = await loadCycle(t2.id);
    eq('C4 new cycle response due is +30 working minutes',
      iso(t2Cycle.responseDueAt), iso(newPolicyCal.addWorkingMs(T('2026-09-07T09:00:00+01:00'), 30 * 60000)));
    eq('C4 new cycle response due is Mon 09:30', iso(t2Cycle.responseDueAt), iso(T('2026-09-07T09:30:00+01:00')));
    eq('C4 new cycle resolution due is Mon 11:00 (2h critical)',
      iso(t2Cycle.resolutionDueAt), iso(T('2026-09-07T11:00:00+01:00')));
    eq('C4 approach instant is 75% consumed',
      iso(t2Cycle.responseApproachAt), iso(T('2026-09-07T09:22:30+01:00')));

    // C5 — the live intake path uses the saved settings too.
    const createdHttp = await req('/api/tickets', {
      method: 'POST',
      token: admin,
      body: { shortDescription: 'Settings intake ticket', requesterEmail: `intake@${DOMAIN}`, priority: 'critical', autoAssign: false },
    });
    eq('C5 ticket created over HTTP', createdHttp.status, 201);
    const fetched = await req(`/api/tickets/${createdHttp.data.id}`, { token: admin });
    const httpCycleStart = fetched.data.sla.cycleStartedAt;
    eq('C5 live intake uses the 30-minute response target',
      iso(fetched.data.sla.response.dueAt), iso(newPolicyCal.addWorkingMs(httpCycleStart, 30 * 60000)));
    check('C5 live intake remaining time is configured-target based',
      fetched.data.sla.response.remainingMs === null ||
        (typeof fetched.data.sla.response.remainingMs === 'number' && fetched.data.sla.response.remainingMs <= 30 * 60000));

    /* ---- D. priority change keeps its existing recalculation ------------- */
    console.log('\n--- D. priority change after a settings change ---');
    const reprioritised = await req(`/api/tickets/${t1.id}`, {
      method: 'PATCH',
      token: admin,
      body: { priority: 'high' },
    });
    eq('D1 priority change accepted', reprioritised.status, 200);
    const t1Reprioritised = await loadCycle(t1.id);
    // Recomputed from the CYCLE START (Mon 08:00, outside the new 09:00–17:00
    // window → the calendar rolls it to 09:00) with the NEW 5h high target.
    eq('D2 resolution target recomputed from the cycle start with the new policy',
      iso(t1Reprioritised.resolutionDueAt), iso(newPolicyCal.addWorkingMs(t1Before.startedAt, 5 * 3600000)));
    eq('D2 response target is untouched by a priority change',
      iso(t1Reprioritised.responseDueAt), t1MirrorBefore.responseDueAt);
    const t1MirrorAfter = await prisma.ticket.findUnique({ where: { id: t1.id } });
    eq('D3 dueAt mirror follows the recomputed target', iso(t1MirrorAfter.dueAt), iso(t1Reprioritised.resolutionDueAt));
    const targetChanged = await prisma.ticketSlaEvent.findFirst({
      where: { ticketId: t1.id, type: 'target_changed', clock: 'resolution' },
      orderBy: { id: 'desc' },
    });
    check('D4 target_changed event recorded', Boolean(targetChanged));

    /* ---- E. working days and timezone ------------------------------------ */
    console.log('\n--- E. working days and timezone ---');
    const weekend = await req('/api/sla/settings', {
      method: 'PATCH',
      token: admin,
      body: { slaWorkingDays: 'sun', slaTimezone: 'UTC' },
    });
    eq('E1 Sunday-only week canonicalised', weekend.data.settings.slaWorkingDays, '0');
    eq('E1 timezone switched to UTC', weekend.data.settings.slaTimezone, 'UTC');

    const utcCal = calOf({ timeZone: 'UTC', workingDays: '0', workdayStartHour: 9 });
    const t3 = await mkTicket('critical');
    await sla.startCycle(t3, { cycleNumber: 1, startedAt: T('2026-09-07T09:00:00Z') }); // a Monday — not configured as working
    const t3Cycle = await loadCycle(t3.id);
    eq('E2 cycle starting on a non-working day rolls to the next configured day',
      iso(t3Cycle.responseDueAt), iso(utcCal.addWorkingMs(T('2026-09-07T09:00:00Z'), 30 * 60000)));
    eq('E2 …which is Sunday 09:30 UTC', iso(t3Cycle.responseDueAt), iso(T('2026-09-13T09:30:00Z')));

    const restored = await req('/api/sla/settings', {
      method: 'PATCH',
      token: admin,
      body: {
        slaResponseTargetMinutes: 60,
        slaResolutionHoursCritical: 4,
        slaResolutionHoursHigh: 8,
        slaWorkdayStartHour: 8,
        slaWorkingDays: 'mon-fri',
        slaTimezone: 'Africa/Lagos',
      },
    });
    eq('E3 restoring via a name range canonicalises Mon–Fri', restored.data.settings.slaWorkingDays, '1,2,3,4,5');
    eq('E3 timezone back to Africa/Lagos', restored.data.settings.slaTimezone, 'Africa/Lagos');

    /* ---- F. invalid values are rejected, nothing changes ----------------- */
    console.log('\n--- F. invalid values ---');
    const settingsSnapshot = JSON.stringify((await req('/api/sla/settings', { token: admin })).data.settings);
    const badUpdates = [
      ['F1 zero response target', { slaResponseTargetMinutes: 0 }],
      ['F2 fractional response target', { slaResponseTargetMinutes: 10.5 }],
      ['F3 negative resolution target', { slaResolutionHoursModerate: -3 }],
      ['F4 start hour out of range', { slaWorkdayStartHour: 24 }],
      ['F5 day that ends when it starts', { slaWorkdayStartHour: 10, slaWorkdayEndHour: 10 }],
      ['F6 unknown weekday token', { slaWorkingDays: 'funday' }],
      ['F7 empty working week', { slaWorkingDays: '' }],
      ['F8 invalid timezone', { slaTimezone: 'Mars/Olympus' }],
      ['F9 unknown key', { slaNope: 1 }],
    ];
    for (const [name, body] of badUpdates) {
      const r = await req('/api/sla/settings', { method: 'PATCH', token: admin, body });
      eq(`${name} is 400`, r.status, 400);
      check(`${name} reports a reason`, Array.isArray(r.data.errors) && r.data.errors.length > 0);
    }
    eq('F10 no invalid update changed anything',
      JSON.stringify((await req('/api/sla/settings', { token: admin })).data.settings), settingsSnapshot);

    /* ---- G. holiday management ------------------------------------------- */
    console.log('\n--- G. holidays ---');
    const h1 = await req('/api/sla/holidays', { method: 'POST', token: admin, body: { date: '2026-09-08', name: 'Test Holiday' } });
    eq('G1 holiday with a name is created', h1.status, 201);
    eq('G1 name stored', h1.data.holiday.name, 'Test Holiday');
    const h2 = await req('/api/sla/holidays', { method: 'POST', token: admin, body: { date: '2026-09-09' } });
    eq('G2 holiday without a name is created', h2.status, 201);
    eq('G2 name optional', h2.data.holiday.name, null);

    const h3 = await req('/api/sla/holidays', { method: 'POST', token: admin, body: { date: '2026-09-08', name: 'Renamed Holiday' } });
    eq('G3 re-saving the same date updates it', h3.status, 200);
    eq('G3 updated flag set', h3.data.updated, true);
    eq('G3 name replaced', h3.data.holiday.name, 'Renamed Holiday');
    eq('G3 still two rows', h3.data.holidays.length, 2);

    for (const bad of [
      ['G4 impossible date is 400', { date: '2026-02-30' }],
      ['G4 non-date is 400', { date: 'tomorrow' }],
      ['G4 out-of-window year is 400', { date: '1899-01-01' }],
      ['G5 over-long name is 400', { date: '2026-09-10', name: 'x'.repeat(200) }],
    ]) {
      eq(bad[0], (await req('/api/sla/holidays', { method: 'POST', token: admin, body: bad[1] })).status, 400);
    }

    // G6 — holidays pause new cycles. Mon 16:45 +60 working minutes: 15
    // minutes fit before Mon 17:00, the remaining 45 continue on the next
    // working day. BOTH Tue 09-08 and Wed 09-09 are holidays by now (G1, G2),
    // so the target lands Thu 08:45 and the approach instant (45 min) Thu 08:30.
    const t4 = await mkTicket('moderate');
    await sla.startCycle(t4, { cycleNumber: 1, startedAt: T('2026-09-07T16:45:00+01:00') });
    const t4Cycle = await loadCycle(t4.id);
    eq('G6 response target skips every holiday', iso(t4Cycle.responseDueAt), iso(T('2026-09-10T08:45:00+01:00')));
    eq('G6 approach instant skips every holiday too', iso(t4Cycle.responseApproachAt), iso(T('2026-09-10T08:30:00+01:00')));

    const removed = await req(`/api/sla/holidays/${h3.data.holiday.id}`, { method: 'DELETE', token: admin });
    eq('G7 holiday removed', removed.status, 200);
    check('G7 list no longer contains the date',
      removed.data.holidays.every((h) => h.date !== '2026-09-08T00:00:00.000Z' && h.date !== '2026-09-08'));
    // With 09-08 removed, the next working day after Monday is Tuesday again
    // (Wed 09-09 is still a holiday, but the target no longer reaches it).
    const t5 = await mkTicket('moderate');
    await sla.startCycle(t5, { cycleNumber: 1, startedAt: T('2026-09-07T16:45:00+01:00') });
    const t5Cycle = await loadCycle(t5.id);
    eq('G7 removing the holiday unpauses new cycles', iso(t5Cycle.responseDueAt), iso(T('2026-09-08T08:45:00+01:00')));
    eq('G8 removing a missing holiday is 404',
      (await req(`/api/sla/holidays/${h3.data.holiday.id}`, { method: 'DELETE', token: admin })).status, 404);
  } finally {
    server.kill();
  }

  console.log('');
  if (failures) {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('ALL PASS');
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
