// Assignment engine — decides which group and which agent receive a ticket.
//
// Order of operations (the category itself is decided earlier, by the existing
// classifier in src/graph/categoryRules.js):
//
//   1. Evaluate active routing rules against category + ticket text.
//      The highest-priority match wins (precedence documented in
//      src/services/routingService.js).
//   2. That rule fixes the assignment group, and may name a preferred agent
//      and a minimum skill level.
//   3. If no rule matches, the group is the configured default —
//      "General IT Support" (Team.isDefault).
//   4. Preferred agent is used when they are active, available, in the chosen
//      group, sufficiently skilled and under the workload cap.
//   5. Otherwise the best agent in that group: lowest open workload, ties
//      broken least-recently-assigned (round-robin).
//   6. If nobody in the group qualifies, fall back across teams to the
//      qualified agent with the lowest workload anywhere.
//      The assignment GROUP is deliberately left unchanged by this step — the
//      ticket still belongs to its group, it is merely being worked by
//      somebody from another team.
//   7. If still nobody, the ticket keeps its group with assignedAgentId null.
//
// config/assignment.config.json still supplies the priority skill boost and
// the workload cap. Category -> group mapping now lives in RoutingRule rows,
// which administrators edit through the API.
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');
const routingService = require('./routingService');

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

const OPEN = ['NEW', 'IN_PROGRESS'];
const WORKLOAD_COUNT = {
  _count: { select: { assignedTickets: { where: { state: { in: OPEN } } } } },
};

/** Lowest workload first; ties go to the least recently assigned. */
function byWorkloadThenRoundRobin(a, b) {
  const byWorkload = a._count.assignedTickets - b._count.assignedTickets;
  if (byWorkload !== 0) return byWorkload;
  const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
  const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.id - b.id;
}

/**
 * Resolve the group and minimum skill for a ticket, without picking an agent.
 * Kept for callers that only need the routing decision.
 */
async function decide({ category, priority, text, forceTeamId }, client = prisma) {
  const config = loadConfig();
  const boost = (config.prioritySkillBoost || {})[priority] || 0;

  // forceTeamId pins the group (used when an admin has just moved a ticket to
  // a specific group and only wants an agent picked inside it). Routing rules
  // are not consulted in that case.
  if (forceTeamId) {
    const forced = await client.team.findUnique({ where: { id: forceTeamId } });
    return {
      rule: null,
      ruleName: null,
      matchedKeywords: [],
      team: forced,
      groupKey: forced ? forced.key : null,
      groupName: forced ? forced.name : null,
      minSkillLevel: clamp(1 + boost, 1, config.maxSkillLevel || 3),
    };
  }

  const { rule, matchedKeywords } = await routingService.matchRule(
    { category, text: text || category },
    client
  );

  let team = null;
  let baseLevel = 1;

  if (rule) {
    team = rule.team;
    if (Number.isInteger(rule.minimumSkillLevel)) baseLevel = rule.minimumSkillLevel;
  } else {
    team = await routingService.defaultGroup(client);
  }

  const minSkillLevel = clamp(baseLevel + boost, 1, config.maxSkillLevel || 3);

  return {
    rule: rule || null,
    ruleName: rule ? rule.name : null,
    matchedKeywords: matchedKeywords || [],
    team,
    groupKey: team ? team.key : null,
    groupName: team ? team.name : null,
    minSkillLevel,
  };
}

/**
 * Pick the group and best available agent for a ticket.
 *
 * Returns full decision metadata so callers can audit it:
 *   { groupKey, groupName, teamId, minSkillLevel, agent|null, rule info,
 *     candidatesConsidered, crossTeam, reason, awaitingAssignment }
 */
