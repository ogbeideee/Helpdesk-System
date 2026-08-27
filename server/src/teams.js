// Team routing + round-robin agent assignment.
const prisma = require('./lib/prisma');

const TEAM_DEFS = [
  { key: 'service_desk', name: 'Service Desk' },
  { key: 'accounts', name: 'Accounts & Access' },
  { key: 'software', name: 'Software & Applications' },
  { key: 'hardware', name: 'Hardware & Devices' },
];

// Category -> default owning team.
const CATEGORY_TEAM_KEY = {
  'Password Reset': 'accounts',
  Software: 'software',
  Hardware: 'hardware',
  'Inquiry / Help': 'service_desk',
};

const FALLBACK_TEAM_KEY = 'service_desk';

function teamKeyForCategory(category) {
  return CATEGORY_TEAM_KEY[category] || FALLBACK_TEAM_KEY;
}

async function ensureTeams(client = prisma) {
  for (const def of TEAM_DEFS) {
    await client.team.upsert({
      where: { key: def.key },
      create: def,
      update: { name: def.name },
    });
  }
}

async function getTeamByKey(key, client = prisma) {
  return client.team.findUnique({ where: { key } });
}

/**
 * Round-robin within a team: pick the active agent least recently assigned
 * (never-assigned agents first), then stamp them as just-assigned.
 */
async function pickAgentRoundRobin(teamId, client = prisma) {
  if (!teamId) return null;
  const { STAFF_ROLES } = require('./services/userService');
  const agent = await client.agent.findFirst({
    where: { teamId, isActive: true, isAvailable: true, role: { in: STAFF_ROLES } },
    orderBy: [{ lastAssignedAt: 'asc' }, { id: 'asc' }],
  });
  if (!agent) return null;
  await client.agent.update({
    where: { id: agent.id },
    data: { lastAssignedAt: new Date() },
  });
  return agent;
}

module.exports = {
  TEAM_DEFS,
  CATEGORY_TEAM_KEY,
  FALLBACK_TEAM_KEY,
  teamKeyForCategory,
  ensureTeams,
  getTeamByKey,
  pickAgentRoundRobin,
};
