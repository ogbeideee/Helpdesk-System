// Admin-configurable email parsing rules — CRUD, validation and the wiring
// between stored rules and the pure matching engine (src/email/parsingRules.js).
//
// The rules influence ONLY the fields they explicitly set. Evaluation is
// fail-open: a broken or missing rule table can never block inbound mail —
// intake falls back to the existing classifier and defaults.
//
// Every mutation writes to the unified audit trail. Keyword lists are stored
// as a JSON array of literal phrases and are never treated as code.
const prisma = require('../lib/prisma');
const auditService = require('./auditService');
const { isValidPriority, PRIORITIES } = require('../states');
const { evaluateRules } = require('../email/parsingRules');

const NAME_MAX = 120;
const KEYWORD_MAX = 120;
const KEYWORDS_MAX = 25;
const CATEGORY_MAX = 80;
const SCOPES = ['subject', 'body', 'both'];

class RuleValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'RuleValidationError';
    this.errors = errors;
  }
}

/** keywords: string (newline/comma/semicolon separated) or array -> clean JSON array. */
function normalizeKeywords(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\n,;]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const keyword = String(item).trim().slice(0, KEYWORD_MAX);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

/** Validate + normalize one rule payload. Throws RuleValidationError. */
async function normalizeRuleInput(input, client, existing = null) {
  const errors = [];
  const data = {};

  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > NAME_MAX) errors.push(`name must be <= ${NAME_MAX} characters`);
  else data.name = name;

  const keywordsInput = input.keywords !== undefined ? input.keywords : existing?.keywords;
  const keywords = normalizeKeywords(
    typeof keywordsInput === 'string' && keywordsInput.trim().startsWith('[')
      ? JSON.parse(keywordsInput)
      : keywordsInput
  );
  if (!keywords.length) errors.push('at least one keyword is required');
  else data.keywords = JSON.stringify(keywords);

  const scope = String(input.scope ?? existing?.scope ?? 'both');
  if (!SCOPES.includes(scope)) errors.push(`scope must be one of: ${SCOPES.join(', ')}`);
  else data.scope = scope;

  const category = input.category !== undefined ? input.category : existing?.category;
  if (category === null || category === undefined || category === '') {
    data.category = null;
  } else if (String(category).length > CATEGORY_MAX) {
    errors.push(`category must be <= ${CATEGORY_MAX} characters`);
  } else {
    data.category = String(category).trim();
  }

  const priority = input.priority !== undefined ? input.priority : existing?.priority;
  if (priority === null || priority === undefined || priority === '') {
    data.priority = null;
  } else if (!isValidPriority(String(priority))) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  } else {
    data.priority = String(priority);
  }

  const teamKey = input.teamKey !== undefined ? input.teamKey : existing?.teamKey;
  if (teamKey === null || teamKey === undefined || teamKey === '') {
    data.teamKey = null;
  } else {
    const team = await client.team.findUnique({ where: { key: String(teamKey).trim() } });
    if (!team) errors.push(`assignment group "${teamKey}" does not exist`);
    else data.teamKey = team.key;
  }

  const precedence = input.precedence !== undefined ? input.precedence : existing?.precedence;
  const precedenceNum = Number(precedence);
  if (precedence === null || precedence === undefined || precedence === '') {
    data.precedence = 100;
  } else if (!Number.isInteger(precedenceNum) || precedenceNum < 0 || precedenceNum > 10000) {
    errors.push('precedence must be an integer between 0 and 10000');
  } else {
    data.precedence = precedenceNum;
  }

  const enabled = input.enabled !== undefined ? input.enabled : existing?.enabled;
  data.enabled = enabled === undefined ? true : Boolean(enabled);

  if (errors.length) throw new RuleValidationError(errors);
  return data;
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    keywords: parseKeywordsSafe(row.keywords),
    scope: row.scope,
    category: row.category,
    priority: row.priority,
    teamKey: row.teamKey,
    precedence: row.precedence,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

