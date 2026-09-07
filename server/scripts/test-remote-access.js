/* Remote Access foundation.
 *
 * Application-side bookkeeping for controlled remote-support sessions tied
 * to a ticket — no transport, no credentials. One suite, real database:
 *
 *   A. Model/migration — table, columns, the two partial unique indexes,
 *      defaults, cascade
 *   C. Lifecycle — requested -> active -> ended with exact timestamps and
 *      duration; cancel-before-start; cancel-active; lazy expiry
 *   D. Invalid transitions — every move outside TRANSITIONS is refused, and
 *      closed/resolved tickets cannot take or start sessions
 *   E. Duplicate live-session prevention — per ticket and per agent, at the
 *      service level AND at the database level (raw insert hits P2002)
 *   F. Audit events — every transition lands in the AuditEvent trail (with
 *      ticket linkage) and in the ticket timeline (TicketAuditLog)
 *   H. Zero ticket/assignment/SLA side effects — byte-identical snapshots
 *   B. Authorization matrix (live HTTP) — 401/403/201/200 per actor
 *   G. No credential storage (live) — smuggled fields are ignored end to end
 *   I. Read APIs (live) — ticket-scoped history, 404s
 *   J. Server restart — persistence, idempotent replays, fresh transitions
 *
 * Usage: npm run test:remote-access (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4232';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('remacc');

const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { nextTicketNumber } = require('../src/ticketNumbers');
const remoteAccessService = require('../src/services/remoteAccessService');

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

const PASSWORD = 'RaSuite!123';
const DOMAIN = 'ra.test';

// Spawn the REAL server.js against this suite's database (testdb.use has
// already pointed DATABASE_URL/DIRECT_URL at it; the spawn inherits env).
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

// Deterministic times for the service-level sections. Fractional hours give
// minute-level control (T(0.5) = 30 minutes past BASE).
const BASE = new Date('2026-09-07T09:00:00.000Z');
const T = (h) => new Date(BASE.getTime() + h * 3600000);

// Create with the role in the insert itself: the returned object must agree
// with the row, or every isAdmin() check on the in-memory fixture fails.
async function mkAgent(name, email, { role = 'agent', teamId = null, skillLevel = 2 } = {}) {
  return prisma.agent.create({
    data: {
      name, email, role, isActive: true, isAvailable: true,
      skillLevel, teamId, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
}

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'Remote access fixture ticket',
      body: 'Remote access fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

const rawSession = async (id) =>
  prisma.remoteAccessSession.findUnique({
    where: { id }, include: {
      ticket: { select: { ticketNumber: true } },
      agent: true, requestedBy: true, endedBy: true,
    },
  });

const auditsFor = (sessionId) =>
  prisma.auditEvent.findMany({
    where: { entityType: 'RemoteAccessSession', entityId: sessionId },
    orderBy: { id: 'asc' },
  });

const historyLines = (ticketId) =>
  prisma.ticketAuditLog.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });

(async () => {
  const net = await prisma.team.create({ data: { key: 'ra-net', name: 'Remote Access Net' } });

  const admin = await mkAgent('Ra Admin', `admin@${DOMAIN}`, { role: 'admin', teamId: net.id });
  const ria = await mkAgent('Ria Assignee', `ria@${DOMAIN}`, { teamId: net.id });
  const theo = await mkAgent('Theo Colleague', `theo@${DOMAIN}`, { teamId: net.id });
  const una = await mkAgent('Una Portal', `una@${DOMAIN}`, { role: 'user', teamId: null });
  const dummy1 = await mkAgent('Dummy One', `dummy1@${DOMAIN}`, { teamId: net.id });

  // Dedicated tickets per scenario so no test inherits another's live session.
  const t1 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });   // B + H
  const t2 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });   // E
  const t3 = await mkTicket({ teamId: net.id });                            // B admin-on-behalf
  const t4 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id, state: 'RESOLVED' });
  const t5 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });   // D9 resolved-after
  const t7 = await mkTicket({ assignedAgentId: dummy1.id, teamId: net.id }); // E
  const t8 = await mkTicket({ assignedAgentId: dummy1.id, teamId: net.id }); // E
  const t10 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // C chain
  const t11 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // C cancel-requested
  const t12 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // C cancel-active
  const t13 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // C lazy expiry
  const t15 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // G credentials
  const t16 = await mkTicket({ assignedAgentId: ria.id, teamId: net.id });  // E live duplicate
  const t17 = await mkTicket({ teamId: net.id });                           // A cascade scratch

  /* ==================================================================== */
  /* A. Model / migration                                                   */
  /* ==================================================================== */
  console.log('\n--- A. model / migration ---');
  {
    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes WHERE tablename = 'RemoteAccessSession'`;
    const names = indexes.map((r) => r.indexname);
    check('A1 the one-live-per-ticket partial unique index exists',
      names.includes('RemoteAccessSession_one_live_per_ticket_key'), names.join(', '));
    check('A2 the one-live-per-agent partial unique index exists',
      names.includes('RemoteAccessSession_one_live_per_agent_key'), names.join(', '));

    const columns = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'RemoteAccessSession'`;
    const cols = columns.map((c) => c.column_name);
    for (const expected of ['ticketId', 'agentId', 'requestedById', 'status', 'requestedAt', 'expiresAt', 'startedAt', 'endedAt', 'note', 'endReason', 'endedById']) {
      check(`A3 column ${expected} exists`, cols.includes(expected));
    }

    // Defaults through the service: a fresh request, with the TTL clock set.
    const created = await remoteAccessService.createSession({
      ticketId: t17.id, actor: ria, note: 'A4 probe', at: T(0),
    });
    eq('A4 a fresh session starts as requested', created.session.status, 'requested');
    check('A5 expiresAt is requestedAt plus the request TTL',
      new Date(created.session.expiresAt).getTime() - new Date(created.session.requestedAt).getTime()
        === remoteAccessService.REQUEST_TTL_MINUTES * 60000);
    eq('A6 an unstarted session has no startedAt', created.session.startedAt, null);
    eq('A7 an unstarted session has no endedAt', created.session.endedAt, null);
    eq('A8 an unstarted session has no duration', created.session.durationMs, null);
    eq('A9 a fresh session is live', created.session.isLive, true);
    eq('A10 the requester is recorded', created.session.requestedBy.id, ria.id);
    eq('A11 the conductor is recorded', created.session.agent.id, ria.id);
    // Close the probe: a live session for ria here would trip the one-live-
    // per-agent rule in every later section that has her request a session.
    const probeClosed = await remoteAccessService.cancelSession({ sessionId: created.session.id, actor: ria, at: T(0.1) });
    eq('A11b the probe closed cleanly', probeClosed.session.status, 'cancelled');

    // A ticket's sessions die with the ticket.
    const scratchTicket = await mkTicket({ assignedAgentId: theo.id, teamId: net.id });
    await prisma.remoteAccessSession.create({
      data: {
        ticketId: scratchTicket.id, agentId: dummy1.id,
        requestedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
      },
    });
    eq('A12 the scratch session exists before the delete',
      await prisma.remoteAccessSession.count({ where: { ticketId: scratchTicket.id } }), 1);
    await prisma.ticket.delete({ where: { id: scratchTicket.id } });
    eq('A13 deleting the ticket cascades its sessions',
      await prisma.remoteAccessSession.count({ where: { ticketId: scratchTicket.id } }), 0);
  }

  /* ==================================================================== */
  /* C. Lifecycle                                                           */
  /* ==================================================================== */
  console.log('\n--- C. lifecycle ---');
  {
    // The full happy path with exact, injected timestamps.
    const opened = await remoteAccessService.createSession({ ticketId: t10.id, actor: ria, at: T(1) });
    const sessionId = opened.session.id;
    const started = await remoteAccessService.startSession({ sessionId, actor: ria, at: T(1.25) });
    eq('C1 start moves requested -> active', started.session.status, 'active');
    eq('C2 startedAt is the start instant', started.session.startedAt, T(1.25).toISOString());
    const ended = await remoteAccessService.endSession({
      sessionId, actor: ria, reason: 'work complete', at: T(2),
    });
    eq('C3 end moves active -> ended', ended.session.status, 'ended');
    eq('C4 endedAt is the end instant', ended.session.endedAt, T(2).toISOString());
    eq('C5 the duration is exact', ended.session.durationMs, T(2).getTime() - T(1.25).getTime());
    eq('C6 the end reason is stored verbatim', ended.session.endReason, 'work complete');
    eq('C7 the ender is recorded', ended.session.endedBy.id, ria.id);
    eq('C8 a finished session is not live', ended.session.isLive, false);

    // Cancelling a request that never started.
    const opened2 = await remoteAccessService.createSession({ ticketId: t11.id, actor: ria, at: T(3) });
    const cancelled = await remoteAccessService.cancelSession({
      sessionId: opened2.session.id, actor: ria, reason: 'no longer needed', at: T(3.1),
    });
    eq('C9 cancelling a request finishes it as cancelled', cancelled.session.status, 'cancelled');
    eq('C10 a cancelled-before-start session has no startedAt', cancelled.session.startedAt, null);
    eq('C11 it still records when it stopped being live', cancelled.session.endedAt, T(3.1).toISOString());
    eq('C12 and no duration — it never ran', cancelled.session.durationMs, null);

    // Cancelling an active session part-way through.
    const opened3 = await remoteAccessService.createSession({ ticketId: t12.id, actor: ria, at: T(4) });
    await remoteAccessService.startSession({ sessionId: opened3.session.id, actor: ria, at: T(4.1) });
    const cancelledActive = await remoteAccessService.cancelSession({
      sessionId: opened3.session.id, actor: admin, reason: 'connection lost', at: T(4.5),
    });
    eq('C13 cancelling an active session works', cancelledActive.session.status, 'cancelled');
    eq('C14 the part-way duration is exact',
      cancelledActive.session.durationMs, T(4.5).getTime() - T(4.1).getTime());

    // Lazy expiry: a start past the request TTL refuses AND expires the row.
    const opened4 = await remoteAccessService.createSession({ ticketId: t13.id, actor: ria, at: T(5) });
    const late = await remoteAccessService.startSession({ sessionId: opened4.session.id, actor: ria, at: T(6) });
    eq('C15 a start past the request TTL is refused', late.ok, false);
    eq('C16 with a 409', late.status, 409);
    const expiredRow = await rawSession(opened4.session.id);
    eq('C17 the late request was expired by the refusal', expiredRow.status, 'expired');
    eq('C18 endedAt is pinned to the moment it actually lapsed',
      expiredRow.endedAt.toISOString(), new Date(T(5).getTime() + remoteAccessService.REQUEST_TTL_MINUTES * 60000).toISOString());

    // The sweeper form of the same rule, and its idempotency.
    const opened5 = await remoteAccessService.createSession({ ticketId: t11.id, actor: ria, at: T(7) });
    eq('C19 expireStaleSessions expires the stale request',
      await remoteAccessService.expireStaleSessions({ at: T(8) }), 1);
    eq('C20 a replay expires nothing more',
      await remoteAccessService.expireStaleSessions({ at: T(8.1) }), 0);
    eq('C21 the row reads expired afterwards', (await rawSession(opened5.session.id)).status, 'expired');
    eq('C22 listForTicket also expires stale requests lazily',
      (await remoteAccessService.listForTicket(t11.id)).find((s) => s.id === opened5.session.id).status, 'expired');
  }

  /* ==================================================================== */
  /* D. Invalid transitions + ticket-state gating                           */
  /* ==================================================================== */
  console.log('\n--- D. invalid transitions ---');
  {
    const endedRow = (await remoteAccessService.listForTicket(t10.id))[0];
    eq('D1 an ended session cannot be started', (await remoteAccessService.startSession({ sessionId: endedRow.id, actor: ria })).status, 409);
    eq('D2 an ended session cannot be ended again', (await remoteAccessService.endSession({ sessionId: endedRow.id, actor: ria })).status, 409);
    eq('D3 an ended session cannot be cancelled', (await remoteAccessService.cancelSession({ sessionId: endedRow.id, actor: ria })).status, 409);

    const cancelledRow = (await remoteAccessService.listForTicket(t11.id)).find((s) => s.status === 'cancelled');
    eq('D4 a cancelled session cannot be started', (await remoteAccessService.startSession({ sessionId: cancelledRow.id, actor: ria })).status, 409);
    eq('D5 a cancelled session cannot be ended', (await remoteAccessService.endSession({ sessionId: cancelledRow.id, actor: ria })).status, 409);
    eq('D6 a cancelled session cannot be cancelled again', (await remoteAccessService.cancelSession({ sessionId: cancelledRow.id, actor: ria })).status, 409);

    const expiredRow = (await remoteAccessService.listForTicket(t13.id))[0];
    eq('D7 an expired session cannot be started', (await remoteAccessService.startSession({ sessionId: expiredRow.id, actor: ria })).status, 409);
    eq('D8 an expired session cannot be ended', (await remoteAccessService.endSession({ sessionId: expiredRow.id, actor: ria })).status, 409);

    // A requested session can be ended neither — it must start or cancel.
    const fresh = await remoteAccessService.createSession({ ticketId: t2.id, actor: ria, at: T(9) });
    eq('D9 a requested session cannot be ended directly', (await remoteAccessService.endSession({ sessionId: fresh.session.id, actor: ria })).status, 409);
    await remoteAccessService.cancelSession({ sessionId: fresh.session.id, actor: ria, at: T(9.1) });

    // Terminal statuses have no moves at all.
    for (const terminal of remoteAccessService.TERMINAL_STATUSES) {
      eq(`D10 ${terminal} is terminal in TRANSITIONS`, remoteAccessService.TRANSITIONS[terminal].length, 0);
    }

    // Closed / resolved tickets take no new sessions.
    eq('D11 a resolved ticket refuses a new session',
      (await remoteAccessService.createSession({ ticketId: t4.id, actor: ria })).status, 400);
    await prisma.ticket.update({ where: { id: t4.id }, data: { state: 'CLOSED' } });
    eq('D12 a closed ticket refuses a new session',
      (await remoteAccessService.createSession({ ticketId: t4.id, actor: ria })).status, 400);

    // A ticket that closes after the request refuses the start.
    const onT5 = await remoteAccessService.createSession({ ticketId: t5.id, actor: ria, at: T(10) });
    await prisma.ticket.update({ where: { id: t5.id }, data: { state: 'RESOLVED' } });
    eq('D13 a start on a since-resolved ticket is refused',
      (await remoteAccessService.startSession({ sessionId: onT5.session.id, actor: ria, at: T(10.1) })).status, 400);
    eq('D14 the refused session is still requested (not silently killed)',
      (await rawSession(onT5.session.id)).status, 'requested');
    await remoteAccessService.cancelSession({ sessionId: onT5.session.id, actor: ria, at: T(10.2) });
    await prisma.ticket.update({ where: { id: t5.id }, data: { state: 'IN_PROGRESS' } });
  }

  /* ==================================================================== */
  /* E. Duplicate live-session prevention                                   */
  /* ==================================================================== */
  console.log('\n--- E. duplicate live sessions ---');
  {
    // An admin arranges the session for dummy1 (only an admin may name
    // another agent); ria's own attempt must not bypass that rule.
    const first = await remoteAccessService.createSession({ ticketId: t7.id, actor: admin, agentId: dummy1.id, at: T(11) });
    eq('E1 the first live session is created', first.ok, true);
    eq('E2 a second live session for the same ticket is refused',
      (await remoteAccessService.createSession({ ticketId: t7.id, actor: dummy1, agentId: dummy1.id, at: T(11.1) })).status, 409);
    eq('E3 a second live session for the same AGENT (other ticket) is refused',
      (await remoteAccessService.createSession({ ticketId: t8.id, actor: admin, agentId: dummy1.id, at: T(11.2) })).status, 409);

    // Once it is finished, the ticket is free again. Ending needs an ACTIVE
    // session, so start it first.
    await remoteAccessService.startSession({ sessionId: first.session.id, actor: dummy1, at: T(11.25) });
    await remoteAccessService.endSession({ sessionId: first.session.id, actor: admin, reason: 'done', at: T(11.3) });
    const again = await remoteAccessService.createSession({ ticketId: t7.id, actor: admin, agentId: dummy1.id, at: T(11.4) });
    eq('E4 after the session ends, the ticket takes a new one', again.ok, true);

    // The database enforces it even if the service is bypassed.
    let errCode = '';
    try {
      await prisma.remoteAccessSession.create({
        data: { ticketId: t7.id, agentId: dummy1.id, requestedAt: T(12), expiresAt: T(13) },
      });
    } catch (e) { errCode = e.code || ''; }
    eq('E5 a raw insert bypassing the service hits the per-ticket index', errCode, 'P2002');
    errCode = '';
    try {
      await prisma.remoteAccessSession.create({
        data: { ticketId: t8.id, agentId: dummy1.id, requestedAt: T(12), expiresAt: T(13) },
      });
    } catch (e) { errCode = e.code || ''; }
    eq('E6 a raw insert for the same agent hits the per-agent index', errCode, 'P2002');

    // Clean up: finish the live session so later sections see no clash.
    await remoteAccessService.cancelSession({ sessionId: again.session.id, actor: admin, at: T(13.1) });
  }

  /* ==================================================================== */
  /* F. Audit events                                                        */
  /* ==================================================================== */
  console.log('\n--- F. audit events ---');
  {
    const chain = (await remoteAccessService.listForTicket(t10.id)).find((s) => s.status === 'ended');
    const events = await auditsFor(chain.id);
    eq('F1 the full lifecycle left three trail events', events.length, 3);
    eq('F2 requested came first', events[0].action, 'remote_access.requested');
    eq('F3 started second', events[1].action, 'remote_access.started');
    eq('F4 ended third', events[2].action, 'remote_access.ended');
    eq('F5 events are linked to the ticket', events[1].ticketId, t10.id);
    eq('F6 the actor is the agent who acted', events[1].actorLabel, `${ria.name} <${ria.email}>`);
    eq('F7 the from/to of the start is requested -> active',
      `${events[1].fromValue} -> ${events[1].toValue}`, '"requested" -> "active"');
    check('F8 the entity label names the ticket and the agent',
      events[0].entityLabel.includes(chain.ticketNumber) && events[0].entityLabel.includes(ria.name),
      events[0].entityLabel);

    const expiredEvents = await auditsFor((await remoteAccessService.listForTicket(t13.id))[0].id);
    eq('F9 expiry is audited too', expiredEvents.map((e) => e.action).join(','), 'remote_access.requested,remote_access.expired');
    eq('F10 the expiry actor is the system', expiredEvents[1].actorLabel, 'system');

    // The ticket timeline (TicketAuditLog) carries the same lifecycle.
    const lines = await historyLines(t10.id);
    eq('F11 the ticket timeline has three remote-access lines', lines.length, 3);
    check('F12 the timeline notes start with "Remote access"',
      lines.every((l) => l.note.startsWith('Remote access')), lines.map((l) => l.note).join(' | '));
    eq('F13 the timeline lines do not change the ticket state',
      lines.every((l) => l.fromState === l.toState), true);
  }

  /* ==================================================================== */
  /* H. Zero ticket / assignment / SLA side effects                         */
  /* ==================================================================== */
  console.log('\n--- H. zero side effects ---');
  {
    const snapshot = async () => JSON.stringify({
      ticket: await prisma.ticket.findUnique({ where: { id: t1.id } }),
      cycles: await prisma.ticketSlaCycle.findMany({ where: { ticketId: t1.id } }),
      events: await prisma.ticketSlaEvent.findMany({ where: { ticketId: t1.id } }),
      handovers: await prisma.handoverRequest.findMany({ where: { ticketId: t1.id } }),
    });
    const before = await snapshot();

    const a = await remoteAccessService.createSession({ ticketId: t1.id, actor: ria, at: T(20) });
    await remoteAccessService.startSession({ sessionId: a.session.id, actor: ria, at: T(20.1) });
    await remoteAccessService.endSession({ sessionId: a.session.id, actor: ria, reason: 'done', at: T(20.2) });
    const b = await remoteAccessService.createSession({ ticketId: t1.id, actor: ria, at: T(20.3) });
    await remoteAccessService.cancelSession({ sessionId: b.session.id, actor: ria, at: T(20.4) });

    eq('H1 the ticket row (assignment, state, SLA mirrors) is byte-identical',
      await snapshot(), before);
    const ticket = await prisma.ticket.findUnique({ where: { id: t1.id } });
    eq('H2 the assignment is untouched', ticket.assignedAgentId, ria.id);
    eq('H3 the state is untouched', ticket.state, 'NEW');
    eq('H4 no SLA cycle appeared', await prisma.ticketSlaCycle.count({ where: { ticketId: t1.id } }), 0);
    eq('H5 no SLA event appeared', await prisma.ticketSlaEvent.count({ where: { ticketId: t1.id } }), 0);
  }

  /* ==================================================================== */
  /* Live sections — spawn the real server                                  */
  /* ==================================================================== */
  console.log('\n--- starting server for live sections ---');
  const server = await startServer();
  const login = async (agent) =>
    (await req('/api/auth/login', { method: 'POST', body: { email: agent.email, password: PASSWORD } })).data.token;
  const adminToken = await login(admin);
  const riaToken = await login(ria);
  const theoToken = await login(theo);
  const unaToken = await login(una);
  check('LIVE logins issued', Boolean(adminToken && riaToken && theoToken && unaToken));

  /* ==================================================================== */
  /* B. Authorization matrix (live)                                         */
  /* ==================================================================== */
  console.log('\n--- B. authorization matrix ---');
  {
    eq('B1 an unauthenticated create is refused',
      (await req('/api/remote-access', { method: 'POST', body: { ticketId: t1.id } })).status, 401);
    eq('B2 a user-role account may not request a session',
      (await req('/api/remote-access', { method: 'POST', token: unaToken, body: { ticketId: t1.id } })).status, 403);
    eq('B3 an unassigned agent may not request on somebody else\'s ticket',
      (await req('/api/remote-access', { method: 'POST', token: theoToken, body: { ticketId: t1.id } })).status, 403);

    const mine = await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t1.id, note: 'check the vpn' } });
    eq('B4 the assignee may request a session', mine.status, 201);
    eq('B5 they conduct it themselves by default', mine.data.agent.name, ria.name);
    eq('B6 the note is stored', mine.data.note, 'check the vpn');
    const liveId = mine.data.id;

    eq('B7 a non-admin may not name another agent',
      (await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t2.id, agentId: theo.id } })).status, 403);

    const behalf = await req('/api/remote-access', { method: 'POST', token: adminToken, body: { ticketId: t3.id, agentId: theo.id } });
    eq('B8 an admin may arrange a session for another agent', behalf.status, 201);
    eq('B9 the named agent conducts it', behalf.data.agent.id, theo.id);
    eq('B10 the admin is recorded as the requester', behalf.data.requestedBy.id, admin.id);
    eq('B11 the session agent (not the requester) may start it',
      (await req(`/api/remote-access/${behalf.data.id}/start`, { method: 'POST', token: theoToken })).status, 200);
    eq('B12 an uninvolved agent may not end it',
      (await req(`/api/remote-access/${behalf.data.id}/end`, { method: 'POST', token: riaToken })).status, 403);
    eq('B13 an administrator may end it',
      (await req(`/api/remote-access/${behalf.data.id}/end`, { method: 'POST', token: adminToken })).status, 200);

    eq('B14 any authenticated agent may READ a ticket\'s sessions',
      (await req(`/api/remote-access/ticket/${t3.id}`, { token: unaToken })).status, 200);
    eq('B15 the requester may cancel their own live request',
      (await req(`/api/remote-access/${liveId}/cancel`, { method: 'POST', token: riaToken })).status, 200);
    eq('B16 an unknown session is 404',
      (await req('/api/remote-access/999999/start', { method: 'POST', token: adminToken })).status, 404);
  }

  /* ==================================================================== */
  /* G. No credential storage (live)                                        */
  /* ==================================================================== */
  console.log('\n--- G. no credential storage ---');
  {
    const smuggled = {
      ticketId: t15.id,
      note: 'help requester with printer',
      password: 'hunter2-secret',
      accessToken: 'tok-abc123',
      secret: 'shhh-value',
      connectionString: 'vnc://host:5900',
      host: '10.0.0.42',
      token: 'bearer-value',
    };
    const created = await req('/api/remote-access', { method: 'POST', token: riaToken, body: smuggled });
    eq('G1 the create succeeds regardless of smuggled fields', created.status, 201);
    const row = await rawSession(created.data.id);
    const rowJson = JSON.stringify(row);
    for (const value of ['hunter2-secret', 'tok-abc123', 'shhh-value', 'vnc://host:5900', '10.0.0.42', 'bearer-value']) {
      check(`G2 no trace of "${value}" in the stored session`, !rowJson.includes(value));
    }
    const events = await auditsFor(created.data.id);
    const auditJson = JSON.stringify(events);
    for (const value of ['hunter2-secret', 'tok-abc123', 'shhh-value', 'vnc://host:5900', '10.0.0.42', 'bearer-value']) {
      check(`G3 no trace of "${value}" in the audit trail`, !auditJson.includes(value));
    }
    eq('G4 the legit note survived the sanitising of everything else', row.note, 'help requester with printer');
    // Close it: a live session for ria here would trip the one-live-per-agent
    // rule in the sections that follow.
    eq('G5 the smuggle probe closed cleanly',
      (await req(`/api/remote-access/${created.data.id}/cancel`, { method: 'POST', token: riaToken })).status, 200);
  }

  /* ==================================================================== */
  /* E(live). duplicate prevention over HTTP                                */
  /* ==================================================================== */
  console.log('\n--- E(live). duplicate over HTTP ---');
  {
    const first = await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t16.id } });
    eq('E7 the first live request is accepted', first.status, 201);
    const second = await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t16.id } });
    eq('E8 the duplicate live request is a 409', second.status, 409);
    check('E9 the error says what to do', /live remote session/.test(second.data.error || ''), second.data.error);
    const doubleStart = await req(`/api/remote-access/${first.data.id}/start`, { method: 'POST', token: riaToken });
    eq('E10 the start succeeds once', doubleStart.status, 200);
    eq('E11 a second start on the same session is refused',
      (await req(`/api/remote-access/${first.data.id}/start`, { method: 'POST', token: riaToken })).status, 409);
    await req(`/api/remote-access/${first.data.id}/end`, { method: 'POST', token: riaToken, body: { reason: 'suite cleanup' } });
  }

  /* ==================================================================== */
  /* I. Read APIs (live)                                                    */
  /* ==================================================================== */
  console.log('\n--- I. read APIs ---');
  {
    const list = await req(`/api/remote-access/ticket/${t10.id}`, { token: adminToken });
    eq('I1 the ticket history endpoint answers', list.status, 200);
    eq('I2 it carries the sessions', Array.isArray(list.data.sessions), true);
    check('I3 newest first', list.data.sessions.length >= 1
      && list.data.sessions[0].id >= list.data.sessions[list.data.sessions.length - 1].id);
    const shaped = list.data.sessions[0];
    for (const field of ['id', 'ticketId', 'status', 'agent', 'requestedBy', 'requestedAt', 'expiresAt', 'startedAt', 'endedAt', 'durationMs', 'isLive', 'note', 'endReason']) {
      check(`I4 the shape carries ${field}`, Object.prototype.hasOwnProperty.call(shaped, field));
    }
    check('I5 other tickets\' sessions do not leak in',
      list.data.sessions.every((s) => s.ticketId === t10.id));
    eq('I6 an unknown ticket is 404',
      (await req('/api/remote-access/ticket/999999', { token: adminToken })).status, 404);
    eq('I7 a non-integer ticket id is 404',
      (await req('/api/remote-access/ticket/notanumber', { token: adminToken })).status, 404);
  }

  /* ==================================================================== */
  /* J. Server restart                                                      */
  /* ==================================================================== */
  console.log('\n--- J. server restart ---');
  {
    const pre = await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t2.id, note: 'survives the restart' } });
    eq('J0 the pre-restart session exists', pre.status, 201);
    const preList = await req(`/api/remote-access/ticket/${t2.id}`, { token: riaToken });
    const preIds = preList.data.sessions.map((s) => s.id);

    console.log('--- stopping the server ---');
    await stopServer(server);
    console.log('--- starting it again over the same database ---');
    const server2 = await startServer();

    const postList = await req(`/api/remote-access/ticket/${t2.id}`, { token: riaToken });
    eq('J1 the sessions survived the restart',
      JSON.stringify(postList.data.sessions.map((s) => s.id)), JSON.stringify(preIds));
    eq('J2 the restarted server did not duplicate history',
      postList.data.sessions.length, preIds.length);
    eq('J3 the note survived too', postList.data.sessions.find((s) => s.id === pre.data.id).note, 'survives the restart');

    // Transitions still work after a restart — and replays stay idempotent.
    const started = await req(`/api/remote-access/${pre.data.id}/start`, { method: 'POST', token: riaToken });
    eq('J4 the surviving request can be started after the restart', started.status, 200);
    check('J5 its startedAt is a real instant', Boolean(started.data.startedAt));
    eq('J6 a second start on the same session is still refused',
      (await req(`/api/remote-access/${pre.data.id}/start`, { method: 'POST', token: riaToken })).status, 409);
    eq('J7 and the session can still be ended',
      (await req(`/api/remote-access/${pre.data.id}/end`, { method: 'POST', token: riaToken, body: { reason: 'post-restart close' } })).status, 200);
    const fresh = await req('/api/remote-access', { method: 'POST', token: riaToken, body: { ticketId: t1.id } });
    eq('J8 a fresh request works after the restart', fresh.status, 201);
    eq('J9 and a fresh cancel too',
      (await req(`/api/remote-access/${fresh.data.id}/cancel`, { method: 'POST', token: adminToken })).status, 200);

    await stopServer(server2);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
