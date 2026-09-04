// Multi-group membership for Assignment Groups (the Team table).
//
// The TeamMembership join table is the source of truth for "who belongs to
// which assignment group, and who leads it". The legacy single-column
// `Agent.teamId` is kept in sync here during the transition phase because
// routing/workload still read it; the next phase flips readers over to this
// table and drops the column.
//
// Business rules:
//   - an agent belongs to at most MAX_GROUPS_PER_AGENT groups
//   - an agent may lead several groups at once (lead status is per-membership)
//   - a group has exactly one lead; promoting a new lead demotes the old one
//   - only an existing member can become a group's lead
//   - leading a group does NOT grant the ADMIN role
//
// Enforcement: max-3 cannot be expressed as a table constraint in SQLite,
// so it is enforced here (and only here). The one-lead-per-group rule is
// additionally guarded in the database by the partial unique index
// `TeamMembership_single_lead` created by the migration (and re-created by
// `ensureSingleLeadIndex` for databases updated via `prisma db push`).
const prisma = require('../lib/prisma');

const MAX_GROUPS_PER_AGENT = 3;

class GroupMembershipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GroupMembershipError';
    this.code = code;
  }
}

function notFound(kind) {
  return new GroupMembershipError('NOT_FOUND', `${kind} does not exist`);
}

/** Number of groups the agent currently belongs to. */
async function countGroupsForAgent(agentId, client = prisma) {
  return client.teamMembership.count({ where: { agentId } });
}

/**
 * The agent's effective group set: the union of its legacy primary-group
 * pointer (Agent.teamId) and its TeamMembership rows, deduplicated.
 *
 * During the transition phase Agent.teamId is always mirrored by a membership
 * row (the migration backfills it and every write below keeps it in sync), so
 * this is normally identical to the membership rows. The union guard keeps the
 * max-groups rule correct even on a half-migrated database, and guarantees the
 * primary pointer is never counted twice.
 */
async function getEffectiveGroupIds(agentId, client = prisma) {
  const agent = await client.agent.findUnique({ where: { id: agentId }, select: { teamId: true } });
  if (!agent) return [];
  const rows = await client.teamMembership.findMany({ where: { agentId }, select: { teamId: true } });
  const ids = new Set(rows.map((r) => r.teamId));
  if (agent.teamId !== null) ids.add(agent.teamId);
  return [...ids];
}

/** Number of distinct groups in the agent's effective group set. */
async function countEffectiveGroups(agentId, client = prisma) {
  return (await getEffectiveGroupIds(agentId, client)).length;
}

/** Is (agentId) a member of (teamId)? */
async function isMember(agentId, teamId, client = prisma) {
  return Boolean(
    await client.teamMembership.findUnique({
      where: { agentId_teamId: { agentId, teamId } },
      select: { id: true },
    })
  );
}

/** All memberships for one agent, newest first. */
async function listAgentMemberships(agentId, client = prisma) {
  return client.teamMembership.findMany({
    where: { agentId },
    orderBy: { id: 'desc' },
    include: { team: true },
  });
}

/** All memberships for one group, leads first, then by member id. */
async function listTeamMembers(teamId, client = prisma) {
  return client.teamMembership.findMany({
    where: { teamId },
    orderBy: [{ isLead: 'desc' }, { agentId: 'asc' }],
    include: { agent: true },
  });
}

/** The group's lead membership row, or null if none is set yet. */
async function groupLead(teamId, client = prisma) {
  return client.teamMembership.findFirst({ where: { teamId, isLead: true } });
}

/**
 * Add an agent to an assignment group.
 *
 * Rules enforced (transactionally):
 *   - the (agent, group) pair must not already exist
 *   - an agent belongs to at most MAX_GROUPS_PER_AGENT groups
 *   - if arriving as a lead, the existing lead of the group is demoted first
 *   - while the legacy Agent.teamId still exists, a group-less agent's
 *     primary-group pointer is set to this group so routing/workload keep
 *     working during the transition.
 *
 * Throws GroupMembershipError with code NOT_FOUND | ALREADY_MEMBER | MAX_GROUPS_REACHED.
 */
async function addMember({ agentId, teamId, isLead = false }, client = prisma) {
  return client.$transaction(async (tx) => {
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true, teamId: true } });
    if (!agent) throw notFound('agent');
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) throw notFound('group');
    // The primary group (Agent.teamId) already counts as a membership: it is
    // represented by the legacy pointer itself, so re-adding it — even before its
    // mirror TeamMembership row exists — is a duplicate,never an extra group.

    if (
      agent.teamId === teamId ||
      await tx.teamMembership.findUnique({ where: { agentId_teamId: { agentId, teamId } }, select: { id: true } })
    ) {
      throw new GroupMembershipError('ALREADY_MEMBER', 'the agent is already a member of that assignment group');
    }
    // Effective (deduplicated) group count: the membership rows plus the
    // legacy primary pointer Agent.teamId. The backfill and the pointer sync
    // below normally mean teamId already has a membership row, so this equals
    // the row count; the union guard makes the rule correct even on a
    // half-migrated database and never counts the primary group twice.
    const count = await tx.teamMembership.count({ where: { agentId } });
    const primaryHasRow =
      agent.teamId === null ||
      Boolean(
        await tx.teamMembership.findUnique({
          where: { agentId_teamId: { agentId, teamId: agent.teamId } },
          select: { id: true },
        })
      );
    const effectiveCount = count + (primaryHasRow ? 0 : 1);
    if (effectiveCount >= MAX_GROUPS_PER_AGENT) {
      throw new GroupMembershipError(
        'MAX_GROUPS_REACHED',
        `an agent can belong to at most ${MAX_GROUPS_PER_AGENT} assignment groups`
      );
    }
    if (isLead) {
      await tx.teamMembership.updateMany({ where: { teamId, isLead: true }, data: { isLead: false } });
    }
    const row = await tx.teamMembership.create({ data: { agentId, teamId, isLead } });
    if (agent.teamId === null) {
      // Transition only: keep the legacy primary-group pointer usable.
      await tx.agent.update({ where: { id: agentId }, data: { teamId } });
    }
    return row;
  });
}

