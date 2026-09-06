/* Audit Trail foundation: the unified AuditEvent trail (auditService) around
   the existing domain-specific audit logs.

   Part A pins the service itself (redaction, truncation, actor resolution,
   event validation). Parts B–H drive real HTTP/service paths against a live
   server on an isolated database and assert the unified events each action
   writes — agents/users, tickets, comments, handovers, settings, holidays,
   routing rules, assignment-group membership, and email intake. Part I checks
   the invariants: structured JSON only, actor attribution, sensitive data
   excluded, the domain logs (TicketAuditLog / UserAuditLog /
   RoutingRuleAuditLog) preserved alongside, and auditService.forTicket()
   retrieval.

   Usage: npm run test:audit  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4196';
// Background workers are off; the suites drive everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('audit');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const auditService = require('../src/services/auditService');
const membership = require('../src/services/groupMembershipService');
const handoverService = require('../src/services/handoverService');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'AuditSuite!123';
const DOMAIN = 'audit.test';
const ADMIN_EMAIL = `admin@${DOMAIN}`;
const NEW_AGENT_PASSWORD = 'NewAgent!pass1';
const CHANGED_PASSWORD = 'ChangedAgent!9';

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
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

/** Latest-first audit events, optionally filtered. */
const auditRows = (where = {}) => prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' } });
const auditCount = (where = {}) => prisma.auditEvent.count({ where });
const lastAudit = async (action) => (await auditRows({ action }))[0] || null;

