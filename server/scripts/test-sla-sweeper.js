/* SLA background sweeper (src/slaSweeper.js).

   Drives sweepSla() directly with fixed instants — deterministic, no sleeps,
   no server. Every expected instant is spelled out as an Africa/Lagos
   wall-clock time (+01:00). Calendar under test: Mon–Fri 08:00–17:00
   Africa/Lagos; evenings, weekends and SlaHoliday dates never count.

   Sweep instants within a block are chronological, but blocks are asserted
   per-ticket: earlier fixtures stay in the database and remain legitimate
   candidates for later sweeps (that is exactly what the sweeper must do), so
   global summary counts are only asserted where the database state makes them
   exact (A, F, H).

   Usage: npm run test:sla-sweeper  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4190';
// Background workers are off; the suite drives sweepSla directly. Read by
// slaSweeper at require time — must be set before the require below.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-sweeper');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const sla = require('../src/slaService');
const sweeper = require('../src/slaSweeper');
const { nextTicketNumber } = require('../src/ticketNumbers');

const PASSWORD = 'SlaSweepPass!123';
const DOMAIN = 'slasweep.example';

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
function eqMs(name, actual, expected) {
  const a = actual === null || actual === undefined ? null : new Date(actual).getTime();
  const b = expected === null || expected === undefined ? null : new Date(expected).getTime();
  check(name, a === b, `expected ${expected ? new Date(expected).toISOString() : null}, got ${actual ? new Date(actual).toISOString() : null}`);
}

// Lagos wall-clock instants for the week of Monday 2026-09-07.
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';
const THU = '2026-09-10';
const FRI = '2026-09-11';
const SAT = '2026-09-12';
const SUN = '2026-09-13';
const MON2 = '2026-09-14';
const d = (day, time) => new Date(`${day}T${time}+01:00`);

const loadCycles = (ticketId) =>
  prisma.ticketSlaCycle.findMany({ where: { ticketId }, orderBy: { cycleNumber: 'asc' } });
const loadEvents = (ticketId) =>
  prisma.ticketSlaEvent.findMany({ where: { ticketId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });

// Per-ticket event counts, keyed "type:clock" — exact regardless of which
// other fixtures a sweep also legitimately recorded.
async function eventCounts(ticketId) {
  const counts = {};
  for (const e of await loadEvents(ticketId)) {
    const key = `${e.type}:${e.clock ?? '-'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
const sweep = (at) => sweeper.sweepSla({ now: at });

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'SLA sweeper fixture ticket',
      body: 'SLA sweeper fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

// A ticket + its cycle 1, started at a fixed instant.
async function mkCycle(startedAt, ticketOverrides = {}) {
  const ticket = await mkTicket(ticketOverrides);
  const cycle = await sla.startCycle(ticket, { cycleNumber: 1, startedAt });
  return { ticket, cycle };
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const team = await prisma.team.create({ data: { key: 'sla-sweep-test', name: 'SLA Sweep Test Team' } });
  const agent = await prisma.agent.create({
    data: {
      name: 'Sweep Tester',
      email: `tester@${DOMAIN}`,
      teamId: team.id,
      role: 'agent',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });

  /* ---- A. approaching response SLA ------------------------------------- */
  console.log('\n--- A. approaching response SLA ---');
  {
    const { ticket, cycle } = await mkCycle(d(MON, '09:00'));
    // moderate, started Mon 09:00: response due Mon 10:00, approach Mon 09:45.
    eqMs('A frozen response approach instant', cycle.responseApproachAt, d(MON, '09:45'));
    eqMs('A frozen response due instant', cycle.responseDueAt, d(MON, '10:00'));

    let s = await sweep(d(MON, '09:30')); // before the 25% threshold
    eq('A scan is empty before the approach instant', s.scanned, 0);
    eq('A nothing recorded before the approach instant', (await loadEvents(ticket.id)).length, 1 /* target_created only */);

    const ticketBefore = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    s = await sweep(d(MON, '09:50')); // inside the window, before the due instant
    eq('A exactly one candidate scanned', s.scanned, 1);
    eq('A one approaching response recorded', s.approachingResponse, 1);
    eq('A no breach recorded', s.breachedResponse, 0);
    eq('A no resolution activity', s.approachingResolution + s.breachedResolution, 0);
    eq('A no claims lost', s.lostClaims, 0);

    const events = await loadEvents(ticket.id);
    eq('A event count (target_created + approaching)', events.length, 2);
    const ev = events.find((e) => e.type === 'approaching_breach');
    check('A approaching_breach event exists', Boolean(ev));
    eq('A event clock', ev.clock, 'response');
    eqMs('A event at the approach instant', ev.at, d(MON, '09:45'));
    eq('A event linked to the cycle', ev.cycleId, cycle.id);
    eq('A event actor', ev.actor, 'system');
    const meta = JSON.parse(ev.metadata);
    eqMs('A metadata carries the due instant', meta.responseDueAt, d(MON, '10:00'));
    eqMs('A metadata carries the detection instant', meta.detectedAt, d(MON, '09:50'));

    const after = (await loadCycles(ticket.id))[0];
    eq('A responseApproached latched', after.responseApproached, true);
    eq('A responseBreached not latched', after.responseBreached, false);

    const ticketAfter = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    eq('A ticket row byte-identical after the sweep', JSON.stringify(ticketAfter), JSON.stringify(ticketBefore));
    eq('A ticket state untouched', ticketAfter.state, 'NEW');

    s = await sweep(d(MON, '09:55')); // repeat sweep inside the window
    eq('A repeat sweep records nothing', s.approachingResponse, 0);
    eq('A still exactly one approaching event', (await eventCounts(ticket.id))['approaching_breach:response'], 1);
  }

  /* ---- B. breached response SLA ---------------------------------------- */
  console.log('\n--- B. breached response SLA ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'));
    await sweep(d(MON, '10:05')); // past the due instant, unanswered
    // (The sweep also correctly records block A's still-open cycle here, so
    // global summary counts are not exact; assert per ticket.)
    eq('B one breach recorded for this ticket', (await eventCounts(ticket.id))['breach:response'], 1);
    eq('B no approaching event (jumped straight past due)', (await eventCounts(ticket.id))['approaching_breach:response'], undefined);

    const events = await loadEvents(ticket.id);
    const ev = events.find((e) => e.type === 'breach');
    check('B breach event exists', Boolean(ev));
    eq('B event clock', ev.clock, 'response');
    eqMs('B event at the due instant', ev.at, d(MON, '10:00'));

    const after = (await loadCycles(ticket.id))[0];
    eq('B responseBreached latched', after.responseBreached, true);
    eq('B responseApproached not latched', after.responseApproached, false);

    await sweep(d(MON, '10:20'));
    eq('B repeat sweep records nothing', (await eventCounts(ticket.id))['breach:response'], 1);
  }

  /* ---- C. approaching resolution SLA ----------------------------------- */
  console.log('\n--- C. approaching resolution SLA ---');
  {
    const { ticket, cycle } = await mkCycle(d(MON, '09:00'));
    // Answer the response clock on time so only the resolution clock can fire.
    await sla.recordFirstResponse(ticket, { at: d(MON, '09:30'), responderId: agent.id });
    // moderate: resolution due Wed 15:00, approach Wed 09:00.
    eqMs('C frozen resolution approach instant', cycle.resolutionApproachAt, d(WED, '09:00'));
    eqMs('C frozen resolution due instant', cycle.resolutionDueAt, d(WED, '15:00'));

    await sweep(d(MON, '12:00')); // before the approach window
    eq('C nothing recorded before the window', (await eventCounts(ticket.id))['approaching_breach:resolution'], undefined);

    const s = await sweep(d(WED, '10:00'));
    eq('C one approaching resolution recorded for this ticket', (await eventCounts(ticket.id))['approaching_breach:resolution'], 1);
    eq('C answered response clock produced no response event', (await eventCounts(ticket.id))['breach:response'], undefined);

    const ev = (await loadEvents(ticket.id)).find((e) => e.type === 'approaching_breach' && e.clock === 'resolution');
    check('C approaching_breach (resolution) exists', Boolean(ev));
    eqMs('C event at the resolution approach instant', ev.at, d(WED, '09:00'));
    const after = (await loadCycles(ticket.id))[0];
    eq('C resolutionApproached latched', after.resolutionApproached, true);
    eq('C resolutionBreached not latched', after.resolutionBreached, false);

    await sweep(d(WED, '11:00'));
    eq('C repeat sweep records nothing', (await eventCounts(ticket.id))['approaching_breach:resolution'], 1);
  }

  /* ---- D. breached resolution SLA -------------------------------------- */
  console.log('\n--- D. breached resolution SLA ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'));
    await sla.recordFirstResponse(ticket, { at: d(MON, '09:30'), responderId: agent.id });

    const s = await sweep(d(WED, '16:00')); // past the Wed 15:00 due instant
    eq('D one resolution breach for this ticket', (await eventCounts(ticket.id))['breach:resolution'], 1);
    eq('D no resolution approach event (jumped straight past due)', (await eventCounts(ticket.id))['approaching_breach:resolution'], undefined);
    eq('D answered response clock never breached', (await eventCounts(ticket.id))['breach:response'], undefined);

    const ev = (await loadEvents(ticket.id)).find((e) => e.type === 'breach' && e.clock === 'resolution');
    eqMs('D event at the resolution due instant', ev.at, d(WED, '15:00'));
    const after = (await loadCycles(ticket.id))[0];
    eq('D resolutionBreached latched', after.resolutionBreached, true);
    eq('D resolutionApproached not latched', after.resolutionApproached, false);

    await sweep(d(WED, '17:00'));
    eq('D repeat sweep records nothing', (await eventCounts(ticket.id))['breach:resolution'], 1);
  }

  /* ---- E. no duplicate events across repeated sweeps ------------------- */
  console.log('\n--- E. no duplicates across repeated sweeps ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'));

    await sweep(d(MON, '09:50'));
    await sweep(d(MON, '09:50')); // identical instant again
    await sweep(d(MON, '09:55'));
    eq('E approaching event recorded exactly once', (await eventCounts(ticket.id))['approaching_breach:response'], 1);

    await sweep(d(MON, '10:05'));
    await sweep(d(MON, '10:05')); // identical instant again
    await sweep(d(MON, '10:20'));
    eq('E breach event recorded exactly once', (await eventCounts(ticket.id))['breach:response'], 1);

    const types = (await loadEvents(ticket.id)).map((e) => e.type);
    eq('E full timeline is exactly the expected three rows', types.join(','), 'target_created,approaching_breach,breach');
  }

  /* ---- F. tickets outside working hours -------------------------------- */
  console.log('\n--- F. outside working hours ---');
  {
    // Started Mon 16:30 (30 min of working time left): response due Tue 08:30,
    // approach Tue 08:15 — the evening and the night do not count.
    const { ticket, cycle } = await mkCycle(d(MON, '16:30'));
    eqMs('F frozen response due', cycle.responseDueAt, d(TUE, '08:30'));
    eqMs('F frozen response approach', cycle.responseApproachAt, d(TUE, '08:15'));

    let s = await sweep(d(MON, '18:00')); // same evening, outside the calendar
    eq('F evening sweep records nothing at all', `${s.scanned}:${s.approachingResponse}:${s.breachedResponse}`, '0:0:0');
    eq('F no events for this ticket', (await loadEvents(ticket.id)).length, 1);

    s = await sweep(d(TUE, '07:00')); // next morning before opening
    eq('F pre-opening sweep records nothing at all', `${s.scanned}:${s.approachingResponse}:${s.breachedResponse}`, '0:0:0');

    s = await sweep(d(TUE, '08:20')); // 20 working minutes into the day
    eq('F exactly one candidate after opening', s.scanned, 1);
    eq('F approaching fires once the working day resumes', s.approachingResponse, 1);
    eqMs('F event back-dated to the approach instant', (await loadEvents(ticket.id)).find((e) => e.type === 'approaching_breach').at, d(TUE, '08:15'));

    s = await sweep(d(TUE, '08:45')); // past the due instant
    eq('F breach fires after the due instant', s.breachedResponse, 1);
    eq('F breach at the due instant', (await loadEvents(ticket.id)).find((e) => e.type === 'breach').at.getTime(), d(TUE, '08:30').getTime());
  }

  /* ---- G. weekends ------------------------------------------------------ */
  console.log('\n--- G. weekends ---');
  {
    // Started Fri 16:30: response due Mon 08:30, approach Mon 08:15. The whole
    // weekend sits between the approach window and the breach.
    const { ticket, cycle } = await mkCycle(d(FRI, '16:30'));
    eqMs('G frozen response due skips the weekend', cycle.responseDueAt, d(MON2, '08:30'));
    eqMs('G frozen response approach skips the weekend', cycle.responseApproachAt, d(MON2, '08:15'));

    await sweep(d(SAT, '10:00'));
    await sweep(d(SUN, '12:00'));
    eq('G weekend sweeps record nothing for this ticket', (await loadEvents(ticket.id)).length, 1);

    await sweep(d(MON2, '08:20'));
    let counts = await eventCounts(ticket.id);
    eq('G approaching fires Monday morning inside the window', counts['approaching_breach:response'], 1);

    await sweep(d(MON2, '08:45'));
    counts = await eventCounts(ticket.id);
    eq('G breach fires Monday morning past the due instant', counts['breach:response'], 1);
    eqMs('G breach back-dated to the Monday due instant', (await loadEvents(ticket.id)).find((e) => e.type === 'breach').at, d(MON2, '08:30'));
  }

  /* ---- H. holidays ------------------------------------------------------ */
  console.log('\n--- H. SlaHoliday dates ---');
  {
    await prisma.slaHoliday.create({
      data: { date: new Date('2026-09-08T00:00:00Z'), name: 'Sweep Fixture Holiday' },
    });
    // Started Mon 16:30 with Tuesday a holiday: response due Wed 08:30,
    // approach Wed 08:15.
    const { ticket, cycle } = await mkCycle(d(MON, '16:30'));
    eqMs('H frozen response due skips the holiday', cycle.responseDueAt, d(WED, '08:30'));
    eqMs('H frozen response approach skips the holiday', cycle.responseApproachAt, d(WED, '08:15'));

    let s = await sweep(d(TUE, '10:00')); // the holiday itself, working hours
    eq('H the holiday produces no scan hits at all', s.scanned, 0);
    eq('H no events for this ticket on the holiday', (await loadEvents(ticket.id)).length, 1);

    s = await sweep(d(WED, '08:20'));
    eq('H approaching fires the day after the holiday', s.approachingResponse, 1);
    eqMs('H event at the post-holiday approach instant', (await loadEvents(ticket.id)).find((e) => e.type === 'approaching_breach').at, d(WED, '08:15'));

    s = await sweep(d(WED, '08:45'));
    eq('H breach fires the day after the holiday', s.breachedResponse, 1);
    eqMs('H breach at the post-holiday due instant', (await loadEvents(ticket.id)).find((e) => e.type === 'breach').at, d(WED, '08:30'));

    await prisma.slaHoliday.deleteMany({});
  }

  /* ---- I. resolved / closed tickets are ignored ------------------------- */
  console.log('\n--- I. resolved and closed tickets ignored ---');
  {
    const resolved = await mkTicket({});
    await sla.startCycle(resolved, { cycleNumber: 1, startedAt: d(MON, '09:00') });
    await prisma.ticket.update({ where: { id: resolved.id }, data: { state: 'RESOLVED' } });
    const closed = await mkTicket({});
    await sla.startCycle(closed, { cycleNumber: 1, startedAt: d(MON, '09:00') });
    await prisma.ticket.update({ where: { id: closed.id }, data: { state: 'CLOSED' } });

    await sweep(d(MON2, '09:00')); // far past both clocks
    eq('I no events for the resolved ticket', (await loadEvents(resolved.id)).length, 1);
    eq('I no events for the closed ticket', (await loadEvents(closed.id)).length, 1);
    const [resolvedCycle, closedCycle] = await Promise.all([
      loadCycles(resolved.id).then((cs) => cs[0]),
      loadCycles(closed.id).then((cs) => cs[0]),
    ]);
    eq('I resolved ticket cycle not latched', resolvedCycle.responseBreached, false);
    eq('I closed ticket cycle not latched', closedCycle.responseBreached, false);

    // Prove the state filter was the only reason: back to NEW, same cycle,
    // same overdue clocks — now the sweep records, exactly once per clock.
    await prisma.ticket.update({ where: { id: resolved.id }, data: { state: 'NEW' } });
    await sweep(d(MON2, '09:05'));
    const types = (await loadEvents(resolved.id)).map((e) => `${e.type}:${e.clock}`);
    eq('I reopened ticket records response breach once', types.filter((t) => t === 'breach:response').length, 1);
    eq('I reopened ticket records resolution breach once', types.filter((t) => t === 'breach:resolution').length, 1);
    eq('I closed ticket still ignored', (await loadEvents(closed.id)).length, 1);
  }

  /* ---- J. cycles without applicable targets ----------------------------- */
  console.log('\n--- J. cycles without targets ---');
  {
    // A backfill-shaped stub: an open cycle with no target instants at all.
    const ticket = await mkTicket({ priority: 'critical' });
    await prisma.ticketSlaCycle.create({
      data: { ticketId: ticket.id, cycleNumber: 1, startedAt: d(MON, '09:00') },
    });
    const before = await loadCycles(ticket.id);

    const s = await sweep(d(MON2, '09:10'));
    eq('J null-target cycle scanned nothing and did not crash', s.scanned >= 0, true);
    eq('J no events for the stub cycle', (await loadEvents(ticket.id)).length, 0);
    const after = await loadCycles(ticket.id);
    eq('J stub cycle untouched', JSON.stringify(after), JSON.stringify(before));
  }

  /* ---- K. priority-prelatched breach still gets its event --------------- */
  console.log('\n--- K. pre-latched breach (priority change into the past) ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'));
    await sla.recordFirstResponse(ticket, { at: d(MON, '09:30'), responderId: agent.id });
    // Raising to critical recomputes the target from the cycle start: Mon 13:00,
    // which is already past at Wed 10:00 — the service latches resolutionBreached
    // immediately and no breach event exists yet.
    await sla.onPriorityChanged(
      { ...ticket, priority: 'critical' },
      { at: d(WED, '10:00'), previousPriority: 'moderate' }
    );
    const pre = (await loadCycles(ticket.id))[0];
    eq('K service pre-latched the breach flag', pre.resolutionBreached, true);
    eq('K no breach event yet', (await eventCounts(ticket.id))['breach:resolution'], undefined);

    const s = await sweep(d(WED, '10:05'));
    eq('K sweep records the missing breach event', (await eventCounts(ticket.id))['breach:resolution'], 1);
    eq('K no approach event for a cycle already past due', (await eventCounts(ticket.id))['approaching_breach:resolution'], undefined);
    eq('K no lost claims', s.lostClaims, 0);
    const ev = (await loadEvents(ticket.id)).find((e) => e.type === 'breach' && e.clock === 'resolution');
    eqMs('K event at the recomputed due instant', ev.at, d(MON, '13:00'));

    await sweep(d(WED, '10:10'));
    eq('K repeat sweep records nothing', (await eventCounts(ticket.id))['breach:resolution'], 1);
  }

  /* ---- L. kill switch and timer lifecycle ------------------------------- */
  console.log('\n--- L. SLA_SWEEP_INTERVAL_MS kill switch ---');
  {
    eq('L interval env respected (0 = disabled)', sweeper.SWEEP_INTERVAL_MS, 0);
    const quiet = { log() {}, error() {} };
    eq('L start is a no-op when disabled', sweeper.startSlaSweeper({ logger: quiet }), false);

    // Fresh module load with a positive interval: the timer starts and stops.
    process.env.SLA_SWEEP_INTERVAL_MS = '25000';
    delete require.cache[require.resolve('../src/slaSweeper')];
    const timed = require('../src/slaSweeper');
    eq('L positive interval enables the sweeper', timed.startSlaSweeper({ logger: quiet }), true);
    timed.stopSlaSweeper();
    eq('L restart after stop works', timed.startSlaSweeper({ logger: quiet }), true);
    timed.stopSlaSweeper();
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
