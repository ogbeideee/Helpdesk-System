/* API integration checks against a live ephemeral server instance.
   Usage: npm run test:api  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = '4177';

const { spawn } = require('child_process');
const path = require('path');

const BASE = `http://localhost:${process.env.PORT}`;
const MARKER = 'api-test-';
let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
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
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForServer(proc);

    // --- health & auth ------------------------------------------------------
    const health = await req('/api/health');
    check('health endpoint responds', health.status === 200 && health.data.ok === true);

    const noAuth = await req('/api/tickets');
    check('unauthenticated tickets request rejected', noAuth.status === 401, String(noAuth.status));

    const badLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@noctincan.com', password: 'wrong-password' },
    });
    check('bad credentials rejected', badLogin.status === 401);

    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@noctincan.com', password: 'ChangeMe!123' },
    });
    check('admin login succeeds', login.status === 200 && Boolean(login.data.token));
    const adminToken = login.data.token;
    check('login returns sanitized agent (no passwordHash)', login.data.agent && !('passwordHash' in login.data.agent));

    const me = await req('/api/auth/me', { token: adminToken });
    check('/me returns current admin', me.status === 200 && me.data.role === 'admin');

    const agentLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'service.desk@noctincan.com', password: 'ChangeMe!123' },
    });
    const agentToken = agentLogin.data.token;
    check('sample agent login succeeds', Boolean(agentToken));

    // --- dashboard & assignment groups ---------------------------------------
    const dash = await req('/api/dashboard', { token: agentToken });
    check(
      'dashboard returns required sections',
      dash.status === 200 &&
        Number.isInteger(dash.data.totalOpen) &&
        Number.isInteger(dash.data.counts.new) &&
        Number.isInteger(dash.data.counts.inProgress) &&
        Number.isInteger(dash.data.counts.resolved) &&
        Number.isInteger(dash.data.counts.closed) &&
        Number.isInteger(dash.data.unassigned) &&
        Number.isInteger(dash.data.critical) &&
        Array.isArray(dash.data.ticketsPerAgent) &&
        typeof dash.data.ticketsPerGroup === 'object' &&
        Array.isArray(dash.data.recentlyCreated),
      JSON.stringify(dash.data).slice(0, 160)
    );

    const groups = await req('/api/assignment-groups', { token: agentToken });
    check(
      'assignment groups listed with capacity',
      groups.status === 200 &&
        Array.isArray(groups.data) &&
        groups.data.length >= 4 &&
        groups.data.every((g) => typeof g.key === 'string' && Number.isInteger(g.activeAgents)),
      JSON.stringify(groups.data).slice(0, 120)
    );

    // --- portal creation with engine routing -----------------------------------
    const created = await req('/api/tickets', {
      method: 'POST',
      token: adminToken,
      body: {
        shortDescription: `${MARKER} laptop screen cracked`,
        body: 'Dropped my laptop, screen cracked.',
        requesterEmail: 'walker@example.com',
        requesterName: 'Kai Walker',
        priority: 'moderate',
      },
    });
    check('portal ticket created with INC number', created.status === 201 && /^INC-\d{6}$/.test(created.data.ticketNumber || ''), created.data.ticketNumber);
    check('portal ticket state NEW', created.data.state === 'NEW');
    check('portal ticket routed to Hardware group', created.data.team && created.data.team.key === 'hardware');
    check('portal ticket auto-assigned by engine', Boolean(created.data.assignedAgent));
    check('portal ticket SLA dueAt set (moderate => ~24h)', created.data.dueAt && Math.abs(new Date(created.data.dueAt) - new Date(created.data.createdAt) - 24 * 3600 * 1000) < 5000);
    check('initial audit log present', created.data.auditLogs.length >= 1);
    const ticketId = created.data.id;

    // --- PATCH partial update ----------------------------------------------------
    const patched = await req(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      token: agentToken,
      body: { priority: 'high' },
    });
    check('PATCH updates priority and recalculates SLA', patched.status === 200 && patched.data.priority === 'high' && patched.data.dueAt !== created.data.dueAt);

    const patchStateBlocked = await req(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      token: agentToken,
      body: { state: 'IN_PROGRESS' },
    });
    check('PATCH rejects state changes (use /status)', patchStateBlocked.status === 400);

    // --- assign ------------------------------------------------------------------
    // An agent may not hand someone else's ticket to another team: that is an
    // administrator action (see assignmentPolicy).
    const assignByAgent = await req(`/api/tickets/${ticketId}/assign`, {
      method: 'POST',
      token: agentToken,
      body: { agentEmail: 'dev.patel@noctincan.com' },
    });
    check('agent cannot assign a ticket that is not theirs', assignByAgent.status === 403, JSON.stringify(assignByAgent.data));

    const assign = await req(`/api/tickets/${ticketId}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { agentEmail: 'dev.patel@noctincan.com' },
    });
    check('admin assign routes across groups, state unchanged', assign.status === 200 && assign.data.assignedAgent.email === 'dev.patel@noctincan.com' && assign.data.state === 'NEW', JSON.stringify(assign.data).slice(0,150));

    const assignUnknown = await req(`/api/tickets/${ticketId}/assign`, {
      method: 'POST',
      token: adminToken,
      body: { agentId: 999999 },
    });
    check('assign to unknown agent fails cleanly', assignUnknown.status === 404);

    // --- workflow transitions -----------------------------------------------------
    const resolveByStranger = await req(`/api/tickets/${ticketId}/resolve`, {
      method: 'POST',
      token: agentToken,
      body: { resolution: 'not my ticket' },
    });
    check('agent cannot resolve a ticket assigned to someone else', resolveByStranger.status === 403);

    const resolveNoNote = await req(`/api/tickets/${ticketId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: {},
    });
    check('resolve without note rejected', resolveNoNote.status === 400);

    const skipAhead = await req(`/api/tickets/${ticketId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { state: 'CLOSED' },
    });
    check('invalid transition NEW->CLOSED rejected', skipAhead.status === 400, JSON.stringify(skipAhead.data));

    const started = await req(`/api/tickets/${ticketId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { state: 'IN_PROGRESS', note: 'picking this up' },
    });
    check('NEW -> IN_PROGRESS works', started.status === 200 && started.data.state === 'IN_PROGRESS');

    const resolved = await req(`/api/tickets/${ticketId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { resolution: `${MARKER} screen replaced under warranty.` },
    });
    check('resolve stores resolution + resolvedAt', resolved.status === 200 && resolved.data.state === 'RESOLVED' && resolved.data.resolvedAt && resolved.data.resolution.includes('warranty'));

    const closed = await req(`/api/tickets/${ticketId}/close`, {
      method: 'POST',
      token: adminToken,
      body: { note: 'verified with requester' },
    });
    check('RESOLVED -> CLOSED works', closed.status === 200 && closed.data.state === 'CLOSED' && closed.data.closedAt);

    const reopenClosedToNew = await req(`/api/tickets/${ticketId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { state: 'NEW' },
    });
    check('invalid transition CLOSED->NEW rejected', reopenClosedToNew.status === 400, JSON.stringify(reopenClosedToNew.data));

    const detailAfterFlow = await req(`/api/tickets/${ticketId}`, { token: agentToken });
    check(
      'every status change produced an audit entry',
      detailAfterFlow.data.auditLogs.filter((l) => l.toState !== l.fromState || !l.fromState).length >= 4,
      String(detailAfterFlow.data.auditLogs.length)
    );

    // --- notes ---------------------------------------------------------------------
    const internalNote = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST',
      token: agentToken,
      body: { body: `${MARKER} internal: quote approved`, isInternal: true },
    });
    check('internal note stored', internalNote.status === 201 && internalNote.data.isInternal === true);

    const publicUpdate = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST',
      token: agentToken,
      body: { body: `${MARKER} replacement ordered` },
    });
    check('requester-facing update stored with author', publicUpdate.status === 201 && publicUpdate.data.isInternal === false && publicUpdate.data.authorEmail === 'service.desk@noctincan.com');

    const emptyNote = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST',
      token: agentToken,
      body: { body: '' },
    });
    check('empty note rejected', emptyNote.status === 400);

    // --- from-email simulated ingestion ---------------------------------------------
    const invalidEmail = await req('/api/tickets/from-email', {
      method: 'POST',
      token: agentToken,
      body: { from: 'not-an-email', subject: 'x', messageId: `${MARKER}-m-bad` },
    });
    check('from-email validates request fields', invalidEmail.status === 400 && Array.isArray(invalidEmail.data.errors));

    const wifiEmail = {
      from: 'john.doe@company.com',
      name: 'John Doe',
      subject: 'My laptop is not connecting to WiFi',
      body: 'I have been unable to connect since this morning.',
      messageId: 'test-message-001',
      conversationId: 'test-conversation-001',
    };
    const fromEmail = await req('/api/tickets/from-email', { method: 'POST', token: agentToken, body: wifiEmail });
    check('simulated email creates ticket', fromEmail.status === 201 && fromEmail.data.status === 'created', JSON.stringify(fromEmail.data).slice(0, 200));
    check('simulated ticket classified as Hardware', fromEmail.data.ticket.category === 'Hardware', fromEmail.data.ticket.category);
    check('simulated ticket priority MODERATE', fromEmail.data.ticket.priority === 'moderate');
    check('simulated ticket state NEW + numbered', fromEmail.data.ticket.state === 'NEW' && /^INC-\d{6}$/.test(fromEmail.data.ticket.ticketNumber));
    check('simulated ticket routed to Hardware group', fromEmail.data.assignment.groupKey === 'hardware' || fromEmail.data.ticket.team?.key === 'hardware');
    check('engine assigned available hardware agent', fromEmail.data.assignment.assignedAgentId !== null && fromEmail.data.assignment.awaitingAssignment === false, JSON.stringify(fromEmail.data.assignment));

    const dupe = await req('/api/tickets/from-email', { method: 'POST', token: agentToken, body: wifiEmail });
    check('same messageId never duplicates', dupe.status === 200 && dupe.data.duplicate === true && dupe.data.ticket.id === fromEmail.data.ticket.id);

    const wifiTicketId = fromEmail.data.ticket.id;
    const wifiDetail = await req(`/api/tickets/${wifiTicketId}`, { token: agentToken });
    check(
      'initial audit log recorded with assignment decision',
      wifiDetail.data.auditLogs.some((l) => l.actor === 'system' && l.note && l.note.includes('assigned'))
    );

    // --- awaiting-assignment path -----------------------------------------------------
    const hwTeam = groups.data.find((g) => g.key === 'hardware');
    // Deactivate all active hardware agents temporarily.
    const agentsList = await req('/api/agents', { token: adminToken });
    const hwAgents = agentsList.data.agents.filter((a) => a.teamId === hwTeam.id && a.isActive);
    for (const a of hwAgents) {
      await req(`/api/agents/${a.id}`, { method: 'PATCH', token: adminToken, body: { isActive: false } });
    }

    const orphan = await req('/api/tickets/from-email', {
      method: 'POST',
      token: agentToken,
      body: {
        from: 'jane.roe@company.com',
        subject: `${MARKER} projector HDMI port dead`,
        body: 'No signal on any cable.',
        messageId: 'test-message-orphan-001',
      },
    });
    check(
      'no available agent -> group kept, awaiting assignment, creation succeeds',
      orphan.status === 201 &&
        orphan.data.ticket.assignedAgentId === null &&
        orphan.data.assignment.awaitingAssignment === true &&
        orphan.data.ticket.team?.key === 'hardware' &&
        orphan.data.ticket.awaitingAssignment === true,
      JSON.stringify(orphan.data.assignment)
    );
    check(
      'awaiting assignment noted in audit log',
      orphan.data.ticket.auditLogs.some((l) => l.note && l.note.toLowerCase().includes('awaiting'))
    );

    // Restore hardware agents.
    for (const a of hwAgents) {
      await req(`/api/agents/${a.id}`, { method: 'PATCH', token: adminToken, body: { isActive: true } });
    }
    const restoredList = await req('/api/agents', { token: adminToken });
    check(
      'agents reactivated after scenario',
      restoredList.data.agents.filter((a) => a.teamId === hwTeam.id).every((a) => a.isActive)
    );

    // --- filters -------------------------------------------------------------------
    const qByNumber = await req(`/api/tickets?q=${encodeURIComponent(fromEmail.data.ticket.ticketNumber)}`, { token: agentToken });
    check('search by ticket number works', qByNumber.status === 200 && qByNumber.data.length === 1);

    const unassignedFilter = await req(`/api/tickets?unassigned=1`, { token: agentToken });
    check('?unassigned= filter surfaces awaiting tickets', unassignedFilter.status === 200 && unassignedFilter.data.some((t) => t.id === orphan.data.ticket.id));

    // --- agents admin surface ---------------------------------------------------------
    const agentsForbidden = await req('/api/agents', { token: agentToken });
    check('agents listing blocked for non-admin', agentsForbidden.status === 403);

    // POST/PATCH agent management roundtrip
    const newAgent = await req('/api/agents', {
      method: 'POST',
      token: adminToken,
      body: {
        name: `${MARKER} Temp Agent`,
        email: `temp.${Date.now()}@example.com`,
        password: 'TempPass!123',
        teamKey: 'software',
        skillLevel: 3,
      },
    });
    check('create agent with skill level + group', newAgent.status === 201 && newAgent.data.skillLevel === 3 && newAgent.data.team.key === 'software');

    const badSkill = await req('/api/agents', {
      method: 'POST',
      token: adminToken,
      body: { name: 'x', email: `y${Date.now()}@example.com`, password: 'LongEnough1!', skillLevel: 9 },
    });
    check('skillLevel out of range rejected', badSkill.status === 400);

    const patchedAgent = await req(`/api/agents/${newAgent.data.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { skillLevel: 2, isActive: false },
    });
    check('PATCH agent updates skill + availability', patchedAgent.status === 200 && patchedAgent.data.skillLevel === 2 && patchedAgent.data.isActive === false);
    await req(`/api/agents/${newAgent.data.id}`, { method: 'DELETE' }).catch(() => {});

    // --- delete permissioning -----------------------------------------------------------
    const delForbidden = await req(`/api/tickets/${ticketId}`, { method: 'DELETE', token: agentToken });
    check('delete blocked for non-admin', delForbidden.status === 403);
    const delOk = await req(`/api/tickets/${ticketId}`, { method: 'DELETE', token: adminToken });
    check('delete allowed for admin', delOk.status === 200);
  } finally {
    proc.kill();
  }

  await cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

async function cleanup() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const tickets = await prisma.ticket.findMany({
      where: {
        OR: [
          { shortDescription: { contains: MARKER } },
          { requesterEmail: 'walker@example.com' },
          { requesterEmail: 'john.doe@company.com' },
          { requesterEmail: 'jane.roe@company.com' },
          { graphMessageId: 'test-message-001' },
        ],
      },
      select: { id: true },
    });
    for (const t of tickets) {
      await prisma.comment.deleteMany({ where: { ticketId: t.id } });
      await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
      await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
    }
    await prisma.agent.deleteMany({ where: { email: { contains: 'temp.' } } });
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => {
    process.exitCode = failures ? 1 : 0;
  });