/**
 * Set (or clear) an agent's lead status within a group.
 *
 * Rules enforced:
 *   - a lead must already be a member of the group (NOT_A_MEMBER)
 *   - a group has exactly one lead: promoting demotes the previous lead,
 *     transactionally, with the partial unique index as a final backstop.
 *
 * Throws GroupMembershipError with code NOT_A_MEMBER.
 */
async function setLead({ agentId, teamId, isLead = true }, client = prisma) {
  return client.$transaction(async (tx) => {
    const row = await tx.teamMembership.findUnique({ where: { agentId_teamId: { agentId, teamId } } });
    if (!row) {
      throw new GroupMembershipError('NOT_A_MEMBER', 'a group lead must first be a member of that assignment group');
    }
    if (isLead) {
      await tx.teamMembership.updateMany({
        where: { teamId, isLead: true, id: { not: row.id } },
        data: { isLead: false },
      });
    }
    return tx.teamMembership.update({ where: { id: row.id }, data: { isLead } });
  });
}

/**
 * Remove an agent from a group.
 *
 * A group's lead cannot be removed this way (LEAD_REMOVAL_FORBIDDEN): the
 * lead must be demoted (or another member promoted) first, so a group is
 * never left without its single-lead invariant breaking visible transitions.
 *
 * Throws GroupMembershipError with code NOT_A_MEMBER | LEAD_REMOVAL_FORBIDDEN.
 */
async function removeMember({ agentId, teamId }, client = prisma) {
  return client.$transaction(async (tx) => {
    const row = await tx.teamMembership.findUnique({ where: { agentId_teamId: { agentId, teamId } } });
    if (!row) throw new GroupMembershipError('NOT_A_MEMBER', 'no such membership');
    if (row.isLead) {
      throw new GroupMembershipError(
        'LEAD_REMOVAL_FORBIDDEN',
        'a group lead must be demoted (or another member promoted) before the membership can be removed'
      );
    }
    await tx.teamMembership.delete({ where: { id: row.id } });
    // Transition only: repoint the legacy primary-group pointer when it aimed
    // at the group being left.
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { teamId: true } });
    if (agent && agent.teamId === teamId) {
      const left = await tx.teamMembership.findMany({
        where: { agentId },
        orderBy: { id: 'asc' },
        take: 1,
        select: { teamId: true },
      });
      await tx.agent.update({ where: { id: agentId }, data: { teamId: left.length ? left[0].teamId : null } });
    }
    return row;
  });
}

/**
 * Database-level guard for "one lead per group": a partial unique index.
 *
 * Prisma cannot express partial indexes for SQLite, so this is created by the
 * migration for migrated databases, and re-created here for databases updated
 * via `prisma db push` (which does not know the index, and would otherwise not
 * have it). Idempotent.
 */
async function ensureSingleLeadIndex(client = prisma) {
  // `isLead` is BOOLEAN on Postgres but a 0/1 INTEGER on SQLite, so compare to
  // the boolean literal `true` — valid in both dialects. (Prisma maps the model
  // field to Postgres BOOLEAN / SQLite INTEGER.)
  await client.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "TeamMembership_single_lead" ON "TeamMembership"("teamId") WHERE "isLead" = true'
  );
}

/**
 * Migrate the legacy single-group layout: every agent with a non-null
 * Agent.teamId gets exactly one TeamMembership row for that group.
 *
 * The legacy schema stores no lead information, so all migrated rows start as
 * plain members (isLead = false); leads are appointed in the next phase.
 *
 * Idempotent: existing (agentId, teamId) pairs are never duplicated, never
 * deleted and never rewritten. No user, group, ticket or ticket assignment
 * group is touched. Returns a tally.
 */
async function backfillFromLegacyTeamId(client = prisma) {
  const agents = await client.agent.findMany({
    where: { teamId: { not: null } },
    select: { id: true, teamId: true },
  });
  let created = 0;
  let existing = 0;
  for (const a of agents) {
    const dup = await client.teamMembership.findUnique({
      where: { agentId_teamId: { agentId: a.id, teamId: a.teamId } },
      select: { id: true },
    });
    if (dup) {
      existing += 1;
      continue;
    }
    await client.teamMembership.create({
      data: { agentId: a.id, teamId: a.teamId, isLead: false },
    });
    created += 1;
  }
  return { total: agents.length, created, existing };
}

module.exports = {
  MAX_GROUPS_PER_AGENT,
  GroupMembershipError,
  countGroupsForAgent,
  getEffectiveGroupIds,
  countEffectiveGroups,
  isMember,
  listAgentMemberships,
  listTeamMembers,
  groupLead,
  addMember,
  setLead,
  removeMember,
  ensureSingleLeadIndex,
  backfillFromLegacyTeamId,
};