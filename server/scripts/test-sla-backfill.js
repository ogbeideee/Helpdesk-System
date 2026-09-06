/* Historical SLA backfill: reconstruction correctness and safety on PostgreSQL.
 *
 * Drives src/slaBackfill.js directly against a disposable database with fixed
 * instants on the documented calendar (Mon–Fri 08:00–17:00 Africa/Lagos,
 * UTC+01:00 all year; fixtures use the week Mon 2026-09-07 … Fri 2026-09-11).
 * A Setting row deliberately overrides the configured response target, so the
 * suite also proves the backfill reconstructs from the DOCUMENTED DEFAULT
 * policy rather than today's configuration.
 *
 * Covered: empty database; eligible resolved/open tickets; tickets that
 * already have cycles; missing lifecycle information (open-ended cycle,
 * approximated ends); reopen chains; the approaching window (sweeper parity);
 * repeated/idempotent execution; preservation of all ticket data; zero
 * notification side effects; and source attribution (source = 'backfill',
 * actor = 'backfill').
 *
 * Usage: npm run test:sla-backfill  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-backfill');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const sla = require('../src/slaService');
const backfill = require('../src/slaBackfill');

const PASSWORD = 'Backfill!123';

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

// Lagos wall-clock instants on the documented working calendar.
const T = (s) => new Date(s);
const iso = (d) => new Date(d).toISOString();
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';
const THU = '2026-09-10';
const LATER = T('2027-03-01T09:00:00+01:00');
const NOW_LATER = () => LATER; // every historical clock has run out long ago

async function mkTicket(overrides = {}, auditLogs = [], comments = []) {
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
      shortDescription: 'Backfill fixture',
      body: 'Backfill fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'email',
      requesterEmail: 'requester@backfill.example',
      ...overrides,
      auditLogs: { create: auditLogs },
      comments: { create: comments },
    },
    include: { auditLogs: true, comments: true },
  });
}

const audit = (fromState, toState, at, note = null) => ({ fromState, toState, actor: 'tester', note, createdAt: at });
const agentComment = (at, authorAgentId) => ({
  authorAgentId,
  authorName: 'Backfill Agent',
  authorEmail: 'agent@backfill.example',
  isRequester: false,
  isInternal: false,
  body: 'Public agent reply',
  createdAt: at,
});

const snapshotTicket = (id) =>
  prisma.ticket.findUnique({ where: { id }, include: { auditLogs: true, comments: true } });
const snapJson = async (id) => JSON.stringify(await snapshotTicket(id));
const cyclesOf = (id) => prisma.ticketSlaCycle.findMany({ where: { ticketId: id }, orderBy: { cycleNumber: 'asc' } });
const eventsOf = (id) => prisma.ticketSlaEvent.findMany({ where: { ticketId: id }, orderBy: [{ cycleId: 'asc' }, { id: 'asc' }] });

async function main() {
  await prisma.agent.create({
    data: {
      name: 'Backfill Agent',
      email: 'agent@backfill.example',
      role: 'agent',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });

  /* ---- A. empty database ------------------------------------------------ */
  console.log('\n--- A. empty database ---');
  {
    const s = await backfill.backfillSla({ now: NOW_LATER() });
    eq('A1 empty db scans nothing', s.ticketsScanned, 0);
    eq('A1 no cycles planned', s.cyclesCreated, 0);
    eq('A1 no events planned', s.eventsCreated, 0);
  }

  /* ---- the configured policy must NOT leak into the reconstruction ------ */
  // An administrator has since changed the response target to 4 working
  // hours; historical cycles must still be reconstructed with the documented
  // default (1 working hour).
  await prisma.setting.create({
    data: { key: 'slaResponseTargetMinutes', value: '240', updatedBy: 'backfill-test' },
  });

  /* ---- B. eligible historical tickets + dry-run ------------------------- */
  console.log('\n--- B. eligible tickets, dry-run, preservation ---');
  // t1 — clean resolved cycle: answered in 30 working minutes, resolved same
  // day, everything on time.
  const t1 = await mkTicket(
    { state: 'RESOLVED', createdAt: T(`${MON}T09:00:00+01:00`), resolvedAt: T(`${MON}T13:00:00+01:00`), resolution: 'fixed' },
    [
      audit(null, 'NEW', T(`${MON}T09:00:00+01:00`), 'created'),
      audit('NEW', 'IN_PROGRESS', T(`${MON}T09:40:00+01:00`)),
      audit('IN_PROGRESS', 'RESOLVED', T(`${MON}T13:00:00+01:00`)),
    ],
    [agentComment(T(`${MON}T09:30:00+01:00`), 1)]
  );
  // t2 — late first response.
  const t2 = await mkTicket(
    { state: 'RESOLVED', createdAt: T(`${MON}T09:00:00+01:00`), resolvedAt: T(`${MON}T16:00:00+01:00`), resolution: 'fixed' },
    [audit('IN_PROGRESS', 'RESOLVED', T(`${MON}T16:00:00+01:00`))],
    [agentComment(T(`${MON}T10:30:00+01:00`), 1)]
  );
  // t3 — resolved, never answered.
  const t3 = await mkTicket(
    { state: 'RESOLVED', createdAt: T(`${MON}T09:00:00+01:00`), resolvedAt: T(`${MON}T16:00:00+01:00`), resolution: 'fixed' },
    [audit('IN_PROGRESS', 'RESOLVED', T(`${MON}T16:00:00+01:00`))]
  );
  // t4 — already carries a live SLA cycle; must never be touched.
  const t4 = await mkTicket({ createdAt: T(`${MON}T09:00:00+01:00`) });
  await sla.startCycle(t4, { cycleNumber: 1, startedAt: t4.createdAt });
  const t4CyclesBefore = await cyclesOf(t4.id);
  const t4EventsBefore = await eventsOf(t4.id);

  const t1Snap = await snapJson(t1.id);
  const t4Snap = await snapJson(t4.id);
  // The only rows in the SLA tables before the backfill are t4's live cycle.
  const rowsBefore = {
    cycles: await prisma.ticketSlaCycle.count(),
    events: await prisma.ticketSlaEvent.count(),
  };

  // Dry-run: full plan, zero writes.
  const dry = await backfill.backfillSla({ now: NOW_LATER(), dryRun: true });
  eq('B1 dry-run finds the eligible tickets', dry.ticketsEligible, 3);
  eq('B1 dry-run plans 3 cycles', dry.cyclesCreated, 3);
  eq('B1 dry-run creates nothing', await prisma.ticketSlaCycle.count(), rowsBefore.cycles);
  eq('B1 dry-run creates no events', await prisma.ticketSlaEvent.count(), rowsBefore.events);

  // Real run — identical plan.
  const real = await backfill.backfillSla({ now: NOW_LATER() });
  eq('B2 real run plans the same cycles as the dry run', real.cyclesCreated, dry.cyclesCreated);
  eq('B2 real run plans the same events as the dry run', real.eventsCreated, dry.eventsCreated);
  eq('B2 one live ticket was skipped', real.ticketsEligible, 3);
  check('B2 ticket data untouched (t1)', (await snapJson(t1.id)) === t1Snap);
  check('B2 ticket data untouched (live t4)', (await snapJson(t4.id)) === t4Snap);
  eq('B2 live ticket still has exactly its own cycle', (await cyclesOf(t4.id)).length, 1);
  eq('B2 live ticket gained no events', (await eventsOf(t4.id)).length, t4EventsBefore.length);

  // t1 assertions — a clean reconstructed cycle.
  const [t1c] = await cyclesOf(t1.id);
  eq('B3 t1 cycle source is backfill', t1c.source, 'backfill');
  eq('B3 t1 starts at ticket creation', iso(t1c.startedAt), iso(T(`${MON}T09:00:00+01:00`)));
  eq('B3 t1 ends at the audited resolve', iso(t1c.endedAt), iso(T(`${MON}T13:00:00+01:00`)));
  eq('B3 t1 resolvedAt matches', iso(t1c.resolvedAt), iso(T(`${MON}T13:00:00+01:00`)));
  eq('B3 t1 response target from the DOCUMENTED DEFAULT policy (1 working hour)',
    iso(t1c.responseDueAt), iso(T(`${MON}T10:00:00+01:00`)));
  eq('B3 t1 resolution target (24 working hours = 8+9+7 over three 09:00-17:00 days)',
    iso(t1c.resolutionDueAt), iso(T(`${WED}T15:00:00+01:00`)));
  eq('B3 t1 first response reconstructed from the comment', iso(t1c.firstResponseAt), iso(T(`${MON}T09:30:00+01:00`)));
  eq('B3 t1 response duration is working time', t1c.responseDurationMs, 30 * 60000);
  eq('B3 t1 resolution duration is working time', t1c.resolutionDurationMs, 4 * 3600000);
  eq('B3 t1 response on time', t1c.responseBreached, false);
  eq('B3 t1 resolution on time', t1c.resolutionBreached, false);
  const t1e = await eventsOf(t1.id);
  eq('B3 t1 has target_created + response_recorded only', t1e.map((e) => e.type).join(','), 'target_created,response_recorded');
  check('B3 every t1 event is authored by the backfill', t1e.every((e) => e.actor === 'backfill'));
  check('B3 response event links to the cycle', t1e[1].cycleId === t1c.id && t1e[1].clock === 'response');

  // t2/t3 — breached reconstructions.
  const [t2c] = await cyclesOf(t2.id);
  eq('B4 t2 late response latched', t2c.responseBreached, true);
  eq('B4 t2 resolution on time', t2c.resolutionBreached, false);
  eq('B4 t2 response duration', t2c.responseDurationMs, 90 * 60000);
  const t2e = await eventsOf(t2.id);
  const t2Breach = t2e.find((e) => e.type === 'breach');
  check('B4 t2 has a response breach event at the target', Boolean(t2Breach) && t2Breach.clock === 'response' && iso(t2Breach.at) === iso(T(`${MON}T10:00:00+01:00`)));
  const [t3c] = await cyclesOf(t3.id);
  eq('B5 t3 unanswered cycle latches the response breach', t3c.responseBreached, true);
  eq('B5 t3 first response stays unknown', t3c.firstResponseAt, null);
  const t3e = await eventsOf(t3.id);
  check('B5 t3 breach event says the cycle ended unanswered',
    t3e.some((e) => e.type === 'breach' && e.clock === 'response' && /ended/.test(e.detail)));
  eq('B5 summary counted the reconstructed responses', real.responsesReconstructed, 2);
  eq('B5 summary counted the response breaches', real.responseBreaches, 2);

  /* ---- C. reopen chain --------------------------------------------------- */
  console.log('\n--- C. reopened ticket: two cycles ---');
  const agent = await prisma.agent.findUnique({ where: { email: 'agent@backfill.example' } });
  const t8 = await mkTicket(
    { state: 'IN_PROGRESS', createdAt: T(`${MON}T09:00:00+01:00`), resolvedAt: null },
    [
      audit('NEW', 'IN_PROGRESS', T(`${MON}T09:20:00+01:00`)),
      audit('IN_PROGRESS', 'RESOLVED', T(`${MON}T13:00:00+01:00`)),
      audit('RESOLVED', 'IN_PROGRESS', T(`${TUE}T10:00:00+01:00`), 'Reopened by requester reply'),
    ],
    [agentComment(T(`${MON}T09:30:00+01:00`), agent.id), agentComment(T(`${TUE}T10:20:00+01:00`), agent.id)]
  );
  const s8 = await backfill.backfillSla({ now: NOW_LATER() });
  eq('C1 reopen ticket backfilled', s8.ticketsEligible, 1);
  const t8c = await cyclesOf(t8.id);
  eq('C1 two cycles reconstructed', t8c.length, 2);
  eq('C1 cycle 1 closed at the audited resolve', iso(t8c[0].endedAt), iso(T(`${MON}T13:00:00+01:00`)));
  eq('C1 cycle 1 keeps its own response', iso(t8c[0].firstResponseAt), iso(T(`${MON}T09:30:00+01:00`)));
  eq('C1 cycle 2 starts at the reopen instant', iso(t8c[1].startedAt), iso(T(`${TUE}T10:00:00+01:00`)));
  eq('C1 cycle 2 is the open cycle', t8c[1].endedAt, null);
  eq('C1 cycle 2 response from the later comment', iso(t8c[1].firstResponseAt), iso(T(`${TUE}T10:20:00+01:00`)));
  eq('C1 cycle 2 attributes the responder', t8c[1].firstResponderId, agent.id);
  eq('C1 both cycles are backfill', t8c.every((c) => c.source === 'backfill'), true);
  const t8e = await eventsOf(t8.id);
  const restart = t8e.find((e) => e.type === 'cycle_restarted');
  check('C1 cycle_restarted event on cycle 2', Boolean(restart) && restart.cycleId === t8c[1].id);
  eq('C1 response events per cycle', t8e.filter((e) => e.type === 'response_recorded').length, 2);

  /* ---- D. missing lifecycle information ---------------------------------- */
  console.log('\n--- D. missing lifecycle ---');
  // t5 — resolved with NO audit trail and NO resolvedAt: an open cycle with
  // no invented outcome.
  const t5 = await mkTicket({ state: 'RESOLVED', createdAt: T(`${MON}T09:00:00+01:00`) });
  // t6 — only the reopen row survived: cycle 1 ends at the reopen instant
  // (approximated), cycle 2 is the open cycle.
  const t6 = await mkTicket(
    { state: 'IN_PROGRESS', createdAt: T(`${MON}T09:00:00+01:00`) },
    [audit('RESOLVED', 'IN_PROGRESS', T(`${TUE}T10:00:00+01:00`), 'Reopened by requester reply')]
  );
  // t7 — closed with only closedAt surviving.
  const t7 = await mkTicket(
    { state: 'CLOSED', createdAt: T(`${MON}T09:00:00+01:00`), closedAt: T(`${TUE}T12:00:00+01:00`) }
  );
  const sD = await backfill.backfillSla({ now: NOW_LATER() });
  eq('D1 three tickets backfilled', sD.ticketsEligible, 3);
  // t5's cycle and t6's second (still-open) cycle have no recoverable end.
  eq('D1 two cycles had no recoverable end', sD.openEndedCycles, 2);
  eq('D1 two ends were approximated from real instants', sD.approximatedEnds, 2);

  const [t5c] = await cyclesOf(t5.id);
  eq('D2 t5 cycle stays open (nothing invented)', t5c.endedAt, null);
  eq('D2 t5 first response stays unknown', t5c.firstResponseAt, null);
  eq('D2 t5 resolution outcome stays unknown', t5c.resolutionDurationMs, null);
  eq('D2 t5 live response breach recorded', t5c.responseBreached, true);
  eq('D2 t5 live resolution breach recorded', t5c.resolutionBreached, true);
  const t5e = await eventsOf(t5.id);
  eq('D2 t5 events: target + the two live breaches', t5e.map((e) => e.type).sort().join(','), 'breach,breach,target_created');
  check('D2 breach events sit at the frozen targets',
    t5e.filter((e) => e.type === 'breach').every((e) =>
      iso(e.at) === iso(T(`${WED}T15:00:00+01:00`)) || iso(e.at) === iso(T(`${MON}T10:00:00+01:00`))));

  const t6c = await cyclesOf(t6.id);
  eq('D3 t6 two cycles', t6c.length, 2);
  eq('D3 t6 cycle 1 ends at the reopen instant', iso(t6c[0].endedAt), iso(T(`${TUE}T10:00:00+01:00`)));
  eq('D3 t6 cycle 2 is open', t6c[1].endedAt, null);
  const t6e = await eventsOf(t6.id);
  check('D3 t6 has a cycle_restarted event', t6e.some((e) => e.type === 'cycle_restarted' && e.cycleId === t6c[1].id));

  const [t7c] = await cyclesOf(t7.id);
  eq('D4 t7 ends at the recorded close instant', iso(t7c.endedAt), iso(T(`${TUE}T12:00:00+01:00`)));

  /* ---- E. approaching window (sweeper parity, no notifications) ---------- */
  console.log('\n--- E. approaching window ---');
  // Critical ticket created Thu 09:00: response target Thu 10:00, resolution
  // target Thu 13:00, approach instants Thu 09:45 / Thu 12:00. Observed at
  // Thu 12:30 the resolution clock is inside the 25% window and the response
  // clock has run out — exactly the states the live sweeper records events
  // for. The backfill records them itself so the sweeper never notifies.
  const t9 = await mkTicket({ priority: 'critical', createdAt: T(`${THU}T09:00:00+01:00`) });
  const sE = await backfill.backfillSla({ now: T(`${THU}T12:30:00+01:00`) });
  eq('E1 critical ticket backfilled', sE.ticketsEligible, 1);
  const [t9c] = await cyclesOf(t9.id);
  eq('E1 response clock past due', t9c.responseBreached, true);
  eq('E1 resolution clock approaching', t9c.resolutionApproached, true);
  eq('E1 resolution not yet breached', t9c.resolutionBreached, false);
  const t9e = await eventsOf(t9.id);
  const t9approach = t9e.find((e) => e.type === 'approaching_breach');
  check('E1 approaching_breach event at the approach instant',
    Boolean(t9approach) && t9approach.clock === 'resolution' && iso(t9approach.at) === iso(T(`${THU}T12:00:00+01:00`)));
  eq('E1 breach + approaching events', t9e.filter((e) => e.type === 'breach' || e.type === 'approaching_breach').length, 2);

  /* ---- F. serialization visibility --------------------------------------- */
  console.log('\n--- F. serializeSla sees the backfilled history ---');
  {
    const full = await snapshotTicket(t1.id);
    full.slaCycles = await cyclesOf(t1.id);
    const view = sla.serializeSla(full, { now: NOW_LATER() });
    check('F1 t1 now has an SLA view', Boolean(view));
    eq('F1 source is backfill', view.source, 'backfill');
    eq('F1 response recorded', view.response.responded, true);
    eq('F1 no breaches on t1', view.response.breached || view.resolution.breached, false);
  }

  /* ---- G. idempotent re-execution + no notification side effects --------- */
  console.log('\n--- G. idempotence + no notifications ---');
  const before = {
    cycles: await prisma.ticketSlaCycle.count(),
    events: await prisma.ticketSlaEvent.count(),
    notifications: await prisma.notification.count(),
  };
  const again = await backfill.backfillSla({ now: NOW_LATER() });
  eq('G1 a second run scans nothing new', again.ticketsScanned, 0);
  eq('G1 a second run creates no cycles', again.cyclesCreated, 0);
  eq('G1 a second run creates no events', again.eventsCreated, 0);
  eq('G1 cycle rows unchanged', await prisma.ticketSlaCycle.count(), before.cycles);
  eq('G1 event rows unchanged', await prisma.ticketSlaEvent.count(), before.events);
  eq('G2 no SLA notification was ever created', before.notifications, 0);
  eq('G2 still no notifications after the second run', await prisma.notification.count(), 0);
  // Exactly one live-source cycle exists in the whole database — t4's own,
  // created before the backfill. Everything else is backfill.
  const allCycles = await prisma.ticketSlaCycle.findMany();
  const liveCycles = allCycles.filter((c) => c.source !== 'backfill');
  eq('G3 the pre-existing live cycle is the only non-backfill cycle',
    liveCycles.length, t4CyclesBefore.length);
  eq('G3 every backfilled cycle carries source=backfill',
    allCycles.length - liveCycles.length, before.cycles - t4CyclesBefore.length);
  check('G3 the live cycle belongs to t4', liveCycles.every((c) => c.ticketId === t4.id));
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
