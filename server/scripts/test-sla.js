/* SLA service layer: working-time calendar, target computation, cycles,
   first public response, finalization, reopen, priority recalculation, and
   the route wiring.

   Parts A (calendar) and B (service, PostgreSQL) use fixed instants —
   deterministic, no sleeps. Part C drives the real routes over HTTP and
   asserts the same calendar math against the cycle rows it finds, so it
   never sleeps either.

   Calendar under test: Mon–Fri 08:00–17:00 Africa/Lagos (UTC+01:00 all
   year). Every expected value below is spelled out as a wall-clock instant.

   Usage: npm run test:sla  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4189';
// Background workers are off; this suite drives everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const calendar = require('../src/slaClock');
const sla = require('../src/slaService');
const { nextTicketNumber } = require('../src/ticketNumbers');
const { computeDueAt } = require('../src/sla');
const { intakeEmailMessage } = require('../src/services/ticketIntake');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'SlaSuitePass!123';
const DOMAIN = 'sla.example';

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
// Exact instant equality (both sides come from the same calendar math).
function eqMs(name, actual, expected) {
  const a = actual === null || actual === undefined ? null : new Date(actual).getTime();
  const b = expected === null || expected === undefined ? null : new Date(expected).getTime();
  check(name, a === b, `expected ${expected ? new Date(expected).toISOString() : null}, got ${actual ? new Date(actual).toISOString() : null}`);
}

// Lagos wall-clock instants, written with the +01:00 offset so the calendar
// arithmetic reads directly off the approved working day.
const T = (s) => new Date(s);
const MON = '2026-09-07'; // Monday
const T0 = T(`${MON}T09:00:00+01:00`);

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
const loadEvents = (ticketId) =>
  prisma.ticketSlaEvent.findMany({ where: { ticketId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'SLA fixture ticket',
      body: 'SLA fixture body',
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
  /* ---- Part A: calendar ------------------------------------------------ */
  console.log('\n--- A. working-time calendar ---');
  const H = 3600000;
  {
    const mon = (s) => T(`2026-09-07T${s}+01:00`); // Monday
    const tue = (s) => T(`2026-09-08T${s}+01:00`);
    const wed = (s) => T(`2026-09-09T${s}+01:00`);
    const fri = (s) => T(`2026-09-11T${s}+01:00`);
    const sat = (s) => T(`2026-09-12T${s}+01:00`);

    eq('A1 same-day span', calendar.workingMsBetween(mon('09:00'), mon('10:30')), 5400000);
    eq('A2 span stops at 17:00', calendar.workingMsBetween(mon('16:00'), mon('17:30')), H);
    eq('A3 overnight span', calendar.workingMsBetween(mon('16:30'), tue('09:30')), 2 * H);
    eq('A4 weekend excluded', calendar.workingMsBetween(fri('16:00'), T(`2026-09-14T10:00:00+01:00`)), 3 * H);
    eq('A5 before-open start', calendar.workingMsBetween(mon('06:00'), mon('08:30')), 1800000);
    eq('A6 empty/reversed span', calendar.workingMsBetween(mon('10:00'), mon('09:00')), 0);

    // Tuesday 2026-09-08 as a holiday.
    const holiday = [new Date('2026-09-08T00:00:00Z')];
    eq('A7 holiday excluded', calendar.workingMsBetween(mon('08:00'), wed('09:00'), holiday), 10 * H);
    eq('A8 holiday by ISO string', calendar.workingMsBetween(mon('08:00'), wed('09:00'), ['2026-09-08']), 10 * H);
    eqMs('A9 add crosses holiday', calendar.addWorkingMs(fri('16:30'), H, [new Date('2026-09-14T00:00:00Z')]), T('2026-09-15T08:30:00+01:00'));

    eqMs('A10 add same day', calendar.addWorkingMs(mon('09:00'), H), mon('10:00'));
    eqMs('A11 add crosses 17:00', calendar.addWorkingMs(mon('16:30'), H), tue('08:30'));
    eqMs('A12 add crosses weekend', calendar.addWorkingMs(fri('16:30'), H), T('2026-09-14T08:30:00+01:00'));
    eqMs('A13 add full day lands on 17:00', calendar.addWorkingMs(mon('08:00'), calendar.WORKDAY_MS), mon('17:00'));
    eqMs('A14 add past 17:00 continues next day', calendar.addWorkingMs(mon('08:00'), calendar.WORKDAY_MS + H), tue('09:00'));
    eqMs('A15 add 24 working hours', calendar.addWorkingMs(mon('08:00'), 24 * H), wed('14:00'));
    eqMs('A16 add 72 working hours over a weekend', calendar.addWorkingMs(fri('16:00'), 72 * H), T('2026-09-23T16:00:00+01:00'));

    eqMs('A17 zero rolls to next working instant (saturday)', calendar.addWorkingMs(sat('12:00'), 0), T('2026-09-14T08:00:00+01:00'));
    eqMs('A18 zero rolls to next working instant (evening)', calendar.addWorkingMs(fri('18:00'), 0), T('2026-09-14T08:00:00+01:00'));
    eqMs('A19 zero rolls to opening time', calendar.addWorkingMs(mon('06:00'), 0), mon('08:00'));
    eqMs('A20 17:00 sharp is outside the window', calendar.addWorkingMs(mon('17:00'), 0), tue('08:00'));

    check('A21 isWorkingMoment inside window', calendar.isWorkingMoment(mon('08:00')));
    check('A22 isWorkingMoment last minute', calendar.isWorkingMoment(mon('16:59')));
    check('A23 isWorkingMoment at 17:00 false', !calendar.isWorkingMoment(mon('17:00')));
    check('A24 isWorkingMoment weekend false', !calendar.isWorkingMoment(sat('10:00')));
    check('A25 isWorkingMoment before open false', !calendar.isWorkingMoment(mon('07:59')));
  }

  /* ---- Part B: service layer on PostgreSQL ----------------------------- */
  console.log('\n--- B. SLA service (PostgreSQL) ---');
  const team = await prisma.team.create({ data: { key: 'sla-test', name: 'SLA Test Team' } });
  const agent = await prisma.agent.create({
    data: {
      name: 'SLA Tester',
      email: `tester@${DOMAIN}`,
      teamId: team.id,
      role: 'agent',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });

  // B1 — cycle creation, targets, mirrors, target_created event.
  {
    const ticket = await mkTicket({ priority: 'moderate', assignedAgentId: agent.id, teamId: team.id });
    const cycle = await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });

    eq('B1 cycle number', cycle.cycleNumber, 1);
    eq('B1 source', cycle.source, 'live');
    eqMs('B1 startedAt', cycle.startedAt, T0);
    eqMs('B1 responseDueAt = +1 working hour', cycle.responseDueAt, T(`${MON}T10:00:00+01:00`));
    eqMs('B1 responseApproachAt = 25% remaining', cycle.responseApproachAt, T(`${MON}T09:45:00+01:00`));
    eqMs('B1 resolutionDueAt = +24 working hours', cycle.resolutionDueAt, T('2026-09-09T15:00:00+01:00'));
    eqMs('B1 resolutionApproachAt', cycle.resolutionApproachAt, T('2026-09-09T09:00:00+01:00'));
    eq('B1 attribution: agent', cycle.assignedAgentId, agent.id);
    eq('B1 attribution: team', cycle.teamId, team.id);

    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    eqMs('B1 dueAt mirror', after.dueAt, cycle.resolutionDueAt);
    eqMs('B1 responseDueAt mirror', after.responseDueAt, cycle.responseDueAt);
    eq('B1 firstResponseAt mirror reset', after.firstResponseAt, null);
    eq('B1 responseBreached mirror reset', after.responseBreached, false);

    const events = await loadEvents(ticket.id);
    eq('B1 target_created event', events.length, 1);
    eq('B1 event type', events[0].type, 'target_created');
    eq('B1 event cycle link', events[0].cycleId, cycle.id);
  }

  // B2 — first response recorded once; late response breaches.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });

    const first = await sla.recordFirstResponse(ticket, {
      at: T(`${MON}T09:30:00+01:00`),
      responderId: agent.id,
      actor: 'SLA Tester <tester@sla.example>',
    });
    eqMs('B2 firstResponseAt', first.firstResponseAt, T(`${MON}T09:30:00+01:00`));
    eq('B2 duration = 30 working minutes', first.responseDurationMs, 1800000);
    eq('B2 on time', first.responseBreached, false);
    eq('B2 responder', first.firstResponderId, agent.id);
    const mirror = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    eqMs('B2 mirror firstResponseAt', mirror.firstResponseAt, first.firstResponseAt);

    const again = await sla.recordFirstResponse(ticket, { at: T(`${MON}T09:50:00+01:00`), responderId: agent.id });
    eq('B2 only the first response counts', again, null);
    const events = await loadEvents(ticket.id);
    eq('B2 one response event', events.filter((e) => e.type === 'response_recorded').length, 1);
    eq('B2 no breach event', events.filter((e) => e.type === 'breach').length, 0);
  }

  // B3 — a response after the response target is a breach.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });
    const updated = await sla.recordFirstResponse(ticket, {
      at: T(`${MON}T10:30:00+01:00`),
      responderId: agent.id,
    });
    eq('B3 breached', updated.responseBreached, true);
    eq('B3 duration = 90 working minutes', updated.responseDurationMs, 5400000);
    const mirror = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    eq('B3 mirror responseBreached', mirror.responseBreached, true);
    const breach = (await loadEvents(ticket.id)).find((e) => e.type === 'breach');
    check('B3 breach event exists', Boolean(breach));
    eq('B3 breach clock', breach.clock, 'response');
    eqMs('B3 breach at the due instant', breach.at, T(`${MON}T10:00:00+01:00`));
  }

  // B4 — finalization on resolve: outcome frozen, on-time.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });
    await sla.recordFirstResponse(ticket, { at: T(`${MON}T09:20:00+01:00`), responderId: agent.id });
    const finished = await sla.finalizeOpenCycle(ticket, { at: T(`${MON}T11:00:00+01:00`) });

    eqMs('B4 endedAt', finished.endedAt, T(`${MON}T11:00:00+01:00`));
    eqMs('B4 resolvedAt', finished.resolvedAt, finished.endedAt);
    eq('B4 resolution duration = 2 working hours', finished.resolutionDurationMs, 7200000);
    eq('B4 on time', finished.resolutionBreached, false);
    eq('B4 no further cycles', await sla.openCycleFor(ticket.id), null);
    const again = await sla.finalizeOpenCycle(ticket, { at: T(`${MON}T12:00:00+01:00`) });
    eq('B4 finalization is once-only', again, null);
    eq('B4 no breach events', (await loadEvents(ticket.id)).filter((e) => e.type === 'breach').length, 0);
  }

  // B5 — late resolution with no response latches both breaches.
  {
    const ticket = await mkTicket({ priority: 'critical' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });
    const finished = await sla.finalizeOpenCycle(ticket, { at: T(`${MON}T14:00:00+01:00`) });

    eq('B5 resolution breached', finished.resolutionBreached, true);
    eq('B5 resolution duration = 5 working hours', finished.resolutionDurationMs, 18000000);
    eq('B5 response breach latched', finished.responseBreached, true);
    const breaches = (await loadEvents(ticket.id)).filter((e) => e.type === 'breach');
    eq('B5 two breach events', breaches.length, 2);
    eqMs('B5 response breach at its due instant', breaches.find((e) => e.clock === 'response').at, T(`${MON}T10:00:00+01:00`));
    eqMs('B5 resolution breach at its due instant', breaches.find((e) => e.clock === 'resolution').at, T(`${MON}T13:00:00+01:00`));
  }

  // B6 — serialization: remaining time, 25% approaching threshold, breach.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });
    const cycles = await loadCycles(ticket.id);
    const view = (now) => sla.serializeSla({ ...ticket, slaCycles: cycles }, { now });

    let s = view(T(`${MON}T09:40:00+01:00`));
    eq('B6 cycle number', s.cycleNumber, 1);
    eq('B6 response remaining = 20 working minutes', s.response.remainingMs, 1200000);
    eq('B6 response approaching before threshold', s.response.approaching, false);
    eq('B6 response not breached', s.response.breached, false);
    eq('B6 response not answered', s.response.responded, false);
    eq('B6 resolution remaining = 23h20m working', s.resolution.remainingMs, 84000000);
    eq('B6 resolution approaching before threshold', s.resolution.approaching, false);

    s = view(T(`${MON}T09:50:00+01:00`));
    eq('B6 response approaching at 25% remaining', s.response.approaching, true);

    s = view(T(`${MON}T10:10:00+01:00`));
    eq('B6 response breached past due', s.response.breached, true);
    eq('B6 approaching off once breached', s.response.approaching, false);
    eq('B6 remaining null once past due', s.response.remainingMs, null);

    s = view(T('2026-09-09T10:00:00+01:00'));
    eq('B6 resolution approaching at 25% remaining', s.resolution.approaching, true);
    eq('B6 resolution not yet breached', s.resolution.breached, false);

    s = view(T('2026-09-09T16:00:00+01:00'));
    eq('B6 resolution breached past due', s.resolution.breached, true);
    eq('B6 resolution remaining null', s.resolution.remainingMs, null);

    // Answered: the response clock is frozen at the recorded response.
    await sla.recordFirstResponse(ticket, { at: T(`${MON}T09:30:00+01:00`), responderId: agent.id });
    const cyclesAfter = await loadCycles(ticket.id);
    s = sla.serializeSla({ ...ticket, slaCycles: cyclesAfter }, { now: T(`${MON}T09:50:00+01:00`) });
    eq('B6 responded', s.response.responded, true);
    eq('B6 answered clock has no remaining', s.response.remainingMs, null);
    eq('B6 answered clock never approaching', s.response.approaching, false);
    eq('B6 answered on time', s.response.breached, false);
    eq('B6 first responder exposed', s.response.firstResponderId, agent.id);
  }

  // B7 — priority change recomputes from the cycle start (policy 8).
  {
    const ticket = await mkTicket({ priority: 'moderate' });
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });

    const raised = await sla.onPriorityChanged(
      { ...ticket, priority: 'critical' },
      { at: T(`${MON}T09:30:00+01:00`), previousPriority: 'moderate', actor: 'admin' }
    );
    const [cycle] = await loadCycles(ticket.id);
    eqMs('B7 critical due from cycle start', cycle.resolutionDueAt, T(`${MON}T13:00:00+01:00`));
    eqMs('B7 critical approach from cycle start', cycle.resolutionApproachAt, T(`${MON}T12:00:00+01:00`));
    eq('B7 not breached immediately', cycle.resolutionBreached, false);
    eqMs('B7 dueAt mirror follows', raised.dueAt, cycle.resolutionDueAt);
    eqMs('B7 response target untouched', cycle.responseDueAt, T(`${MON}T10:00:00+01:00`));
    const changed = (await loadEvents(ticket.id)).find((e) => e.type === 'target_changed');
    check('B7 target_changed event', Boolean(changed));
    eq('B7 event clock', changed.clock, 'resolution');

    // Raising priority after the fact can land in the past: that is an
    // immediate breach under policy 8, by construction.
    const late = await sla.onPriorityChanged(
      { ...ticket, priority: 'critical' },
      { at: T('2026-09-09T10:00:00+01:00'), previousPriority: 'critical' }
    );
    const [lateCycle] = await loadCycles(ticket.id);
    eq('B7 recalculation from the past breaches', lateCycle.resolutionBreached, true);
    eqMs('B7 mirror follows the recalculation', late.dueAt, lateCycle.resolutionDueAt);
  }

  // B8 — reopen: previous cycle preserved, new cycle, cycle_restarted event.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, { cycleNumber: 1, startedAt: T0 });
    await sla.recordFirstResponse(ticket, { at: T(`${MON}T09:20:00+01:00`), responderId: agent.id });
    await sla.finalizeOpenCycle(ticket, { at: T(`${MON}T11:00:00+01:00`) });
    const cycle1Before = (await loadCycles(ticket.id))[0];

    await sla.restartCycle(ticket, {
      at: T(`${MON}T12:00:00+01:00`),
      actor: 'requester@sla.example',
      reason: 'Reopened by requester reply',
    });

    const cycles = await loadCycles(ticket.id);
    eq('B8 two cycles', cycles.length, 2);
    const [c1, c2] = cycles;
    eqMs('B8 cycle 1 preserved: startedAt', c1.startedAt, cycle1Before.startedAt);
    eqMs('B8 cycle 1 preserved: endedAt', c1.endedAt, cycle1Before.endedAt);
    eqMs('B8 cycle 1 preserved: firstResponseAt', c1.firstResponseAt, cycle1Before.firstResponseAt);
    eq('B8 cycle 1 preserved: duration', c1.resolutionDurationMs, cycle1Before.resolutionDurationMs);

    eq('B8 cycle 2 number', c2.cycleNumber, 2);
    eqMs('B8 cycle 2 starts at reopen', c2.startedAt, T(`${MON}T12:00:00+01:00`));
    eqMs('B8 cycle 2 response due', c2.responseDueAt, T(`${MON}T13:00:00+01:00`));
    eqMs('B8 cycle 2 resolution due (+24wh from reopen)', c2.resolutionDueAt, T('2026-09-10T09:00:00+01:00'));
    eqMs('B8 cycle 2 resolution approach', c2.resolutionApproachAt, T('2026-09-09T12:00:00+01:00'));

    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    eqMs('B8 dueAt mirror = cycle 2 target', after.dueAt, c2.resolutionDueAt);
    eqMs('B8 responseDueAt mirror = cycle 2 target', after.responseDueAt, c2.responseDueAt);
    eq('B8 firstResponseAt mirror reset for the new cycle', after.firstResponseAt, null);
    eq('B8 responseBreached mirror reset', after.responseBreached, false);

    const restarted = (await loadEvents(ticket.id)).find((e) => e.type === 'cycle_restarted');
    check('B8 cycle_restarted event', Boolean(restarted));
    eq('B8 restart actor', restarted.actor, 'requester@sla.example');

    // Second cycle is independent: resolve it late and only cycle 2 breaches.
    // Thu 10:00 consumes Mon 5h + Tue 9h + Wed 9h + Thu 2h = 25 working hours.
    const finished = await sla.finalizeOpenCycle(ticket, { at: T('2026-09-10T10:00:00+01:00') });
    eq('B8 cycle 2 resolved late', finished.resolutionBreached, true);
    eq('B8 cycle 2 duration = 25 working hours', finished.resolutionDurationMs, 90000000);
    eq('B8 cycle 1 still intact', (await loadCycles(ticket.id))[0].resolutionBreached, false);
  }

  // B9 — SlaHoliday rows are honored through the service path.
  {
    await prisma.slaHoliday.create({
      data: { date: new Date('2026-09-08T00:00:00Z'), name: 'Fixture Holiday' },
    });
    const loaded = await sla.loadHolidaysBetween(T0, T('2026-09-09T09:00:00+01:00'));
    eq('B9 holiday loaded from the table', loaded.length, 1);
    eqMs('B9 holiday day', loaded[0], new Date('2026-09-08T00:00:00Z'));

    const ticket = await mkTicket({ priority: 'moderate' });
    const cycle = await sla.startCycle(ticket, {
      cycleNumber: 1,
      startedAt: T(`${MON}T16:30:00+01:00`),
    });
    eqMs('B9 response due skips the holiday', cycle.responseDueAt, T('2026-09-09T08:30:00+01:00'));
    eqMs('B9 response approach skips the holiday', cycle.responseApproachAt, T('2026-09-09T08:15:00+01:00'));
    eqMs('B9 resolution due skips the holiday', cycle.resolutionDueAt, T('2026-09-11T13:30:00+01:00'));
    await prisma.slaHoliday.deleteMany({});
  }

  // B10 — weekend response: clock does not accrue, breach still detected.
  {
    const ticket = await mkTicket({});
    await sla.startCycle(ticket, {
      cycleNumber: 1,
      startedAt: T('2026-09-11T16:30:00+01:00'), // Friday evening
    });
    const updated = await sla.recordFirstResponse(ticket, {
      at: T('2026-09-12T10:00:00+01:00'), // Saturday
      responderId: agent.id,
    });
    eq('B10 weekend response accrues no working time', updated.responseDurationMs, 1800000);
    // Breach is an instant comparison: Saturday 10:00 is still BEFORE the
    // Monday 08:30 deadline, so an out-of-hours response is not a breach.
    eq('B10 weekend response is before the Monday deadline', updated.responseBreached, false);
  }

  // B11 — legacy tickets (no cycles) are inert for the SLA layer.
  {
    const ticket = await mkTicket({});
    const cycles = await loadCycles(ticket.id);
    eq('B11 serialize without cycles is null', sla.serializeSla({ ...ticket, slaCycles: cycles }), null);
    eq('B11 finalize without cycles is null', await sla.finalizeOpenCycle(ticket, { at: T0 }), null);
    eq('B11 response without cycles is null', await sla.recordFirstResponse(ticket, { at: T0 }), null);
    eq('B11 priority change without cycles is null', await sla.onPriorityChanged(ticket, { at: T0 }), null);
  }

  /* ---- Part C: route wiring over HTTP ---------------------------------- */
  console.log('\n--- C. route wiring (live server) ---');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    const adminRow = await prisma.agent.create({
      data: {
        name: 'SLA Admin',
        email: `admin@${DOMAIN}`,
        role: 'admin',
        isActive: true,
        isAvailable: true,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
      },
    });
    const login = await req('/api/auth/login', { method: 'POST', body: { email: adminRow.email, password: PASSWORD } });
    eq('C0 login', login.status, 200);
    const token = login.data.token;

    // C1 — creation starts cycle 1 and syncs the mirrors.
    const created = await req('/api/tickets', {
      method: 'POST',
      token,
      body: {
        shortDescription: 'SLA wiring ticket',
        requesterEmail: `wiring@${DOMAIN}`,
        priority: 'critical',
        autoAssign: false,
      },
    });
    eq('C1 create', created.status, 201);
    eq('C1 response carries sla', created.data.sla && created.data.sla.cycleNumber, 1);
    check('C1 raw cycle rows stripped from payload', created.data.slaCycles === undefined);
    const row = await prisma.ticket.findUnique({ where: { id: created.data.id } });
    const [cycle1] = await loadCycles(row.id);
    check('C1 cycle 1 exists', Boolean(cycle1));
    eqMs('C1 cycle starts at creation', cycle1.startedAt, row.createdAt);
    const critTargets = sla.computeTargets({ priority: 'critical', from: cycle1.startedAt, holidays: [] });
    eqMs('C1 resolution target on the working calendar', cycle1.resolutionDueAt, critTargets.resolutionDueAt);
    eqMs('C1 response target on the working calendar', cycle1.responseDueAt, critTargets.responseDueAt);
    eqMs('C1 dueAt mirror', row.dueAt, cycle1.resolutionDueAt);
    eqMs('C1 responseDueAt mirror', row.responseDueAt, cycle1.responseDueAt);

    // C2 — GET /:id exposes the SLA block.
    const got = await req(`/api/tickets/${row.id}`, { token });
    eq('C2 get sla block', got.data.sla && got.data.sla.cycleNumber, 1);
    eqMs('C2 response due exposed', got.data.sla.response.dueAt, cycle1.responseDueAt);
    eqMs('C2 resolution due exposed', got.data.sla.resolution.dueAt, cycle1.resolutionDueAt);

    // C3 — internal note: no response recorded.
    const internal = await req(`/api/tickets/${row.id}/notes`, {
      method: 'POST', token, body: { body: 'internal investigation', isInternal: true },
    });
    eq('C3 internal note accepted', internal.status, 201);
    eq('C3 internal note is not a response', (await loadCycles(row.id))[0].firstResponseAt, null);

    // C4 — public note records the first response.
    const publish = await req(`/api/tickets/${row.id}/notes`, {
      method: 'POST', token, body: { body: 'We are on it — updating the network driver.' },
    });
    eq('C4 public note accepted', publish.status, 201);
    const answered = (await loadCycles(row.id))[0];
    check('C4 first response recorded', Boolean(answered.firstResponseAt));
    eq('C4 responder attributed', answered.firstResponderId, adminRow.id);
    check('C4 response event', (await loadEvents(row.id)).some((e) => e.type === 'response_recorded'));
    const mirror = await prisma.ticket.findUnique({ where: { id: row.id } });
    eqMs('C4 mirror firstResponseAt', mirror.firstResponseAt, answered.firstResponseAt);

    // C5 — PATCH priority recomputes the cycle target from the cycle start.
    const patched = await req(`/api/tickets/${row.id}`, { method: 'PATCH', token, body: { priority: 'moderate' } });
    eq('C5 patch accepted', patched.status, 200);
    const [recalced] = await loadCycles(row.id);
    const modTargets = sla.computeTargets({ priority: 'moderate', from: recalced.startedAt, holidays: [] });
    eqMs('C5 resolution target recomputed from cycle start', recalced.resolutionDueAt, modTargets.resolutionDueAt);
    eqMs('C5 dueAt follows the recalculation', (await prisma.ticket.findUnique({ where: { id: row.id } })).dueAt, recalced.resolutionDueAt);
    eqMs('C5 response target untouched by priority', recalced.responseDueAt, critTargets.responseDueAt);
    check('C5 target_changed event', (await loadEvents(row.id)).some((e) => e.type === 'target_changed'));
    check('C5 patched body exposes the new target', patched.data.sla.resolution.dueAt !== null);

    // C6 — resolve finalizes the cycle.
    const started = await req(`/api/tickets/${row.id}/start`, { method: 'POST', token, body: {} });
    eq('C6 start accepted', started.status, 200);
    const resolved = await req(`/api/tickets/${row.id}/resolve`, {
      method: 'POST', token, body: { resolution: 'Driver updated, verified with the requester.' },
    });
    eq('C6 resolve accepted', resolved.status, 200);
    eq('C6 body reports the ended cycle', resolved.data.sla.cycleEndedAt !== null, true);
    eq('C6 body reports on-time resolution', resolved.data.sla.resolution.breached, false);
    const finalized = (await loadCycles(row.id))[0];
    check('C6 cycle ended', finalized.endedAt !== null);
    check('C6 resolvedAt recorded', finalized.resolvedAt !== null);
    check('C6 resolution duration present', finalized.resolutionDurationMs !== null);
    eq('C6 no breach on a fast resolution', finalized.resolutionBreached, false);
    eq('C6 response answered', finalized.firstResponseAt !== null, true);

    // C7 — requester reply reopens: previous cycle preserved, cycle 2 started.
    const before = (await loadCycles(row.id))[0];
    const reply = await intakeEmailMessage({
      messageId: `sla-wiring-reopen-${row.id}`,
      subject: `Re: [${row.ticketNumber}] it broke again`,
      from: `wiring@${DOMAIN}`,
      body: 'The same fault is back.',
    });
    eq('C7 reply reopens the ticket', reply.status, 'reopened');
    const cycles = await loadCycles(row.id);
    eq('C7 two cycles', cycles.length, 2);
    eqMs('C7 cycle 1 endedAt unchanged', cycles[0].endedAt, before.endedAt);
    eqMs('C7 cycle 1 resolvedAt unchanged', cycles[0].resolvedAt, before.resolvedAt);
    check('C7 cycle 2 started', cycles[1].startedAt > cycles[0].startedAt);
    check('C7 cycle_restarted event', (await loadEvents(row.id)).some((e) => e.type === 'cycle_restarted'));
    const reopenedRow = await prisma.ticket.findUnique({ where: { id: row.id } });
    eq('C7 response clock reset for cycle 2', reopenedRow.firstResponseAt, null);
    eqMs('C7 dueAt mirror = cycle 2 target', reopenedRow.dueAt, cycles[1].resolutionDueAt);
    eqMs('C7 responseDueAt mirror = cycle 2 target', reopenedRow.responseDueAt, cycles[1].responseDueAt);

    // C8 — legacy ticket (no cycle): SLA layer stays out of the way.
    const legacy = await mkTicket({ priority: 'low' });
    const legacyGet = await req(`/api/tickets/${legacy.id}`, { token });
    eq('C8 legacy ticket serializes sla=null', legacyGet.data.sla, null);
    const legacyPatch = await req(`/api/tickets/${legacy.id}`, { method: 'PATCH', token, body: { priority: 'moderate' } });
    eq('C8 legacy patch accepted', legacyPatch.status, 200);
    const legacyRow = await prisma.ticket.findUnique({ where: { id: legacy.id } });
    eqMs('C8 legacy dueAt keeps the calendar rule', legacyRow.dueAt, computeDueAt('moderate', legacyRow.createdAt));
    const legacyStart = await req(`/api/tickets/${legacy.id}/start`, { method: 'POST', token, body: {} });
    eq('C8 legacy start accepted', legacyStart.status, 200);
    const legacyResolve = await req(`/api/tickets/${legacy.id}/resolve`, {
      method: 'POST', token, body: { resolution: 'Answered on the phone.' },
    });
    eq('C8 legacy resolve accepted', legacyResolve.status, 200);
    eq('C8 legacy ticket still has no cycles', (await loadCycles(legacy.id)).length, 0);
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
