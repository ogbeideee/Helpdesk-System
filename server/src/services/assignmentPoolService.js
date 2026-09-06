// Assignment pool + agent availability state.
//
// AVAILABILITY MODEL
// ------------------
// The product deliberately has ONE user record (Agent) and no presence
// infrastructure, so the availability state is derived from the two existing
// columns that every enforcement point already reads:
//
//   online      isActive && isAvailable   — signed-in account accepting work
//   unavailable isActive && !isAvailable  — active but not accepting new work
//                                           (an administrator may still assign
//                                           to them deliberately)
//   offline     !isActive                 — account deactivated: cannot sign
//                                           in and never receives work
//
// These are the exact combinations the assignment engine, the manual
// assignment policy, the claim check and the handover clock already act on,
// so the state model adds vocabulary — never a second source of truth.
//
// TRANSITIONS
// -----------
// applyAvailabilityState() writes ONLY these columns plus the audit row. It
// never reassigns tickets and never touches SLA data: an agent going offline
// keeps their tickets, automatic assignment simply stops picking them, and
// historical SLA attribution (frozen onto the cycle at start) is unaffected.
// The one explicit handover interaction is the existing clock hook: waiting
// handover requests pause while the recipient is not online and resume when
// they come back — the behaviour handoverService already implements.
//
// THE POOL
// --------
// For each active assignment group, the pool is every staff agent whose
// effective membership covers that group: a TeamMembership row (the source of
// truth for multi-group) OR the legacy primary-group pointer Agent.teamId,
// which the membership service keeps in sync and which the assignment engine
// still reads. The maximum-membership rule (MAX_GROUPS_PER_AGENT) is enforced
// where memberships change, so a pool can never contain an agent who is over
// the limit — this module only reads.
const prisma = require('../lib/prisma');
const { OPEN_STATES } = require('../states');
const { skillLabel } = require('./assignmentPolicy');

const AVAILABILITY_STATES = ['online', 'unavailable', 'offline'];

/** The column values each availability state stands for. */
const STATE_COLUMNS = {
  online: { isActive: true, isAvailable: true },
  unavailable: { isActive: true, isAvailable: false },
  offline: { isActive: false, isAvailable: false },
};

/** Stable display/selection order: online first, offline last. */
const STATE_RANK = { online: 0, unavailable: 1, offline: 2 };

function isValidState(state) {
  return AVAILABILITY_STATES.includes(state);
}

/** Pure derivation — the single definition of "what state is this agent in?" */
function availabilityStateOf(agent) {
  if (!agent || !agent.isActive) return 'offline';
  return agent.isAvailable ? 'online' : 'unavailable';
}

function columnsForState(state) {
  if (!isValidState(state)) {
    throw new Error(`unknown availability state "${state}"`);
  }
  return { ...STATE_COLUMNS[state] };
}

/**
 * Move one agent to an availability state. Caller-authored rules live in the
 * route (who may change whom, and the self-service unavailability guards);
 * this helper owns the write, the audit row and nothing else.
 *
 * @returns {{ agent, from, to }} the updated agent and the state transition
 */
async function applyAvailabilityState({ agentId, state, actor = null, note = null, client = prisma }) {
  const columns = columnsForState(state);
  const existing = await client.agent.findUnique({ where: { id: agentId } });
  if (!existing) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  const from = availabilityStateOf(existing);
  const agent = await client.agent.update({ where: { id: agentId }, data: columns });

  await client.userAuditLog.create({
    data: {
      agentId,
      action: 'availability_changed',
      field: 'availabilityState',
      fromValue: from,
      toValue: state,
      actor: actor ? `${actor.name} <${actor.email}>` : 'system',
      note:
        note ||
        (state === 'offline'
          ? 'Account taken offline — no tickets were reassigned'
          : `Availability set to ${state}`),
    },
  });

  return { agent, from, to: state };
}

/* ==================================================================== */
/* The pool                                                             */
/* ==================================================================== */

const STAFF_FILTER = () => {
  const { STAFF_ROLES } = require('./userService');
  return { role: { in: STAFF_ROLES } };
};

/**
 * Build the assignment pool for every active group.
 *
 * Deterministic by construction: groups sort by key, members sort by
 * availability state, then lead status, then name, then id.
 *
 * "Eligible" means the agent would be picked by automatic assignment right
 * now: online, skilled enough for the group's current routing bar, and under
 * the workload cap. It is the same test the engine applies, restated for
 * display — never a second rule.
 */
