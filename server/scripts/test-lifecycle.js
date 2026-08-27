/* Ticket lifecycle, reassignment, authorization and workload tests.

   Runs against a live ephemeral server so every rule is exercised through the
   HTTP API — the same surface an agent could call directly to try to bypass
   the UI. No Microsoft Graph, no credentials.

   Usage: npm run test:lifecycle  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4188';

const { spawn } = require('child_process');
const path = require('path');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');

const BASE = `http://localhost:${process.env.PORT}`;
const MARK = 'lifecycle-test-';
const DOMAIN = 'lifecycle.example';
const PASSWORD = 'LifecyclePass!123';

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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

const bcrypt = require('bcryptjs');

async function cleanup() {
  const tickets = await prisma.ticket.findMany({
    where: { OR: [{ graphMessageId: { startsWith: MARK } }, { requesterEmail: { endsWith: `@${DOMAIN}` } }] },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  await prisma.agent.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
}

/** Create a ticket already in a known state, owned by a known agent. */
async function makeTicket({ agentId, teamId, state = 'NEW', suffix }) {
  const { nextTicketNumber } = require('../src/ticketNumbers');
  const number = await nextTicketNumber(prisma);
  return prisma.ticket.create({
    data: {
      ticketNumber: number,
      shortDescription: `${MARK}${suffix}`,
      body: 'Lifecycle fixture.',
      category: 'Hardware',
      priority: 'moderate',
      state,
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      requesterName: 'Fixture Requester',
      graphMessageId: `${MARK}${suffix}`,
      graphConversationId: `${MARK}conv-${suffix}`,
      teamId,
      assignedAgentId: agentId,
      auditLogs: { create: { fromState: null, toState: state, actor: 'system', note: 'fixture' } },
    },
  });
}

