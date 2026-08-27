/* Assignment groups, skills and configurable routing rules.

   Runs against a live ephemeral server. Every rule the tests rely on is
   created by the test itself, so the outcome never depends on the seeded
   defaults. No Graph, no email, no credentials.

   Usage: npm run test:routing  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4177';

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const routingService = require('../src/services/routingService');
const engine = require('../src/services/assignmentEngine');

const BASE = `http://localhost:${process.env.PORT}`;
const MARK = 'routing-test-';
const DOMAIN = 'routing.example';
const PASSWORD = 'RoutingPass!123';
const quiet = { log() {}, warn() {}, error() {} };

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

/* ---- fixtures ------------------------------------------------------- */

let parkedRuleIds = [];
/**
 * Deactivate the seeded default rules for the duration of the suite, so the
 * assertions depend only on rules this test creates.
 */
async function parkExistingRules() {
  const rows = await prisma.routingRule.findMany({
    where: { isActive: true, NOT: { name: { startsWith: MARK } } },
    select: { id: true },
  });
  parkedRuleIds = rows.map((r) => r.id);
  if (parkedRuleIds.length) {
    await prisma.routingRule.updateMany({ where: { id: { in: parkedRuleIds } }, data: { isActive: false } });
  }
}
async function unparkExistingRules() {
  if (parkedRuleIds.length) {
    await prisma.routingRule.updateMany({ where: { id: { in: parkedRuleIds } }, data: { isActive: true } });
  }
  parkedRuleIds = [];
}

let parkedIds = [];
/** Park every pre-existing agent so only this test's agents are eligible. */
async function parkEveryoneElse() {
  const rows = await prisma.agent.findMany({
    where: { isAvailable: true, NOT: { email: { endsWith: `@${DOMAIN}` } } },
    select: { id: true },
  });
  parkedIds = rows.map((r) => r.id);
  if (parkedIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: parkedIds } }, data: { isAvailable: false } });
  }
}
async function unparkEveryoneElse() {
  if (parkedIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: parkedIds } }, data: { isAvailable: true } });
  }
  parkedIds = [];
}