async function assign(
  { category, priority, text, forceTeamId, excludeAgentIds = [] },
  client = prisma,
  logger = console
) {
  const config = loadConfig();
  const cap = config.maxActiveTicketsPerAgent || FALLBACK_CONFIG.maxActiveTicketsPerAgent;
  const { STAFF_ROLES } = require('./userService');

  const decision = await decide({ category, priority, text, forceTeamId }, client);
  const { team, minSkillLevel, rule } = decision;
  const groupKey = decision.groupKey;
  const groupName = decision.groupName;

  const base = {
    rule: rule ? { id: rule.id, name: rule.name, priority: rule.priority } : null,
    ruleName: decision.ruleName,
    matchedKeywords: decision.matchedKeywords,
    groupKey,
    groupName,
    teamId: team ? team.id : null,
    minSkillLevel,
  };

  const eligibilityBase = {
    isActive: true,
    isAvailable: true,
    role: { in: STAFF_ROLES },
    skillLevel: { gte: minSkillLevel },
    // Used when moving work away from a specific agent: they must not be
    // handed the same ticket straight back.
    ...(excludeAgentIds.length ? { id: { notIn: excludeAgentIds } } : {}),
  };

  /* ---- 1. preferred agent named by the rule ------------------------ */
  if (rule && rule.preferredAgentId) {
    const preferred = await client.agent.findFirst({
      where: { id: rule.preferredAgentId, ...eligibilityBase, ...(team ? { teamId: team.id } : {}) },
      include: WORKLOAD_COUNT,
    });

    if (preferred && preferred._count.assignedTickets < cap) {
      await client.agent.update({ where: { id: preferred.id }, data: { lastAssignedAt: new Date() } });
      return {
        ...base,
        agent: preferred,
        candidatesConsidered: 1,
        crossTeam: false,
        preferredAgentUsed: true,
        reason: `preferred agent for rule "${rule.name}"`,
        awaitingAssignment: false,
      };
    }
    // Not usable — say why once, then fall through to the normal search.
    const why = !preferred
      ? 'unavailable, wrong group, or insufficient skill'
      : `at or above the workload cap (${cap})`;
    logger.warn(
      `[assignment] preferred agent for rule "${rule.name}" not used — ${why}; falling back to the group`
    );
  }

  /* ---- 2. best agent inside the chosen group ----------------------- */
  const inGroup = team
    ? await client.agent.findMany({
        where: { ...eligibilityBase, teamId: team.id },
        include: WORKLOAD_COUNT,
      })
    : [];
  const groupEligible = inGroup.filter((a) => a._count.assignedTickets < cap);

  if (groupEligible.length) {
    groupEligible.sort(byWorkloadThenRoundRobin);
    const chosen = groupEligible[0];
    await client.agent.update({ where: { id: chosen.id }, data: { lastAssignedAt: new Date() } });
    return {
      ...base,
      agent: chosen,
      candidatesConsidered: inGroup.length,
      crossTeam: false,
      preferredAgentUsed: false,
      reason: `selected by lowest workload (${chosen._count.assignedTickets} open), skill >= ${minSkillLevel}`,
      awaitingAssignment: false,
    };
  }

  /* ---- 3. cross-team fallback -------------------------------------- */
  // Nobody in the group can take it. Rather than leave the ticket unassigned,
  // find the lowest-workload qualified agent anywhere. The ticket KEEPS its
  // assignment group: only the person working it comes from elsewhere.
  // Applies even when the group is pinned: pinning fixes which group OWNS the
  // ticket, not who may work it. Callers that require a same-group agent check
  // the returned agent's teamId themselves.
  const anywhere = await client.agent.findMany({
    where: { ...eligibilityBase, ...(team ? { NOT: { teamId: team.id } } : {}) },
    include: WORKLOAD_COUNT,
  });
  const globalEligible = anywhere.filter((a) => a._count.assignedTickets < cap);

  if (globalEligible.length) {
    globalEligible.sort(byWorkloadThenRoundRobin);
    const chosen = globalEligible[0];
    await client.agent.update({ where: { id: chosen.id }, data: { lastAssignedAt: new Date() } });
    logger.log(
      `[assignment] no one available in ${groupName || groupKey} — ` +
        `${chosen.name} is taking it from another team (group unchanged)`
    );
    return {
      ...base,
      agent: chosen,
      candidatesConsidered: inGroup.length + anywhere.length,
      crossTeam: true,
      preferredAgentUsed: false,
      reason:
        `no available agent in ${groupName || groupKey}; ` +
        `assigned across teams by lowest workload (${chosen._count.assignedTickets} open)`,
      awaitingAssignment: false,
    };
  }

  /* ---- 4. nobody at all -------------------------------------------- */
  const reason = inGroup.length
    ? `all ${inGroup.length} agent(s) in ${groupName || groupKey} at or above the workload cap (${cap}), and no one else qualifies`
    : `no available agent with skill level >= ${minSkillLevel} in ${groupName || groupKey} or any other team`;
  logger.warn(`[assignment] ${groupName || groupKey}: awaiting assignment — ${reason}`);
  return {
    ...base,
    agent: null,
    candidatesConsidered: inGroup.length + anywhere.length,
    crossTeam: false,
    preferredAgentUsed: false,
    reason,
    awaitingAssignment: true,
  };
}

module.exports = { assign, decide, loadConfig };
