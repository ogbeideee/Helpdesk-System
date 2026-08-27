// Team routing + round-robin agent assignment.
const prisma = require('./lib/prisma');

// Assignment groups (IT teams). `isDefault` marks the group that receives a
// ticket when no routing rule matches — "General IT Support".
const TEAM_DEFS = [
  {
    key: 'service_desk',
    name: 'General IT Support',
    description: 'First-line support and triage. Receives anything no routing rule claims.',
    isDefault: true,
  },
  {
    key: 'accounts',
    name: 'Accounts & Access',
    description: 'Account lifecycle, passwords, MFA and access requests.',
  },
  {
    key: 'software',
    name: 'Software & Applications',
    description: 'Desktop and line-of-business applications, licensing and updates.',
  },
  {
    key: 'hardware',
    name: 'Hardware & Devices',
    description: 'Laptops, peripherals, printers and meeting-room equipment.',
  },
  {
    key: 'network',
    name: 'Network Team',
    description: 'Connectivity: WiFi, LAN, VPN, routers and firewalls.',
  },
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
    const data = {
      key: def.key,
      name: def.name,
      description: def.description || null,
      isDefault: Boolean(def.isDefault),
    };
    await client.team.upsert({
      where: { key: def.key },
      create: data,
      // isActive is deliberately not reset: an admin may have deactivated a
      // group, and re-running the seed must not silently re-enable it.
      update: { name: data.name, description: data.description, isDefault: data.isDefault },
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