function parseKeywordsSafe(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Every rule (any state) for administration. */
async function listRules(client = prisma) {
  const rows = await client.emailParsingRule.findMany({
    orderBy: [{ precedence: 'asc' }, { id: 'asc' }],
  });
  return rows.map(serialize);
}

/** Enabled rules in evaluation order — the exact order the engine uses. */
async function listEnabledRules(client = prisma) {
  const rows = await client.emailParsingRule.findMany({
    where: { enabled: true },
    orderBy: [{ precedence: 'asc' }, { id: 'asc' }],
  });
  return rows;
}

async function getRule(id, client = prisma) {
  const row = await client.emailParsingRule.findUnique({ where: { id: Number(id) } });
  return serialize(row);
}

async function createRule(input, actor, client = prisma) {
  const data = await normalizeRuleInput(input, client);
  const row = await client.emailParsingRule.create({ data });
  await auditService.record(client, {
    action: 'email_rule.created',
    entityType: 'EmailParsingRule',
    entityId: row.id,
    entityLabel: row.name,
    actor,
    to: { name: row.name, scope: row.scope, category: row.category, priority: row.priority, group: row.teamKey },
    description: `Email parsing rule "${row.name}" created`,
    metadata: { keywords: parseKeywordsSafe(row.keywords), enabled: row.enabled, precedence: row.precedence },
  });
  return serialize(row);
}

async function updateRule(id, input, actor, client = prisma) {
  const existing = await client.emailParsingRule.findUnique({ where: { id: Number(id) } });
  if (!existing) return null;
  const data = await normalizeRuleInput(input, client, existing);
  const row = await client.emailParsingRule.update({ where: { id: existing.id }, data });
  await auditService.record(client, {
    action: 'email_rule.updated',
    entityType: 'EmailParsingRule',
    entityId: row.id,
    entityLabel: row.name,
    actor,
    from: {
      name: existing.name, scope: existing.scope, category: existing.category,
      priority: existing.priority, group: existing.teamKey, enabled: existing.enabled,
    },
    to: {
      name: row.name, scope: row.scope, category: row.category,
      priority: row.priority, group: row.teamKey, enabled: row.enabled,
    },
    description: `Email parsing rule "${row.name}" updated`,
    metadata: { keywords: parseKeywordsSafe(row.keywords), precedence: row.precedence },
  });
  return serialize(row);
}

async function deleteRule(id, actor, client = prisma) {
  const existing = await client.emailParsingRule.findUnique({ where: { id: Number(id) } });
  if (!existing) return null;
  await client.emailParsingRule.delete({ where: { id: existing.id } });
  await auditService.record(client, {
    action: 'email_rule.deleted',
    entityType: 'EmailParsingRule',
    entityId: existing.id,
    entityLabel: existing.name,
    actor,
    from: { name: existing.name, scope: existing.scope, enabled: existing.enabled },
    description: `Email parsing rule "${existing.name}" deleted`,
    metadata: null,
  });
  return { ok: true, id: existing.id };
}

/**
 * Evaluate the stored, enabled rules for one inbound message. Fail-open by
 * design: any error collapses to "no rules matched" so inbound mail can never
 * be blocked by the configuration layer.
 */
async function evaluateForMessage({ subject, body }, client = prisma) {
  try {
    const rules = await listEnabledRules(client);
    if (!rules.length) return { matches: [], effective: {}, effectiveBy: {} };
    return evaluateRules({ subject, body, rules });
  } catch (err) {
    console.error(`[email-rules] evaluation failed, continuing without rules: ${err.message}`);
    return { matches: [], effective: {}, effectiveBy: {} };
  }
}

module.exports = {
  RuleValidationError,
  normalizeKeywords,
  listRules,
  listEnabledRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  evaluateForMessage,
  serialize,
  KEYWORDS_MAX,
  KEYWORD_MAX,
};