async function listGroupPools(client = prisma) {
  const assignmentEngine = require('./assignmentEngine');
  const config = assignmentEngine.loadConfig();
  const cap = config.maxActiveTicketsPerAgent || 25;
  // The group's routing skill bar: the lowest minimum skill among the routing
  // categories that map to this group (the same figure /api/assignment-groups
  // shows), 1 when no category maps to it.
  const minSkillByGroup = new Map();
  for (const c of Object.values(config.categories || {})) {
    if (!c || !c.group) continue;
    const level = Number.isInteger(c.minSkillLevel) ? c.minSkillLevel : 1;
    minSkillByGroup.set(c.group, Math.min(minSkillByGroup.get(c.group) ?? level, level));
  }

  const [teams, memberships, agents] = await Promise.all([
    client.team.findMany({ where: { isActive: true }, orderBy: { key: 'asc' } }),
    client.teamMembership.findMany({ select: { agentId: true, teamId: true, isLead: true } }),
    client.agent.findMany({
      where: STAFF_FILTER(),
      select: { id: true, name: true, email: true, role: true, skillLevel: true, isActive: true, isAvailable: true, teamId: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  const staffIds = agents.map((a) => a.id);
  const teamIds = teams.map((t) => t.id);
  const [openByAgent, openByTeam, unassignedByTeam] = await Promise.all([
    staffIds.length
      ? client.ticket.groupBy({
          by: ['assignedAgentId'],
          _count: { _all: true },
          where: { assignedAgentId: { in: staffIds }, state: { in: OPEN_STATES } },
        })
      : Promise.resolve([]),
    teamIds.length
      ? client.ticket.groupBy({
          by: ['teamId'],
          _count: { _all: true },
          where: { teamId: { in: teamIds }, state: { in: OPEN_STATES } },
        })
      : Promise.resolve([]),
    teamIds.length
      ? client.ticket.groupBy({
          by: ['teamId'],
          _count: { _all: true },
          where: { teamId: { in: teamIds }, state: { in: OPEN_STATES }, assignedAgentId: null },
        })
      : Promise.resolve([]),
  ]);

  const loadOf = new Map(staffIds.map((id) => [id, 0]));
  for (const row of openByAgent) loadOf.set(row.assignedAgentId, row._count._all);
  const groupOpen = new Map(teamIds.map((id) => [id, 0]));
  for (const row of openByTeam) groupOpen.set(row.teamId, row._count._all);
  const groupUnassigned = new Map(teamIds.map((id) => [id, 0]));
  for (const row of unassignedByTeam) groupUnassigned.set(row.teamId, row._count._all);

  // agentId -> { teamId -> isLead } for quick lead lookup.
  const leadByPair = new Map();
  // agentId -> Set(teamId) for effective membership.
  const memberTeams = new Map();
  for (const m of memberships) {
    if (!leadByPair.has(m.agentId)) leadByPair.set(m.agentId, new Map());
    leadByPair.get(m.agentId).set(m.teamId, m.isLead);
    if (!memberTeams.has(m.agentId)) memberTeams.set(m.agentId, new Set());
    memberTeams.get(m.agentId).add(m.teamId);
  }

  return teams.map((team) => {
    const minSkillLevel = minSkillByGroup.get(team.key) || 1;
    const members = agents.filter(
      (a) => a.teamId === team.id || (memberTeams.get(a.id) || new Set()).has(team.id)
    );
    const cards = members
      .map((a) => {
        const availabilityState = availabilityStateOf(a);
        const openTickets = loadOf.get(a.id) || 0;
        return {
          id: a.id,
          name: a.name,
          email: a.email,
          role: a.role,
          skillLevel: a.skillLevel,
          skillLabel: skillLabel(a.skillLevel),
          availabilityState,
          // Would automatic assignment pick this agent for this group right
          // now? Exactly the engine's tests: online + skill + under the cap.
          autoEligible:
            availabilityState === 'online' &&
            a.skillLevel >= minSkillLevel &&
            openTickets < cap,
          isLead: Boolean((leadByPair.get(a.id) || new Map()).get(team.id)),
          isPrimaryGroup: a.teamId === team.id,
          openTickets,
        };
      })
      .sort(
        (x, y) =>
          STATE_RANK[x.availabilityState] - STATE_RANK[y.availabilityState] ||
          (x.isLead === y.isLead ? 0 : x.isLead ? -1 : 1) ||
          x.name.localeCompare(y.name) ||
          x.id - y.id
      );

    const leadCard = cards.find((c) => c.isLead) || null;
    const byState = (state) => cards.filter((c) => c.availabilityState === state);

    return {
      teamId: team.id,
      key: team.key,
      name: team.name,
      description: team.description,
      isDefault: team.isDefault,
      minSkillLevel,
      lead: leadCard ? { id: leadCard.id, name: leadCard.name } : null,
      agents: cards,
      pool: {
        total: cards.length,
        online: byState('online').length,
        unavailable: byState('unavailable').length,
        offline: byState('offline').length,
        eligible: cards.filter((c) => c.autoEligible).length,
      },
      load: {
        openTickets: groupOpen.get(team.id) || 0,
        unassignedTickets: groupUnassigned.get(team.id) || 0,
      },
    };
  });
}

/** One group's pool, or null when the group does not exist. */
async function getGroupPool(teamId, client = prisma) {
  const pools = await listGroupPools(client);
  return pools.find((p) => p.teamId === teamId) || null;
}

module.exports = {
  AVAILABILITY_STATES,
  STATE_COLUMNS,
  STATE_RANK,
  availabilityStateOf,
  columnsForState,
  isValidState,
  applyAvailabilityState,
  listGroupPools,
  getGroupPool,
};