/** Parse-safe view of the JSON columns, for structure checks. */
function jsonColumns(row) {
  return { fromValue: row.fromValue, toValue: row.toValue, metadata: row.metadata };
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const team = await prisma.team.create({ data: { key: 'audit-team', name: 'Audit Team' } });
  const team2 = await prisma.team.create({ data: { key: 'audit-team-2', name: 'Audit Team Two' } });
  const mkUser = (name, email, role) =>
    prisma.agent.create({
      data: {
        name,
        email,
        role,
        teamId: role === 'admin' ? null : team.id,
        isActive: true,
        isAvailable: true,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
      },
    });
  const adminUser = await mkUser('Audit Admin', ADMIN_EMAIL, 'admin');
  const agentA = await mkUser('Agent A', `a@${DOMAIN}`, 'agent');
  const agentB = await mkUser('Agent B', `b@${DOMAIN}`, 'agent');

  /* ---- A. the service itself (no server, no database) ------------------ */
  console.log('\n--- A. auditService unit behaviour ---');
  const sanitized = auditService.sanitizeValue({
    password: 'hunter2',
    token: 'jwt-value',
    apiKey: 'key123',
    passwordHash: '$2a$10$whatever',
    nested: { secret: 's', safe: 'ok' },
    keep: 'visible',
  });
  eq('A1 password redacted', sanitized.password, '[redacted]');
  eq('A2 token redacted', sanitized.token, '[redacted]');
  eq('A3 api key redacted', sanitized.apiKey, '[redacted]');
  eq('A4 password hash redacted', sanitized.passwordHash, '[redacted]');
  eq('A5 nested secret redacted', sanitized.nested.secret, '[redacted]');
  eq('A6 nested safe value kept', sanitized.nested.safe, 'ok');
  eq('A7 plain value kept', sanitized.keep, 'visible');

  const long = 'x'.repeat(500);
  check('A8 long strings are previewed',
    auditService.sanitizeValue(long).startsWith('x'.repeat(auditService.VALUE_PREVIEW_MAX)) &&
    auditService.sanitizeValue(long).length > auditService.VALUE_PREVIEW_MAX);
  check('A9 preview marks the cut', auditService.sanitizeValue(long).includes('[truncated'));

  let threw = null;
  try { auditService.buildEvent({ entityType: 'Ticket' }); } catch (e) { threw = e; }
  check('A10 buildEvent requires an action', Boolean(threw));
  threw = null;
  try { auditService.buildEvent({ action: 'x' }); } catch (e) { threw = e; }
  check('A11 buildEvent requires an entityType', Boolean(threw));

  const withAgent = auditService.resolveActor({ id: 7, name: 'Ada', email: 'ada@x.y' });
  eq('A12 agent actor keeps its id', withAgent.actorId, 7);
  eq('A13 agent actor label', withAgent.actorLabel, 'Ada <ada@x.y>');
  const asString = auditService.resolveActor('requester@example.com');
  eq('A14 string actor has no id', asString.actorId, null);
  eq('A15 string actor label preserved', asString.actorLabel, 'requester@example.com');
  eq('A16 null actor is system', auditService.resolveActor(null).actorLabel, 'system');

  /* ---- the live server -------------------------------------------------- */
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
    const aLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `a@${DOMAIN}`, password: PASSWORD },
    });
    eq('login agent A', aLogin.status, 200);
    const agentAToken = aLogin.data.token;
    const bLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: `b@${DOMAIN}`, password: PASSWORD },
    });
    eq('login agent B', bLogin.status, 200);
    const agentBToken = bLogin.data.token;
    const adminObj = { id: adminUser.id, name: adminUser.name, email: adminUser.email };

    /* ---- B. agents/users ------------------------------------------------- */
    console.log('\n--- B. agent and user changes ---');
    const created = await req('/api/agents', {
      method: 'POST',
      token: admin,
      body: {
        name: 'New Agent',
        email: `na@${DOMAIN}`,
        password: NEW_AGENT_PASSWORD,
        role: 'agent',
        teamKey: 'audit-team',
      },
    });
    eq('B1 admin creates an agent', created.status, 201);
    const newAgentId = created.data.id;
    const b1 = await lastAudit('agent.created');
    check('B1 agent.created event exists', Boolean(b1));
    eq('B1 actorId is the admin', b1 && b1.actorId, adminUser.id);
    eq('B1 actor label', b1 && b1.actorLabel, 'Audit Admin <admin@audit.test>');
    eq('B1 entity is the new agent', b1 && b1.entityId, newAgentId);
    eq('B1 to.role recorded', b1 && JSON.parse(b1.toValue).role, 'agent');
    eq('B1 domain UserAuditLog still written',
      await prisma.userAuditLog.count({ where: { agentId: newAgentId, action: 'created' } }), 1);

    let r = await req(`/api/agents/${newAgentId}`, {
      method: 'PATCH', token: admin, body: { isAvailable: false, name: 'Renamed Agent' },
    });
    eq('B2 admin updates availability + name', r.status, 200);
    const b2 = await lastAudit('agent.availability_changed');
    eq('B2 availability event from/to', b2 && `${JSON.parse(b2.fromValue).isAvailable}->${JSON.parse(b2.toValue).isAvailable}`, 'true->false');
    const b2n = await lastAudit('agent.updated');
    eq('B2 name change event', b2n && JSON.parse(b2n.toValue).name, 'Renamed Agent');

    r = await req(`/api/agents/${newAgentId}`, {
      method: 'PATCH', token: admin, body: { password: CHANGED_PASSWORD },
    });
    eq('B3 admin sets a new password', r.status, 200);
    const b3 = await lastAudit('agent.password_changed');
    check('B3 password change is audited', Boolean(b3));
    eq('B3 no credential material recorded', b3 && (b3.fromValue || b3.toValue), null);

    r = await req(`/api/agents/${newAgentId}`, {
      method: 'PATCH', token: admin, body: { teamKey: 'audit-team-2' },
    });
    eq('B4 admin moves the agent to another group', r.status, 200);
    const b4 = await lastAudit('agent.group_changed');
    eq('B4 group change event from/to',
      b4 && `${JSON.parse(b4.fromValue).teamId}->${JSON.parse(b4.toValue).teamId}`,
      `${team.id}->${team2.id}`);
    eq('B4 UserAuditLog group_changed preserved',
      await prisma.userAuditLog.count({ where: { agentId: newAgentId, action: 'group_changed' } }), 1);

    r = await req(`/api/agents/${newAgentId}`, { method: 'PATCH', token: admin, body: { isActive: false } });
    eq('B5 admin deactivates the agent', r.status, 200);
    eq('B5 deactivated event actioned by admin', (await lastAudit('agent.deactivated')).actorId, adminUser.id);

    /* ---- C. ticket lifecycle --------------------------------------------- */
    console.log('\n--- C. ticket changes ---');
    r = await req('/api/tickets', {
      method: 'POST', token: agentAToken,
      body: {
        shortDescription: 'Audit lifecycle ticket',
        body: 'Created to exercise the audit trail',
        requesterEmail: `requester@${DOMAIN}`,
        autoAssign: false,
        assignmentGroup: 'audit-team',
      },
    });
    eq('C1 agent creates a ticket', r.status, 201);
    const t1 = r.data;
    const c1 = await lastAudit('ticket.created');
    check('C1 ticket.created event exists', Boolean(c1));
    eq('C1 actor is agent A', c1 && c1.actorId, agentA.id);
    eq('C1 ticketId links the event', c1 && c1.ticketId, t1.id);
    eq('C1 to.source portal', c1 && JSON.parse(c1.toValue).source, 'portal');
    eq('C1 domain TicketAuditLog still written',
      await prisma.ticketAuditLog.count({ where: { ticketId: t1.id } }), 1);

    r = await req(`/api/tickets/${t1.id}/assign`, { method: 'POST', token: admin, body: { agentId: agentA.id } });
    eq('C2 admin assigns the ticket', r.status, 200);
    const c2 = await lastAudit('ticket.assigned');
    eq('C2 from/to agents recorded',
      c2 && `${JSON.parse(c2.fromValue).assignedAgent}->${JSON.parse(c2.toValue).assignedAgent}`,
      `null->${agentA.name}`);
    eq('C2 metadata records the via path', c2 && JSON.parse(c2.metadata).via, 'assign');
    check('C2 TicketAuditLog keeps the reassignment line',
      Boolean(await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t1.id, note: { contains: `Reassigned from nobody to ${agentA.name}` } },
      })));

    r = await req(`/api/tickets/${t1.id}/start`, { method: 'POST', token: agentAToken, body: {} });
    eq('C3 agent starts the ticket', r.status, 200);
    const c3 = await lastAudit('ticket.started');
    eq('C3 started event from/to states',
      c3 && `${JSON.parse(c3.fromValue).state}->${JSON.parse(c3.toValue).state}`, 'NEW->IN_PROGRESS');

    r = await req(`/api/tickets/${t1.id}`, { method: 'PATCH', token: admin, body: { priority: 'high' } });
    eq('C4 admin raises the priority', r.status, 200);
    const c4 = await lastAudit('ticket.priority_changed');
    eq('C4 priority from/to',
      c4 && `${JSON.parse(c4.fromValue).priority}->${JSON.parse(c4.toValue).priority}`, 'moderate->high');
    check('C4 TicketAuditLog keeps the priority note',
      Boolean(await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t1.id, note: { contains: 'priority changed to high' } },
      })));

    const PUBLIC_NOTE = 'public note body for audit exclusion check';
    r = await req(`/api/tickets/${t1.id}/notes`, {
      method: 'POST', token: agentAToken, body: { body: 'internal thinking notes', isInternal: true },
    });
    eq('C5 agent adds an internal note', r.status, 201);
    r = await req(`/api/tickets/${t1.id}/notes`, {
      method: 'POST', token: agentAToken, body: { body: PUBLIC_NOTE },
    });
    eq('C5 agent adds a public reply', r.status, 201);
    const notes = await auditRows({ action: 'ticket.commented' });
    eq('C5 two commented events', notes.length, 2);
    eq('C5 internal flag recorded',
      notes.map((n) => JSON.parse(n.metadata).isInternal).sort().join(','), 'false,true');
    eq('C5 comment entity type', notes[0] && notes[0].entityType, 'Comment');

    r = await req(`/api/tickets/${t1.id}`, {
      method: 'PATCH', token: agentAToken, body: { shortDescription: 'Audit lifecycle ticket (edited)' },
    });
    eq('C6 agent edits the subject', r.status, 200);
    const c6 = await lastAudit('ticket.updated');
    eq('C6 edited subject from/to',
      c6 && `${JSON.parse(c6.fromValue).shortDescription}->${JSON.parse(c6.toValue).shortDescription}`,
      'Audit lifecycle ticket->Audit lifecycle ticket (edited)');

    r = await req(`/api/tickets/${t1.id}`, {
      method: 'PATCH', token: admin, body: { assignmentGroup: 'audit-team-2' },
    });
    eq('C7 admin moves the ticket to another group', r.status, 200);
    const c7 = await lastAudit('ticket.group_changed');
    eq('C7 group from/to',
      c7 && `${JSON.parse(c7.fromValue).group}->${JSON.parse(c7.toValue).group}`,
      'Audit Team->Audit Team Two');
    eq('C7 cleared-assignee flag', c7 && JSON.parse(c7.metadata).clearedAssignee, true);

    r = await req(`/api/tickets/${t1.id}/resolve`, {
      method: 'POST', token: admin, body: { resolution: 'Fixed and verified' },
    });
    eq('C8 ticket resolved', r.status, 200);
    const c8 = await lastAudit('ticket.resolved');
    eq('C8 resolved event to.state', c8 && JSON.parse(c8.toValue).state, 'RESOLVED');

    r = await req(`/api/tickets/${t1.id}/status`, { method: 'POST', token: admin, body: { state: 'IN_PROGRESS' } });
    eq('C9 ticket reopened', r.status, 200);
    const c9 = await lastAudit('ticket.reopened');
    eq('C9 reopened event from/to',
      c9 && `${JSON.parse(c9.fromValue).state}->${JSON.parse(c9.toValue).state}`, 'RESOLVED->IN_PROGRESS');

    r = await req(`/api/tickets/${t1.id}`, { method: 'DELETE', token: agentAToken });
    eq('C10 agent cannot delete a ticket', r.status, 403);
    eq('C10 no ticket.deleted event written', await auditCount({ action: 'ticket.deleted' }), 0);
    r = await req(`/api/tickets/${t1.id}`, { method: 'DELETE', token: admin });
    eq('C10 admin deletes the ticket', r.status, 200);
    const c10 = await lastAudit('ticket.deleted');
    eq('C10 entityLabel survives deletion', c10 && c10.entityLabel, t1.ticketNumber);
    eq('C10 ticketId link is SetNull after delete', c10 && c10.ticketId, null);

    /* ---- D. handovers ----------------------------------------------------- */
    console.log('\n--- D. handovers ---');
    r = await req('/api/tickets', {
      method: 'POST', token: admin,
      body: {
        shortDescription: 'Audit handover ticket', requesterEmail: `requester@${DOMAIN}`,
        autoAssign: false, assignmentGroup: 'audit-team',
      },
    });
    eq('D1 second ticket created', r.status, 201);
    const t2 = r.data;
    await req(`/api/tickets/${t2.id}/assign`, { method: 'POST', token: admin, body: { agentId: agentA.id } });

    r = await req(`/api/tickets/${t2.id}/handover`, { method: 'POST', token: agentAToken, body: { agentId: agentB.id } });
    eq('D2 agent A requests a handover to B', r.status, 201);
    const requestId = r.data.request.id;
    const d2 = await lastAudit('handover.created');
    check('D2 handover.created event exists', Boolean(d2));
    eq('D2 event linked to the ticket', d2 && d2.ticketId, t2.id);
    eq('D2 actor is the owner', d2 && d2.actorId, agentA.id);
    check('D2 TicketAuditLog keeps the handover line',
      Boolean(await prisma.ticketAuditLog.findFirst({
        where: { ticketId: t2.id, note: { contains: 'Handover requested' } },
      })));

    r = await req(`/api/handovers/${requestId}/accept`, { method: 'POST', token: agentBToken, body: {} });
    eq('D3 agent B accepts', r.status, 200);
    const d3 = await lastAudit('handover.accepted');
    eq('D3 accepted event actor is B', d3 && d3.actorId, agentB.id);
    const assignedAfterAccept = (await auditRows({ action: 'ticket.assigned', ticketId: t2.id }))[0];
    eq('D3 ownership move also audited (via workloadService)',
      assignedAfterAccept && JSON.parse(assignedAfterAccept.toValue).assignedAgent, 'Agent B');

    // A second handover, this time declined.
    r = await req(`/api/tickets/${t2.id}/handover`, { method: 'POST', token: agentBToken, body: { agentId: agentA.id } });
    eq('D4 agent B requests a handover back', r.status, 201);
    const declineId = r.data.request.id;
    r = await req(`/api/handovers/${declineId}/decline`, {
      method: 'POST', token: agentAToken, body: { note: 'busy with other work' },
    });
    eq('D4 agent A declines', r.status, 200);
    const d4 = await lastAudit('handover.declined');
    eq('D4 decline reason in metadata', d4 && JSON.parse(d4.metadata).note, 'busy with other work');

    // A third handover, cancelled by its requester.
    r = await req(`/api/tickets/${t2.id}/handover`, { method: 'POST', token: agentBToken, body: { agentId: agentA.id } });
    const cancelId = r.data.request.id;
    r = await req(`/api/handovers/${cancelId}/cancel`, { method: 'POST', token: agentBToken, body: { reason: 'no longer needed' } });
    eq('D5 agent B cancels the request', r.status, 200);
    const d5 = await lastAudit('handover.cancelled');
    eq('D5 cancel reason in metadata', d5 && JSON.parse(d5.metadata).reason, 'no longer needed');

    // Expiry: force a request past its clock and run the sweep directly.
    r = await req(`/api/tickets/${t2.id}/handover`, { method: 'POST', token: agentBToken, body: { agentId: agentA.id } });
    const expireId = r.data.request.id;
    await prisma.handoverRequest.update({
      where: { id: expireId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const sweep = await handoverService.sweepExpired({});
    eq('D6 sweep expires the overdue request', sweep.ids.includes(expireId), true);
    const d6 = await lastAudit('handover.expired');
    check('D6 handover.expired event exists', Boolean(d6));
    eq('D6 expiry is a system event', d6 && d6.actorId, null);

    /* ---- E. settings, holidays ------------------------------------------- */
    console.log('\n--- E. admin and settings changes ---');
    const beforeSettings = await auditCount({ action: 'setting.updated' });
    r = await req('/api/sla/settings', {
      method: 'PATCH', token: agentAToken, body: { slaResponseTargetMinutes: 90 },
    });
    eq('E1 agent cannot change SLA settings', r.status, 403);
    eq('E1 denied write leaves no audit event', await auditCount({ action: 'setting.updated' }), beforeSettings);

    // A fresh database stores no value for the key yet: the first write has
    // no "from" (the effective default came from env), the second does.
    r = await req('/api/sla/settings', {
      method: 'PATCH', token: admin, body: { slaResponseTargetMinutes: 75 },
    });
    eq('E2a admin stores the response target', r.status, 200);
    const e2a = await lastAudit('setting.updated');
    eq('E2a first write has no stored previous value', e2a && e2a.fromValue, null);
    eq('E2a to.value recorded', e2a && JSON.parse(e2a.toValue).value, '75');

    r = await req('/api/sla/settings', {
      method: 'PATCH', token: admin, body: { slaResponseTargetMinutes: 90 },
    });
    eq('E2 admin changes the response target', r.status, 200);
    const e2 = await lastAudit('setting.updated');
    eq('E2 changed key recorded', e2 && e2.entityLabel, 'slaResponseTargetMinutes');
    eq('E2 from/to values',
      e2 && `${JSON.parse(e2.fromValue).value}->${JSON.parse(e2.toValue).value}`, '75->90');
    eq('E2 settings group in metadata', e2 && JSON.parse(e2.metadata).group, 'sla');
    eq('E2 actor is the admin', e2 && e2.actorId, adminUser.id);
    const storedSetting = await prisma.setting.findUnique({ where: { key: 'slaResponseTargetMinutes' } });
    eq('E2 Setting.updatedBy attribution preserved', storedSetting.updatedBy, 'Audit Admin <admin@audit.test>');

    r = await req('/api/sla/settings', {
      method: 'PATCH', token: admin, body: { slaResponseTargetMinutes: 0 },
    });
    eq('E3 invalid value rejected', r.status, 400);
    eq('E3 rejected write leaves no audit event',
      await auditCount({ action: 'setting.updated', entityLabel: 'slaResponseTargetMinutes' }), 2);

    r = await req('/api/sla/holidays', {
      method: 'POST', token: admin, body: { date: '2026-12-25', name: 'Christmas Day' },
    });
    eq('E4 admin adds a holiday', r.status, 201);
    const holidayId = r.data.holiday.id;
    const e4 = await lastAudit('sla.holiday_added');
    eq('E4 holiday entity label carries date + name', e4 && e4.entityLabel, '2026-12-25 — Christmas Day');
    r = await req('/api/sla/holidays', {
      method: 'POST', token: admin, body: { date: '2026-12-25', name: 'Christmas' },
    });
    eq('E4 same date again updates the name', r.status, 200);
    const e4u = await lastAudit('sla.holiday_updated');
    eq('E4 update records the name change',
      e4u && `${JSON.parse(e4u.fromValue).name}->${JSON.parse(e4u.toValue).name}`, 'Christmas Day->Christmas');
    r = await req(`/api/sla/holidays/${holidayId}`, { method: 'DELETE', token: admin });
    eq('E4 admin removes the holiday', r.status, 200);
    const e4d = await lastAudit('sla.holiday_removed');
    eq('E4 removal records the day', e4d && e4d.entityLabel, '2026-12-25 — Christmas');

    r = await req('/api/handovers/settings', {
      method: 'PATCH', token: admin, body: { handoverExpiryMinutes: 45 },
    });
    eq('E5 admin changes handover settings', r.status, 200);
    const e5 = await lastAudit('setting.updated');
    eq('E5 handover group in metadata', e5 && JSON.parse(e5.metadata).group, 'handover');

    /* ---- F. routing rules and groups -------------------------------------- */
    console.log('\n--- F. routing rules ---');
    r = await req('/api/routing/rules', {
      method: 'POST', token: admin,
      body: { name: 'Audit rule', keywords: 'printer', teamId: team.id, priority: 50, isActive: true },
    });
    eq('F1 admin creates a routing rule', r.status, 201);
    const ruleId = r.data.id;
    const f1 = await lastAudit('routing_rule.created');
    eq('F1 created event labelled with the rule', f1 && f1.entityLabel, 'Audit rule');
    eq('F1 RoutingRuleAuditLog still written',
      await prisma.routingRuleAuditLog.count({ where: { ruleId, action: 'created' } }), 1);

    r = await req(`/api/routing/rules/${ruleId}`, { method: 'PATCH', token: admin, body: { priority: 10 } });
    eq('F2 admin edits the rule', r.status, 200);
    const f2 = await lastAudit('routing_rule.updated');
    eq('F2 priority from/to', f2 && `${JSON.parse(f2.fromValue).priority}->${JSON.parse(f2.toValue).priority}`, '50->10');
    r = await req(`/api/routing/rules/${ruleId}`, { method: 'PATCH', token: admin, body: { isActive: false } });
    eq('F3 admin deactivates the rule', r.status, 200);
    const f3 = await lastAudit('routing_rule.deactivated');
    eq('F3 isActive from/to', f3 && `${JSON.parse(f3.fromValue).isActive}->${JSON.parse(f3.toValue).isActive}`, 'true->false');

    r = await req(`/api/routing/rules/${ruleId}`, { method: 'DELETE', token: admin });
    eq('F4 admin deletes the rule', r.status, 200);
    const f4 = await lastAudit('routing_rule.deleted');
    eq('F4 deletion keeps the rule name', f4 && f4.entityLabel, 'Audit rule');
    eq('F4 RoutingRuleAuditLog history preserved',
      await prisma.routingRuleAuditLog.count({ where: { ruleId } }), 4);

    r = await req(`/api/routing/groups/${team2.id}`, {
      method: 'PATCH', token: admin, body: { description: 'Second audit group' },
    });
    eq('F5 admin edits an assignment group', r.status, 200);
    const f5 = await lastAudit('group.updated');
    eq('F5 group change recorded', f5 && f5.entityId, team2.id);

    /* ---- G. assignment-group membership (service level) ------------------- */
    console.log('\n--- G. group membership ---');
    await membership.addMember({ agentId: agentA.id, teamId: team2.id, actor: adminObj });
    const g1 = await lastAudit('group.member_added');
    eq('G1 member_added event', g1 && g1.entityLabel, 'Audit Team Two');
    eq('G1 actor attributed', g1 && g1.actorId, adminUser.id);
    await membership.setLead({ agentId: agentA.id, teamId: team2.id, actor: adminObj });
    const g2 = await lastAudit('group.lead_changed');
    eq('G2 lead promotion from/to', g2 && `${JSON.parse(g2.fromValue).isLead}->${JSON.parse(g2.toValue).isLead}`, 'false->true');
    await membership.setLead({ agentId: agentA.id, teamId: team2.id, isLead: false, actor: adminObj });
    await membership.removeMember({ agentId: agentA.id, teamId: team2.id, actor: adminObj });
    const g3 = await lastAudit('group.member_removed');
    eq('G3 member_removed event', g3 && JSON.parse(g3.fromValue).member, `a@${DOMAIN}`);

    /* ---- H. email intake --------------------------------------------------- */
    console.log('\n--- H. email intake ---');
    r = await req('/api/tickets/from-email', {
      method: 'POST', token: admin,
      body: {
        messageId: 'audit-mail-1',
        subject: 'Laptop will not start',
        body: 'It beeps three times and turns off.',
        from: `intake-req@${DOMAIN}`,
        name: 'Intake Requester',
      },
    });
    eq('H1 email creates a ticket', r.status, 201);
    const t3 = r.data.ticket;
    const h1 = await lastAudit('ticket.created');
    eq('H1 system-created event has no actorId', h1 && h1.actorId, null);
    eq('H1 to.source email', h1 && JSON.parse(h1.toValue).source, 'email');
    eq('H1 domain TicketAuditLog still written',
      await prisma.ticketAuditLog.count({ where: { ticketId: t3.id } }), 1);

    r = await req(`/api/tickets/${t3.id}/start`, { method: 'POST', token: admin, body: {} });
    eq('H2 ticket started', r.status, 200);
    r = await req(`/api/tickets/${t3.id}/resolve`, {
      method: 'POST', token: admin, body: { resolution: 'Reseated the memory' },
    });
    eq('H2 ticket resolved', r.status, 200);
    r = await req('/api/tickets/from-email', {
      method: 'POST', token: admin,
      body: {
        messageId: 'audit-mail-2',
        subject: `Re: [${t3.ticketNumber}] Laptop will not start`,
        body: 'It happened again.',
        from: `intake-req@${DOMAIN}`,
      },
    });
    eq('H3 requester reply reopens the ticket', r.status, 200);
    eq('H3 intake reports reopened', r.data.status, 'reopened');
    const h3 = await lastAudit('ticket.reopened');
    eq('H3 reopened event linked to the ticket', h3 && h3.ticketId, t3.id);
    eq('H3 actor is the requester email', h3 && h3.actorLabel, `intake-req@${DOMAIN}`);
    eq('H3 requester is not an agent row', h3 && h3.actorId, null);

    /* ---- I. invariants ------------------------------------------------------ */
    console.log('\n--- I. trail invariants ---');
    const all = await prisma.auditEvent.findMany({ orderBy: { id: 'asc' } });
    check('I1 every event has an action and entityType',
      all.every((e) => e.action && e.entityType));
    check('I2 every event has a description', all.every((e) => e.description && e.description.length > 0));
    check('I3 every event has a server-generated timestamp',
      all.every((e) => e.createdAt instanceof Date && !Number.isNaN(e.createdAt.getTime())));
    let structured = true;
    for (const e of all) {
      for (const raw of [e.fromValue, e.toValue, e.metadata]) {
        if (raw === null) continue;
        try { JSON.parse(raw); } catch { structured = false; }
      }
    }
    check('I4 from/to/metadata columns hold structured JSON', structured);

    const secrets = [PASSWORD, NEW_AGENT_PASSWORD, CHANGED_PASSWORD];
    const storedHash = (await prisma.agent.findUnique({ where: { email: `na@${DOMAIN}` } })).passwordHash;
    if (storedHash) secrets.push(storedHash);
    secrets.push('hunter2', 'jwt-value');
    const haystack = all
      .map((e) => [e.action, e.entityType, e.entityLabel, e.actorLabel, e.fromValue, e.toValue, e.description, e.metadata].join('\n'))
      .join('\n');
    for (const s of secrets) {
      check(`I5 sensitive material never stored (${s.slice(0, 4).replace(/./g, '*')}…)`, !haystack.includes(s));
    }
    check('I6 comment bodies never stored', !haystack.includes(PUBLIC_NOTE) && !haystack.includes('internal thinking notes'));

    const attribution = all.filter((e) => e.actorId !== null);
    check('I7 attributed events carry a Name <email> label',
      attribution.every((e) => /.+ <.+@.+>/.test(e.actorLabel)));
    const systemEvents = all.filter((e) => e.actorId === null);
    check('I8 system/string actors keep a readable label',
      systemEvents.every((e) => e.actorLabel && e.actorLabel.length > 0));

    const t2Trail = await auditService.forTicket(t2.id, {}, prisma);
    check('I9 forTicket returns the ticket trail oldest first',
      t2Trail.length >= 6 && t2Trail.every((e) => e.ticketId === t2.id) &&
      t2Trail.every((e, i) => i === 0 || e.id > t2Trail[i - 1].id));

    // Domain logs preserved alongside: every part left its domain row.
    check('I10 TicketAuditLog rows exist for the exercised tickets',
      (await prisma.ticketAuditLog.count({ where: { ticketId: { in: [t2.id, t3.id] } } })) >= 6);
    check('I11 UserAuditLog rows exist for the exercised agents',
      (await prisma.userAuditLog.count({ where: { agentId: { in: [newAgentId, agentA.id] } } })) >= 4);
    check('I12 RoutingRuleAuditLog rows exist for the exercised rule',
      (await prisma.routingRuleAuditLog.count({ where: { ruleId } })) === 4);

    /* ---- J. the read-only audit API -------------------------------------- */
    console.log('\n--- J. audit API ---');
    eq('J1 unauthenticated read is 401', (await req('/api/audit')).status, 401);
    eq('J1 agent cannot read the trail', (await req('/api/audit', { token: agentAToken })).status, 403);
    let r2 = await req('/api/audit', { token: admin });
    eq('J1 admin reads the trail', r2.status, 200);
    eq('J2 default page size is 50', r2.data.pageSize, 50);
    eq('J2 entity type list is included', Array.isArray(r2.data.entityTypes) && r2.data.entityTypes.includes('Ticket'), true);

    r2 = await req('/api/audit?page=1&pageSize=5', { token: admin });
    eq('J2 page 1 honours the page size', r2.data.events.length, 5);
    eq('J2 total is independent of the page window',
      r2.data.total, (await req('/api/audit', { token: admin })).data.total);
    eq('J2 totalPages math', r2.data.totalPages, Math.ceil(r2.data.total / 5));
    const page2 = await req('/api/audit?page=2&pageSize=5', { token: admin });
    eq('J2 page 2 returns different rows',
      page2.data.events.some((e) => !r2.data.events.some((p) => p.id === e.id)), true);
    const beyond = await req('/api/audit?page=9999&pageSize=5', { token: admin });
    eq('J2 past the end the page is empty but the total stands',
      beyond.data.events.length === 0 && beyond.data.total === r2.data.total, true);
    const clamped = await req('/api/audit?pageSize=9999', { token: admin });
    eq('J2 oversized page size is clamped', clamped.data.pageSize, 200);
    const newestFirst = r2.data.events.every((e, i) => i === 0 || r2.data.events[i - 1].createdAt >= e.createdAt);
    check('J2 newest first', newestFirst);

    r2 = await req('/api/audit?action=ticket.&pageSize=200', { token: admin });
    check('J3 action filter matches the prefix',
      r2.data.events.length > 0 && r2.data.events.every((e) => e.action.startsWith('ticket.')));
    r2 = await req('/api/audit?action=TICKET.CREATED&pageSize=200', { token: admin });
    check('J3 action filter is case-insensitive',
      r2.data.events.length > 0 && r2.data.events.every((e) => e.action === 'ticket.created'));

    r2 = await req('/api/audit?entityType=Setting&pageSize=200', { token: admin });
    check('J4 entity type filter',
      r2.data.events.length > 0 && r2.data.events.every((e) => e.entityType === 'Setting'));
    r2 = await req('/api/audit?entityType=NoSuchEntity', { token: admin });
    eq('J4 unknown entity type is an empty result',
      r2.data.events.length === 0 && r2.data.total === 0, true);

    r2 = await req(`/api/audit?actorId=${adminUser.id}&pageSize=200`, { token: admin });
    check('J5 actorId filter',
      r2.data.events.length > 0 && r2.data.events.every((e) => e.actorId === adminUser.id));
    r2 = await req('/api/audit?actor=audit%20admin&pageSize=200', { token: admin });
    check('J5 actor label search is case-insensitive',
      r2.data.events.length > 0 && r2.data.events.every((e) => e.actor.includes('Audit Admin')));
    r2 = await req('/api/audit?actorId=999999', { token: admin });
    eq('J5 unknown actor is an empty result', r2.data.events.length === 0 && r2.data.total === 0, true);

    const unfiltered = await req('/api/audit', { token: admin });
    const newestIso = unfiltered.data.events[0].createdAt;
    // Events written in one batch share a timestamp; the bounds act on the
    // instant, so count how many sit at the newest one.
    const sharedCount = unfiltered.data.events.filter((e) => e.createdAt === newestIso).length;
    r2 = await req(`/api/audit?from=${encodeURIComponent(newestIso)}`, { token: admin });
    eq('J6 from bound is inclusive of the newest instant', r2.data.total, sharedCount);
    const beforeNewest = await req(
      `/api/audit?to=${encodeURIComponent(new Date(new Date(newestIso).getTime() - 1).toISOString())}`,
      { token: admin }
    );
    eq('J6 to bound excludes the newest instant',
      beforeNewest.data.total, unfiltered.data.total - sharedCount);
    eq('J6 invalid date is rejected',
      (await req('/api/audit?from=not-a-date', { token: admin })).status, 400);
    eq('J6 reversed range is rejected',
      (await req(`/api/audit?from=${encodeURIComponent(newestIso)}&to=2020-01-01T00:00:00Z`, { token: admin })).status, 400);

    r2 = await req('/api/audit?action=ticket.commented&pageSize=1', { token: admin });
    const commented = r2.data.events[0];
    check('J7 metadata arrives as structured JSON', commented && typeof commented.metadata === 'object');
    eq('J7 internal flag is a real boolean', typeof commented.metadata.isInternal, 'boolean');
    const assigned = (await req('/api/audit?action=ticket.assigned&pageSize=1', { token: admin })).data.events[0];
    check('J7 from/to arrive as structured objects',
      assigned && typeof assigned.from === 'object' && typeof assigned.to === 'object');

    let sensitive = '';
    for (let p = 1; p <= Math.ceil((await req('/api/audit', { token: admin })).data.total / 200); p++) {
      const pageData = await req(`/api/audit?page=${p}&pageSize=200`, { token: admin });
      sensitive += JSON.stringify(pageData.data);
    }
    for (const s of [PASSWORD, NEW_AGENT_PASSWORD, CHANGED_PASSWORD, 'hunter2', 'jwt-value']) {
      check(`J8 API exposes no sensitive material (${'*'.repeat(4)}…)`, !sensitive.includes(s));
    }

    r2 = await req('/api/audit?action=definitely-no-such-action', { token: admin });
    eq('J9 empty result shape', r2.data.events.length === 0 && r2.data.total === 0 && r2.data.totalPages === 0, true);
  } finally {
    server.kill();
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
