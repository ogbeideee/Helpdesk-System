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
//   3a. An agent ADDRESSED BY NAME in the message greeting takes the ticket
//      first, ahead of the rule's preferred agent (step 4) — see
//      services/addressedRecipient.js. They still pass the same eligibility
//      gate (active, available, staff role, skilled enough, under the cap), and
//      a greeting never changes the ticket's assignment GROUP: someone working
//      across groups is permitted only for the low/moderate tier.
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
// which administrators edit through the API — and so does the minimum skill,
// so `groupSkillBars()` reports the bar the engine is really applying.
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');
const routingService = require('./routingService');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'assignment.config.json');

const FALLBACK_CONFIG = {
  defaultGroup: 'service_desk',
  prioritySkillBoost: { low: 0, moderate: 0, high: 1, critical: 2 },
  maxSkillLevel: 3,
  maxActiveTicketsPerAgent: 25,
  supportingMaxPriority: 'moderate',
};

const PRIORITY_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

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

/**
 * Is `priority` within the supporting-member tier? Supporting members (primary
 * team differs from the group being assigned within) are only eligible for
 * tickets whose priority is at or below the configured supportingMaxPriority
 * (default moderate). high and critical are never in tier.
 */
function isSupportingTier(priority, config) {
  const max = (config && config.supportingMaxPriority) || FALLBACK_CONFIG.supportingMaxPriority;
  const maxRank = PRIORITY_RANK[max] !== undefined ? PRIORITY_RANK[max] : 1;
  const rank = PRIORITY_RANK[priority] !== undefined ? PRIORITY_RANK[priority] : 1;
  return rank <= maxRank;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * The skill bar each group is currently enforcing: the LOWEST minimum skill
 * among that group's active routing rules — the very rows `decide()` reads —
 * or 1 when no active rule names one. It is the display form of the engine's
 * own gate, never a second rule, so the pool and the group list can never
 * claim a bar the engine does not apply. (The routes used to read a
 * category->skill map out of assignment.config.json, which is how a group
 * could read "L1" while the engine demanded "L2".)
 *
 * @returns {Promise<Map<number, number>>} teamId -> minimum skill level
 */
async function groupSkillBars(client = prisma) {
  const rules = await client.routingRule.findMany({
    where: { isActive: true },
    select: { teamId: true, minimumSkillLevel: true },
  });
  const bars = new Map();
  for (const rule of rules) {
    const level = Number.isInteger(rule.minimumSkillLevel) ? rule.minimumSkillLevel : 1;
    bars.set(rule.teamId, Math.min(bars.get(rule.teamId) ?? level, level));
  }
  return bars;
}

/**
 * The skill level a ticket actually requires: the bar of the routing rule that
 * governs it INSIDE the group that owns it, plus the priority boost — exactly
 * the figure `assign()` gates on.
 *
 * It is derived, never stored, which is deliberate: the answer for an existing
 * ticket follows the current rules, so correcting an over-stated rule corrects
 * every ticket it governs, past and present, with no backfill.
 *
 * @param {{category:string, priority:string, text:string, subject?:string, teamId?:number|null}} ticket
 * @returns {Promise<{level:number, ruleId:number|null, ruleName:string|null}>}
 */
async function requiredSkill({ category, priority, text, subject, teamId = null }, client = prisma) {
  const config = loadConfig();
  const boost = (config.prioritySkillBoost || {})[priority] || 0;
  const { rule } = await routingService.matchRule(
    {
      category,
      text: text || category,
      subject,
      ...(Number.isInteger(teamId) ? { teamId } : {}),
    },
    client
  );
  const base = rule && Number.isInteger(rule.minimumSkillLevel) ? rule.minimumSkillLevel : 1;
  return {
    level: clamp(base + boost, 1, config.maxSkillLevel || 3),
    ruleId: rule ? rule.id : null,
    ruleName: rule ? rule.name : null,
  };
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
async function decide({ category, priority, text, subject, forceTeamId }, client = prisma) {
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
    { category, text: text || category, subject },
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
  { category, priority, text, subject, forceTeamId, excludeAgentIds = [], addressed = null },
  client = prisma,
  logger = console
) {
  const config = loadConfig();
  const cap = config.maxActiveTicketsPerAgent || FALLBACK_CONFIG.maxActiveTicketsPerAgent;
  const { STAFF_ROLES } = require('./userService');

  const decision = await decide({ category, priority, text, subject, forceTeamId }, client);
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
    // Always present, on every path, so a caller never has to test for the key:
    // false when the ticket went through the normal routing search.
    addressedAgentUsed: false,
    addressedName: null,
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

  /* ---- 1. agent addressed by the message's greeting ------------------ */
  // The sender wrote "Dear Dare," — that is a direct request for one person,
  // and it outranks both the routing rule's preferred agent and the
  // lowest-workload search below.
  //
  // It does NOT outrank eligibility. The same gate the preferred agent passes
  // applies here: active, available, a staff role, and under the workload cap.
  // The skill bar still applies too — a greeting is not a qualification.
  //
  // The GROUP is left exactly as the routing rule decided it, for the same
  // reason the cross-team fallback leaves it unchanged: the ticket belongs to
  // its assignment group whoever works it. When the addressed agent is not in
  // that group they are pulled in cross-group, which is permitted only for the
  // low/moderate tier — the same `isSupportingTier()` gate the cross-team
  // fallback uses. A high or critical ticket never leaves its group on the
  // strength of a greeting.
  if (addressed && Number.isInteger(addressed.agentId)) {
    const named = await client.agent.findFirst({
      where: { id: addressed.agentId, ...eligibilityBase },
      include: WORKLOAD_COUNT,
    });

    let crossGroupBlocked = false;
    if (named && team && named.teamId !== team.id && !isSupportingTier(priority, config)) {
      crossGroupBlocked = true;
    }

    if (named && !crossGroupBlocked && named._count.assignedTickets < cap) {
      await client.agent.update({ where: { id: named.id }, data: { lastAssignedAt: new Date() } });
      const crossGroup = Boolean(team) && named.teamId !== team.id;
      return {
        ...base,
        agent: named,
        candidatesConsidered: 1,
        crossTeam: crossGroup,
        preferredAgentUsed: false,
        addressedAgentUsed: true,
        addressedName: addressed.matchedName || named.name,
        reason:
          `addressed by name in the message greeting ("${addressed.matchedName || named.name}" → ${named.name})` +
          (crossGroup ? `, working across groups (group ${groupName || 'triage'} unchanged)` : ''),
        awaitingAssignment: false,
      };
    }
    // Not usable — say why once, then fall through to the normal search. The
    // message still becomes a ticket; it just is not handed to the person it
    // names, and the audit trail says exactly why.
    let why;
    if (!named) {
      // The gate query filters on eligibility, so a null here means "did not
      // pass it" or "is gone". One extra read distinguishes them, because
      // "on leave" and "no longer works here" are different answers to give.
      const existing = await client.agent.findUnique({
        where: { id: addressed.agentId },
        select: { isActive: true, isAvailable: true, role: true, skillLevel: true },
      });
      if (!existing) {
        why = 'account no longer exists';
      } else if (!existing.isActive) {
        why = 'account is deactivated';
      } else if (!existing.isAvailable) {
        why = 'currently unavailable';
      } else if (!STAFF_ROLES.includes(existing.role)) {
        why = 'not a helpdesk agent';
      } else {
        why = `below the group skill bar (needs level ${minSkillLevel})`;
      }
    } else if (crossGroupBlocked) {
      why = `outside ${groupName || 'triage'} and not eligible for ${priority} priority`;
    } else {
      why = `at or above the workload cap (${cap})`;
    }
    logger.warn(
      `[assignment] addressed agent "${addressed.matchedName || addressed.agentId}" not used — ${why}; ` +
        'falling back to normal routing',
    );
  }

  /* ---- 2. preferred agent named by the rule ------------------------ */
  if (rule && rule.preferredAgentId) {
    const preferred = await client.agent.findFirst({
      where: { id: rule.preferredAgentId, ...eligibilityBase },
      include: WORKLOAD_COUNT,
    });

    // If the preferred agent is a supporting member of this group
    // (their primary team differs), they are only eligible for
    // low/moderate priority tickets.
    let supportingBlock = false;
    if (preferred && team && preferred.teamId !== team.id && !isSupportingTier(priority, config)) {
      supportingBlock = true;
    }

    if (preferred && !supportingBlock && preferred._count.assignedTickets < cap) {
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
      ? 'unavailable or insufficient skill'
      : supportingBlock
        ? `supporting member not eligible for ${priority} priority`
        : `at or above the workload cap (${cap})`;
    logger.warn(
      `[assignment] preferred agent for rule "${rule.name}" not used — ${why}; falling back to the group`
    );
  }

  /* ---- 2. best agent inside the chosen group ----------------------- */
  // Primary members: agents whose primary team (Agent.teamId) is this group.
  // Supporting members: agents with a TeamMembership in this group but a
  // different primary team. Supporting members are only eligible for
  // low/moderate priority tickets.
  let primaryMembers = [];
  let supportingMembers = [];
  if (team) {
    [primaryMembers, supportingMembers] = await Promise.all([
      client.agent.findMany({
        where: { ...eligibilityBase, teamId: team.id },
        include: WORKLOAD_COUNT,
      }),
      isSupportingTier(priority, config)
        ? client.agent.findMany({
            where: {
              ...eligibilityBase,
              teamId: { not: team.id },
              memberships: { some: { teamId: team.id } },
            },
            include: WORKLOAD_COUNT,
          })
        : Promise.resolve([]),
    ]);
  }

  // Deduplicate (an agent could match both if their primary overlaps with a
  // membership — rare but safe). Primary membership takes precedence.
  const seenIds = new Set(primaryMembers.map((a) => a.id));
  const inGroup = primaryMembers.concat(supportingMembers.filter((a) => !seenIds.has(a.id)));
  const groupEligible = inGroup.filter((a) => a._count.assignedTickets < cap);

  if (groupEligible.length) {
    groupEligible.sort(byWorkloadThenRoundRobin);
    const chosen = groupEligible[0];
    await client.agent.update({ where: { id: chosen.id }, data: { lastAssignedAt: new Date() } });
    const isSupporting = chosen.teamId !== team.id;
    return {
      ...base,
      agent: chosen,
      candidatesConsidered: primaryMembers.length + supportingMembers.length,
      crossTeam: false,
      preferredAgentUsed: false,
      supportingMember: isSupporting || undefined,
      reason: isSupporting
        ? `selected by lowest workload (${chosen._count.assignedTickets} open), supporting member for ${groupName || groupKey}`
        : `selected by lowest workload (${chosen._count.assignedTickets} open), skill >= ${minSkillLevel}`,
      awaitingAssignment: false,
    };
  }

  /* ---- 3. cross-team fallback -------------------------------------- */
  // Nobody in the group can take it. Find the lowest-workload qualified
  // agent anywhere. The ticket KEEPS its assignment group. For high/critical
  // tickets, the cross-team fallback ALSO respects the supporting tier gate:
  // any agent whose primary team is not the ticket's group is a supporting
  // member of it, so they are blocked for high/critical.
  const anywhere = await client.agent.findMany({
    where: {
      ...eligibilityBase,
      ...(team ? { NOT: { teamId: team.id } } : {}),
      ...(!isSupportingTier(priority, config) && team ? { memberships: { none: { teamId: team.id } } } : {}),
    },
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
      candidatesConsidered: primaryMembers.length + supportingMembers.length + anywhere.length,
      crossTeam: true,
      preferredAgentUsed: false,
      reason:
        `no available agent in ${groupName || groupKey}; ` +
        `assigned across teams by lowest workload (${chosen._count.assignedTickets} open)`,
      awaitingAssignment: false,
    };
  }

  /* ---- 4. nobody at all -------------------------------------------- */
  const reason = (primaryMembers.length + supportingMembers.length)
    ? `all ${primaryMembers.length + supportingMembers.length} agent(s) in ${groupName || groupKey} at or above the workload cap (${cap}), and no one else qualifies`
    : `no available agent with skill level >= ${minSkillLevel} in ${groupName || groupKey} or any other team`;
  logger.warn(`[assignment] ${groupName || groupKey}: awaiting assignment — ${reason}`);
  return {
    ...base,
    agent: null,
    candidatesConsidered: primaryMembers.length + supportingMembers.length + anywhere.length,
    crossTeam: false,
    preferredAgentUsed: false,
    reason,
    awaitingAssignment: true,
  };
}

module.exports = { assign, decide, requiredSkill, groupSkillBars, loadConfig };
