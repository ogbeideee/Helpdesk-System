/* Full end-to-end workflow test against a live server instance.
   Mirrors the exact API calls the React UI makes.

   Usage: npm run test:e2e  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.PORT = '4188';

const { spawn } = require('child_process');
const path = require('path');

const BASE = `http://localhost:${process.env.PORT}`;
const MARK = 'e2e-';
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

async function req(pathname, opts = {}) {
  const { method = 'GET', token, body } = opts;
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
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not ready');
}

function expectedPick(agentsList, groupKey, minSkill) {
  const candidates = agentsList
    .filter((a) => a.assignmentGroupKey === groupKey && a.isActive && a.skillLevel >= minSkill)
    .sort((x, y) => {
      if (x.openWorkload !== y.openWorkload) return x.openWorkload - y.openWorkload;
      const xt = x.lastAssignedAt ? new Date(x.lastAssignedAt).getTime() : 0;
      const yt = y.lastAssignedAt ? new Date(y.lastAssignedAt).getTime() : 0;
      return xt - yt || x.agentId - y.agentId;
    });
  return candidates[0] || null;
}

function withGroupKeys(agentsList, groups) {
  return agentsList.map((a) => ({
    ...a,
    assignmentGroupKey: groups.find((g) => g.id === a.teamId)?.key || null,
  }));
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', () => {});

  try {
    await waitForServer(proc);

    // ---- setup: logins + fresh agents in different groups -----------------
    const admin = (
      await req('/api/auth/login', {
        method: 'POST',
        body: { email: 'admin@noctincan.com', password: 'ChangeMe!123' },
      })
    ).data;

    const agentSpecs = [
      { name: MARK + 'Riley Chen', email: MARK + 'riley@noctincan.com', group: 'hardware', skill: 3 },
      { name: MARK + 'Sam Ortiz', email: MARK + 'sam@noctincan.com', group: 'software', skill: 2 },
      { name: MARK + 'Alex Reed', email: MARK + 'alex@noctincan.com', group: 'accounts', skill: 1 },
    ];
    const createdAgents = [];
    for (const spec of agentSpecs) {
      const r = await req('/api/agents', {
        method: 'POST',
        token: admin.token,
        body: {
          name: spec.name,
          email: spec.email,
          password: 'E2ePass!123',
          teamKey: spec.group,
          skillLevel: spec.skill,
          role: 'agent',
        },
      });
      check('setup: created ' + spec.name + ' (L' + spec.skill + ', ' + spec.group + ')', r.status === 201);
      createdAgents.push({ ...spec, id: r.data.id });
    }

    const riley = (
      await req('/api/auth/login', {
        method: 'POST',
        body: { email: createdAgents[0].email, password: 'E2ePass!123' },
      })
    ).data;

    const groupsData = (await req('/api/assignment-groups', { token: admin.token })).data;
    const agentsBefore = withGroupKeys(
      (await req('/api/agents', { token: admin.token })).data.agents,
      groupsData
    );

    // ---- steps 3-7: simulated email -> classified -> routed -> assigned ---
    const EMAIL = {
      from: 'jane.user@company.com',
      name: 'Jane User',
      subject: MARK + 'My laptop screen is cracked',
      body: 'The display is physically damaged after a drop.',
      messageId: MARK + 'msg-001',
      conversationId: MARK + 'conv-001',
    };

    const intake = await req('/api/tickets/from-email', { method: 'POST', token: admin.token, body: EMAIL });
    check('email accepted (201 created)', intake.status === 201, JSON.stringify(intake.data).slice(0, 200));
    const t = intake.data.ticket;
    check('ticket number generated (INC-NNNNNN)', /^INC-\d{6}$/.test((t && t.ticketNumber) || ''), t && t.ticketNumber);

    const hwGroup = groupsData.find((g) => g.key === 'hardware');
    const minSkill = hwGroup ? hwGroup.minSkillLevel : 1;

    check('category classified as Hardware', t.category === 'Hardware', t.category);
    check('priority set to MODERATE', t.priority === 'moderate');
    check('state NEW', t.state === 'NEW');
    check(
      'assignment group = Hardware & Devices',
      t.team && t.team.key === 'hardware' && intake.data.assignment.groupKey === 'hardware'
    );

    const expect = expectedPick(agentsBefore, 'hardware', minSkill);
    check(
      'engine selected lowest-workload suitable available agent',
      Boolean(t.assignedAgentId) &&
        intake.data.assignment.awaitingAssignment === false &&
        (!expect || t.assignedAgent.email === expect.email),
      'got=' + (t.assignedAgent ? t.assignedAgent.email : 'none') + ' expected=' + (expect ? expect.email : 'none')
    );

    const detail0 = (await req('/api/tickets/' + t.id, { token: admin.token })).data;
    check(
      'initial audit log recorded',
      detail0.auditLogs.some((l) => l.fromState === null && l.toState === 'NEW' && l.actor === 'system')
    );

    // ---- duplicate messageId ----------------------------------------------
    const dupe = await req('/api/tickets/from-email', { method: 'POST', token: admin.token, body: EMAIL });
    check(
      'duplicate messageId returns existing ticket, no new ticket',
      dupe.status === 200 && dupe.data.duplicate === true && dupe.data.ticket.id === t.id
    );
    const byNumber = await req('/api/tickets?q=' + encodeURIComponent(t.ticketNumber), { token: admin.token });
    check('exactly one ticket exists for that message', byNumber.data.length === 1);

    // ---- step 8: dashboard shows the ticket ---------------------------------
    const dash = (await req('/api/dashboard', { token: admin.token })).data;
    check(
      'ticket appears on dashboard (recently created)',
      dash.recentlyCreated.some((r) => r.ticketNumber === t.ticketNumber)
    );
    check('dashboard counts.new includes it', dash.counts.new >= 1);
    check('dashboard has per-agent workload rows', dash.ticketsPerAgent.length > 0);
    check('dashboard has per-group breakdown', Object.keys(dash.ticketsPerGroup).length >= 4);

    // ---- steps 9-11: open ticket, start work, notes --------------------------
    const started = await req('/api/tickets/' + t.id + '/status', {
      method: 'POST',
      token: riley.token,
      body: { state: 'IN_PROGRESS' },
    });
    check('moved to IN_PROGRESS by assigned agent', started.status === 200 && started.data.state === 'IN_PROGRESS');

    const note = await req('/api/tickets/' + t.id + '/notes', {
      method: 'POST',
      token: riley.token,
      body: { body: MARK + 'internal: driver rollback scheduled', isInternal: true },
    });
    check('internal note added', note.status === 201 && note.data.isInternal === true);

    const pub = await req('/api/tickets/' + t.id + '/notes', {
      method: 'POST',
      token: riley.token,
      body: { body: MARK + 'public: we are on it, update within the hour.' },
    });
    check('requester-facing update added', pub.status === 201 && pub.data.isInternal === false);

    // ---- steps 12-13: resolve (note mandatory) & close ------------------------
    const resolveNoNote = await req('/api/tickets/' + t.id + '/resolve', {
      method: 'POST',
      token: riley.token,
      body: {},
    });
    check('resolving without resolution note rejected', resolveNoNote.status === 400);

    const badTransition = await req('/api/tickets/' + t.id + '/status', {
      method: 'POST',
      token: riley.token,
      body: { state: 'CLOSED' },
    });
    check('invalid transition IN_PROGRESS->CLOSED rejected', badTransition.status === 400);

    const resolved = await req('/api/tickets/' + t.id + '/resolve', {
      method: 'POST',
      token: riley.token,
      body: { resolution: MARK + 'WiFi driver rolled back; connectivity verified.' },
    });
    check('resolved with mandatory resolution note', resolved.status === 200 && resolved.data.state === 'RESOLVED' && resolved.data.resolution.includes('rolled back'));

    const closed = await req('/api/tickets/' + t.id + '/close', { method: 'POST', token: riley.token, body: {} });
    check('RESOLVED -> CLOSED works', closed.status === 200 && closed.data.state === 'CLOSED');

    const closedToNew = await req('/api/tickets/' + t.id + '/status', {
      method: 'POST',
      token: riley.token,
      body: { state: 'NEW' },
    });
    check('invalid transition CLOSED->NEW rejected', closedToNew.status === 400);

    // ---- step 15: verify complete activity/audit history -----------------------
    const finalDetail = (await req('/api/tickets/' + t.id, { token: admin.token })).data;
    const states = finalDetail.auditLogs.filter((l) => l.fromState !== l.toState).map((l) => l.toState);
    check(
      'audit trail contains full lifecycle NEW->IN_PROGRESS->RESOLVED->CLOSED',
      states.includes('NEW') && states.includes('IN_PROGRESS') && states.includes('RESOLVED') && states.includes('CLOSED'),
      states.join(',')
    );
    const comments = finalDetail.comments;
    check('timeline holds both internal note and public update', comments.length === 2 && comments.some((c) => c.isInternal) && comments.some((c) => !c.isInternal));
    check('resolution stored for timeline display', Boolean(finalDetail.resolution));

    // ---- reassignment -----------------------------------------------------------
    const EMAIL2 = {
      from: 'kurt.user@company.com',
      subject: MARK + 'printer jams on every job',
      body: 'Paper jam each time.',
      messageId: MARK + 'msg-002',
    };
    const intake2 = await req('/api/tickets/from-email', { method: 'POST', token: admin.token, body: EMAIL2 });
    const t2 = intake2.data.ticket;
    check('second email creates second ticket', intake2.status === 201 && t2.id !== t.id);
    const beforeAssignee = t2.assignedAgent.email;
    const otherHw = createdAgents[0].email === beforeAssignee
      ? (await req('/api/agents', { token: admin.token })).data.agents.find(
          (a) => a.teamId === t2.teamId && a.isActive && a.email !== beforeAssignee && !a.email.startsWith(MARK + 'sam')
        )
      : createdAgents[0];
    const reassigned = await req('/api/tickets/' + t2.id + '/assign', {
      method: 'POST',
      token: admin.token,
      body: { agentEmail: otherHw.email },
    });
    check(
      'reassignment moves ticket to another agent + audits it',
      reassigned.status === 200 &&
        reassigned.data.assignedAgent.email === otherHw.email &&
        reassigned.data.auditLogs.some((l) => l.note && l.note.toLowerCase().includes('assigned'))
    );
    check('reassignment keeps state unchanged', reassigned.data.state === 'NEW');

    // ---- priority changes ---------------------------------------------------------
    const prioBefore = reassigned.data.dueAt;
    const bumped = await req('/api/tickets/' + t2.id, {
      method: 'PATCH',
      token: riley.token,
      body: { priority: 'critical' },
    });
    check(
      'priority change recalculates SLA target',
      bumped.status === 200 && bumped.data.priority === 'critical' && new Date(bumped.data.dueAt) < new Date(prioBefore)
    );

    // ---- no available agent ---------------------------------------------------------
    const agentsAll = (await req('/api/agents', { token: admin.token })).data.agents;
    // Everyone, not just this group: with nobody in the group the engine now
    // falls back across teams, so only a fully parked roster leaves a ticket
    // awaiting assignment.
    const hwActives = agentsAll.filter((a) => a.isActive && a.isAvailable);
    for (const a of hwActives) {
      await req('/api/agents/' + a.id, { method: 'PATCH', token: admin.token, body: { isAvailable: false } });
    }
    const orphanEmail = {
      from: 'mia.user@company.com',
      subject: MARK + 'monitor no signal after reboot',
      body: 'Screen stays black.',
      messageId: MARK + 'msg-orphan',
    };
    const orphan = await req('/api/tickets/from-email', { method: 'POST', token: admin.token, body: orphanEmail });
    check(
      'no available agent: creation succeeds, group kept, awaiting assignment',
      orphan.status === 201 &&
        orphan.data.ticket.assignedAgentId === null &&
        orphan.data.assignment.awaitingAssignment === true &&
        Boolean(orphan.data.ticket.team)
    );
    for (const a of hwActives) {
      await req('/api/agents/' + a.id, { method: 'PATCH', token: admin.token, body: { isAvailable: true } });
    }

    // ---- SPA smoke (built frontend served by backend) ----------------------------
    const spa = await fetch(BASE + '/');
    const html = await spa.text();
    check('SPA served from /', spa.status === 200 && html.includes('<div id="root">'));
  } finally {
    proc.kill();
  }

  await cleanup();
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

async function cleanup() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const tickets = await prisma.ticket.findMany({
      where: {
        OR: [
          { requesterEmail: { endsWith: '@company.com' } },
          { shortDescription: { contains: MARK } },
        ],
      },
      select: { id: true },
    });
    for (const tk of tickets) {
      await prisma.comment.deleteMany({ where: { ticketId: tk.id } });
      await prisma.ticketAuditLog.deleteMany({ where: { ticketId: tk.id } });
      await prisma.ticket.delete({ where: { id: tk.id } }).catch(() => {});
    }
    await prisma.agent.deleteMany({ where: { email: { startsWith: MARK } } });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
