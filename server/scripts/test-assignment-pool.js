/* Assignment pool + online-agent functionality.
 *
 * The availability state model (online / unavailable / offline) derives from
 * the existing Agent.isActive/isAvailable columns; the pool is the per-group
 * roster built from effective membership. Everything here runs against the
 * real (isolated) database and the REAL assignment engine, routing rules,
 * handover service and SLA service — no stand-ins for the code under test.
 * Only the live-API section mounts an HTTP app.
 *
 * A. State model (pure derivation + column mapping)
 * B. Pool building (effective membership, lead, load, max-membership rule)
 * C. Transitions — and no ticket moves when somebody goes offline
 * D. Automatic assignment skips unavailable/offline agents; none eligible -> unassigned
 * E. Deterministic selection (workload, then round-robin, then id)
 * F. Manual assignment + the availability-state API (live, authorized paths)
 * G. Routing-rule compatibility (rules pick the group; the pool picks the person)
 * H. Handover compatibility (clocks pause offline, resume online)
 * I. Historical SLA attribution is untouched by availability changes
 *
 * Usage: npm run test:assignment-pool  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4230';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('assignpool');

const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');
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

const PASSWORD = 'PoolSuite!123';
const DOMAIN = 'pool.test';
const QUIET = { log() {}, warn() {}, error() {} };

const poolService = require('../src/services/assignmentPoolService');
const assignmentEngine = require('../src/services/assignmentEngine');
const assignmentPolicy = require('../src/services/assignmentPolicy');
const groupMembershipService = require('../src/services/groupMembershipService');
const handoverService = require('../src/services/handoverService');
const slaService = require('../src/slaService');

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
      shortDescription: 'Pool fixture ticket',
      body: 'Pool fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

(async () => {
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: QUIET });

  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  const net = await prisma.team.create({ data: { key: 'pool-net', name: 'Pool Network' } });
  const apps = await prisma.team.create({ data: { key: 'pool-apps', name: 'Pool Apps' } });

  const admin = await mkAgent('Pool Admin', `admin@${DOMAIN}`, { role: 'admin', teamId: defaultTeam.id });
  // alice: primary group net, PLUS a membership row in apps (multi-group).
  const alice = await mkAgent('Alice Available', `alice@${DOMAIN}`, { teamId: net.id, skillLevel: 2 });
  // bob: legacy primary group only (no membership row) — the transition shape.
  const bob = await mkAgent('Bob Legacy', `bob@${DOMAIN}`, { teamId: net.id, skillLevel: 1 });
  // carol: membership row in net only; her primary pointer lives in apps.
  const carol = await mkAgent('Carol Member', `carol@${DOMAIN}`, { teamId: apps.id, skillLevel: 1 });
  // dave: primary net, will go offline mid-suite.
  const dave = await mkAgent('Dave Offline', `dave@${DOMAIN}`, { teamId: net.id, skillLevel: 2 });
  // erin: no group at all — the cross-team fallback candidate.
  const erin = await mkAgent('Erin Floating', `erin@${DOMAIN}`, { teamId: null, skillLevel: 2 });

  await prisma.teamMembership.create({ data: { agentId: alice.id, teamId: apps.id } });
  await prisma.teamMembership.create({ data: { agentId: carol.id, teamId: net.id, isLead: true } });

  /* ==================================================================== */
  /* A. State model                                                       */
  /* ==================================================================== */
  console.log('\n--- A. state model ---');
  eq('A1 active+available is online', poolService.availabilityStateOf({ isActive: true, isAvailable: true }), 'online');
  eq('A2 active+unavailable is unavailable', poolService.availabilityStateOf({ isActive: true, isAvailable: false }), 'unavailable');
  eq('A3 inactive is offline whatever the availability flag', poolService.availabilityStateOf({ isActive: false, isAvailable: true }), 'offline');
  eq('A4 a missing agent reads as offline', poolService.availabilityStateOf(null), 'offline');
  eq('A5 online maps to both columns true', JSON.stringify(poolService.columnsForState('online')), JSON.stringify({ isActive: true, isAvailable: true }));
  eq('A6 unavailable keeps the account active', poolService.columnsForState('unavailable').isActive, true);
  eq('A7 offline deactivates', poolService.columnsForState('offline').isActive, false);
  check('A8 an unknown state is refused', !poolService.isValidState('busy'));
  let threw = false;
  try { poolService.columnsForState('busy'); } catch { threw = true; }
  eq('A9 columnsForState throws on an unknown state', threw, true);
  check('A10 exactly three states exist', JSON.stringify(poolService.AVAILABILITY_STATES) === JSON.stringify(['online', 'unavailable', 'offline']));

  /* ==================================================================== */
  /* B. Pool building                                                     */
  /* ==================================================================== */
  console.log('\n--- B. pool building ---');
  const pools = await poolService.listGroupPools();
  const netPool = pools.find((p) => p.key === 'pool-net');
  const appsPool = pools.find((p) => p.key === 'pool-apps');
  check('B1 every active group has a pool', pools.some((p) => p.key === defaultTeam.key) && Boolean(netPool && appsPool));

  const memberIds = (p) => p.agents.map((a) => a.id);
  check('B2 a multi-group agent appears in both pools',
    memberIds(netPool).includes(alice.id) && memberIds(appsPool).includes(alice.id));
  check('B3 a legacy primary-group member (no membership row) is in the pool', memberIds(netPool).includes(bob.id));
  check('B4 a membership-row member is in the pool on top of their primary group',
    memberIds(netPool).includes(carol.id) && memberIds(appsPool).includes(carol.id));
  check('B5 a group-less agent is in no pool', !memberIds(netPool).includes(erin.id) && !memberIds(appsPool).includes(erin.id));
  eq('B6 the lead is surfaced from the membership row', netPool.lead && netPool.lead.id, carol.id);

  // Load: give alice two open tickets and leave one unassigned in net.
  await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'NEW' });
  await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'IN_PROGRESS' });
  await mkTicket({ teamId: net.id, state: 'NEW' });
  const loaded = (await poolService.listGroupPools()).find((p) => p.key === 'pool-net');
  eq('B7 the member card carries the live open-ticket load',
    loaded.agents.find((a) => a.id === alice.id).openTickets, 2);
  eq('B8 the group load counts its open tickets', loaded.load.openTickets, 3);
  eq('B9 the group load counts unassigned tickets separately', loaded.load.unassignedTickets, 1);

  {
    // The maximum-membership rule bounds every pool by construction: an agent
    // can never belong to more than MAX_GROUPS_PER_AGENT groups.
    const frodo = await mkAgent('Frodo Maxed', `frodo@${DOMAIN}`, { teamId: null });
    await groupMembershipService.addMember({ agentId: frodo.id, teamId: net.id });
    await groupMembershipService.addMember({ agentId: frodo.id, teamId: apps.id });
    await groupMembershipService.addMember({ agentId: frodo.id, teamId: defaultTeam.id });
    let membershipError = null;
    try {
      const extra = await prisma.team.create({ data: { key: 'pool-extra', name: 'Pool Extra' } });
      await groupMembershipService.addMember({ agentId: frodo.id, teamId: extra.id });
    } catch (err) { membershipError = err; }
    eq('B10 a fourth membership is refused (MAX_GROUPS_REACHED)',
      membershipError && membershipError.code, 'MAX_GROUPS_REACHED');
    const frodoPools = (await poolService.listGroupPools()).filter((p) => p.agents.some((a) => a.id === frodo.id)).length;
    eq('B11 the pool count for a maxed agent never exceeds the rule', frodoPools, 3);
    // Frodo exists only to prove the membership ceiling — park the account so
    // the assignment sections below see exactly the agents they expect.
    await prisma.agent.update({ where: { id: frodo.id }, data: { isActive: false } });
  }

  {
    // Eligibility mirrors the engine: online + skill >= bar + under the cap.
    const card = loaded.agents.find((a) => a.id === alice.id);
    eq('B12 an online, skilled, under-cap agent is auto-eligible', card.autoEligible, true);
  }

  /* ==================================================================== */
  /* C. Transitions — nothing moves when somebody goes offline            */
  /* ==================================================================== */
  console.log('\n--- C. transitions without reassignment ---');
  const daveNew = await mkTicket({ assignedAgentId: dave.id, teamId: net.id, state: 'NEW' });
  const daveWip = await mkTicket({ assignedAgentId: dave.id, teamId: net.id, state: 'IN_PROGRESS' });

  {
    const { agent, from, to } = await poolService.applyAvailabilityState({
      agentId: dave.id, state: 'offline', actor: admin,
    });
    eq('C1 the transition reports where it came from', `${from}->${to}`, 'online->offline');
    eq('C2 offline deactivates the account', agent.isActive, false);
    eq('C3 offline clears the availability flag too', agent.isAvailable, false);
    eq('C4 the NEW ticket keeps its owner', (await prisma.ticket.findUnique({ where: { id: daveNew.id } })).assignedAgentId, dave.id);
    eq('C5 the IN_PROGRESS ticket keeps its owner', (await prisma.ticket.findUnique({ where: { id: daveWip.id } })).assignedAgentId, dave.id);
    const audit = await prisma.userAuditLog.findFirst({
      where: { agentId: dave.id, action: 'availability_changed', field: 'availabilityState' },
      orderBy: { id: 'desc' },
    });
    eq('C6 the transition is audited with the state names', `${audit.fromValue}->${audit.toValue}`, 'online->offline');
  }
  {
    const { agent, to } = await poolService.applyAvailabilityState({ agentId: dave.id, state: 'unavailable', actor: admin });
    eq('C7 coming back from offline reactivates the account', agent.isActive, true);
    eq('C8 unavailable keeps the account active but stops the work', to === 'unavailable' && agent.isActive && agent.isAvailable === false, true);
    const { agent: online } = await poolService.applyAvailabilityState({ agentId: dave.id, state: 'online', actor: admin });
    eq('C9 online restores both flags', online.isActive && online.isAvailable, true);
  }

  /* ==================================================================== */
  /* D. Automatic assignment vs the pool                                  */
  /* ==================================================================== */
  console.log('\n--- D. automatic assignment ---');
  {
    // Group pool: everyone online. alice carries 2 open tickets and dave 2
    // (from section C); bob and carol tie at zero, and the round-robin
    // tiebreak (lastAssignedAt, then id) deterministically picks bob.
    const decision = await assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'a network problem', forceTeamId: net.id },
      prisma, QUIET
    );
    eq('D1 the group is kept', decision.teamId, net.id);
    eq('D2 the pick is deterministic (lightest workload, then round-robin, then id)',
      decision.agent.id, bob.id);
    eq('D3 the pick is not awaiting assignment', decision.awaitingAssignment, false);
  }

  {
    // The whole net pool goes dark: alice+bob unavailable, dave offline, the
    // suite administrator unavailable too. The engine's cross-team fallback —
    // which respects the availability state exactly like the in-group search —
    // lands on carol: she is a member of the net POOL (via her membership row)
    // whose primary group is apps, so the engine reaches her as a cross-team
    // agent. (A group-less agent like erin carries no primary group for the
    // engine's query — existing engine behaviour, unchanged here.)
    for (const a of [alice, bob, admin]) {
      await prisma.agent.update({ where: { id: a.id }, data: { isAvailable: false } });
    }
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'offline', actor: admin });
    const decision = await assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'another problem', forceTeamId: net.id },
      prisma, QUIET
    );
    eq('D4 no unavailable/offline group member is chosen', decision.agent && decision.agent.id, carol.id);
    eq('D5 the fallback is marked cross-team and keeps the group', decision.crossTeam, true);
    eq('D6 the ticket still belongs to its group', decision.teamId, net.id);
  }

  {
    // Carol goes unavailable too: NO eligible online agent exists anywhere.
    await prisma.agent.update({ where: { id: carol.id }, data: { isAvailable: false } });
    await prisma.agent.update({ where: { id: erin.id }, data: { isAvailable: false } });
    const decision = await assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'nobody home', forceTeamId: net.id },
      prisma, QUIET
    );
    eq('D7 with nobody online the ticket is left unassigned', decision.agent, null);
    eq('D8 the engine reports it as awaiting assignment', decision.awaitingAssignment, true);
    eq('D9 the group is still kept for triage', decision.teamId, net.id);
  }

  {
    // A group whose ONLY member is unavailable is skipped even when that group
    // is force-pinned — with no online fallback anywhere, the ticket waits.
    const solo = await mkAgent('Solo Unavailable', `solo@${DOMAIN}`, { teamId: apps.id, skillLevel: 3, isAvailable: false });
    const decision = await assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', text: 'solo group', forceTeamId: apps.id, excludeAgentIds: [alice.id] },
      prisma, QUIET
    );
    eq('D10 an unavailable-only pool leaves the ticket unassigned', decision.agent, null);
    eq('D11 the unavailable agent was considered but refused', decision.awaitingAssignment, true);

    // Restore the world for the later sections.
    for (const a of [alice, bob, carol, erin, admin]) {
      await prisma.agent.update({ where: { id: a.id }, data: { isAvailable: true } });
    }
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'online', actor: admin });
    await prisma.agent.update({ where: { id: solo.id }, data: { isActive: false } });
  }

  /* ==================================================================== */
  /* E. Deterministic selection                                           */
  /* ==================================================================== */
  console.log('\n--- E. deterministic selection ---');
  {
    // Two fresh, equally-loaded online agents: id order wins first, then
    // round-robin. The same inputs always produce the same answer.
    const t1 = await prisma.team.create({ data: { key: 'pool-det', name: 'Pool Deterministic' } });
    const p1 = await mkAgent('Pat First', `pat@${DOMAIN}`, { teamId: t1.id });
    const p2 = await mkAgent('Rin Second', `rin@${DOMAIN}`, { teamId: t1.id });
    const pick = () => assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'low', text: 'deterministic pick', forceTeamId: t1.id },
      prisma, QUIET
    );
    const first = await pick();
    eq('E1 the lowest-workload, least-recently-assigned agent wins', first.agent.id, p1.id);
    const second = await pick();
    eq('E2 the round-robin tiebreak rotates to the other agent', second.agent.id, p2.id);
    const third = await pick();
    eq('E3 and back again — fully deterministic', third.agent.id, p1.id);

    // A workload difference overrides recency.
    await mkTicket({ assignedAgentId: p1.id, teamId: t1.id, state: 'NEW' });
    const fourth = await pick();
    eq('E4 the lighter workload wins regardless of recency', fourth.agent.id, p2.id);
  }

  /* ==================================================================== */
  /* F. Manual assignment + the availability-state API (live)             */
  /* ==================================================================== */
  console.log('\n--- F. manual assignment and the state API ---');
  {
    const manual = await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'NEW' });
    const plainActor = { id: alice.id, role: 'agent', name: alice.name };
    const adminActor = { id: admin.id, role: 'admin', name: admin.name };
    const asTicket = await prisma.ticket.findUnique({ where: { id: manual.id } });
    const bobFresh = await prisma.agent.findUnique({ where: { id: bob.id } });
    const daveOnline = await prisma.agent.findUnique({ where: { id: dave.id } });

    // Manual assignment to an ONLINE teammate: unchanged.
    eq('F1 an agent may reassign to an online same-group teammate',
      assignmentPolicy.checkTarget(asTicket, plainActor, bobFresh).ok, true);
    // Manual assignment to an UNAVAILABLE teammate: refused for agents...
    await prisma.agent.update({ where: { id: bob.id }, data: { isAvailable: false } });
    const bobUnavailable = await prisma.agent.findUnique({ where: { id: bob.id } });
    const agentVerdict = assignmentPolicy.checkTarget(asTicket, plainActor, bobUnavailable);
    eq('F2 an agent may not assign to an unavailable teammate', agentVerdict.ok, false);
    eq('F3 the refusal explains the state', /unavailable/i.test(agentVerdict.error), true);
    // ...but an administrator may still do it deliberately.
    eq('F4 an administrator may assign to an unavailable agent (deliberate override)',
      assignmentPolicy.checkTarget(asTicket, adminActor, bobUnavailable).ok, true);
    // OFFLINE (deactivated) is refused for everybody.
    await poolService.applyAvailabilityState({ agentId: bob.id, state: 'offline', actor: admin });
    const bobOffline = await prisma.agent.findUnique({ where: { id: bob.id } });
    eq('F5 an offline agent receives no work, even from an administrator',
      assignmentPolicy.checkTarget(asTicket, adminActor, bobOffline).ok, false);
    await poolService.applyAvailabilityState({ agentId: bob.id, state: 'online', actor: admin });
    void daveOnline;
  }

  {
    // Live API: the state endpoint and the pools endpoint.
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/workload', require('../src/authMiddleware').requireAuth, require('../routes/workload'));
    // Same handler server.js mounts.
    app.get('/api/assignment-pools', require('../src/authMiddleware').requireAuth, async (req, res) => {
      res.json({ pools: await poolService.listGroupPools() });
    });
    await new Promise((resolve) => { app.listen(process.env.PORT, resolve); });
    const BASE = `http://localhost:${process.env.PORT}`;
    async function req(pathname, { method = 'GET', token, body } = {}) {
      const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, data, text };
    }

    await mkAgent('Web Agent', `web@${DOMAIN}`, { teamId: net.id });
    const adminLogin = await req('/api/auth/login', { method: 'POST', body: { email: `admin@${DOMAIN}`, password: PASSWORD } });
    const webLogin = await req('/api/auth/login', { method: 'POST', body: { email: `web@${DOMAIN}`, password: PASSWORD } });
    const adminToken = adminLogin.data.token;
    const webToken = webLogin.data.token;
    check('F6 tokens issued', Boolean(adminToken && webToken));

    eq('F7 the pools endpoint requires authentication', (await req('/api/assignment-pools')).status, 401);
    const poolsView = await req('/api/assignment-pools', { token: webToken });
    eq('F8 a signed-in agent can read the pools', poolsView.status, 200);
    const netView = poolsView.data.pools.find((p) => p.key === 'pool-net');
    check('F9 the pool payload carries group, states and load',
      netView && netView.name === 'Pool Network' && typeof netView.pool.online === 'number' && typeof netView.load.openTickets === 'number');
    check('F10 the pool partitions by the three states',
      netView.agents.every((a) => ['online', 'unavailable', 'offline'].includes(a.availabilityState)));

    // Self-service: online/unavailable through the state shape.
    const selfOnline = await req('/api/workload/availability', { method: 'POST', token: webToken, body: { state: 'online' } });
    eq('F11 state "online" self-service works', selfOnline.status, 200);
    eq('F12 the response carries the derived state', selfOnline.data.availabilityState, 'online');
    // Self-offline is refused with an explanation.
    const selfOffline = await req('/api/workload/availability', { method: 'POST', token: webToken, body: { state: 'offline' } });
    eq('F13 self-offline is refused', selfOffline.status, 400);
    check('F14 the refusal explains the sign-in consequence', /sign-in/.test(selfOffline.data.error));
    // A non-admin cannot change somebody else.
    const agentSetsOther = await req('/api/workload/availability', { method: 'POST', token: webToken, body: { state: 'offline', agentId: alice.id } });
    eq('F15 a non-admin cannot change another agent', agentSetsOther.status, 403);
    // Admin takes dave offline: presence-only, tickets untouched.
    const adminOffline = await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'offline', agentId: dave.id } });
    eq('F16 an administrator can take another agent offline', adminOffline.status, 200);
    eq('F17 no ticket was reassigned by it', adminOffline.data.reassigned, null);
    eq('F18 the offline agent keeps their tickets',
      await prisma.ticket.count({ where: { assignedAgentId: dave.id, state: 'IN_PROGRESS' } }), 1);
    eq('F19 the audit trail names the state transition',
      (await prisma.userAuditLog.findFirst({
        where: { agentId: dave.id, field: 'availabilityState', toValue: 'offline' },
        orderBy: { id: 'desc' },
      })).toValue, 'offline');
    // Legacy boolean shape still works.
    const legacy = await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { available: false } });
    eq('F20 the legacy available:false shape still works', legacy.status, 200);
    await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { available: true } });
    // Unknown state refused.
    eq('F21 an unknown state is a 400',
      (await req('/api/workload/availability', { method: 'POST', token: webToken, body: { state: 'busy' } })).status, 400);
    // Back online for the handover tests below.
    await req('/api/workload/availability', { method: 'POST', token: adminToken, body: { state: 'online', agentId: dave.id } });
  }

  /* ==================================================================== */
  /* G. Routing-rule compatibility                                        */
  /* ==================================================================== */
  console.log('\n--- G. routing rules vs the pool ---');
  {
    // A keyword no seeded rule claims, at the top precedence, so THIS rule
    // makes the routing decision.
    const rule = await prisma.routingRule.create({
      data: {
        name: 'Pool VPN rule', keywords: 'poolsuitevpn', teamId: net.id,
        minimumSkillLevel: 2, priority: 1, isActive: true,
      },
    });
    // In-group with skill >= 2 and online: alice (dave is online but the rule
    // bar is 2 — both qualify; workload decides deterministically).
    const decision = await assignmentEngine.assign(
      { category: 'Software', priority: 'low', text: 'the poolsuitevpn connection drops' },
      prisma, QUIET
    );
    eq('G1 the routing rule still fixes the group', decision.teamId, net.id);
    eq('G2 the rule name travels with the decision', decision.ruleName, 'Pool VPN rule');
    check('G3 the chosen agent satisfies the rule bar AND the pool state',
      decision.agent.skillLevel >= 2 && decision.agent.isAvailable && decision.agent.isActive);

    // Alice goes offline: the rule keeps routing to net, and the pool offers
    // only the skill-2 ONLINE members inside the group — dave (2 open) and
    // the section-F web agent (0 open, so the workload rule picks it); the
    // skill-1 members (bob, carol) and the offline alice are all out.
    await poolService.applyAvailabilityState({ agentId: alice.id, state: 'offline', actor: admin });
    const second = await assignmentEngine.assign(
      { category: 'Software', priority: 'low', text: 'poolsuitevpn is down again' },
      prisma, QUIET
    );
    eq('G4 the rule-routed group is unchanged', second.teamId, net.id);
    check('G5 the pick is an online, skill-2 group member — never the offline alice',
      second.agent && second.agent.id !== alice.id
      && second.agent.skillLevel >= 2 && second.agent.isAvailable && second.agent.isActive
      && second.agent.teamId === net.id && second.crossTeam === false);

    // A rule naming an OFFLINE preferred agent falls back to the pool.
    const preferredRule = await prisma.routingRule.create({
      data: {
        name: 'Pool preferred rule', keywords: 'printer', teamId: net.id,
        preferredAgentId: alice.id, priority: 11, isActive: true,
      },
    });
    const third = await assignmentEngine.assign(
      { category: 'Hardware', priority: 'low', text: 'printer jammed' },
      prisma, QUIET
    );
    eq('G6 an offline preferred agent is not used', third.preferredAgentUsed, false);
    check('G7 the fallback pick is an online pool member',
      third.agent && third.agent.isAvailable && third.agent.isActive);
    await poolService.applyAvailabilityState({ agentId: alice.id, state: 'online', actor: admin });
    await prisma.routingRule.delete({ where: { id: rule.id } });
    await prisma.routingRule.delete({ where: { id: preferredRule.id } });
  }

  /* ==================================================================== */
  /* H. Handover compatibility                                            */
  /* ==================================================================== */
  console.log('\n--- H. handovers and the availability state ---');
  {
    const hTicket = await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'NEW' });
    const created = await handoverService.createRequest({
      ticket: hTicket, actor: alice, targetAgentId: dave.id, note: 'going on leave',
    });
    eq('H1 a request to an online agent is accepted', created.ok, true);
    eq('H2 the expiry clock is running for an online recipient',
      Boolean(created.request.expiresAt) && !created.request.pausedAt, true);

    // Dave goes offline: the clock pauses, nothing is cancelled.
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'offline', actor: admin });
    await handoverService.onAvailabilityChanged(dave.id, false);
    const paused = await prisma.handoverRequest.findUnique({ where: { id: created.request.id } });
    eq('H3 the clock pauses while the recipient is offline', Boolean(paused.pausedAt) && paused.expiresAt === null, true);
    check('H4 the remaining time is preserved', paused.remainingMs === null || paused.remainingMs > 0);

    // Dave comes back online: the clock resumes.
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'online', actor: admin });
    await handoverService.onAvailabilityChanged(dave.id, true);
    const resumed = await prisma.handoverRequest.findUnique({ where: { id: created.request.id } });
    eq('H5 the clock resumes when they are back', resumed.pausedAt === null && Boolean(resumed.expiresAt), true);

    // A request raised while the target is unavailable (but active) starts
    // paused. The offer itself must come from an administrator: the policy
    // only lets an admin hand work to somebody who is not accepting tickets.
    // An OFFLINE target is refused outright — deactivated accounts receive
    // nothing, so there is nothing to pause.
    await poolService.applyAvailabilityState({ agentId: bob.id, state: 'unavailable', actor: admin });
    const hTicket2 = await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'NEW' });
    // A fresh row: the in-memory admin fixture predates its role promotion.
    const adminRow = await prisma.agent.findUnique({ where: { id: admin.id } });
    const created2 = await handoverService.createRequest({
      ticket: hTicket2, actor: adminRow, targetAgentId: bob.id, note: 'target is away',
    });
    eq('H6 a request to an unavailable agent starts paused',
      created2.ok && Boolean(created2.request.pausedAt) && created2.request.expiresAt === null, true);
    const refused = await handoverService.createRequest({
      ticket: hTicket2, actor: admin, targetAgentId: dave.id, note: 'target is offline',
    });
    eq('H7 a request to an offline agent is refused outright', refused.ok, false);

    await poolService.applyAvailabilityState({ agentId: bob.id, state: 'online', actor: admin });
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'online', actor: admin });
    await prisma.handoverRequest.deleteMany({ where: { ticketId: { in: [hTicket.id, hTicket2.id] } } });
  }

  /* ==================================================================== */
  /* I. Historical SLA attribution is untouched                           */
  /* ==================================================================== */
  console.log('\n--- I. SLA attribution ---');
  {
    const slaTicket = await mkTicket({ assignedAgentId: alice.id, teamId: net.id, state: 'NEW' });
    const cycle = await slaService.startCycle(slaTicket, { cycleNumber: 1 });
    eq('I1 the cycle froze the owner at start', cycle.assignedAgentId, alice.id);
    eq('I2 the cycle froze the group at start', cycle.teamId, net.id);
    const eventsBefore = await prisma.ticketSlaEvent.count({ where: { ticketId: slaTicket.id } });

    // Flip every availability state there is — history must not budge.
    await poolService.applyAvailabilityState({ agentId: alice.id, state: 'offline', actor: admin });
    await poolService.applyAvailabilityState({ agentId: alice.id, state: 'online', actor: admin });
    await poolService.applyAvailabilityState({ agentId: alice.id, state: 'unavailable', actor: admin });
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'offline', actor: admin });
    await poolService.applyAvailabilityState({ agentId: dave.id, state: 'online', actor: admin });

    const after = await prisma.ticketSlaCycle.findFirst({ where: { ticketId: slaTicket.id, cycleNumber: 1 } });
    eq('I3 the frozen owner attribution is unchanged', after.assignedAgentId, alice.id);
    eq('I4 the frozen group attribution is unchanged', after.teamId, net.id);
    eq('I5 no new cycle appeared', await prisma.ticketSlaCycle.count({ where: { ticketId: slaTicket.id } }), 1);
    eq('I6 no SLA events were written by availability changes',
      await prisma.ticketSlaEvent.count({ where: { ticketId: slaTicket.id } }), eventsBefore);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  await prisma.$disconnect().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(`SUITE ERROR: ${err.stack || err}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
