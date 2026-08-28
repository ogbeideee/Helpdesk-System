/* Agent-to-agent ticket handovers.

   Runs against a live ephemeral server. Every agent and ticket is created by
   the test; pre-existing staff and routing rules are parked so the assignment
   algorithms are deterministic. No Graph, no email, no credentials.

   Usage: npm run test:handover  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4167';
// The background workers are driven directly by this suite.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';

// Isolated database: this suite never touches the application's dev.db.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('handover');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const workload = require('../src/services/workloadService');
const handover = require('../src/services/handoverService');
const settings = require('../src/services/settingsService');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const MARK = 'ho-test-';
const DOMAIN = 'handover.example';
const PASSWORD = 'HandoverPass!123';

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

async function login(email) {
  const r = await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.token;
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
  const users = await prisma.agent.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.handoverRequest.deleteMany({
      where: { OR: [{ requestedById: { in: ids } }, { targetAgentId: { in: ids } }] },
    });
  }
  const tickets = await prisma.ticket.findMany({
    where: { OR: [{ graphMessageId: { startsWith: MARK } }, { requesterEmail: { endsWith: `@${DOMAIN}` } }] },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.handoverRequest.deleteMany({ where: { ticketId: t.id } });
    await prisma.notification.deleteMany({ where: { ticketId: t.id } });
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  if (ids.length) {
    await prisma.ticket.updateMany({ where: { assignedAgentId: { in: ids } }, data: { assignedAgentId: null } });
    await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.userAuditLog.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.routingRule.updateMany({ where: { preferredAgentId: { in: ids } }, data: { preferredAgentId: null } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  }
  // Settings this suite changes are restored to "unset" (env default).
  await prisma.setting.deleteMany({ where: { key: { in: ['handoverPendingLimit', 'handoverExpiryMinutes'] } } });
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const mkAgent = (name, local, teamId, skillLevel = 3, extra = {}) =>
  prisma.agent.create({
    data: {
      name, email: `${local}@${DOMAIN}`, teamId, skillLevel,
      role: 'agent', isActive: true, isAvailable: true, passwordHash: hash,
      lastAssignedAt: null, ...extra,
    },
  });

let seq = 0;
async function mkTicket({ agentId, teamId, state = 'NEW', label }) {
  seq += 1;
  const suffix = label || `t${seq}`;
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: `${MARK}${suffix}`,
      body: 'Handover fixture ticket.',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state,
      source: 'portal',
      requesterEmail: `req@${DOMAIN}`,
      graphMessageId: `${MARK}${suffix}-${seq}`,
      teamId,
      originatingTeamId: teamId,
      assignedAgentId: agentId ?? null,
    },
  });
}

const request = (token, ticketId, agentId, note) =>
  req(`/api/tickets/${ticketId}/handover`, { method: 'POST', token, body: { agentId, note } });

async function main() {
  await ensureTeams(prisma);
  await cleanup();
  await parkOthers();

  const teams = Object.fromEntries((await prisma.team.findMany()).map((t) => [t.key, t]));
  const general = teams.service_desk;
  const hardware = teams.hardware;

  const alice = await mkAgent('Alice Owner', 'alice', general.id);
  const bob = await mkAgent('Bob Target', 'bob', general.id);
  const carol = await mkAgent('Carol Third', 'carol', general.id);
  const dave = await mkAgent('Dave Fourth', 'dave', general.id);
  const erin = await mkAgent('Erin Other Team', 'erin', hardware.id);
  const admin = await mkAgent('Handover Admin', 'hoadmin', general.id, 3, { role: 'admin' });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });

  try {
    await waitForServer(server);
    const aliceT = await login(alice.email);
    const bobT = await login(bob.email);
    const carolT = await login(carol.email);
    const daveT = await login(dave.email);
    const erinT = await login(erin.email);
    const adminT = await login(admin.email);

    /* ================================================================== */
    /* 1. Creating a handover request                                     */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'create' });

      const created = await request(aliceT, t.id, bob.id, 'Handing this to you, I am on the network outage.');
      eq('create: request accepted', created.status, 201);
      eq('create: starts PENDING', created.data.request.status, 'PENDING');
      eq('create: requester is the current owner', created.data.request.requestedById, alice.id);
      eq('create: target recorded', created.data.request.targetAgentId, bob.id);
      check('create: expiry set', Boolean(created.data.request.expiresAt));
      check('create: note kept', created.data.request.note.startsWith('Handing this to you'));

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('create: ownership does NOT change yet', after.assignedAgentId, alice.id);
      eq('create: ticket status unchanged', after.state, 'NEW');

      const inbox = await req('/api/handovers/inbox', { token: bobT });
      eq('create: appears in the target inbox', inbox.data.pending.length, 1);
      eq('create: inbox carries the ticket number', inbox.data.pending[0].ticket.ticketNumber, t.ticketNumber);
      check('create: inbox carries the requesting agent', inbox.data.pending[0].requestedBy.name === 'Alice Owner');
      check('create: inbox reports time remaining', inbox.data.pending[0].remainingMs > 0);

      const outbox = await req('/api/handovers/outbox', { token: aliceT });
      eq('create: appears in the requester outbox', outbox.data.requests.length, 1);

      const notif = await prisma.notification.findFirst({
        where: { agentId: bob.id, type: 'handover_requested', ticketId: t.id },
      });
      check('create: the target is notified', Boolean(notif));

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { startsWith: 'Handover requested' } },
      });
      check('create: recorded in ticket history', Boolean(audit));

      // One offer at a time per ticket.
      const dup = await request(aliceT, t.id, carol.id);
      eq('create: a second offer on the same ticket is refused', dup.status, 409);

      /* ---- 2. Accept ------------------------------------------------- */
      const id = created.data.request.id;
      const workloadBefore = await workload.workloadFor(bob.id);
      eq('workload: a pending handover does not count for the target', workloadBefore, 0);
      eq('workload: it still counts for the current owner', await workload.workloadFor(alice.id), 1);

      const accepted = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: bobT });
      eq('accept: succeeds', accepted.status, 200);
      eq('accept: marked ACCEPTED', accepted.data.request.status, 'ACCEPTED');

      const owned = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('accept: ownership transfers immediately', owned.assignedAgentId, bob.id);
      eq('accept: ticket status is unchanged', owned.state, 'NEW');
      eq('accept: workload moves to the new owner', await workload.workloadFor(bob.id), 1);
      eq('accept: workload leaves the previous owner', await workload.workloadFor(alice.id), 0);

      const accNotif = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'handover_accepted', ticketId: t.id },
      });
      check('accept: the previous agent is notified', Boolean(accNotif));

      const accAudit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { contains: 'handover accepted by Bob Target' } },
      });
      check('accept: recorded in ticket history', Boolean(accAudit));

      const history = await req(`/api/tickets/${t.id}/handovers`, { token: aliceT });
      eq('history: the accepted handover is retained', history.data.handovers.length, 1);
      eq('history: it keeps its result', history.data.handovers[0].status, 'ACCEPTED');
    }

    /* ================================================================== */
    /* 3. Decline                                                         */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'decline' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const declined = await req(`/api/handovers/${id}/decline`, {
        method: 'POST', token: bobT, body: { note: 'At capacity today.' },
      });
      eq('decline: succeeds', declined.status, 200);
      eq('decline: marked DECLINED', declined.data.request.status, 'DECLINED');

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('decline: the ticket stays with the original agent', after.assignedAgentId, alice.id);

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { startsWith: 'Handover declined by Bob Target' } },
      });
      check('decline: history records "Handover declined by [name]"', Boolean(audit));

      const notif = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'handover_declined', ticketId: t.id },
      });
      check('decline: the original agent is notified', Boolean(notif));

      // Requirement 2: the original agent can now try somebody else.
      const retry = await request(aliceT, t.id, carol.id);
      eq('decline: the original agent can try another teammate', retry.status, 201);
      await req(`/api/handovers/${retry.data.request.id}/cancel`, { method: 'POST', token: aliceT });
    }

    /* ================================================================== */
    /* 4. Suggest another teammate                                        */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'suggest' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const suggested = await req(`/api/handovers/${id}/suggest`, {
        method: 'POST', token: bobT, body: { agentId: carol.id, note: 'Carol knows this printer.' },
      });
      eq('suggest: succeeds', suggested.status, 200);
      eq('suggest: the request itself is closed', suggested.data.request.status, 'DECLINED');
      eq('suggest: the suggestion is recorded', suggested.data.request.suggestedAgentId, carol.id);
      check('suggest: the suggested agent is named', suggested.data.suggestion.name === 'Carol Third');

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('suggest: the ticket stays with the original agent', after.assignedAgentId, alice.id);

      // Requirement 2: no request is created for the suggested teammate.
      const carolInbox = await req('/api/handovers/inbox', { token: carolT });
      eq('suggest: no request is auto-sent to the suggested teammate',
        carolInbox.data.pending.filter((r) => r.ticketId === t.id).length, 0);
      const anyForCarol = await prisma.handoverRequest.count({
        where: { ticketId: t.id, targetAgentId: carol.id },
      });
      eq('suggest: nothing was created for them at all', anyForCarol, 0);

      const notif = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'handover_suggested', ticketId: t.id },
      });
      check('suggest: the suggestion is shown to the original agent', Boolean(notif));

      // The original agent decides. Only then does a request exist.
      const approved = await request(aliceT, t.id, carol.id);
      eq('suggest: the suggested teammate needs the original agent to send it', approved.status, 201);
      eq('suggest: and then they do have a request', approved.data.request.targetAgentId, carol.id);
      await req(`/api/handovers/${approved.data.request.id}/cancel`, { method: 'POST', token: aliceT });

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { contains: 'suggested Carol Third instead' } },
      });
      check('suggest: recorded in ticket history', Boolean(audit));
    }

    /* ================================================================== */
    /* 5. Pending limit and the FIFO queue                                */
    /* ================================================================== */
    {
      const settingsRes = await req('/api/handovers/settings', { token: aliceT });
      eq('limit: default is 2 active requests per recipient', settingsRes.data.settings.handoverPendingLimit, 2);

      const t1 = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'q1' });
      const t2 = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'q2' });
      const t3 = await mkTicket({ agentId: carol.id, teamId: general.id, label: 'q3' });
      const t4 = await mkTicket({ agentId: dave.id, teamId: general.id, label: 'q4' });

      const r1 = await request(aliceT, t1.id, bob.id);
      const r2 = await request(aliceT, t2.id, bob.id);
      const r3 = await request(carolT, t3.id, bob.id);
      const r4 = await request(daveT, t4.id, bob.id);

      eq('limit: the first request is active', r1.data.request.status, 'PENDING');
      eq('limit: the second request is active', r2.data.request.status, 'PENDING');
      eq('limit: the third is queued, not active', r3.data.request.status, 'QUEUED');
      eq('limit: the fourth is queued too', r4.data.request.status, 'QUEUED');
      eq('queue: FIFO position of the third', r3.data.request.queuePosition, 1);
      eq('queue: FIFO position of the fourth', r4.data.request.queuePosition, 2);

      const inbox = await req('/api/handovers/inbox', { token: bobT });
      eq('limit: exactly 2 pending in the inbox', inbox.data.pending.length, 2);
      eq('queue: 2 queued behind them', inbox.data.queued.length, 2);
      eq('limit: the inbox reports the configured limit', inbox.data.limit, 2);

      eq('workload: queued handovers do not count for the recipient', await workload.workloadFor(bob.id), 1);

      // Answering one frees a slot: the OLDEST queued request activates.
      const declined = await req(`/api/handovers/${r1.data.request.id}/decline`, { method: 'POST', token: bobT });
      eq('promotion: answering one succeeds', declined.status, 200);

      const promoted = await prisma.handoverRequest.findUnique({ where: { id: r3.data.request.id } });
      eq('promotion: the oldest queued request is activated automatically', promoted.status, 'PENDING');
      check('promotion: its expiry clock starts on activation', Boolean(promoted.expiresAt));
      const stillQueued = await prisma.handoverRequest.findUnique({ where: { id: r4.data.request.id } });
      eq('promotion: the newer one stays queued (FIFO)', stillQueued.status, 'QUEUED');

      const promoNotif = await prisma.notification.findFirst({
        where: { agentId: bob.id, type: 'handover_requested', ticketId: t3.id },
      });
      check('promotion: the recipient is notified', Boolean(promoNotif));

      /* ---- configurable limit ---------------------------------------- */
      const denied = await req('/api/handovers/settings', {
        method: 'PATCH', token: bobT, body: { handoverPendingLimit: 5 },
      });
      eq('settings: an agent cannot change the limit', denied.status, 403);

      const raised = await req('/api/handovers/settings', {
        method: 'PATCH', token: adminT, body: { handoverPendingLimit: 3 },
      });
      eq('settings: an admin can change the limit', raised.status, 200);
      eq('settings: the new limit is returned', raised.data.settings.handoverPendingLimit, 3);
      eq('settings: it is rejected when out of range',
        (await req('/api/handovers/settings', { method: 'PATCH', token: adminT, body: { handoverPendingLimit: 0 } })).status, 400);

      // Raising the limit opens a slot, so the queue drains on the next event.
      await handover.promoteQueue(bob.id);
      const nowActive = await prisma.handoverRequest.findUnique({ where: { id: r4.data.request.id } });
      eq('settings: raising the limit activates a queued request', nowActive.status, 'PENDING');
      eq('settings: the recipient now holds 3 active requests', await handover.activeCountFor(bob.id), 3);

      await req('/api/handovers/settings', { method: 'PATCH', token: adminT, body: { handoverPendingLimit: 2 } });

      for (const r of [r2, r3, r4]) {
        await req(`/api/handovers/${r.data.request.id}/cancel`, { method: 'POST', token: adminT });
      }
    }

    /* ================================================================== */
    /* 6. Expiry                                                          */
    /* ================================================================== */
    {
      await req('/api/handovers/settings', { method: 'PATCH', token: adminT, body: { handoverExpiryMinutes: 60 } });
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'expiry' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const beforeSweep = await handover.sweepExpired({});
      eq('expiry: a request inside its window is not expired', beforeSweep.expired, 0);

      // Wind the clock back rather than waiting an hour.
      await prisma.handoverRequest.update({
        where: { id }, data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const swept = await req('/api/handovers/sweep', { method: 'POST', token: adminT });
      eq('expiry: the sweep expires it', swept.data.expired, 1);

      const expired = await prisma.handoverRequest.findUnique({ where: { id } });
      eq('expiry: marked EXPIRED', expired.status, 'EXPIRED');

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('expiry: ownership stays with the original agent', after.assignedAgentId, alice.id);

      const notif = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'handover_expired', ticketId: t.id },
      });
      check('expiry: the original agent is notified', Boolean(notif));
      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { contains: 'expired' } },
      });
      check('expiry: recorded in ticket history', Boolean(audit));

      const answering = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: bobT });
      eq('expiry: an expired request can no longer be accepted', answering.status, 409);
    }

    /* ================================================================== */
    /* 7. Expiry pauses while the recipient is unavailable                */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'pause' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const off = await req('/api/workload/availability', {
        method: 'POST', token: bobT, body: { available: false, confirmReassign: true },
      });
      eq('pause: the recipient can go unavailable', off.status, 200);

      const paused = await prisma.handoverRequest.findUnique({ where: { id } });
      eq('pause: the request is kept', paused.status, 'PENDING');
      check('pause: its timer is paused', Boolean(paused.pausedAt));
      eq('pause: no absolute deadline while paused', paused.expiresAt, null);
      check('pause: the remaining time is parked', paused.remainingMs > 0, String(paused.remainingMs));

      // Time passing while away must not expire it.
      const sweep = await handover.sweepExpired({});
      eq('pause: a paused request is never expired by the sweep', sweep.expired, 0);

      const banked = paused.remainingMs;
      const on = await req('/api/workload/availability', { method: 'POST', token: bobT, body: { available: true } });
      eq('pause: the recipient can come back', on.status, 200);

      const resumed = await prisma.handoverRequest.findUnique({ where: { id } });
      eq('resume: no longer paused', resumed.pausedAt, null);
      check('resume: the deadline is restored from the banked time',
        Math.abs(new Date(resumed.expiresAt).getTime() - Date.now() - banked) < 5000,
        `banked ${banked}, expires in ${new Date(resumed.expiresAt).getTime() - Date.now()}`);

      const accepted = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: bobT });
      eq('resume: the request is still answerable', accepted.status, 200);
      await prisma.ticket.update({ where: { id: t.id }, data: { assignedAgentId: alice.id } });
    }

    /* ================================================================== */
    /* 8. Deactivated recipient                                           */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'deactivate' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const off = await req(`/api/agents/${bob.id}`, {
        method: 'PATCH', token: adminT, body: { isActive: false },
      });
      eq('deactivation: the admin can deactivate the recipient', off.status, 200);

      const rerouted = await prisma.handoverRequest.findUnique({
        where: { id }, include: { targetAgent: true },
      });
      check('deactivation: the request survives', ['PENDING', 'QUEUED'].includes(rerouted.status), rerouted.status);
      check('deactivation: it is routed to a different agent', rerouted.targetAgentId !== bob.id,
        `still ${rerouted.targetAgentId}`);
      check('deactivation: the new target is an available agent',
        rerouted.targetAgent.isActive && rerouted.targetAgent.isAvailable);
      eq('deactivation: it is never routed back to the ticket owner', rerouted.targetAgentId === alice.id, false);

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('deactivation: ownership is untouched by the reroute', after.assignedAgentId, alice.id);

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { startsWith: 'Handover rerouted' } },
      });
      check('deactivation: recorded in ticket history', Boolean(audit));
      const notif = await prisma.notification.findFirst({
        where: { agentId: alice.id, type: 'handover_rerouted', ticketId: t.id },
      });
      check('deactivation: the original agent is told where it went', Boolean(notif));

      await req(`/api/handovers/${id}/cancel`, { method: 'POST', token: adminT });
      await req(`/api/agents/${bob.id}`, { method: 'PATCH', token: adminT, body: { isActive: true, isAvailable: true } });
    }

    /* ================================================================== */
    /* 9. Cancellation                                                    */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'cancel' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const byOther = await req(`/api/handovers/${id}/cancel`, { method: 'POST', token: carolT });
      eq('cancel: an unrelated agent cannot cancel it', byOther.status, 403);

      const notifBefore = await prisma.notification.count({ where: { agentId: bob.id, ticketId: t.id } });

      const cancelled = await req(`/api/handovers/${id}/cancel`, {
        method: 'POST', token: aliceT, body: { reason: 'Sorted it myself.' },
      });
      eq('cancel: the original agent can withdraw it', cancelled.status, 200);
      eq('cancel: marked CANCELLED', cancelled.data.request.status, 'CANCELLED');

      const notifAfter = await prisma.notification.count({ where: { agentId: bob.id, ticketId: t.id } });
      eq('cancel: the recipient is NOT notified', notifAfter, notifBefore);

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { contains: 'cancelled by Alice Owner' } },
      });
      check('cancel: retained in ticket history', Boolean(audit));

      const answering = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: bobT });
      eq('cancel: a cancelled request cannot be accepted', answering.status, 409);

      // A queued request can be cancelled before it is ever activated.
      const t2 = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'cancel-q1' });
      const t3 = await mkTicket({ agentId: carol.id, teamId: general.id, label: 'cancel-q2' });
      const t4 = await mkTicket({ agentId: dave.id, teamId: general.id, label: 'cancel-q3' });
      const a = await request(aliceT, t2.id, bob.id);
      const b = await request(carolT, t3.id, bob.id);
      const c = await request(daveT, t4.id, bob.id);
      eq('cancel: the third request is queued', c.data.request.status, 'QUEUED');
      const cancelQueued = await req(`/api/handovers/${c.data.request.id}/cancel`, { method: 'POST', token: daveT });
      eq('cancel: a queued request can be cancelled too', cancelQueued.status, 200);
      eq('cancel: it is marked CANCELLED', cancelQueued.data.request.status, 'CANCELLED');

      // ADMIN can cancel anything.
      const adminCancel = await req(`/api/handovers/${a.data.request.id}/cancel`, { method: 'POST', token: adminT });
      eq('cancel: an admin can cancel any request', adminCancel.status, 200);
      await req(`/api/handovers/${b.data.request.id}/cancel`, { method: 'POST', token: adminT });
    }

    /* ================================================================== */
    /* 10. ADMIN override                                                 */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'override' });

      // An admin may raise a handover on the owner's behalf.
      const created = await req(`/api/tickets/${t.id}/handover`, {
        method: 'POST', token: adminT, body: { agentId: bob.id },
      });
      eq('override: an admin can create a handover for somebody else', created.status, 201);
      eq('override: the requester is still the ticket owner', created.data.request.requestedById, alice.id);
      const id = created.data.request.id;

      const byAgent = await req(`/api/handovers/${id}/override`, { method: 'POST', token: carolT });
      eq('override: an agent cannot override', byAgent.status, 403);

      const forced = await req(`/api/handovers/${id}/override`, { method: 'POST', token: adminT });
      eq('override: the admin forces it through', forced.status, 200);
      eq('override: marked ACCEPTED', forced.data.request.status, 'ACCEPTED');

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('override: ownership transfers without the recipient answering', after.assignedAgentId, bob.id);
      await prisma.ticket.update({ where: { id: t.id }, data: { assignedAgentId: alice.id } });
    }

    /* ================================================================== */
    /* 11. Resolving/closing the ticket cancels a pending handover        */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, state: 'IN_PROGRESS', label: 'closure' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const resolved = await req(`/api/tickets/${t.id}/resolve`, {
        method: 'POST', token: aliceT, body: { resolution: 'Fixed while the handover was pending.' },
      });
      eq('closure: the ticket resolves normally', resolved.status, 200);

      const request1 = await prisma.handoverRequest.findUnique({ where: { id } });
      eq('closure: the pending handover is cancelled', request1.status, 'CANCELLED');

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('closure: the ticket is left resolved', after.state, 'RESOLVED');
      eq('closure: ownership is unchanged', after.assignedAgentId, alice.id);

      const audit = await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t.id, note: { contains: 'cancelled — ticket was resolved' } },
      });
      check('closure: the cancellation is recorded', Boolean(audit));

      const late = await request(aliceT, t.id, bob.id);
      eq('closure: no new handover can be raised on a resolved ticket', late.status, 400);
    }

    /* ================================================================== */
    /* 12. Permissions (enforced on the backend, not the UI)              */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'perms' });

      const notMine = await request(carolT, t.id, bob.id);
      eq('permissions: an agent cannot hand over somebody else\'s ticket', notMine.status, 403);

      const crossTeam = await request(aliceT, t.id, erin.id);
      eq('permissions: an agent cannot hand over outside their group', crossTeam.status, 403);

      const toSelf = await request(aliceT, t.id, alice.id);
      eq('permissions: an agent cannot hand a ticket to themselves', toSelf.status, 400);

      const anon = await req(`/api/tickets/${t.id}/handover`, { method: 'POST', body: { agentId: bob.id } });
      eq('permissions: authentication is required', anon.status, 401);

      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      const wrongResponder = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: carolT });
      eq('permissions: only the target can accept', wrongResponder.status, 403);
      const wrongDecliner = await req(`/api/handovers/${id}/decline`, { method: 'POST', token: carolT });
      eq('permissions: only the target can decline', wrongDecliner.status, 403);
      const wrongSuggester = await req(`/api/handovers/${id}/suggest`, {
        method: 'POST', token: carolT, body: { agentId: dave.id },
      });
      eq('permissions: only the target can suggest', wrongSuggester.status, 403);
      const requesterAccepting = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: aliceT });
      eq('permissions: the requester cannot accept their own handover', requesterAccepting.status, 403);

      // The admin bypasses all of the above.
      const adminAccept = await req(`/api/handovers/${id}/accept`, { method: 'POST', token: adminT });
      eq('permissions: an admin may act on any handover', adminAccept.status, 200);
      await prisma.ticket.update({ where: { id: t.id }, data: { assignedAgentId: alice.id } });

      // An admin can still reassign directly, bypassing the handover process.
      const direct = await req(`/api/tickets/${t.id}/reassign`, {
        method: 'POST', token: adminT, body: { agentId: erin.id },
      });
      eq('permissions: an admin can still reassign directly', direct.status, 200);
      await prisma.ticket.update({ where: { id: t.id }, data: { assignedAgentId: alice.id } });
    }

    /* ================================================================== */
    /* 13. Concurrency                                                    */
    /* ================================================================== */
    {
      const t = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'race' });
      const created = await request(aliceT, t.id, bob.id);
      const id = created.data.request.id;

      // Two simultaneous accepts: the admin and the target both answer at once.
      const [a, b] = await Promise.all([
        req(`/api/handovers/${id}/accept`, { method: 'POST', token: bobT }),
        req(`/api/handovers/${id}/accept`, { method: 'POST', token: adminT }),
      ]);
      const codes = [a.status, b.status].sort();
      check('concurrency: exactly one accept wins', codes[0] === 200 && codes[1] === 409,
        JSON.stringify(codes));

      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('concurrency: the ticket lands with the target exactly once', after.assignedAgentId, bob.id);

      const moves = await prisma.ticketAuditLog.count({
        where: { ticketId: t.id, note: { contains: 'handover accepted' } },
      });
      eq('concurrency: only one ownership change is recorded', moves, 1);

      // An accept racing a cancel: still exactly one outcome.
      await prisma.ticket.update({ where: { id: t.id }, data: { assignedAgentId: alice.id } });
      const second = await request(aliceT, t.id, bob.id);
      const id2 = second.data.request.id;
      const [acc, can] = await Promise.all([
        req(`/api/handovers/${id2}/accept`, { method: 'POST', token: bobT }),
        req(`/api/handovers/${id2}/cancel`, { method: 'POST', token: aliceT }),
      ]);
      check('concurrency: accept and cancel cannot both succeed',
        [acc.status, can.status].filter((s) => s === 200).length === 1,
        JSON.stringify([acc.status, can.status]));
      const final = await prisma.handoverRequest.findUnique({ where: { id: id2 } });
      check('concurrency: the request settles on one status',
        ['ACCEPTED', 'CANCELLED'].includes(final.status), final.status);
    }

    /* ================================================================== */
    /* 14. Workload is untouched by pending handovers                     */
    /* ================================================================== */
    {
      await prisma.ticket.updateMany({
        where: { shortDescription: { startsWith: MARK } }, data: { assignedAgentId: null },
      });
      const t1 = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'wl1' });
      const t2 = await mkTicket({ agentId: alice.id, teamId: general.id, label: 'wl2' });

      const aliceBefore = await workload.workloadFor(alice.id);
      const bobBefore = await workload.workloadFor(bob.id);

      await request(aliceT, t1.id, bob.id);
      await request(aliceT, t2.id, bob.id);

      eq('workload: the requester keeps their tickets while offers are open',
        await workload.workloadFor(alice.id), aliceBefore);
      eq('workload: the recipient gains nothing from pending offers',
        await workload.workloadFor(bob.id), bobBefore);

      const snap = await workload.workloadSnapshot();
      const bobRow = snap.agents.find((a) => a.agentId === bob.id);
      eq('workload: the dashboard snapshot agrees', bobRow.openTickets, bobBefore);
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
