// Who may assign what, to whom.
//
// Every assignment/reassignment path in the API funnels through this module,
// so the rules cannot be bypassed by calling a different endpoint directly.
// The frontend only *reflects* these rules — it never defines them.
//
// Rules (requirements 4 and 5):
//
//   AGENT may reassign a ticket when ALL of:
//     - the ticket is currently assigned to them
//     - the ticket is not CLOSED
//     - the target agent exists and is active (available)
//     - the target agent is in the ticket's assignment group
//     - the target agent is not the current assignee
//
//   ADMIN may assign any open ticket to any active agent, across groups, and
//   may deliberately assign to an unavailable agent.
//
// "Available" means the account is enabled (isActive) AND the person is
// currently accepting work (isAvailable). Both are shown on the Agents admin
// screen and both are respected by the assignment engine.
const prisma = require('../lib/prisma');
const { OPEN_STATES } = require('../states');
const { STAFF_ROLES } = require('./userService');

/**
 * Workload = tickets that still need work.
 *
 * NEW and IN_PROGRESS count. CLOSED never counts. RESOLVED does NOT count:
 * the work is done and the ticket is only awaiting closure, so it must not
 * make an agent look busier than they are. This matches OPEN_STATES, which
 * the dashboard and the assignment engine already use, so every workload
 * figure in the product comes from one definition.
 */
const WORKLOAD_STATES = OPEN_STATES; // ['NEW', 'IN_PROGRESS']

function isAdmin(actor) {
  return Boolean(actor && actor.role === 'admin');
}

/** Open workload for one agent. */
async function workloadFor(agentId, client = prisma) {
  return client.ticket.count({
    where: { assignedAgentId: agentId, state: { in: WORKLOAD_STATES } },
  });
}

/** Open workload for many agents at once, as a Map(agentId -> count). */
async function workloadByAgent(agentIds, client = prisma) {
  if (!agentIds.length) return new Map();
  const rows = await client.ticket.groupBy({
    by: ['assignedAgentId'],
    _count: { _all: true },
    where: {
      assignedAgentId: { in: agentIds },
      state: { in: WORKLOAD_STATES },
    },
  });
  const map = new Map(agentIds.map((id) => [id, 0]));
  for (const r of rows) map.set(r.assignedAgentId, r._count._all);
  return map;
}

const SKILL_LABELS = { 1: 'Junior', 2: 'Mid', 3: 'Senior' };
function skillLabel(level) {
  return SKILL_LABELS[level] || `L${level}`;
}

/**
 * Candidate agents for (re)assigning this ticket, with everything the UI needs
 * to show: availability, workload, skill and whether they may be selected.
 *
 * An agent sees only their own group. An admin sees every active agent plus
 * unavailable ones, which they alone may select.
 */
async function listCandidates(ticket, actor, client = prisma) {
  const admin = isAdmin(actor);

  // Agents an admin can reach: every staff member. An agent: the ticket's
  // group only. USER-role accounts never appear — they cannot hold tickets.
  const where = admin
    ? { role: { in: STAFF_ROLES } }
    : { teamId: ticket.teamId, role: { in: STAFF_ROLES } };
  const agents = await client.agent.findMany({
    where,
    include: { team: true },
    orderBy: [{ isActive: 'desc' }, { isAvailable: 'desc' }, { name: 'asc' }],
  });

  const counts = await workloadByAgent(agents.map((a) => a.id), client);

  return agents
    .map((a) => {
      const decision = checkTarget(ticket, actor, a);
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        skillLevel: a.skillLevel,
        skillLabel: skillLabel(a.skillLevel),
        available: a.isActive && a.isAvailable,
        teamId: a.teamId,
        assignmentGroup: a.team ? a.team.name : null,
        assignmentGroupKey: a.team ? a.team.key : null,
        openTickets: counts.get(a.id) || 0,
        isCurrentAssignee: a.id === ticket.assignedAgentId,
        selectable: decision.ok,
        reason: decision.ok ? null : decision.error,
      };
    })
    .sort((a, b) => {
      // Prefer available agents, then the lightest workload. An unavailable
      // agent is never the first suggestion, even for an admin.
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (a.selectable !== b.selectable) return a.selectable ? -1 : 1;
      return a.openTickets - b.openTickets;
    });
}

/**
 * May `actor` move `ticket` to `target`?
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function checkTarget(ticket, actor, target) {
  if (!target) {
    return { ok: false, status: 404, error: 'Agent not found' };
  }
  if (ticket.state === 'CLOSED') {
    return { ok: false, status: 400, error: 'Cannot reassign a closed ticket' };
  }
  if (target.id === ticket.assignedAgentId) {
    return { ok: false, status: 400, error: 'Ticket is already assigned to this agent' };
  }

  const admin = isAdmin(actor);

  // A USER-role account never holds tickets, whoever is asking.
  if (!STAFF_ROLES.includes(target.role)) {
    return {
      ok: false,
      status: 400,
      error: `${target.name} is not a helpdesk agent`,
    };
  }
  // A disabled account can never receive work — not even from an admin.
  if (!target.isActive) {
    return {
      ok: false,
      status: 400,
      error: `${target.name}'s account is deactivated`,
    };
  }
  // Being unavailable is a softer state: an admin may override it deliberately.
  if (!target.isAvailable && !admin) {
    return {
      ok: false,
      status: 400,
      error: `${target.name} is currently unavailable`,
    };
  }

  if (admin) return { ok: true };

  // --- agent-only rules ------------------------------------------------
  if (!actor) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  if (ticket.assignedAgentId !== actor.id) {
    return {
      ok: false,
      status: 403,
      error: 'You can only reassign tickets assigned to you',
    };
  }
  if (!ticket.teamId) {
    return {
      ok: false,
      status: 403,
      error: 'This ticket has no assignment group — an administrator must route it first',
    };
  }
  if (target.teamId !== ticket.teamId) {
    return {
      ok: false,
      status: 403,
      error: 'You can only reassign within your own assignment group',
    };
  }
  return { ok: true };
}

/**
 * May `actor` change this ticket's assignment group?
 * Admin-only: an agent moving tickets between unrelated teams is exactly the
 * behaviour requirement 4 forbids.
 */
function checkGroupChange(ticket, actor) {
  if (!isAdmin(actor)) {
    return {
      ok: false,
      status: 403,
      error: 'Only an administrator can change the assignment group',
    };
  }
  if (ticket.state === 'CLOSED') {
    return { ok: false, status: 400, error: 'Cannot change the group of a closed ticket' };
  }
  return { ok: true };
}

module.exports = {
  WORKLOAD_STATES,
  isAdmin,
  workloadFor,
  workloadByAgent,
  listCandidates,
  checkTarget,
  checkGroupChange,
  skillLabel,
};
