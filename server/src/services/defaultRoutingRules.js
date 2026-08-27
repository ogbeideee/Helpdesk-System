// Starter routing rules.
//
// Seeded only when no rules exist at all, so an administrator's edits are
// never overwritten. They are ordinary rows: everything here can be changed,
// reordered, deactivated or deleted through /api/routing/rules.
//
// No employee names appear here. A preferred agent is configured by an
// administrator against a real account, never hardcoded.
//
// Priority: lower number = evaluated first = wins. The bands leave room to
// insert rules without renumbering:
//   10-29  specific technical domains (network, printing, …)
//   30-49  reserved for future specific rules
//   50-89  broad per-category rules
//   90+    catch-alls
const routingService = require('./routingService');

const DEFAULT_RULES = [
  {
    name: 'Network Issues',
    priority: 10,
    // Category-agnostic on purpose: connectivity wording can land in any
    // category, and this rule's keywords are specific enough to decide on
    // their own. Its low priority number makes it win outright.
    category: null,
    groupKey: 'network',
    minimumSkillLevel: 'MID',
    keywords: [
      'wifi', 'wi-fi', 'wireless', 'internet', 'network', 'lan', 'ethernet',
      'vpn', 'router', 'switch', 'firewall', 'connection', 'connectivity',
      'no signal', 'cannot connect', 'dropping connection',
    ],
  },
  {
    name: 'Printing',
    priority: 20,
    category: null,
    groupKey: 'hardware',
    keywords: ['printer', 'printing', 'print queue', 'toner', 'paper jam', 'scanner'],
  },
  {
    name: 'Account & Access',
    priority: 50,
    category: 'Password Reset',
    groupKey: 'accounts',
    keywords: [],
  },
  {
    name: 'Software & Applications',
    priority: 60,
    category: 'Software',
    groupKey: 'software',
    minimumSkillLevel: 'MID',
    keywords: [],
  },
  {
    name: 'Hardware & Devices',
    priority: 70,
    category: 'Hardware',
    groupKey: 'hardware',
    keywords: [],
  },
  {
    name: 'General Enquiries',
    priority: 90,
    category: 'Inquiry / Help',
    groupKey: 'service_desk',
    keywords: [],
  },
];

/**
 * Insert the starter rules if the table is empty.
 * @returns {Promise<{status:string, created?:number}>}
 */
async function ensureDefaultRoutingRules({ client, logger = console } = {}) {
  const prisma = client || require('../lib/prisma');

  const existing = await prisma.routingRule.count();
  if (existing > 0) return { status: 'skipped', reason: `${existing} rule(s) already configured` };

  const teams = await prisma.team.findMany();
  const byKey = Object.fromEntries(teams.map((t) => [t.key, t]));

  let created = 0;
  for (const def of DEFAULT_RULES) {
    const team = byKey[def.groupKey];
    if (!team) {
      logger.warn(`[routing] skipping rule "${def.name}" — no assignment group "${def.groupKey}"`);
      continue;
    }
    const rule = await prisma.routingRule.create({
      data: {
        name: def.name,
        keywords: routingService.serialiseKeywords(def.keywords),
        category: def.category || null,
        teamId: team.id,
        preferredAgentId: null,
        minimumSkillLevel: def.minimumSkillLevel
          ? routingService.skillValue(def.minimumSkillLevel)
          : null,
        priority: def.priority,
        isActive: true,
      },
    });
    await routingService.recordRuleAudit(
      { rule, action: 'created', changes: { seeded: true }, actor: 'system (default rules)' },
      prisma
    );
    created += 1;
  }

  logger.log(`[routing] seeded ${created} default routing rule(s)`);
  return { status: 'seeded', created };
}

module.exports = { DEFAULT_RULES, ensureDefaultRoutingRules };