async function cleanup() {
  await prisma.routingRule.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.routingRuleAuditLog.deleteMany({ where: { ruleName: { startsWith: MARK } } });
  const tickets = await prisma.ticket.findMany({
    where: { OR: [{ graphMessageId: { startsWith: MARK } }, { requesterEmail: { endsWith: `@${DOMAIN}` } }] },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  const users = await prisma.agent.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  if (users.length) {
    const ids = users.map((u) => u.id);
    await prisma.ticket.updateMany({ where: { assignedAgentId: { in: ids } }, data: { assignedAgentId: null } });
    await prisma.routingRule.updateMany({ where: { preferredAgentId: { in: ids } }, data: { preferredAgentId: null } });
    await prisma.userAuditLog.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  }
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const mkAgent = (name, local, teamId, skillLevel, extra = {}) =>
  prisma.agent.create({
    data: {
      name, email: `${local}@${DOMAIN}`, teamId, skillLevel,
      role: 'agent', isActive: true, isAvailable: true, passwordHash: hash,
      lastAssignedAt: null, ...extra,
    },
  });

/** Route a ticket description and return the engine's decision. */
const route = (text, category, priority = 'moderate') =>
  engine.assign({ category, priority, text }, prisma, quiet);

async function main() {
  await ensureTeams(prisma);
  await cleanup();

  const teams = Object.fromEntries((await prisma.team.findMany()).map((t) => [t.key, t]));
  const network = teams.network;
  const hardware = teams.hardware;
  const general = teams.service_desk;

  /* ================================================================== */
  /* Keyword normalisation (deterministic, no LLM)                      */
  /* ================================================================== */
  {
    const hay = routingService.normalise('My Wi-Fi keeps DROPPING!!');
    const hayC = routingService.compact('My Wi-Fi keeps DROPPING!!');
    for (const variant of ['wifi', 'Wi-Fi', 'WIFI', 'wi fi', 'WI-FI']) {
      check(`keywords: "${variant}" matches "Wi-Fi" in text`, routingService.keywordMatches(variant, hay, hayC));
    }
    check('keywords: case is ignored', routingService.keywordMatches('DROPPING', hay, hayC));
    check('keywords: punctuation is ignored', routingService.keywordMatches('dropping', hay, hayC));

    const h2 = routingService.normalise('please advance the request');
    const h2c = routingService.compact('please advance the request');
    check('keywords: no partial-word false positives ("van" vs "advance")',
      !routingService.keywordMatches('van', h2, h2c));

    const h3 = routingService.normalise('the docking station is broken');
    const h3c = routingService.compact('the docking station is broken');
    check('keywords: multi-word phrase matches', routingService.keywordMatches('docking station', h3, h3c));

    eq('keywords: serialisation de-duplicates', routingService.serialiseKeywords(['wifi', 'WiFi', ' wifi ']), 'wifi');
    eq('keywords: parsing splits on commas and newlines',
      routingService.parseKeywords('a, b\nc; d').join('|'), 'a|b|c|d');

    eq('skills: JUNIOR is 1', routingService.skillValue('JUNIOR'), 1);
    eq('skills: MID is 2', routingService.skillValue('MID'), 2);
    eq('skills: SENIOR is 3', routingService.skillValue('SENIOR'), 3);
    eq('skills: name round-trips', routingService.skillName(3), 'SENIOR');
  }

  /* ================================================================== */
  /* Rules, agents and routing behaviour                                */
  /* ================================================================== */
  await parkEveryoneElse();
  await parkExistingRules();

  // Network team: a senior, a mid and a junior.
  const netSenior = await mkAgent('Net Senior', 'net.senior', network.id, 3);
  const netMid = await mkAgent('Net Mid', 'net.mid', network.id, 2);
  const netJunior = await mkAgent('Net Junior', 'net.junior', network.id, 1);
  // General IT Support.
  const genAgent = await mkAgent('General Tech', 'general.tech', general.id, 2);
  // Hardware, used for the cross-team fallback.
  const hwAgent = await mkAgent('Hardware Tech', 'hardware.tech', hardware.id, 3);

  const mkRule = (data) =>
    prisma.routingRule.create({
      data: {
        name: `${MARK}${data.name}`,
        keywords: routingService.serialiseKeywords(data.keywords || []),
        category: data.category ?? null,
        teamId: data.teamId,
        preferredAgentId: data.preferredAgentId ?? null,
        minimumSkillLevel: data.minimumSkillLevel ?? null,
        priority: data.priority,
        isActive: data.isActive !== false,
      },
    });

  /* ---- Network Issues -> Network Team ------------------------------ */
  const networkRule = await mkRule({
    name: 'Network Issues',
    priority: 10,
    keywords: ['wifi', 'wi-fi', 'internet', 'network', 'lan', 'vpn', 'router', 'connection'],
    teamId: network.id,
    minimumSkillLevel: 2, // MID
  });

  {
    for (const text of [
      'Cannot connect to WiFi',
      'Wi-Fi keeps dropping',
      'WIFI is down!!!',
      'The VPN will not connect',
      'Our LAN is unreachable',
    ]) {
      const d = await route(text, 'Hardware');
      check(`network: "${text}" -> Network Team`, d.groupName === network.name, `${d.ruleName} -> ${d.groupName}`);
    }
    const d = await route('Cannot connect to WiFi', 'Hardware');
    eq('network: matched rule reported', d.ruleName, `${MARK}Network Issues`);
    check('network: matched keywords reported', d.matchedKeywords.length > 0, JSON.stringify(d.matchedKeywords));
    eq('network: rule minimum skill applied (MID)', d.minSkillLevel, 2);
    check('network: a MID or SENIOR agent was chosen', d.agent && d.agent.skillLevel >= 2, d.agent && d.agent.name);
  }

  /* ---- preferred agent --------------------------------------------- */
  {
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { preferredAgentId: netSenior.id } });

    const d = await route('WiFi outage on floor 2', 'Hardware');
    eq('preferred: named agent is selected', d.agent && d.agent.id, netSenior.id);
    eq('preferred: flagged in the decision', d.preferredAgentUsed, true);

    // Unavailable preferred agent -> fall back inside the group.
    await prisma.agent.update({ where: { id: netSenior.id }, data: { isAvailable: false } });
    const d2 = await route('WiFi outage on floor 3', 'Hardware');
    check('preferred: unavailable preferred agent falls back to the group',
      d2.agent && d2.agent.id !== netSenior.id, d2.agent && d2.agent.name);
    eq('preferred: fallback is still inside the group', d2.agent.teamId, network.id);
    eq('preferred: flag reflects the fallback', d2.preferredAgentUsed, false);
    await prisma.agent.update({ where: { id: netSenior.id }, data: { isAvailable: true } });

    // Insufficient skill -> fall back.
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { preferredAgentId: netJunior.id } });
    const d3 = await route('WiFi outage on floor 4', 'Hardware');
    check('preferred: under-skilled preferred agent falls back',
      d3.agent && d3.agent.id !== netJunior.id, d3.agent && d3.agent.name);
    check('preferred: replacement meets the minimum skill', d3.agent.skillLevel >= 2);

    // Deactivated account -> fall back.
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { preferredAgentId: netSenior.id } });
    await prisma.agent.update({ where: { id: netSenior.id }, data: { isActive: false } });
    const d4 = await route('WiFi outage on floor 5', 'Hardware');
    check('preferred: deactivated preferred agent falls back', d4.agent && d4.agent.id !== netSenior.id);
    await prisma.agent.update({ where: { id: netSenior.id }, data: { isActive: true } });
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { preferredAgentId: null } });
  }

  /* ---- lowest workload, then round-robin ---------------------------- */
  {
    const { nextTicketNumber } = require('../src/ticketNumbers');
    const giveTickets = async (agentId, count) => {
      for (let i = 0; i < count; i++) {
        await prisma.ticket.create({
          data: {
            ticketNumber: await nextTicketNumber(prisma),
            shortDescription: `${MARK}load-${agentId}-${i}`,
            body: 'load', category: 'Hardware', priority: 'moderate', state: 'NEW', source: 'portal',
            requesterEmail: `load@${DOMAIN}`, graphMessageId: `${MARK}load-${agentId}-${i}`,
            teamId: network.id, assignedAgentId: agentId,
          },
        });
      }
    };

    // netSenior busy, netMid free -> netMid should win on workload.
    await giveTickets(netSenior.id, 3);
    const d = await route('Router keeps rebooting', 'Hardware');
    eq('workload: the least-loaded qualified agent is chosen', d.agent && d.agent.id, netMid.id);
    check('workload: reason names the workload', /lowest workload/.test(d.reason), d.reason);

    // Equal workload -> least-recently-assigned wins (round-robin).
    await prisma.ticket.deleteMany({ where: { graphMessageId: { startsWith: `${MARK}load-` } } });
    const long = new Date('2020-01-01T00:00:00Z');
    const recent = new Date();
    await prisma.agent.update({ where: { id: netMid.id }, data: { lastAssignedAt: recent } });
    await prisma.agent.update({ where: { id: netSenior.id }, data: { lastAssignedAt: long } });
    const rr = await route('Network switch failure', 'Hardware');
    eq('round-robin: tie broken by least-recently-assigned', rr.agent && rr.agent.id, netSenior.id);

    // And the winner is stamped, so the next tie goes the other way.
    const rr2 = await route('Another network switch failure', 'Hardware');
    eq('round-robin: rotates on the next ticket', rr2.agent && rr2.agent.id, netMid.id);
  }

  /* ---- no matching rule -> General IT Support ----------------------- */
  {
    const d = await route('Where do I find the staff handbook?', 'Inquiry / Help');
    eq('no rule: falls back to the default group', d.groupName, general.name);
    check('no rule: the default group is the configured one', general.isDefault === true);
    eq('no rule: no rule reported', d.ruleName, null);
    eq('no rule: assigned inside the default group', d.agent && d.agent.teamId, general.id);
  }

  /* ---- General IT Support unavailable -> global fallback ------------ */
  {
    await prisma.agent.update({ where: { id: genAgent.id }, data: { isAvailable: false } });

    const d = await route('Where do I find the travel policy?', 'Inquiry / Help');
    eq('global fallback: assignment group is STILL General IT Support', d.groupName, general.name);
    eq('global fallback: group id unchanged', d.teamId, general.id);
    check('global fallback: an agent from another team took it', d.agent && d.agent.teamId !== general.id, d.agent && d.agent.name);
    eq('global fallback: flagged as cross-team', d.crossTeam, true);
    check('global fallback: reason explains it', /across teams/.test(d.reason), d.reason);

    await prisma.agent.update({ where: { id: genAgent.id }, data: { isAvailable: true } });
  }

  /* ---- nobody anywhere -> awaiting assignment, group kept ----------- */
  {
    const mine = await prisma.agent.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
    await prisma.agent.updateMany({ where: { id: { in: mine.map((m) => m.id) } }, data: { isAvailable: false } });

    const d = await route('Nobody is around to help', 'Inquiry / Help');
    eq('no agent at all: awaiting assignment', d.awaitingAssignment, true);
    eq('no agent at all: no agent chosen', d.agent, null);
    eq('no agent at all: group still recorded', d.groupName, general.name);

    await prisma.agent.updateMany({ where: { id: { in: mine.map((m) => m.id) } }, data: { isAvailable: true } });
  }

  /* ---- precedence: specific beats generic --------------------------- */
  {
    const generic = await mkRule({
      name: 'Generic Hardware', priority: 70, category: 'Hardware', keywords: [], teamId: hardware.id,
    });
    const d = await route('Cannot connect to WiFi on my laptop', 'Hardware');
    eq('precedence: lower priority number wins', d.groupName, network.name);
    eq('precedence: the specific rule is the one reported', d.ruleName, `${MARK}Network Issues`);

    // Flip the priorities: the generic rule should now win.
    await prisma.routingRule.update({ where: { id: generic.id }, data: { priority: 5 } });
    const d2 = await route('Cannot connect to WiFi on my laptop', 'Hardware');
    eq('precedence: priority is what decides, not specificity', d2.groupName, hardware.name);
    await prisma.routingRule.update({ where: { id: generic.id }, data: { priority: 70 } });

    // At equal priority, a category-specific rule beats a category-agnostic one.
    const anyCat = await mkRule({
      name: 'Any Category Catch', priority: 40, category: null, keywords: ['gadget'], teamId: general.id,
    });
    const catSpecific = await mkRule({
      name: 'Hardware Gadget', priority: 40, category: 'Hardware', keywords: ['gadget'], teamId: hardware.id,
    });
    const d3 = await route('My gadget is broken', 'Hardware');
    eq('precedence: category-specific beats category-agnostic at equal priority', d3.ruleName, `${MARK}Hardware Gadget`);

    // At equal priority and specificity, more matched keywords wins.
    await prisma.routingRule.update({ where: { id: anyCat.id }, data: { category: 'Hardware', keywords: routingService.serialiseKeywords(['gadget', 'broken']) } });
    const d4 = await route('My gadget is broken', 'Hardware');
    eq('precedence: more matched keywords wins', d4.ruleName, `${MARK}Any Category Catch`);

    await prisma.routingRule.deleteMany({ where: { id: { in: [generic.id, anyCat.id, catSpecific.id] } } });
  }

  /* ---- inactive rules and groups are ignored ------------------------ */
  {
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { isActive: false } });
    const d = await route('Cannot connect to WiFi', 'Hardware');
    check('inactive rule: is not applied', d.ruleName !== `${MARK}Network Issues`, String(d.ruleName));
    await prisma.routingRule.update({ where: { id: networkRule.id }, data: { isActive: true } });

    await prisma.team.update({ where: { id: network.id }, data: { isActive: false } });
    const d2 = await route('Cannot connect to WiFi', 'Hardware');
    check('inactive group: its rules are skipped', d2.groupName !== network.name, String(d2.groupName));
    await prisma.team.update({ where: { id: network.id }, data: { isActive: true } });
  }

  /* ================================================================== */
  /* HTTP: admin rule management + originating group                    */
  /* ================================================================== */
  const admin = await mkAgent('Routing Admin', 'routing.admin', null, 3, { role: 'admin' });
  const plainAgent = await prisma.agent.findUnique({ where: { id: netMid.id } });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, INITIAL_ADMIN_EMAIL: '' }, stdio: 'ignore',
  });

  try {
    await waitForServer(server);
    const login = async (email) =>
      (await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).data.token;
    const adminT = await login(admin.email);
    const agentT = await login(plainAgent.email);
    check('setup: admin and agent signed in', Boolean(adminT && agentT));

    /* ---- authorization --------------------------------------------- */
    eq('authz: agent cannot list routing rules', (await req('/api/routing/rules', { token: agentT })).status, 403);
    eq('authz: unauthenticated cannot list routing rules', (await req('/api/routing/rules')).status, 401);
    eq('authz: admin can list routing rules', (await req('/api/routing/rules', { token: adminT })).status, 200);
    eq('authz: agent cannot create a rule',
      (await req('/api/routing/rules', { method: 'POST', token: agentT, body: { name: 'x', assignmentGroupId: network.id } })).status, 403);

    /* ---- CRUD ------------------------------------------------------- */
    const created = await req('/api/routing/rules', {
      method: 'POST', token: adminT,
      body: {
        name: `${MARK}HTTP Rule`,
        keywords: ['projector', 'hdmi'],
        category: 'Hardware',
        assignmentGroupId: hardware.id,
        minimumSkillLevel: 'SENIOR',
        priority: 15,
      },
    });
    eq('rules: admin can create a rule', created.status, 201);
    eq('rules: keywords stored as a list', created.data.keywords.join(','), 'projector,hdmi');
    eq('rules: minimum skill stored by name', created.data.minimumSkillName, 'SENIOR');
    eq('rules: assignment group linked', created.data.assignmentGroup.id, hardware.id);
    const ruleId = created.data.id;

    const badCategory = await req('/api/routing/rules', {
      method: 'POST', token: adminT,
      body: { name: 'bad', category: 'Nonsense', assignmentGroupId: hardware.id },
    });
    eq('rules: unknown category rejected', badCategory.status, 400);
    const badGroup = await req('/api/routing/rules', {
      method: 'POST', token: adminT, body: { name: 'bad', assignmentGroupId: 999999 },
    });
    eq('rules: unknown assignment group rejected', badGroup.status, 400);
    const badSkill = await req('/api/routing/rules', {
      method: 'POST', token: adminT,
      body: { name: 'bad', assignmentGroupId: hardware.id, minimumSkillLevel: 'WIZARD' },
    });
    eq('rules: unknown skill level rejected', badSkill.status, 400);

    const edited = await req(`/api/routing/rules/${ruleId}`, {
      method: 'PATCH', token: adminT, body: { priority: 12, keywords: ['projector', 'hdmi', 'display port'] },
    });
    eq('rules: admin can edit a rule', edited.status, 200);
    eq('rules: priority updated', edited.data.priority, 12);
    eq('rules: keywords updated', edited.data.keywords.length, 3);

    const deactivated = await req(`/api/routing/rules/${ruleId}`, {
      method: 'PATCH', token: adminT, body: { isActive: false },
    });
    eq('rules: admin can deactivate a rule', deactivated.data.isActive, false);
    const reactivated = await req(`/api/routing/rules/${ruleId}`, {
      method: 'PATCH', token: adminT, body: { isActive: true },
    });
    eq('rules: admin can reactivate a rule', reactivated.data.isActive, true);

    const preferred = await req(`/api/routing/rules/${ruleId}`, {
      method: 'PATCH', token: adminT, body: { preferredAgentId: hwAgent.id },
    });
    eq('rules: preferred agent can be set', preferred.data.preferredAgent.id, hwAgent.id);
    const cleared = await req(`/api/routing/rules/${ruleId}`, {
      method: 'PATCH', token: adminT, body: { preferredAgentId: null },
    });
    eq('rules: preferred agent can be cleared', cleared.data.preferredAgentId, null);

    /* ---- preview ---------------------------------------------------- */
    const preview = await req('/api/routing/preview', {
      method: 'POST', token: adminT, body: { text: 'The projector has no HDMI signal', category: 'Hardware' },
    });
    eq('preview: responds', preview.status, 200);
    eq('preview: shows the winning rule', preview.data.matchedRule.name, `${MARK}HTTP Rule`);
    eq('preview: shows the target group', preview.data.assignmentGroup.id, hardware.id);

    /* ---- audit ------------------------------------------------------ */
    const audit = await req('/api/routing/audit', { token: adminT });
    eq('audit: endpoint responds', audit.status, 200);
    const mine = audit.data.events.filter((e) => e.ruleName === `${MARK}HTTP Rule`);
    const actions = mine.map((e) => e.action);
    for (const expected of ['created', 'updated', 'activated', 'deactivated']) {
      check(`audit: ${expected} recorded`, actions.includes(expected), actions.join(','));
    }
    check('audit: actor recorded', mine.every((e) => e.actor && e.actor.includes('Routing Admin')));
    check('audit: timestamps recorded', mine.every((e) => Boolean(e.createdAt)));
    eq('audit: agents cannot read the routing audit', (await req('/api/routing/audit', { token: agentT })).status, 403);

    const del = await req(`/api/routing/rules/${ruleId}`, { method: 'DELETE', token: adminT });
    eq('rules: admin can delete a rule', del.status, 200);
    eq('rules: rule is gone', (await req(`/api/routing/rules/${ruleId}`, { method: 'PATCH', token: adminT, body: { priority: 1 } })).status, 404);
    const auditAfter = await req('/api/routing/audit', { token: adminT });
    check('audit: deletion recorded and survives the rule',
      auditAfter.data.events.some((e) => e.ruleName === `${MARK}HTTP Rule` && e.action === 'deleted'));

    /* ---- assignment groups ------------------------------------------ */
    const groups = await req('/api/routing/groups', { token: adminT });
    eq('groups: endpoint responds', groups.status, 200);
    const gen = groups.data.groups.find((g) => g.id === general.id);
    check('groups: General IT Support is the default', gen.isDefault === true, JSON.stringify(gen));
    check('groups: description exposed', 'description' in gen);
    check('groups: agent and rule counts exposed', typeof gen.agentCount === 'number' && typeof gen.ruleCount === 'number');
    eq('groups: the default group cannot be deactivated',
      (await req(`/api/routing/groups/${general.id}`, { method: 'PATCH', token: adminT, body: { isActive: false } })).status, 409);
    eq('groups: agent cannot edit groups',
      (await req(`/api/routing/groups/${hardware.id}`, { method: 'PATCH', token: agentT, body: { description: 'x' } })).status, 403);
    const originalDescription = hardware.description;
    const descUpdate = await req(`/api/routing/groups/${hardware.id}`, {
      method: 'PATCH', token: adminT, body: { description: `${MARK}updated description` },
    });
    eq('groups: admin can edit a description', descUpdate.status, 200);
    // Restore it: this suite must not leave edits behind in the real database.
    await req(`/api/routing/groups/${hardware.id}`, {
      method: 'PATCH', token: adminT, body: { description: originalDescription },
    });

    /* ---- originating assignment group ------------------------------- */
    {
      const made = await req('/api/tickets', {
        method: 'POST', token: adminT,
        body: {
          shortDescription: `${MARK}WiFi down in the annexe`,
          body: 'No wireless connection at all.',
          category: 'Hardware', priority: 'moderate',
          requesterEmail: `origin@${DOMAIN}`, requesterName: 'Origin Tester',
        },
      });
      eq('origin: ticket created', made.status, 201);
      const row = await prisma.ticket.findUnique({ where: { id: made.data.id } });
      check('origin: originating group recorded at creation', row.originatingTeamId !== null);
      eq('origin: it equals the group the ticket was routed to', row.originatingTeamId, row.teamId);
      const originalGroup = row.originatingTeamId;

      // Move the ticket to a different group.
      const moved = await req(`/api/tickets/${made.data.id}`, {
        method: 'PATCH', token: adminT, body: { assignmentGroup: 'software', autoAssign: false },
      });
      eq('origin: group change succeeded', moved.status, 200);
      const after = await prisma.ticket.findUnique({ where: { id: made.data.id } });
      check('origin: current group changed', after.teamId !== originalGroup);
      eq('origin: originating group is unchanged', after.originatingTeamId, originalGroup);

      // And again, to be sure it is never rewritten.
      await req(`/api/tickets/${made.data.id}`, {
        method: 'PATCH', token: adminT, body: { assignmentGroup: 'accounts', autoAssign: false },
      });
      const after2 = await prisma.ticket.findUnique({ where: { id: made.data.id } });
      eq('origin: still unchanged after a second move', after2.originatingTeamId, originalGroup);
    }

    /* ---- routing happens immediately on creation --------------------- */
    {
      const made = await req('/api/tickets', {
        method: 'POST', token: adminT,
        body: {
          shortDescription: `${MARK}VPN will not connect`,
          body: 'Remote access is broken.',
          category: 'Hardware', priority: 'moderate',
          requesterEmail: `immediate@${DOMAIN}`,
        },
      });
      eq('immediate: ticket created', made.status, 201);
      eq('immediate: routed to the Network Team on creation', made.data.team && made.data.team.key, 'network');
      check('immediate: an agent was assigned straight away', made.data.assignedAgentId !== null, JSON.stringify(made.data.assignment));
      const audits = await prisma.ticketAuditLog.findMany({ where: { ticketId: made.data.id } });
      check('immediate: the routing decision is in the audit trail',
        audits.some((a) => a.note && /rule "/.test(a.note)), JSON.stringify(audits.map((a) => a.note)));
    }
  } finally {
    server.kill();
    await unparkExistingRules();
    await unparkEveryoneElse();
    await cleanup();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => { console.error(err); failures += 1; })
  .finally(async () => {
    await unparkExistingRules().catch(() => {});
    await unparkEveryoneElse().catch(() => {});
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
