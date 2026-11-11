const prisma = require('../lib/prisma');
const auditService = require('./auditService');
const { FALLBACK_TEAM_KEY } = require('../teams');

const deletionCounts = { memberships: true, routingRules: true, tickets: true, originated: true, slaCycles: true };

function deletionInfo(group) {
  let reason = null;
  if (group.isDefault || group.key === FALLBACK_TEAM_KEY) reason = 'The default or fallback assignment group cannot be deleted.';
  else if (group._count.memberships) reason = 'Remove all primary and supporting memberships before deleting this group.';
  else if (group._count.routingRules) reason = 'Move or delete its routing rules before deleting this group, including inactive rules.';
  else if (group._count.tickets || group._count.originated || group._count.slaCycles) reason = 'This group is referenced by ticket or SLA history and cannot be deleted. Deactivate it instead.';
  return { deletable: !reason, deleteBlockedReason: reason };
}

async function deleteGroup(id, actor, client = prisma) {
  if (!actor || actor.role !== 'admin' || actor.isActive === false) throw Object.assign(new Error('Administrator access required'), { status: 403 });
  try {
    return await client.$transaction(async tx => {
      // FK inserts take a key-share lock: hold the group row so membership,
      // rule and ticket writers cannot slip between the checks and deletion.
      const rows = await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${id} FOR UPDATE`;
      if (!rows.length) throw Object.assign(new Error('Assignment group not found'), { status: 404 });
      const group = await tx.team.findUnique({ where: { id }, include: { _count: { select: deletionCounts } } });
      const info = deletionInfo(group);
      if (!info.deletable) throw Object.assign(new Error(info.deleteBlockedReason), { status: 409 });
      await tx.team.delete({ where: { id } });
      await auditService.record(tx, {
        action: 'group.deleted', entityType: 'Team', entityId: id, entityLabel: group.name, actor,
        from: { key: group.key, name: group.name, description: group.description },
        description: `Assignment group "${group.name}" deleted`,
      });
      return { deleted: true, id };
    });
  } catch (err) {
    if (err.code === 'P2003') throw Object.assign(new Error('This group is in use and cannot be deleted. Refresh and try again.'), { status: 409 });
    throw err;
  }
}

module.exports = { deletionCounts, deletionInfo, deleteGroup };
