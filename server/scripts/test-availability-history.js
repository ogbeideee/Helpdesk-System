/* Agent Unavailability Timeline.
 *
 * Persistent history for availability state changes, recorded through the
 * ONE availability transition path (applyAvailabilityState / the user-update
 * path) so every state change is captured consistently:
 *
 *   A. Initial state — no transitions, no periods; first transition opens one
 *   B. online -> unavailable -> online
 *   C. Transitions involving offline (state endpoint AND the PATCH
 *      deactivation/reactivation path in userService)
 *   D. Repeated same-state updates create no duplicate period
 *   E. Multiple consecutive periods form a strict chain
 *   F. The current period stays open (endedAt null) until the next transition
 *   G. Duration calculation (exact, with injected transition times)
 *   H. Actor/source attribution (admin state changes vs self-service vs PATCH)
 *   I. Read APIs: one agent's history + the admin-wide filtered view (live)
 *   J. Authentication/authorization (live)
 *   K. Server restart: history survives, replays duplicate nothing
 *   L. Zero ticket/assignment/SLA side effects
 *   M. Existing handover behavior unchanged (pause/resume/refusal)
 *   N. Audit-row shapes unchanged (legacy self rows, state rows, PATCH rows)
 *
 * Everything runs against the real (isolated) database and the REAL services;
 * only the live sections spawn server.js. Usage: npm run test:availability-history
 * (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4231';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('availhist');

const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { nextTicketNumber } = require('../src/ticketNumbers');

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

const PASSWORD = 'HistSuite!123';
const DOMAIN = 'hist.test';

// Spawn the REAL server.js against this suite's database (testdb.use has
// already pointed DATABASE_URL/DIRECT_URL at it, and the spawned process
// inherits this env). A restart is just a second spawn over the same DB.
async function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`http://localhost:${process.env.PORT}/api/health`)).ok) return proc; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

async function stopServer(proc) {
  proc.kill();
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
}

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`http://localhost:${process.env.PORT}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const poolService = require('../src/services/assignmentPoolService');
const historyService = require('../src/services/availabilityHistoryService');
const userService = require('../src/services/userService');
const handoverService = require('../src/services/handoverService');
const slaService = require('../src/slaService');

// Deterministic transition times for the service-level sections.
const BASE = new Date('2026-09-06T09:00:00.000Z');
const T = (h) => new Date(BASE.getTime() + h * 3600000);

async function mkAgent(name, email, { role = 'agent', teamId = null, skillLevel = 2, isAvailable = true } = {}) {
  const a = await prisma.agent.create({
    data: {
      name, email, role: 'agent', isActive: true, isAvailable,
      skillLevel, teamId, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
  if (role !== 'agent') await prisma.agent.update({ where: { id: a.id }, data: { role } });
  return a;
}

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'History fixture ticket',
      body: 'History fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

const periodsOf = async (agentId) =>
  prisma.agentAvailabilityPeriod.findMany({ where: { agentId }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] });

(async () => {
  const net = await prisma.team.create({ data: { key: 'hist-net', name: 'History Network' } });

  const admin = await mkAgent('History Admin', `admin@${DOMAIN}`, { role: 'admin', teamId: net.id });
  const mia = await mkAgent('Mia Online', `mia@${DOMAIN}`, { teamId: net.id, skillLevel: 2 });
  const theo = await mkAgent('Theo Away', `theo@${DOMAIN}`, { teamId: net.id, skillLevel: 2 });

  /* ==================================================================== */
  /* A. Initial state                                                      */
  /* ==================================================================== */
  console.log('\n--- A. initial state ---');
  {
    const before = await historyService.agentHistory(mia.id);
    eq('A1 an agent that never transitioned has no periods', before.periods.length, 0);
    eq('A2 the current state still comes from the columns', before.agent.availabilityState, 'online');
    eq('A3 an unknown agent reads as null', await historyService.agentHistory(999999), null);
    eq('A4 recordTransition refuses a same-state write outright',
      await historyService.recordTransition({ agentId: mia.id, from: 'online', to: 'online' }), null);

    // First-ever transition: nothing to close, one period opens.
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'unavailable', actor: admin, at: T(1) });
    const rows = await periodsOf(mia.id);
    eq('A5 the first transition opens exactly one period', rows.length, 1);
    eq('A6 it records the new state', rows[0].state, 'unavailable');
    eq('A7 it records where the state came from', rows[0].previousState, 'online');
    eq('A8 it started at the transition', rows[0].startedAt.toISOString(), T(1).toISOString());
    eq('A9 and it is open', rows[0].endedAt, null);
  }

  /* ==================================================================== */
  /* B. online -> unavailable -> online                                    */
  /* ==================================================================== */
  console.log('\n--- B. online -> unavailable -> online ---');
  {
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'online', actor: admin, at: T(2) });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'unavailable', actor: admin, at: T(3) });
    const rows = await periodsOf(mia.id);
    eq('B1 three real transitions make three periods', rows.length, 3);
    eq('B2 the first period closed when the second opened', rows[0].endedAt.toISOString(), T(2).toISOString());
    eq('B3 the closed/open boundary is exact', rows[1].startedAt.toISOString(), rows[0].endedAt.toISOString());
    eq('B4 the second period is online after unavailable', rows[1].state, 'online');
    eq('B5 its previousState chains back', rows[1].previousState, 'unavailable');
    eq('B6 the third period is the current one', rows[2].endedAt, null);
    eq('B7 closed rows keep their history', rows[0].endedAt !== null && rows[1].endedAt !== null, true);
  }

  /* ==================================================================== */
  /* C. Transitions involving offline                                      */
  /* ==================================================================== */
  console.log('\n--- C. offline transitions (state endpoint + PATCH path) ---');
  {
    const tProg = await mkTicket({ assignedAgentId: theo.id, teamId: net.id, state: 'IN_PROGRESS' });

    // The presence-only state path: offline.
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'offline', actor: admin, at: T(4) });
    let rows = await periodsOf(theo.id);
    eq('C1 going offline opens an offline period', rows.length, 1);
    eq('C2 it came from online', rows[0].previousState, 'online');
    eq('C3 an offline agent keeps their tickets',
      (await prisma.ticket.findUnique({ where: { id: tProg.id } })).assignedAgentId, theo.id);

    // The PATCH deactivation path (userService.applyUserUpdate — what
    // PATCH /api/agents/:id uses) reactivates: offline -> unavailable,
    // because the offline write had also parked isAvailable.
    const offlineRow = await prisma.agent.findUnique({ where: { id: theo.id } });
    await userService.applyUserUpdate(offlineRow, admin, { isActive: true });
    rows = await periodsOf(theo.id);
    eq('C4 reactivation through PATCH opens the next period', rows.length, 2);
    eq('C5 it lands in unavailable (isAvailable was parked)', rows[1].state, 'unavailable');
    eq('C6 chained from offline', rows[1].previousState, 'offline');
    eq('C7 the PATCH path attributes to the admin', rows[1].actorId, admin.id);
    eq('C8 and records the source', rows[1].source, 'admin');

    // PATCH availability flips on top.
    const unavailableRow = await prisma.agent.findUnique({ where: { id: theo.id } });
    await userService.applyUserUpdate(unavailableRow, admin, { isAvailable: true });
    let fresh = await periodsOf(theo.id);
    eq('C9 PATCH to available opens an online period', fresh[2].state, 'online');
    eq('C10 with the audit note as its context', fresh[2].note, 'Marked available');
    await userService.applyUserUpdate(await prisma.agent.findUnique({ where: { id: theo.id } }), admin, { isAvailable: false });
    fresh = await periodsOf(theo.id);
    eq('C11 PATCH to unavailable opens an unavailable period', fresh[3].state, 'unavailable');

    // A PATCH that changes nothing about availability records nothing.
    const countBefore = (await periodsOf(theo.id)).length;
    await userService.applyUserUpdate(await prisma.agent.findUnique({ where: { id: theo.id } }), admin, { isAvailable: false });
    eq('C12 a no-change PATCH adds no period', (await periodsOf(theo.id)).length, countBefore);
    eq('C13 the reactivated account is genuinely active again',
      (await prisma.agent.findUnique({ where: { id: theo.id } })).isActive, true);

    // Back online for the handover sections below (agents may only hand work
    // to available teammates, so an unavailable target would skew L/M).
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'online', actor: admin });
  }

  /* ==================================================================== */
  /* D. Repeated same-state update                                         */
  /* ==================================================================== */
  console.log('\n--- D. repeated same-state update ---');
  {
    const before = await periodsOf(mia.id); // mia is unavailable since T(3)
    eq('D1 mia has three periods so far', before.length, 3);
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'unavailable', actor: admin, at: T(5) });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'unavailable', actor: admin, at: T(6) });
    const after = await periodsOf(mia.id);
    eq('D2 repeated same-state updates create no duplicate period', after.length, 3);
    eq('D3 the open period did not close', after[2].endedAt, null);
    eq('D4 its start is still the original transition', after[2].startedAt.toISOString(), T(3).toISOString());
  }

  /* ==================================================================== */
  /* E. Multiple consecutive periods + F. open period + G. durations       */
  /* ==================================================================== */
  console.log('\n--- E/F/G. the chain, the open period, the durations ---');
  {
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'online', actor: admin, at: T(7) });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'offline', actor: admin, at: T(8) });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'online', actor: admin, at: T(9) });

    const view = await historyService.agentHistory(mia.id);
    const chain = [...view.periods].reverse(); // oldest first
    eq('E1 six periods, newest first from the API', view.periods.length, 6);
    eq('E2 the state chain is exact',
      chain.map((p) => p.state).join(','),
      'unavailable,online,unavailable,online,offline,online');
    eq('E3 the previousState chain is exact',
      chain.map((p) => p.previousState).join(','),
      'online,unavailable,online,unavailable,online,offline');
    check('E4 consecutive periods share their boundary',
      chain.slice(0, -1).every((p, i) => p.endedAt === chain[i + 1].startedAt));

    const current = view.periods[0];
    eq('F1 the newest period is the open one', current.isOpen, true);
    eq('F2 it has no end', current.endedAt, null);
    eq('F3 it carries no finished duration', current.durationMs, null);
    check('F4 every closed period is marked closed', view.periods.slice(1).every((p) => !p.isOpen));

    eq('G1 a closed period exposes its exact duration (1h)',
      view.periods[1].durationMs, 3600000);
    eq('G2 the 4-hour period measures 4 hours', view.periods[3].durationMs, 4 * 3600000);
    eq('G3 the other 1-hour period measures 1 hour', view.periods[2].durationMs, 3600000);
    check('G4 durations equal end minus start throughout',
      view.periods.slice(1).every((p) => p.durationMs === new Date(p.endedAt).getTime() - new Date(p.startedAt).getTime()));
  }

  /* ==================================================================== */
  /* H. Actor/source attribution                                           */
  /* ==================================================================== */
  console.log('\n--- H. actor/source attribution ---');
  {
    const miaPeriods = await periodsOf(mia.id);
    check('H1 admin-driven state changes record the admin as actor',
      miaPeriods.every((p) => p.actorId === admin.id));
    check('H2 and the admin source', miaPeriods.every((p) => p.source === 'admin'));
    const theoPeriods = await periodsOf(theo.id);
    check('H3 PATCH-driven changes attribute to the acting admin too',
      theoPeriods.slice(1).every((p) => p.actorId === admin.id && p.source === 'admin'));
    eq('H4 the API surfaces the actor by name',
      (await historyService.agentHistory(mia.id)).periods[1].actor.name, admin.name);
    // Self-service attribution is proven live in section J (H5 there).
  }

  /* ==================================================================== */
  /* L. Zero ticket/assignment/SLA side effects                            */
  /* ==================================================================== */
  console.log('\n--- L. zero ticket/assignment/SLA side effects ---');
  {
    const tNew = await mkTicket({ assignedAgentId: mia.id, teamId: net.id, state: 'NEW' });
    const tProg = await mkTicket({ assignedAgentId: mia.id, teamId: net.id, state: 'IN_PROGRESS' });
    await slaService.startCycle(tProg, { cycleNumber: 1 });
    const created = await handoverService.createRequest({
      ticket: tNew, actor: mia, targetAgentId: theo.id, note: 'history side-effect probe',
    });
    eq('L0 the probe handover is live', created.ok, true);

    const snapTickets = () => prisma.ticket.findMany({ where: { id: { in: [tNew.id, tProg.id] } }, orderBy: { id: 'asc' } });
    const snapHandovers = () => prisma.handoverRequest.findMany({ where: { ticketId: { in: [tNew.id, tProg.id] } }, orderBy: { id: 'asc' } });
    const snapCycles = () => prisma.ticketSlaCycle.findMany({ where: { ticketId: tProg.id }, orderBy: { id: 'asc' } });
    const snapEvents = () => prisma.ticketSlaEvent.findMany({ where: { ticketId: tProg.id }, orderBy: { id: 'asc' } });
    const before = {
      tickets: JSON.stringify(await snapTickets()),
      handovers: JSON.stringify(await snapHandovers()),
      cycles: JSON.stringify(await snapCycles()),
      events: JSON.stringify(await snapEvents()),
    };

    // Flip mia through every state, both directions.
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'offline', actor: admin });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'unavailable', actor: admin });
    await poolService.applyAvailabilityState({ agentId: mia.id, state: 'online', actor: admin });
    await userService.applyUserUpdate(await prisma.agent.findUnique({ where: { id: mia.id } }), admin, { isAvailable: false });
    await userService.applyUserUpdate(await prisma.agent.findUnique({ where: { id: mia.id } }), admin, { isAvailable: true });

    const after = {
      tickets: JSON.stringify(await snapTickets()),
      handovers: JSON.stringify(await snapHandovers()),
      cycles: JSON.stringify(await snapCycles()),
      events: JSON.stringify(await snapEvents()),
    };
    eq('L1 tickets are byte-identical (state, assignee, everything)', after.tickets, before.tickets);
    eq('L2 handover requests are byte-identical', after.handovers, before.handovers);
    eq('L3 SLA cycles are byte-identical (frozen attribution intact)', after.cycles, before.cycles);
    eq('L4 SLA events are byte-identical', after.events, before.events);
    check('L5 the transitions did write history',
      (await periodsOf(mia.id)).length > 6);
  }

  /* ==================================================================== */
  /* M. Handover behavior unchanged                                        */
  /* ==================================================================== */
  console.log('\n--- M. handover compatibility ---');
  {
    // A request to an ONLINE agent: clock running.
    const hTicket = await mkTicket({ assignedAgentId: mia.id, teamId: net.id, state: 'NEW' });
    const created = await handoverService.createRequest({
      ticket: hTicket, actor: mia, targetAgentId: theo.id, note: 'online target',
    });
    eq('M1 a request to an online agent is accepted', created.ok, true);
    eq('M2 its expiry clock is running', Boolean(created.request.expiresAt) && !created.request.pausedAt, true);

    // The target goes offline: the clock pauses, nothing is cancelled — the
    // same behavior the availability timeline now sits alongside.
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'offline', actor: admin });
    await handoverService.onAvailabilityChanged(theo.id, false);
    const paused = await prisma.handoverRequest.findUnique({ where: { id: created.request.id } });
    eq('M3 the clock pauses while the recipient is offline', Boolean(paused.pausedAt) && paused.expiresAt === null, true);

    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'online', actor: admin });
    await handoverService.onAvailabilityChanged(theo.id, true);
    const resumed = await prisma.handoverRequest.findUnique({ where: { id: created.request.id } });
    eq('M4 the clock resumes when they are back', resumed.pausedAt === null && Boolean(resumed.expiresAt), true);

    // A request raised while the target is unavailable starts paused (admin
    // offer); an OFFLINE target is refused outright. Theo's earlier requests
    // (the L probe and M1) are removed first: the pending-request limit would
    // otherwise QUEUE this one instead of creating it paused.
    await prisma.handoverRequest.deleteMany({ where: { targetAgentId: theo.id } });
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'unavailable', actor: admin });
    const hTicket2 = await mkTicket({ assignedAgentId: mia.id, teamId: net.id, state: 'NEW' });
    const adminRow = await prisma.agent.findUnique({ where: { id: admin.id } });
    const created2 = await handoverService.createRequest({
      ticket: hTicket2, actor: adminRow, targetAgentId: theo.id, note: 'target is away',
    });
    eq('M5 a request to an unavailable agent starts paused',
      created2.ok && Boolean(created2.request.pausedAt) && created2.request.expiresAt === null, true);
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'offline', actor: admin });
    const refused = await handoverService.createRequest({
      ticket: hTicket2, actor: admin, targetAgentId: theo.id, note: 'target is offline',
    });
    eq('M6 a request to an offline agent is refused outright', refused.ok, false);
    await poolService.applyAvailabilityState({ agentId: theo.id, state: 'online', actor: admin });
    await prisma.handoverRequest.deleteMany({ where: { ticketId: { in: [hTicket.id, hTicket2.id] } } });
  }

  /* ==================================================================== */
  /* N. Audit-row shapes unchanged                                         */
  /* ==================================================================== */
  console.log('\n--- N. audit-row shapes unchanged ---');
  {
    const stateRow = await prisma.userAuditLog.findFirst({
      where: { agentId: mia.id, action: 'availability_changed', field: 'availabilityState', toValue: 'offline' },
      orderBy: { id: 'desc' },
    });
    check('N1 the state path still writes availabilityState rows with state names',
      stateRow && stateRow.fromValue === 'online' && stateRow.toValue === 'offline');
    const patchRow = await prisma.userAuditLog.findFirst({
      where: { agentId: theo.id, action: 'deactivated' },
      orderBy: { id: 'desc' },
    });
    // Section C only REactivated theo through the PATCH path, so exercise a
    // real deactivation here to pin its audit-row shape.
    const pat = await mkAgent('Pat Patch', `pat@${DOMAIN}`, { teamId: net.id, skillLevel: 1 });
    await userService.applyUserUpdate(pat, admin, { isActive: false });
    const deactRow = await prisma.userAuditLog.findFirst({
      where: { agentId: pat.id, action: 'deactivated' },
      orderBy: { id: 'desc' },
    });
    check('N2 the PATCH path still writes its own deactivated row',
      deactRow && deactRow.field === 'isActive' && deactRow.fromValue === 'true' && deactRow.toValue === 'false');
    eq('N2b and no deactivated row exists for the agent never PATCHed so',
      patchRow, null);
    // Legacy self-service rows are asserted live in section J (N3 there).
  }

  /* ==================================================================== */
  /* K1/J. Live server, first lifecycle                                    */
  /* ==================================================================== */
  console.log('\n--- K1. live server: idempotency before a restart ---');
  let server = await startServer();
  const robin = await mkAgent('Robin Restart', `robin@${DOMAIN}`, { teamId: net.id, skillLevel: 2 });
  const miaSelf = await mkAgent('Mia Self', `miaself@${DOMAIN}`, { teamId: net.id, skillLevel: 1 });
  let persisted = null;

  const adminLogin = await req('/api/auth/login', { method: 'POST', body: { email: admin.email, password: PASSWORD } });
  const adminToken = adminLogin.data.token;
  const miaSelfLogin = await req('/api/auth/login', { method: 'POST', body: { email: miaSelf.email, password: PASSWORD } });
  const miaSelfToken = miaSelfLogin.data.token;
  check('K1 logins issued', Boolean(adminToken && miaSelfToken));

  {
    // Same-state replay through the API, before any restart.
    const once = await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'unavailable', agentId: robin.id } });
    eq('K2 an admin state change works', once.status, 200);
    eq('K3 it opened exactly one period', (await periodsOf(robin.id)).length, 1);
    const replay = await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'unavailable', agentId: robin.id } });
    eq('K4 replaying the same state succeeds', replay.status, 200);
    eq('K5 but creates no duplicate period', (await periodsOf(robin.id)).length, 1);
    const openRow = (await periodsOf(robin.id))[0];
    persisted = { startedAt: openRow.startedAt.toISOString(), state: openRow.state };
  }
  await stopServer(server);

  console.log('\n--- K2. live server: history survives the restart ---');
  server = await startServer();
  {
    const rows = await periodsOf(robin.id);
    eq('K6 the period survived the restart', rows.length, 1);
    eq('K7 with the same start and state',
      `${rows[0].startedAt.toISOString()}|${rows[0].state}`,
      `${persisted.startedAt}|${persisted.state}`);
    const replay = await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'unavailable', agentId: robin.id } });
    eq('K8 replaying after the restart still adds nothing', replay.status, 200);
    eq('K9 one open period, not two', (await periodsOf(robin.id)).length, 1);
    // A real transition after a restart still records.
    await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'online', agentId: robin.id } });
    const after = await periodsOf(robin.id);
    eq('K10 a fresh transition after the restart records normally', after.length, 2);
    eq('K11 chained from the persisted period', after[1].previousState, 'unavailable');
  }

  /* ==================================================================== */
  /* I. Read APIs over HTTP                                                */
  /* ==================================================================== */
  console.log('\n--- I. read APIs ---');
  {
    const mine = await req(`/api/workload/availability-history/${robin.id}`, { token: adminToken });
    eq('I1 the per-agent endpoint answers', mine.status, 200);
    eq('I2 it carries the current state', mine.data.agent.availabilityState, 'online');
    eq('I3 newest period first', mine.data.periods[0].state, 'online');
    eq('I4 the closed period exposes a numeric duration', typeof mine.data.periods[1].durationMs, 'number');
    eq('I5 the open period is flagged', mine.data.periods[0].isOpen, true);
    eq('I6 and carries the admin actor', mine.data.periods[0].actor.name, admin.name);

    const wide = await req('/api/workload/availability-history', { token: adminToken });
    eq('I7 the admin-wide endpoint answers', wide.status, 200);
    check('I8 it paginates with a total', typeof wide.data.total === 'number' && typeof wide.data.page === 'number' && typeof wide.data.pageSize === 'number');
    check('I9 its rows carry the agent they belong to', wide.data.periods.every((p) => p.agent && p.agent.name));
    check('I10 newest first', wide.data.periods.every((p, i, a) => i === 0 || a[i - 1].startedAt >= p.startedAt));

    const filtered = await req(`/api/workload/availability-history?agentId=${robin.id}&state=unavailable`, { token: adminToken });
    eq('I11 agent+state filters combine', filtered.status, 200);
    check('I12 every hit matches both filters',
      filtered.data.periods.every((p) => p.agentId === robin.id && p.state === 'unavailable'));
    eq('I13 the total reflects the filter', filtered.data.total, 1);

    const paged = await req('/api/workload/availability-history?pageSize=3&page=2', { token: adminToken });
    eq('I14 page 2 skips page 1', paged.data.periods[0].id, wide.data.periods[3].id);

    // Service-level filter bounds, on a dedicated agent whose periods all
    // carry injected T() timestamps — so the window can never collide with
    // the real-clock timestamps the live sections above have written.
    const zoe = await mkAgent('Zoe Window', `zoe@${DOMAIN}`, { teamId: net.id, skillLevel: 1 });
    await poolService.applyAvailabilityState({ agentId: zoe.id, state: 'unavailable', actor: admin, at: T(20) });
    await poolService.applyAvailabilityState({ agentId: zoe.id, state: 'online', actor: admin, at: T(21) });
    const windowed = await historyService.listHistory({ agentId: zoe.id, from: T(20.5), to: T(21.5) });
    eq('I15 a time window matches only the periods that started inside it', windowed.total, 1);
    eq('I16 that is the online span', windowed.periods[0].state, 'online');
    const offlineOnly = await historyService.listHistory({ state: 'offline' });
    check('I17 a state filter keeps only that state',
      offlineOnly.periods.length > 0 && offlineOnly.periods.every((p) => p.state === 'offline'));
  }

  /* ==================================================================== */
  /* J. Authentication / authorization                                     */
  /* ==================================================================== */
  console.log('\n--- J. authentication / authorization ---');
  {
    eq('J1 the per-agent history requires authentication',
      (await req(`/api/workload/availability-history/${robin.id}`)).status, 401);
    eq('J2 the admin-wide history requires authentication',
      (await req('/api/workload/availability-history')).status, 401);
    eq('J3 an agent may read their own history',
      (await req(`/api/workload/availability-history/${miaSelf.id}`, { token: miaSelfToken })).status, 200);
    eq('J4 an agent may not read somebody else\'s history',
      (await req(`/api/workload/availability-history/${robin.id}`, { token: miaSelfToken })).status, 403);
    eq('J5 the admin-wide view is administrator-only',
      (await req('/api/workload/availability-history', { token: miaSelfToken })).status, 403);
    eq('J6 an unknown agent is a 404',
      (await req('/api/workload/availability-history/999999', { token: adminToken })).status, 404);
    eq('J7 a non-numeric agent id is a 404',
      (await req('/api/workload/availability-history/abc', { token: adminToken })).status, 404);
    eq('J8 a non-integer agentId filter is a 400',
      (await req('/api/workload/availability-history?agentId=abc', { token: adminToken })).status, 400);
    eq('J9 an unknown state filter is a 400',
      (await req('/api/workload/availability-history?state=busy', { token: adminToken })).status, 400);
    eq('J10 a malformed date bound is a 400',
      (await req('/api/workload/availability-history?from=nonsense', { token: adminToken })).status, 400);

    // Self-service through both request shapes: the periods must read as
    // source 'self' with the agent as their own actor.
    await req('/api/workload/availability', { method: 'POST', token: miaSelfToken, body: { available: false } });
    await req('/api/workload/availability', { method: 'POST', token: miaSelfToken, body: { available: true } });
    await req('/api/workload/availability', { method: 'POST', token: miaSelfToken, body: { state: 'unavailable' } });
    await req('/api/workload/availability', { method: 'POST', token: miaSelfToken, body: { state: 'unavailable' } });
    const mine = await req(`/api/workload/availability-history/${miaSelf.id}`, { token: miaSelfToken });
    eq('J11 three real self-transitions, replay excluded', mine.data.periods.length, 3);
    check('H5 self-service periods record source "self"',
      mine.data.periods.every((p) => p.source === 'self'));
    check('H6 and the agent as their own actor',
      mine.data.periods.every((p) => p.actor && p.actor.id === miaSelf.id));
    eq('N3 the legacy self path still writes its isAvailable audit row',
      (await prisma.userAuditLog.findFirst({
        where: { agentId: miaSelf.id, field: 'isAvailable', toValue: 'true', note: 'Marked themselves available' },
      })) !== null, true);
  }
  await stopServer(server);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
