// Assignment engine — decides which agent should receive a ticket.
//
// Decision order (per spec):
//   1. correct assignment group
//   2. minimum required skill level (category rule + priority boost)
//   3. agent availability (isActive, workload cap)
//   4. lowest current open-workload, ties broken least-recently-assigned
//
// Rules are externalised in config/assignment.config.json — no code changes
// needed to re-route categories or adjust skill requirements.
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'assignment.config.json');

const FALLBACK_CONFIG = {
  defaultGroup: 'service_desk',
  categories: {},
  prioritySkillBoost: { low: 0, moderate: 0, high: 1, critical: 2 },
  maxSkillLevel: 3,
  maxActiveTicketsPerAgent: 25,
};

let cachedConfig = null;
let cachedMtime = 0;

function loadConfig(logger = console) {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!cachedConfig || stat.mtimeMs !== cachedMtime) {
      cachedConfig = { ...FALLBACK_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
      cachedMtime = stat.mtimeMs;
      logger.log('[assignment] rules loaded from config/assignment.config.json');
    }
    return cachedConfig;
  } catch (err) {
    if (cachedConfig) return cachedConfig;
    logger.warn(`[assignment] config unavailable (${err.message}) — using built-in defaults`);
    return { ...FALLBACK_CONFIG };
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Resolve the target group key + minimum required skill level for a ticket. */
function decide({ category, priority }) {
  const config = loadConfig();
  const rule = (config.categories && config.categories[category]) || {};
  const groupKey = rule.group || config.defaultGroup;
  const baseLevel = Number.isInteger(rule.minSkillLevel) ? rule.minSkillLevel : 1;
  const boost = (config.prioritySkillBoost || {})[priority] || 0;
  const minSkillLevel = clamp(baseLevel + boost, 1, config.maxSkillLevel || 3);
  return { groupKey, minSkillLevel };
}

/**
 * Pick the best available agent for a ticket.
 * Returns full decision metadata so callers can audit/log it:
 *   { groupKey, groupName|null, minSkillLevel, agent|null,
 *     candidatesConsidered, reason, awaitingAssignment }
 */
async function assign({ category, priority }, client = prisma, logger = console) {
  const config = loadConfig();
  const { groupKey, minSkillLevel } = decide({ category, priority });

  const team = await client.team.findUnique({ where: { key: groupKey } });
  const groupName = team ? team.name : null;

  // Eligibility: staff who can actually take work — the account is enabled,
  // they are currently available, and their role receives assignments (a USER
  // never does). Plus the right group and sufficient skill.
  const { STAFF_ROLES } = require('./userService');
  const candidates = await client.agent.findMany({
    where: {
      isActive: true,
      isAvailable: true,
      role: { in: STAFF_ROLES },
      ...(team ? { teamId: team.id } : {}),
      skillLevel: { gte: minSkillLevel },
    },
    include: {
      _count: {
        select: { assignedTickets: { where: { state: { in: ['NEW', 'IN_PROGRESS'] } } } },
      },
    },
  });

  const cap = config.maxActiveTicketsPerAgent || FALLBACK_CONFIG.maxActiveTicketsPerAgent;
  const eligible = candidates.filter((a) => a._count.assignedTickets < cap);

  // Priority 4: lowest current workload, then least-recently-assigned.
  eligible.sort((a, b) => {
    const byWorkload = a._count.assignedTickets - b._count.assignedTickets;
    if (byWorkload !== 0) return byWorkload;
    const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
    const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
    return aTime - bTime;
  });

  if (!eligible.length) {
    const reason = candidates.length
      ? `all ${candidates.length} eligible agent(s) at or above workload cap (${cap})`
      : `no active agent in "${groupName || groupKey}" with skill level >= ${minSkillLevel}`;
    logger.warn(`[assignment] ${groupName || groupKey}: awaiting assignment — ${reason}`);
    return {
      groupKey,
      groupName,
      minSkillLevel,
      agent: null,
      candidatesConsidered: candidates.length,
      reason,
      awaitingAssignment: true,
    };
  }

  const chosen = eligible[0];
  await client.agent.update({
    where: { id: chosen.id },
    data: { lastAssignedAt: new Date() },
  });

  return {
    groupKey,
    groupName,
    minSkillLevel,
    agent: chosen,
    candidatesConsidered: candidates.length,
    reason: `selected by lowest workload (${chosen._count.assignedTickets} open), skill >= ${minSkillLevel}`,
    awaitingAssignment: false,
  };
}

module.exports = { assign, decide, loadConfig };
