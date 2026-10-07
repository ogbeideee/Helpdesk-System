// TeamMembership is the only stored group membership, including primary and
// supporting status. Agent teamId/team are derived DTO compatibility fields.
// Agent row locks serialize membership changes; partial unique indexes protect
// one primary per agent and one lead per group. Maximum three groups per agent.
const prisma = require('../lib/prisma');
const auditService = require('./auditService');

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

/** The canonical assignment-group ids for an agent. */
async function getEffectiveGroupIds(agentId, client = prisma) {
  const rows = await client.teamMembership.findMany({ where: { agentId }, select: { teamId: true } });
  return rows.map(row => row.teamId);
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
 *   - the first membership becomes primary.
 *
 * Throws GroupMembershipError with code NOT_FOUND | ALREADY_MEMBER | MAX_GROUPS_REACHED.
 */
async function addMember({ agentId, teamId, isLead = false, actor = null }, client = prisma) {
  return client.$transaction(async (tx) => {
    await lockAgent(agentId, tx);
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true, name: true, email: true } });
    if (!agent) throw notFound('agent');
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, key: true } });
    if (!team) throw notFound('group');
    if (await isMember(agentId, teamId, tx)) throw new GroupMembershipError('ALREADY_MEMBER', 'the agent is already a member of that assignment group');
    const count = await countGroupsForAgent(agentId, tx);
    if (count >= MAX_GROUPS_PER_AGENT) throw new GroupMembershipError('MAX_GROUPS_REACHED', `an agent can belong to at most ${MAX_GROUPS_PER_AGENT} assignment groups`);
    if (isLead) {
      await tx.teamMembership.updateMany({ where: { teamId, isLead: true }, data: { isLead: false } });
    }
    const row = await tx.teamMembership.create({ data: { agentId, teamId, isLead, isPrimary: count === 0 } });
    await auditService.record(tx, {
      action: 'group.member_added',
      entityType: 'Team',
      entityId: teamId,
      entityLabel: team.name,
      actor,
      to: { member: agent.email, isLead },
      description: `${agent.name} added to assignment group ${team.name}${isLead ? ' as lead' : ''}`,
      metadata: { agentId, key: team.key },
    });
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
async function setLead({ agentId, teamId, isLead = true, actor = null }, client = prisma) {
  return client.$transaction(async (tx) => {
    const row = await tx.teamMembership.findUnique({
      where: { agentId_teamId: { agentId, teamId } },
      include: { agent: { select: { name: true, email: true } }, team: { select: { name: true, key: true } } },
    });
    if (!row) {
      throw new GroupMembershipError('NOT_A_MEMBER', 'a group lead must first be a member of that assignment group');
    }
    if (isLead) {
      await tx.teamMembership.updateMany({
        where: { teamId, isLead: true, id: { not: row.id } },
        data: { isLead: false },
      });
    }
    const updated = await tx.teamMembership.update({ where: { id: row.id }, data: { isLead } });
    await auditService.record(tx, {
      action: 'group.lead_changed',
      entityType: 'Team',
      entityId: teamId,
      entityLabel: row.team.name,
      actor,
      from: { isLead: row.isLead },
      to: { isLead },
      description:
        `${row.agent.name} ${isLead ? 'promoted to' : 'demoted from'} lead of ${row.team.name}`,
      metadata: { agentId, key: row.team.key },
    });
    return updated;
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
async function removeMember({ agentId, teamId, actor = null }, client = prisma) {
  return client.$transaction(async (tx) => {
    await lockAgent(agentId, tx);
    const row = await tx.teamMembership.findUnique({
      where: { agentId_teamId: { agentId, teamId } },
      include: { agent: { select: { name: true, email: true } }, team: { select: { name: true, key: true } } },
    });
    if (!row) throw new GroupMembershipError('NOT_A_MEMBER', 'no such membership');
    if (row.isLead) {
      throw new GroupMembershipError(
        'LEAD_REMOVAL_FORBIDDEN',
        'a group lead must be demoted (or another member promoted) before the membership can be removed'
      );
    }
    await tx.teamMembership.delete({ where: { id: row.id } });
    await auditService.record(tx, {
      action: 'group.member_removed',
      entityType: 'Team',
      entityId: teamId,
      entityLabel: row.team.name,
      actor,
      from: { member: row.agent.email },
      description: `${row.agent.name} removed from assignment group ${row.team.name}`,
      metadata: { agentId, key: row.team.key },
    });
    if (row.isPrimary) {
      const next = await tx.teamMembership.findFirst({ where: { agentId }, orderBy: { id: 'asc' } });
      if (next) await tx.teamMembership.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return row;
  });
}

/**
 * Is this agent a "supporting" member of the given team?
 * An agent is a supporting member when they belong to the team (via
 * TeamMembership) but their primary group (Agent.teamId) is a different team.
 */
async function isSupportingMember(agentId, teamId, client = prisma) {
  const membership = await client.teamMembership.findUnique({ where: { agentId_teamId: { agentId, teamId } } });
  return Boolean(membership && !membership.isPrimary);
}

async function lockAgent(agentId, client) {
  await client.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
}

// Called by the Agent DTO adapter inside the caller's transaction. There is no
// primary-group scalar on Agent: the membership row owns this decision.
async function setPrimary({ agentId, teamId }, client = prisma) {
  await lockAgent(agentId, client);
  const rows = await client.teamMembership.findMany({ where: { agentId }, orderBy: { id: 'asc' } });
  const current = rows.find(row => row.isPrimary);
  if (current?.teamId === teamId) return;
  if (teamId === null) {
    if (current?.isLead) throw new GroupMembershipError('LEAD_REMOVAL_FORBIDDEN', 'Demote the group lead before clearing their primary group');
    if (current) await client.teamMembership.delete({ where: { id: current.id } });
    const next = rows.find(row => row.id !== current?.id);
    if (next) await client.teamMembership.update({ where: { id: next.id }, data: { isPrimary: true } });
    return;
  }
  const existing = rows.find(row => row.teamId === teamId);
  if (!existing && current) {
    if (current.isLead) throw new GroupMembershipError('LEAD_REMOVAL_FORBIDDEN', 'Demote the group lead before replacing their primary group');
    await client.teamMembership.delete({ where: { id: current.id } });
  } else if (!existing && rows.length >= MAX_GROUPS_PER_AGENT) throw new GroupMembershipError('MAX_GROUPS_REACHED', 'Remove a membership before adding another primary group');
  await client.teamMembership.updateMany({ where: { agentId, isPrimary: true }, data: { isPrimary: false } });
  if (existing) await client.teamMembership.update({ where: { id: existing.id }, data: { isPrimary: true } });
  else await client.teamMembership.create({ data: { agentId, teamId, isPrimary: true } });
}

module.exports = {
  MAX_GROUPS_PER_AGENT,
  setPrimary,
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
  isSupportingMember,
};
