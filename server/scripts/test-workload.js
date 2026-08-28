/* Workload, unattended-ticket claiming, availability and rebalancing.

   Runs against a live ephemeral server. Every agent and ticket is created by
   the test; pre-existing staff are parked so the algorithms are deterministic.
   No Graph, no email, no credentials.

   Usage: npm run test:workload  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4166';
// Keep the background balancer out of the way: this suite drives it directly.
process.env.REBALANCE_INTERVAL_MS = '0';

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const workload = require('../src/services/workloadService');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const MARK = 'wl-test-';
const DOMAIN = 'workload.example';
const PASSWORD = 'WorkloadPass!123';
const HOUR = 60 * 60 * 1000;

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

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

/* ---- isolation ------------------------------------------------------ */
let parkedAgentIds = [];
let parkedRuleIds = [];

async function parkOthers() {
  const agents = await prisma.agent.findMany({
    where: { isAvailable: true, NOT: { email: { endsWith: `@${DOMAIN}` } } },
    select: { id: true },
  });
  parkedAgentIds = agents.map((a) => a.id);
  if (parkedAgentIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: parkedAgentIds } }, data: { isAvailable: false } });
  }
  const rules = await prisma.routingRule.findMany({ where: { isActive: true }, select: { id: true } });
  parkedRuleIds = rules.map((r) => r.id);
  if (parkedRuleIds.length) {
    await prisma.routingRule.updateMany({ where: { id: { in: parkedRuleIds } }, data: { isActive: false } });
  }
}
async function unparkOthers() {
  if (parkedAgentIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: parkedAgentIds } }, data: { isAvailable: true } });
  }
  if (parkedRuleIds.length) {
    await prisma.routingRule.updateMany({ where: { id: { in: parkedRuleIds } }, data: { isActive: true } });
  }
  parkedAgentIds = [];
  parkedRuleIds = [];
}