async function main() {
  await ensureTeams(prisma);
  await cleanup();

  const hardware = await prisma.team.findUnique({ where: { key: 'hardware' } });
  const software = await prisma.team.findUnique({ where: { key: 'software' } });

  const hash = bcrypt.hashSync(PASSWORD, 10);
  // isActive = account enabled; isAvailable = currently accepting work.
  const mk = (name, email, teamId, skillLevel, isAvailable = true, role = 'agent') =>
    prisma.agent.create({
      data: { name, email, teamId, skillLevel, isActive: true, isAvailable, role, passwordHash: hash },
    });

  // Hardware team
  const jane = await mk('Jane Smith', `jane@${DOMAIN}`, hardware.id, 2);
  const sarah = await mk('Sarah Smith', `sarah@${DOMAIN}`, hardware.id, 3);
  const michael = await mk('Michael Brown', `michael@${DOMAIN}`, hardware.id, 1, false); // on leave: active but unavailable
  // Software team
  const dave = await mk('Dave Software', `dave@${DOMAIN}`, software.id, 2);
  // Admin
  const admin = await mk('Lifecycle Admin', `admin@${DOMAIN}`, null, 3, true, 'admin');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env },
    stdio: 'ignore',
  });

  try {
    await waitForServer(server);

    const login = async (email) =>
      (await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).data.token;

    const janeT = await login(jane.email);
    const sarahT = await login(sarah.email);
    const daveT = await login(dave.email);
    const adminT = await login(admin.email);
    check('setup: all four logins succeeded', Boolean(janeT && sarahT && daveT && adminT));

    /* ============================================================== */
    /* LIFECYCLE                                                      */
    /* ============================================================== */
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'lifecycle-1' });

      // NEW -> IN_PROGRESS via the dedicated Start action
      const started = await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: janeT });
      eq('lifecycle: NEW -> IN_PROGRESS via /start', started.status, 200);
      eq('lifecycle: state is IN_PROGRESS', started.data.state, 'IN_PROGRESS');

      const audits1 = await prisma.ticketAuditLog.findMany({ where: { ticketId: t.id }, orderBy: { id: 'desc' }, take: 1 });
      check('lifecycle: start recorded in the audit history', audits1[0].fromState === 'NEW' && audits1[0].toState === 'IN_PROGRESS');
      check('lifecycle: start records the acting agent', audits1[0].actor.includes('Jane Smith'), audits1[0].actor);

      // Starting twice is rejected
      const restart = await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: janeT });
      eq('lifecycle: cannot start an already-started ticket', restart.status, 400);

      // IN_PROGRESS -> RESOLVED requires a resolution note
      const noNote = await req(`/api/tickets/${t.id}/resolve`, { method: 'POST', token: janeT, body: {} });
      eq('lifecycle: resolve without a note is rejected', noNote.status, 400);
      const blankNote = await req(`/api/tickets/${t.id}/resolve`, { method: 'POST', token: janeT, body: { resolution: '   ' } });
      eq('lifecycle: resolve with a blank note is rejected', blankNote.status, 400);

      const resolution = "Reset the user's password and confirmed that they can successfully sign in.";
      const resolved = await req(`/api/tickets/${t.id}/resolve`, { method: 'POST', token: janeT, body: { resolution } });
      eq('lifecycle: IN_PROGRESS -> RESOLVED', resolved.status, 200);
      eq('lifecycle: state is RESOLVED', resolved.data.state, 'RESOLVED');
      eq('lifecycle: resolution note stored', resolved.data.resolution, resolution);
      check('lifecycle: resolvedAt populated', Boolean(resolved.data.resolvedAt));

      const audits2 = await prisma.ticketAuditLog.findMany({ where: { ticketId: t.id }, orderBy: { id: 'desc' }, take: 1 });
      check('lifecycle: resolution records the resolving agent', audits2[0].actor.includes('Jane Smith'));
      check('lifecycle: resolution transition audited', audits2[0].fromState === 'IN_PROGRESS' && audits2[0].toState === 'RESOLVED');

      // RESOLVED -> CLOSED
      const closed = await req(`/api/tickets/${t.id}/close`, { method: 'POST', token: adminT, body: { note: 'verified' } });
      eq('lifecycle: RESOLVED -> CLOSED', closed.status, 200);
      eq('lifecycle: state is CLOSED', closed.data.state, 'CLOSED');
      check('lifecycle: closedAt populated', Boolean(closed.data.closedAt));
      const audits3 = await prisma.ticketAuditLog.findMany({ where: { ticketId: t.id }, orderBy: { id: 'desc' }, take: 1 });
      check('lifecycle: closure records the closing actor', audits3[0].actor.includes('Lifecycle Admin'), audits3[0].actor);

      // A CLOSED ticket is final for every agent-driven transition.
      for (const target of ['NEW', 'IN_PROGRESS', 'RESOLVED']) {
        const bad = await req(`/api/tickets/${t.id}/status`, { method: 'POST', token: adminT, body: { state: target } });
        eq(`lifecycle: CLOSED -> ${target} rejected`, bad.status, 400);
      }
      const closedStart = await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: adminT });
      eq('lifecycle: cannot start a CLOSED ticket', closedStart.status, 400);
    }

    // Invalid forward jumps
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'invalid-jumps' });
      const toClosed = await req(`/api/tickets/${t.id}/status`, { method: 'POST', token: adminT, body: { state: 'CLOSED' } });
      eq('lifecycle: NEW -> CLOSED rejected', toClosed.status, 400);
      const toResolved = await req(`/api/tickets/${t.id}/status`, { method: 'POST', token: adminT, body: { state: 'RESOLVED', resolution: 'x' } });
      eq('lifecycle: NEW -> RESOLVED rejected', toResolved.status, 400);
      const closeNew = await req(`/api/tickets/${t.id}/close`, { method: 'POST', token: adminT });
      eq('lifecycle: cannot close a NEW ticket', closeNew.status, 400);

      await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: janeT });
      const closeInProgress = await req(`/api/tickets/${t.id}/close`, { method: 'POST', token: janeT });
      eq('lifecycle: cannot close an IN_PROGRESS ticket', closeInProgress.status, 400);
    }

    /* ============================================================== */
    /* REASSIGNMENT                                                   */
    /* ============================================================== */
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'reassign-1' });

      // Agent reassigns their own ticket to an available teammate
      const reason = 'Currently handling multiple critical requests.';
      const ok = await req(`/api/tickets/${t.id}/reassign`, {
        method: 'POST', token: janeT, body: { agentId: sarah.id, reason },
      });
      eq('reassign: agent can reassign their own ticket', ok.status, 200);
      eq('reassign: new assignee applied', ok.data.assignedAgent.id, sarah.id);

      const audit = await prisma.ticketAuditLog.findFirst({ where: { ticketId: t.id }, orderBy: { id: 'desc' } });
      check('reassign: audit names the previous agent', audit.note.includes('Jane Smith'), audit.note);
      check('reassign: audit names the new agent', audit.note.includes('Sarah Smith'), audit.note);
      check('reassign: audit records the assignment group', audit.note.includes('Hardware'), audit.note);
      check('reassign: reason preserved', audit.note.includes(reason), audit.note);
      check('reassign: actor recorded', audit.actor.includes('Jane Smith'), audit.actor);
      check('reassign: state unchanged by a reassignment', audit.fromState === audit.toState);

      const history = await prisma.ticketAuditLog.count({ where: { ticketId: t.id } });
      check('reassign: previous assignment preserved in history, not overwritten', history >= 2, String(history));
    }

    {
      // Jane no longer owns it -> cannot reassign it again
      const t = await makeTicket({ agentId: sarah.id, teamId: hardware.id, suffix: 'reassign-not-mine' });
      const denied = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: janeT, body: { agentId: jane.id } });
      eq("reassign: agent cannot reassign another agent's ticket", denied.status, 403);
      const after = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('reassign: rejected attempt changed nothing', after.assignedAgentId, sarah.id);
    }

    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'reassign-cross-team' });

      // Cross-group is forbidden for an agent
      const cross = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: janeT, body: { agentId: dave.id } });
      eq('reassign: agent cannot reassign outside their group', cross.status, 403);

      // Unavailable teammate is forbidden for an agent
      const unavailable = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: janeT, body: { agentId: michael.id } });
      eq('reassign: agent cannot assign to an unavailable teammate', unavailable.status, 400);
      check('reassign: refusal explains why', String(unavailable.data.error).includes('unavailable'), JSON.stringify(unavailable.data));

      // Self is forbidden (already the assignee)
      const self = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: janeT, body: { agentId: jane.id } });
      eq('reassign: current assignee cannot be selected', self.status, 400);

      // Unknown target
      const unknown = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: janeT, body: { agentId: 999999 } });
      eq('reassign: target agent must exist', unknown.status, 404);

      const stillJane = await prisma.ticket.findUnique({ where: { id: t.id } });
      eq('reassign: none of the rejected attempts changed the assignee', stillJane.assignedAgentId, jane.id);

      // Admin may cross teams and may pick an unavailable agent
      const adminCross = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: adminT, body: { agentId: dave.id, reason: 'better suited' } });
      eq('reassign: admin can reassign across teams', adminCross.status, 200);
      eq('reassign: admin cross-team assignee applied', adminCross.data.assignedAgent.id, dave.id);

      const adminUnavailable = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: adminT, body: { agentId: michael.id } });
      eq('reassign: admin may deliberately assign to an unavailable agent', adminUnavailable.status, 200);
    }

    {
      // A closed ticket cannot be reassigned
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, state: 'CLOSED', suffix: 'reassign-closed' });
      const denied = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: adminT, body: { agentId: sarah.id } });
      eq('reassign: closed tickets cannot be reassigned', denied.status, 400);
    }

    /* ============================================================== */
    /* CANDIDATES (availability, workload, skill)                     */
    /* ============================================================== */
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'candidates' });
      const res = await req(`/api/tickets/${t.id}/assignment-candidates`, { token: janeT });
      eq('candidates: endpoint responds', res.status, 200);

      const byId = Object.fromEntries(res.data.candidates.map((c) => [c.id, c]));
      check('candidates: teammate listed', Boolean(byId[sarah.id]));
      check('candidates: unavailable teammate is shown', Boolean(byId[michael.id]));
      eq('candidates: availability flag reflects isAvailable', byId[michael.id].available, false);
      eq('candidates: unavailable teammate is not selectable by an agent', byId[michael.id].selectable, false);
      eq('candidates: available teammate is selectable', byId[sarah.id].selectable, true);
      eq('candidates: current assignee flagged', byId[jane.id].isCurrentAssignee, true);
      eq('candidates: current assignee not selectable', byId[jane.id].selectable, false);
      check('candidates: skill level exposed', byId[sarah.id].skillLevel === 3 && byId[sarah.id].skillLabel === 'Senior');
      check('candidates: workload exposed', typeof byId[sarah.id].openTickets === 'number');
      check('candidates: assignment group exposed', byId[sarah.id].assignmentGroup === 'Hardware & Devices', byId[sarah.id].assignmentGroup);
      check('candidates: agent sees only their own group', res.data.candidates.every((c) => c.teamId === hardware.id));
      eq('candidates: agent cannot change group', res.data.canChangeGroup, false);
      check('candidates: available agents ranked before unavailable', res.data.candidates.findIndex((c) => c.id === michael.id) === res.data.candidates.length - 1);

      const adminRes = await req(`/api/tickets/${t.id}/assignment-candidates`, { token: adminT });
      check('candidates: admin sees other groups too', adminRes.data.candidates.some((c) => c.teamId === software.id));
      eq('candidates: admin may change group', adminRes.data.canChangeGroup, true);
      const adminMichael = adminRes.data.candidates.find((c) => c.id === michael.id);
      eq('candidates: admin may select an unavailable agent', adminMichael.selectable, true);
    }

    /* ============================================================== */
    /* WORKLOAD                                                       */
    /* ============================================================== */
    {
      const policy = require('../src/services/assignmentPolicy');
      await prisma.ticket.deleteMany({ where: { assignedAgentId: sarah.id, graphMessageId: { startsWith: `${MARK}wl-` } } });

      const base = await policy.workloadFor(sarah.id);
      const tNew = await makeTicket({ agentId: sarah.id, teamId: hardware.id, state: 'NEW', suffix: 'wl-new' });
      const tProg = await makeTicket({ agentId: sarah.id, teamId: hardware.id, state: 'IN_PROGRESS', suffix: 'wl-prog' });
      eq('workload: NEW and IN_PROGRESS both count', await policy.workloadFor(sarah.id), base + 2);

      await makeTicket({ agentId: sarah.id, teamId: hardware.id, state: 'RESOLVED', suffix: 'wl-resolved' });
      eq('workload: RESOLVED does not count as active work', await policy.workloadFor(sarah.id), base + 2);

      await makeTicket({ agentId: sarah.id, teamId: hardware.id, state: 'CLOSED', suffix: 'wl-closed' });
      eq('workload: CLOSED does not count', await policy.workloadFor(sarah.id), base + 2);

      // Workload follows a reassignment
      const beforeJane = await policy.workloadFor(jane.id);
      const moved = await req(`/api/tickets/${tNew.id}/reassign`, { method: 'POST', token: sarahT, body: { agentId: jane.id } });
      eq('workload: reassignment succeeded', moved.status, 200);
      eq('workload: rises for the new assignee', await policy.workloadFor(jane.id), beforeJane + 1);
      eq('workload: falls for the previous assignee', await policy.workloadFor(sarah.id), base + 1);

      // Workload drops when work finishes
      await req(`/api/tickets/${tProg.id}/resolve`, { method: 'POST', token: sarahT, body: { resolution: 'done' } });
      eq('workload: falls once a ticket is resolved', await policy.workloadFor(sarah.id), base);
      await req(`/api/tickets/${tProg.id}/close`, { method: 'POST', token: sarahT });
      eq('workload: stays down after closing', await policy.workloadFor(sarah.id), base);

      // Exposed through the API for the frontend
      const dash = await req('/api/dashboard', { token: adminT });
      const row = dash.data.ticketsPerAgent.find((a) => a.agentId === jane.id);
      check('workload: exposed on the dashboard API', row && typeof row.openTickets === 'number', JSON.stringify(row));
    }

    /* ============================================================== */
    /* ASSIGNMENT GROUP CHANGES                                       */
    /* ============================================================== */
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'group-change' });

      // Agents may not move tickets between groups
      const byAgent = await req(`/api/tickets/${t.id}`, { method: 'PATCH', token: janeT, body: { assignmentGroup: 'software' } });
      eq('group: agent cannot change the assignment group', byAgent.status, 403);

      // Unknown group is rejected
      const bogus = await req(`/api/tickets/${t.id}`, { method: 'PATCH', token: adminT, body: { assignmentGroup: 'does-not-exist' } });
      eq('group: unknown group rejected', bogus.status, 400);

      // Admin moves it; the hardware assignee must not survive
      const moved = await req(`/api/tickets/${t.id}`, {
        method: 'PATCH', token: adminT, body: { assignmentGroup: 'software', autoAssign: false },
      });
      eq('group: admin can change the group', moved.status, 200);
      eq('group: ticket moved to the new group', moved.data.team.key, 'software');
      eq('group: wrong-team assignee cleared', moved.data.assignedAgentId, null);

      const audit = await prisma.ticketAuditLog.findFirst({ where: { ticketId: t.id }, orderBy: { id: 'desc' } });
      check('group: audit records the previous and new group', audit.note.includes('Hardware') && audit.note.includes('Software'), audit.note);
      check('group: audit records the cleared assignee', audit.note.includes('cleared the assignee'), audit.note);

      // Reassignment works after the group change
      const after = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', token: adminT, body: { agentId: dave.id } });
      eq('group: reassignment works after the group change', after.status, 200);
      eq('group: new assignee belongs to the new group', after.data.assignedAgent.id, dave.id);
    }

    {
      // Auto-assignment after a group change, using the existing engine
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'group-auto' });
      const moved = await req(`/api/tickets/${t.id}`, { method: 'PATCH', token: adminT, body: { assignmentGroup: 'software' } });
      eq('group: auto-assign path responds', moved.status, 200);
      eq('group: ticket is in the new group', moved.data.team.key, 'software');
      if (moved.data.assignedAgentId) {
        const picked = await prisma.agent.findUnique({ where: { id: moved.data.assignedAgentId } });
        eq('group: auto-assigned agent belongs to the new group', picked.teamId, software.id);
      } else {
        check('group: left unassigned when the engine found nobody eligible', true);
      }
    }

    /* ============================================================== */
    /* AUTHORIZATION (direct API calls, no UI involved)               */
    /* ============================================================== */
    {
      const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, suffix: 'authz' });

      const noToken = await req(`/api/tickets/${t.id}/reassign`, { method: 'POST', body: { agentId: sarah.id } });
      eq('authz: unauthenticated reassign rejected', noToken.status, 401);
      const noTokenStart = await req(`/api/tickets/${t.id}/start`, { method: 'POST' });
      eq('authz: unauthenticated start rejected', noTokenStart.status, 401);

      const strangerStart = await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: daveT });
      eq("authz: agent cannot start someone else's ticket", strangerStart.status, 403);

      await req(`/api/tickets/${t.id}/start`, { method: 'POST', token: janeT });
      const strangerResolve = await req(`/api/tickets/${t.id}/resolve`, { method: 'POST', token: daveT, body: { resolution: 'not mine' } });
      eq("authz: agent cannot resolve someone else's ticket", strangerResolve.status, 403);

      await req(`/api/tickets/${t.id}/resolve`, { method: 'POST', token: janeT, body: { resolution: 'fixed' } });
      const strangerClose = await req(`/api/tickets/${t.id}/close`, { method: 'POST', token: daveT });
      eq("authz: agent cannot close someone else's ticket", strangerClose.status, 403);

      const ownerClose = await req(`/api/tickets/${t.id}/close`, { method: 'POST', token: janeT });
      eq('authz: the assignee can close their own ticket', ownerClose.status, 200);

      // /assign must enforce the same rules as /reassign
      const t2 = await makeTicket({ agentId: sarah.id, teamId: hardware.id, suffix: 'authz-assign' });
      const bypass = await req(`/api/tickets/${t2.id}/assign`, { method: 'POST', token: janeT, body: { agentId: dave.id } });
      eq('authz: /assign cannot be used to bypass the reassign rules', bypass.status, 403);
    }

    /* ============================================================== */
    /* REOPENING VIA REQUESTER REPLY                                  */
    /* ============================================================== */
    {
      const { ingestRawEmail } = require('../src/services/emailIngestion');
      const quiet = { log() {}, warn() {}, error() {} };

      for (const state of ['RESOLVED', 'CLOSED']) {
        const suffix = `reopen-${state}`;
        const t = await makeTicket({ agentId: jane.id, teamId: hardware.id, state, suffix });
        await prisma.ticket.update({
          where: { id: t.id },
          data: { resolvedAt: new Date(), closedAt: state === 'CLOSED' ? new Date() : null, resolution: 'was fixed' },
        });

        const before = await prisma.ticketAuditLog.count({ where: { ticketId: t.id } });
        const { result } = await ingestRawEmail(
          {
            messageId: `${MARK}${suffix}-reply`,
            from: { name: 'Fixture Requester', email: `requester@${DOMAIN}` },
            subject: `Re: [${t.ticketNumber}] ${MARK}${suffix}`,
            body: 'This is happening again.',
            bodyType: 'text',
          },
          { logger: quiet }
        );

        eq(`reopen: requester reply to ${state} reopens the ticket`, result.status, 'reopened');
        eq(`reopen: ${state} -> IN_PROGRESS`, result.ticket.state, 'IN_PROGRESS');
        eq(`reopen: no new ticket created from a ${state} reply`, await prisma.ticket.count({ where: { graphMessageId: `${MARK}${suffix}-reply` } }), 0);

        const audits = await prisma.ticketAuditLog.count({ where: { ticketId: t.id } });
        eq(`reopen: ${state} reopen adds an audit entry`, audits, before + 1);
        const last = await prisma.ticketAuditLog.findFirst({ where: { ticketId: t.id }, orderBy: { id: 'desc' } });
        check(`reopen: ${state} audit shows the transition`, last.fromState === state && last.toState === 'IN_PROGRESS');
        check(`reopen: ${state} audit names the reopen rule`, last.note === 'Reopened by requester reply', last.note);

        const activity = await prisma.comment.count({ where: { graphMessageId: `${MARK}${suffix}-reply` } });
        eq(`reopen: ${state} reply recorded as an activity`, activity, 1);
      }
    }
  } finally {
    server.kill();
    await cleanup();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