async function cleanup() {
  const tickets = await prisma.ticket.findMany({
    where: { OR: [{ graphMessageId: { startsWith: MARK } }, { requesterEmail: { endsWith: `@${DOMAIN}` } }] },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.notification.deleteMany({ where: { ticketId: t.id } });
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  const users = await prisma.agent.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  if (users.length) {
    const ids = users.map((u) => u.id);
    await prisma.ticket.updateMany({ where: { assignedAgentId: { in: ids } }, data: { assignedAgentId: null } });
    await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.userAuditLog.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.routingRule.updateMany({ where: { preferredAgentId: { in: ids } }, data: { preferredAgentId: null } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  }
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const mkAgent = (name, local, teamId, skillLevel = 2, extra = {}) =>
  prisma.agent.create({
    data: {
      name, email: `${local}@${DOMAIN}`, teamId, skillLevel,
      role: 'agent', isActive: true, isAvailable: true, passwordHash: hash,
      lastAssignedAt: null, ...extra,
    },
  });

let seq = 0;
async function mkTicket({ agentId, teamId, state = 'NEW', ageHours = 0, originTeamId, label }) {
  seq += 1;
  const suffix = label || `t${seq}`;
  const createdAt = new Date(Date.now() - ageHours * HOUR);
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: `${MARK}${suffix}`,
      body: 'Workload fixture ticket.',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state,
      source: 'portal',
      requesterEmail: `req@${DOMAIN}`,
      graphMessageId: `${MARK}${suffix}-${seq}`,
      teamId,
      originatingTeamId: originTeamId ?? teamId,
      assignedAgentId: agentId ?? null,
      createdAt,
    },
  });
}

async function main() {
  await ensureTeams(prisma);
  await cleanup();
  await parkOthers();

  const teams = Object.fromEntries((await prisma.team.findMany()).map((t) => [t.key, t]));
  const general = teams.service_desk;
  const hardware = teams.hardware;

  const alice = await mkAgent('Alice Busy', 'alice', general.id, 3);
  const bob = await mkAgent('Bob Free', 'bob', general.id, 3);
  const carol = await mkAgent('Carol Other', 'carol', hardware.id, 3);
  const admin = await mkAgent('Workload Admin', 'wadmin', null, 3, { role: 'admin' });

  /* ================================================================== */
  /* 1. Workload calculation                                            */
  /* ================================================================== */
  {
    eq('workload: starts at zero', await workload.workloadFor(alice.id), 0);

    await mkTicket({ agentId: alice.id, teamId: general.id, state: 'NEW', label: 'wl-new' });
    eq('workload: NEW counts', await workload.workloadFor(alice.id), 1);

    await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: 'wl-prog' });
    eq('workload: IN_PROGRESS counts', await workload.workloadFor(alice.id), 2);

    await mkTicket({ agentId: alice.id, teamId: general.id, state: 'RESOLVED', label: 'wl-res' });
    eq('workload: RESOLVED does not count', await workload.workloadFor(alice.id), 2);

    await mkTicket({ agentId: alice.id, teamId: general.id, state: 'CLOSED', label: 'wl-closed' });
    eq('workload: CLOSED does not count', await workload.workloadFor(alice.id), 2);

    const map = await workload.workloadByAgent([alice.id, bob.id]);
    check('workload: batch counts match', map.get(alice.id) === 2 && map.get(bob.id) === 0);

    const snap = await workload.workloadSnapshot();
    const row = snap.agents.find((a) => a.agentId === alice.id);
    check('workload: snapshot exposes the agent', Boolean(row));
    eq('workload: snapshot count matches', row.openTickets, 2);
    check('workload: snapshot reports the imbalance spread', typeof snap.imbalance.spread === 'number');

    // Clear for the next sections.
    await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: `${MARK}wl-` } } });
  }

  /* ================================================================== */
  /* 2. The 4-hour unattended threshold                                 */
  /* ================================================================== */
  {
    const fresh = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 1, label: 'fresh' });
    const stale = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 5, label: 'stale' });
    const staleUnassigned = await mkTicket({ agentId: null, teamId: general.id, ageHours: 5, label: 'stale-un' });
    const inProgressStale = await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', ageHours: 9, label: 'prog-stale' });

    eq('threshold: a 1-hour-old ticket is not unattended', workload.isUnattended(fresh), false);
    eq('threshold: a 5-hour-old NEW ticket is unattended', workload.isUnattended(stale), true);
    eq('threshold: an unassigned 5-hour-old ticket is unattended too', workload.isUnattended(staleUnassigned), true);
    eq('threshold: IN_PROGRESS is never "unattended"', workload.isUnattended(inProgressStale), false);
    check('threshold: exactly 4 hours qualifies',
      workload.isUnattended({ state: 'NEW', createdAt: new Date(Date.now() - 4 * HOUR) }), 'boundary');
    check('threshold: countdown reported for a fresh ticket',
      workload.hoursUntilClaimable(fresh) > 2.9 && workload.hoursUntilClaimable(fresh) <= 3.01,
      String(workload.hoursUntilClaimable(fresh)));
    eq('threshold: countdown is zero once claimable', workload.hoursUntilClaimable(stale), 0);

    // checkClaim, the rule the API enforces.
    const bobActor = { ...bob, role: 'agent' };
    const adminActor = { ...admin, role: 'admin' };

    eq('claim: teammate blocked before the threshold', workload.checkClaim(fresh, bobActor).ok, false);
    eq('claim: refusal is a 403', workload.checkClaim(fresh, bobActor).status, 403);
    check('claim: refusal explains the wait',
      /becomes available/.test(workload.checkClaim(fresh, bobActor).error),
      workload.checkClaim(fresh, bobActor).error);

    eq('claim: teammate allowed after the threshold', workload.checkClaim(stale, bobActor).ok, true);
    eq('claim: unassigned stale ticket is claimable', workload.checkClaim(staleUnassigned, bobActor).ok, true);
    eq('claim: ADMIN may assign before the threshold', workload.checkClaim(fresh, adminActor).ok, true);
    check('claim: admin reason recorded', /administrator/.test(workload.checkClaim(fresh, adminActor).reason));

    eq('claim: cannot take your own ticket', workload.checkClaim(stale, { ...alice, role: 'agent' }).ok, false);
    eq('claim: cannot take an IN_PROGRESS ticket from someone else',
      workload.checkClaim(inProgressStale, bobActor).ok, false);
    eq('claim: agent from another group is refused',
      workload.checkClaim(stale, { ...carol, role: 'agent' }).ok, false);
    eq('claim: unavailable agent cannot take tickets',
      workload.checkClaim(stale, { ...bob, role: 'agent', isAvailable: false }).ok, false);

    await prisma.ticket.deleteMany({
      where: { shortDescription: { in: [`${MARK}fresh`, `${MARK}stale`, `${MARK}stale-un`, `${MARK}prog-stale`] } },
    });
  }

  /* ================================================================== */
  /* 3. Assignment selection: lowest workload, then round-robin         */
  /* ================================================================== */
  {
    const engine = require('../src/services/assignmentEngine');
    const quiet = { log() {}, warn() {} };

    // Alice loaded, Bob free -> Bob.
    for (let i = 0; i < 3; i++) {
      await mkTicket({ agentId: alice.id, teamId: general.id, label: `load-${i}` });
    }
    const d = await engine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'general question', forceTeamId: general.id },
      prisma, quiet
    );
    eq('selection: lowest workload wins', d.agent && d.agent.id, bob.id);

    // Level them, then the tie goes to the least recently assigned.
    await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: `${MARK}load-` } } });
    await prisma.agent.update({ where: { id: alice.id }, data: { lastAssignedAt: new Date('2020-01-01') } });
    await prisma.agent.update({ where: { id: bob.id }, data: { lastAssignedAt: new Date() } });
    const rr = await engine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'general question', forceTeamId: general.id },
      prisma, quiet
    );
    eq('selection: round-robin breaks the tie', rr.agent && rr.agent.id, alice.id);

    const rr2 = await engine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'general question', forceTeamId: general.id },
      prisma, quiet
    );
    eq('selection: rotation continues', rr2.agent && rr2.agent.id, bob.id);

    // An unavailable agent is never selected.
    await prisma.agent.update({ where: { id: bob.id }, data: { isAvailable: false } });
    const noBob = await engine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'general question', forceTeamId: general.id },
      prisma, quiet
    );
    check('selection: unavailable agent excluded', !noBob.agent || noBob.agent.id !== bob.id);
    await prisma.agent.update({ where: { id: bob.id }, data: { isAvailable: true } });

    // A deactivated agent is never selected.
    await prisma.agent.update({ where: { id: bob.id }, data: { isActive: false } });
    const noBob2 = await engine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'general question', forceTeamId: general.id },
      prisma, quiet
    );
    check('selection: deactivated agent excluded', !noBob2.agent || noBob2.agent.id !== bob.id);
    await prisma.agent.update({ where: { id: bob.id }, data: { isActive: true } });
  }

  /* ================================================================== */
  /* 4. Concurrency: two workers, one ticket                            */
  /* ================================================================== */
  {
    const t = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 6, label: 'race' });

    const [first, second] = await Promise.all([
      workload.moveTicket({ ticket: t, toAgentId: bob.id, actor: 'worker-a', note: 'race a' }),
      workload.moveTicket({ ticket: t, toAgentId: carol.id, actor: 'worker-b', note: 'race b' }),
    ]);

    const winners = [first, second].filter((r) => r.moved);
    const losers = [first, second].filter((r) => !r.moved);
    eq('concurrency: exactly one writer wins', winners.length, 1);
    eq('concurrency: the other reports a conflict', losers.length, 1);
    check('concurrency: the loser explains why', /changed by another process/.test(losers[0].reason), losers[0].reason);

    const fresh = await prisma.ticket.findUnique({ where: { id: t.id } });
    check('concurrency: ticket has exactly one owner',
      fresh.assignedAgentId === bob.id || fresh.assignedAgentId === carol.id, String(fresh.assignedAgentId));

    // Replaying a stale move is a no-op, not a double assignment.
    const replay = await workload.moveTicket({ ticket: t, toAgentId: carol.id, actor: 'worker-a' });
    eq('concurrency: replaying a stale move is refused', replay.moved, false);

    const audits = await prisma.ticketAuditLog.count({ where: { ticketId: t.id } });
    eq('concurrency: only the successful move was audited', audits, 1);

    await prisma.notification.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
  }

  /* ================================================================== */
  /* 5. Previous-team ticket recovery                                   */
  /* ================================================================== */
  {
    // Alice is in General IT Support but holds a ticket that started in Hardware.
    const t = await mkTicket({
      agentId: alice.id, teamId: general.id, originTeamId: hardware.id, label: 'origin',
    });

    const returned = await workload.returnToOriginatingGroup(t, 'system');
    eq('previous team: ticket returned to its originating group', returned.teamId, hardware.id);
    eq('previous team: originatingTeamId is unchanged', returned.originatingTeamId, hardware.id);

    const audit = await prisma.ticketAuditLog.findFirst({ where: { ticketId: t.id }, orderBy: { id: 'desc' } });
    check('previous team: the return is audited', /originating assignment group/.test(audit.note), audit.note);

    // Already in its origin -> no-op.
    const again = await workload.returnToOriginatingGroup(returned, 'system');
    eq('previous team: no-op when already in the origin group', again.teamId, hardware.id);

    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.notification.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
  }

  /* ================================================================== */
  /* HTTP: availability, taking tickets, deactivation, rebalancing      */
  /* ================================================================== */
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, INITIAL_ADMIN_EMAIL: '', REBALANCE_INTERVAL_MS: '0' },
    stdio: 'ignore',
  });

  try {
    await waitForServer(server);
    const login = async (email) =>
      (await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).data.token;
    const aliceT = await login(alice.email);
    const bobT = await login(bob.email);
    const adminT = await login(admin.email);
    check('setup: logins succeeded', Boolean(aliceT && bobT && adminT));

    /* ---- workload API ---------------------------------------------- */
    {
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'api-1' });
      const mine = await req('/api/workload/me', { token: aliceT });
      eq('api: /workload/me responds', mine.status, 200);
      eq('api: own open count exposed', mine.data.openTickets, 1);

      const all = await req('/api/workload', { token: adminT });
      eq('api: /workload responds', all.status, 200);
      check('api: every agent listed with a count',
        all.data.agents.some((a) => a.agentId === alice.id && a.openTickets === 1));
      check('api: imbalance figure exposed', typeof all.data.imbalance.spread === 'number');
    }

    /* ---- Take Ticket ------------------------------------------------ */
    {
      const fresh = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 1, label: 'take-fresh' });
      const stale = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 6, label: 'take-stale' });

      const tooSoon = await req(`/api/tickets/${fresh.id}/take`, { method: 'POST', token: bobT });
      eq('take: blocked before 4 hours', tooSoon.status, 403);
      eq('take: ticket untouched',
        (await prisma.ticket.findUnique({ where: { id: fresh.id } })).assignedAgentId, alice.id);

      const ok = await req(`/api/tickets/${stale.id}/take`, { method: 'POST', token: bobT });
      eq('take: allowed after 4 hours', ok.status, 200);
      eq('take: ownership changed immediately', ok.data.assignedAgentId, bob.id);

      const audit = await prisma.ticketAuditLog.findFirst({ where: { ticketId: stale.id }, orderBy: { id: 'desc' } });
      check('take: audit entry created', /Reassigned from Alice Busy to Bob Free/.test(audit.note), audit.note);

      const note = await prisma.notification.findFirst({
        where: { agentId: alice.id, ticketId: stale.id }, orderBy: { id: 'desc' },
      });
      check('take: previous assignee gets an in-app notification', Boolean(note));
      eq('take: notification type', note.type, 'ticket_taken');

      // An admin may take a fresh ticket.
      const adminTake = await req(`/api/tickets/${fresh.id}/take`, { method: 'POST', token: adminT });
      eq('take: admin may take before the threshold', adminTake.status, 200);

      // /claim is the same handler.
      const another = await mkTicket({ agentId: alice.id, teamId: general.id, ageHours: 6, label: 'take-claim' });
      eq('take: /claim behaves identically',
        (await req(`/api/tickets/${another.id}/claim`, { method: 'POST', token: bobT })).status, 200);

      // Ticket payload advertises claimability.
      const detail = await req(`/api/tickets/${another.id}`, { token: bobT });
      check('take: ticket payload exposes unattended/hoursUntilClaimable',
        'unattended' in detail.data && 'hoursUntilClaimable' in detail.data);
    }

    /* ---- Availability: agent self-service ---------------------------- */
    {
      // Clear Alice down to a known state.
      await prisma.ticket.updateMany({ where: { assignedAgentId: alice.id }, data: { assignedAgentId: null } });

      const inProgress = await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: 'av-prog' });
      const blocked = await req('/api/workload/availability', {
        method: 'POST', token: aliceT, body: { available: false },
      });
      eq('availability: blocked while holding IN_PROGRESS work', blocked.status, 409);
      check('availability: refusal explains why', /in progress/i.test(blocked.data.error), blocked.data.error);
      check('availability: the blocking tickets are listed', blocked.data.inProgress.length === 1);
      check('availability: a way to find them is offered', Boolean(blocked.data.findThemAt));
      eq('availability: agent is still available',
        (await prisma.agent.findUnique({ where: { id: alice.id } })).isAvailable, true);

      await prisma.ticket.update({ where: { id: inProgress.id }, data: { state: 'CLOSED' } });

      // NEW tickets require confirmation first.
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'av-new-1' });
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'av-new-2' });

      const needsConfirm = await req('/api/workload/availability', {
        method: 'POST', token: aliceT, body: { available: false },
      });
      eq('availability: NEW tickets need confirmation', needsConfirm.status, 409);
      eq('availability: confirmation flag returned', needsConfirm.data.confirmationRequired, true);
      eq('availability: the tickets to be reassigned are listed', needsConfirm.data.newTickets.length, 2);

      const confirmed = await req('/api/workload/availability', {
        method: 'POST', token: aliceT, body: { available: false, confirmReassign: true },
      });
      eq('availability: confirmed change succeeds', confirmed.status, 200);
      eq('availability: agent is now unavailable', confirmed.data.isAvailable, false);
      eq('availability: NEW tickets were handed over', confirmed.data.reassigned.considered, 2);
      eq('availability: none left with the departing agent', await workload.workloadFor(alice.id), 0);

      const preview = await req('/api/workload/availability/preview', { token: aliceT });
      eq('availability: preview endpoint responds', preview.status, 200);

      const backOn = await req('/api/workload/availability', {
        method: 'POST', token: aliceT, body: { available: true },
      });
      eq('availability: becoming available again is immediate', backOn.data.isAvailable, true);
    }

    /* ---- Admin emergency override ------------------------------------ */
    {
      await prisma.ticket.updateMany({ where: { assignedAgentId: alice.id }, data: { assignedAgentId: null } });
      const prog = await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: 'force-prog' });
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'force-new' });

      const refused = await req(`/api/agents/${alice.id}`, {
        method: 'PATCH', token: adminT, body: { isAvailable: false },
      });
      eq('override: admin is warned about in-progress work', refused.status, 409);
      check('override: the warning names the force flag', /force/.test(refused.data.error), refused.data.error);

      const forced = await req(`/api/agents/${alice.id}`, {
        method: 'PATCH', token: adminT, body: { isAvailable: false, force: true },
      });
      eq('override: force succeeds', forced.status, 200);
      eq('override: agent is unavailable', forced.data.isAvailable, false);
      eq('override: all open work was reassigned', await workload.workloadFor(alice.id), 0);
      check('override: the response reports what moved', forced.data.reassigned.considered >= 2,
        JSON.stringify(forced.data.reassigned));

      const progAfter = await prisma.ticket.findUnique({ where: { id: prog.id } });
      check('override: the IN_PROGRESS ticket kept its state', progAfter.state === 'IN_PROGRESS');
      check('override: it now has a different owner', progAfter.assignedAgentId !== alice.id);

      const notified = await prisma.notification.count({
        where: { agentId: alice.id, type: 'availability_forced' },
      });
      check('override: the agent was notified', notified >= 1, String(notified));

      await req(`/api/agents/${alice.id}`, { method: 'PATCH', token: adminT, body: { isAvailable: true } });
    }

    /* ---- Admin deactivation ------------------------------------------ */
    {
      await prisma.ticket.updateMany({ where: { assignedAgentId: alice.id }, data: { assignedAgentId: null } });
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'deact-new' });
      await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: 'deact-prog' });
      const closed = await mkTicket({ agentId: alice.id, teamId: general.id, state: 'CLOSED', label: 'deact-closed' });

      const deact = await req(`/api/agents/${alice.id}`, {
        method: 'PATCH', token: adminT, body: { isActive: false },
      });
      eq('deactivation: succeeds', deact.status, 200);
      eq('deactivation: open tickets reassigned', await workload.workloadFor(alice.id), 0);
      eq('deactivation: CLOSED ticket untouched',
        (await prisma.ticket.findUnique({ where: { id: closed.id } })).assignedAgentId, alice.id);
      check('deactivation: the response reports what moved', deact.data.reassigned.considered === 2,
        JSON.stringify(deact.data.reassigned));

      await req(`/api/agents/${alice.id}`, { method: 'PATCH', token: adminT, body: { isActive: true } });
    }

    /* ---- No suitable replacement ------------------------------------- */
    {
      await prisma.ticket.updateMany({ where: { assignedAgentId: { in: [alice.id, bob.id] } }, data: { assignedAgentId: null } });
      // Only Alice can serve this group; park everyone else.
      await prisma.agent.updateMany({
        where: { email: { endsWith: `@${DOMAIN}` }, id: { not: alice.id } },
        data: { isAvailable: false },
      });
      const orphan = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'orphan' });

      const summary = await workload.reassignOpenTicketsFor(alice.id, {
        actor: 'system', reason: 'no replacement available',
      });
      eq('no replacement: reported as unassigned', summary.unassigned, 1);
      const after = await prisma.ticket.findUnique({ where: { id: orphan.id }, include: { team: true } });
      eq('no replacement: assignedAgentId is null', after.assignedAgentId, null);
      eq('no replacement: assignment group retained', after.teamId, general.id);

      await prisma.agent.updateMany({
        where: { email: { endsWith: `@${DOMAIN}` } }, data: { isAvailable: true },
      });
    }

    /* ---- Rebalancing -------------------------------------------------- */
    {
      await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: MARK } } });
      await prisma.agent.updateMany({
        where: { email: { endsWith: `@${DOMAIN}` } }, data: { isAvailable: true, isActive: true },
      });
      // Two participants only. Carol sits at zero in another group, and with a
      // threshold of 3 she would legitimately attract a second move — correct
      // behaviour, but it makes this section's arithmetic hard to read.
      await prisma.agent.update({ where: { id: carol.id }, data: { isAvailable: false } });

      // Alice 4 open, Bob 0 -> spread 4, above the threshold of 3.
      for (let i = 0; i < 4; i++) {
        await mkTicket({ agentId: alice.id, teamId: general.id, label: `bal-${i}` });
      }
      eq('rebalance: starting spread', (await workload.workloadFor(alice.id)) - (await workload.workloadFor(bob.id)), 4);

      const first = await workload.rebalanceOnce({});
      eq('rebalance: a move was made', first.moved, true);
      eq('rebalance: it moved a NEW ticket', first.ticketState, 'NEW');
      eq('rebalance: from the busiest agent', first.from, 'Alice Busy');
      eq('rebalance: to the quietest', first.to, 'Bob Free');
      eq('rebalance: only ONE ticket moved', await workload.workloadFor(bob.id), 1);
      eq('rebalance: the busiest agent dropped by one', await workload.workloadFor(alice.id), 3);

      // Recalculated: spread is now 2, below the threshold, so it stops.
      const second = await workload.rebalanceOnce({});
      eq('rebalance: stops once the spread is acceptable', second.moved, false);
      check('rebalance: it explains why it stopped', /below the threshold/.test(second.reason), second.reason);

      // A cycle is bounded and terminates.
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'bal-extra-1' });
      await mkTicket({ agentId: alice.id, teamId: general.id, label: 'bal-extra-2' });
      const cycle = await workload.rebalanceCycle({});
      check('rebalance: a cycle terminates with a reason', Boolean(cycle.stopped), JSON.stringify(cycle.stopped));
      check('rebalance: it never exceeds the per-cycle cap', cycle.moves.length <= workload.MAX_MOVES_PER_CYCLE);
      const finalSpread = Math.abs((await workload.workloadFor(alice.id)) - (await workload.workloadFor(bob.id)));
      check('rebalance: the spread ends below the threshold', finalSpread < workload.IMBALANCE_THRESHOLD, String(finalSpread));

      // NEW is preferred over IN_PROGRESS.
      await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: MARK } } });
      for (let i = 0; i < 3; i++) {
        await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: `pref-prog-${i}` });
      }
      await mkTicket({ agentId: alice.id, teamId: general.id, state: 'NEW', label: 'pref-new' });
      const pref = await workload.rebalanceOnce({});
      eq('rebalance: prefers a NEW ticket over IN_PROGRESS', pref.ticketState, 'NEW');

      // With only IN_PROGRESS left and the gap still >= 3, it moves one.
      await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: MARK } } });
      await prisma.ticket.updateMany({ where: { assignedAgentId: bob.id }, data: { assignedAgentId: null } });
      for (let i = 0; i < 4; i++) {
        await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: `only-prog-${i}` });
      }
      const progMove = await workload.rebalanceOnce({});
      eq('rebalance: moves IN_PROGRESS when nothing else is available', progMove.moved, true);
      eq('rebalance: and it is an IN_PROGRESS ticket', progMove.ticketState, 'IN_PROGRESS');

      const progNote = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'ticket_rebalanced' }, orderBy: { id: 'desc' },
      });
      check('rebalance: the original agent is notified of an IN_PROGRESS move', Boolean(progNote));
      check('rebalance: the notification records why',
        progNote && /workload balancing/.test(progNote.body || ''), progNote && progNote.body);

      const balAudit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: progMove.ticketId }, orderBy: { id: 'desc' },
      });
      check('rebalance: the move is audited with a reason',
        /workload balancing/.test(balAudit.note), balAudit.note);

      await prisma.agent.update({ where: { id: carol.id }, data: { isAvailable: true } });

      // Admin-only endpoint.
      eq('rebalance: agents cannot trigger it',
        (await req('/api/workload/rebalance', { method: 'POST', token: bobT })).status, 403);
      const run = await req('/api/workload/rebalance', { method: 'POST', token: adminT, body: { dryRun: true } });
      eq('rebalance: admin dry run responds', run.status, 200);
      eq('rebalance: dry run makes no changes', run.data.dryRun, true);
    }

    /* ---- Cross-team fallback on reassignment --------------------------- */
    {
      await prisma.ticket.deleteMany({ where: { shortDescription: { startsWith: MARK } } });
      // Only Carol (Hardware) is available; the ticket belongs to General IT.
      await prisma.agent.updateMany({
        where: { email: { endsWith: `@${DOMAIN}` }, id: { notIn: [carol.id, alice.id] } },
        data: { isAvailable: false },
      });
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'cross' });

      const summary = await workload.reassignOpenTicketsFor(alice.id, {
        actor: 'system', reason: 'cross-team test',
      });
      eq('cross-team: the ticket found an owner', summary.moved, 1);
      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('cross-team: taken by the agent from another team', after.assignedAgentId, carol.id);
      eq('cross-team: assignment group is unchanged', after.teamId, general.id);

      await prisma.agent.updateMany({
        where: { email: { endsWith: `@${DOMAIN}` } }, data: { isAvailable: true },
      });
    }

    /* ---- Notification feed --------------------------------------------- */
    {
      const feed = await req('/api/workload/notifications', { token: aliceT });
      eq('notifications: feed responds', feed.status, 200);
      check('notifications: entries returned', feed.data.notifications.length > 0, String(feed.data.notifications.length));
      check('notifications: unread count reported', typeof feed.data.unread === 'number');
      const marked = await req('/api/workload/notifications/read', { method: 'POST', token: aliceT });
      eq('notifications: can be marked read', marked.status, 200);
      const after = await req('/api/workload/notifications', { token: aliceT });
      eq('notifications: unread count drops to zero', after.data.unread, 0);
      const others = await req('/api/workload/notifications', { token: bobT });
      check('notifications: an agent only sees their own',
        others.data.notifications.every((n) => n.agentId === bob.id));
    }
  } finally {
    server.kill();
    await unparkOthers();
    await cleanup();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => { console.error(err); failures += 1; })
  .finally(async () => {
    await unparkOthers().catch(() => {});
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
