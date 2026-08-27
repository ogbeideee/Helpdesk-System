// Administrator API for routing rules and assignment groups.
//
// Rules decide which assignment group (and optionally which agent and minimum
// skill) a new ticket goes to. Matching and precedence live in
// src/services/routingService.js; this router only validates and persists.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { requireAdmin } = require('../src/authMiddleware');
const routingService = require('../src/services/routingService');
const { CATEGORIES } = require('../src/states');

const router = express.Router();
router.use(requireAdmin);

const SKILL_MIN = 1;
const SKILL_MAX = 3;

function serialiseRule(r) {
  return {
    id: r.id,
    name: r.name,
    keywords: routingService.parseKeywords(r.keywords),
    category: r.category,
    assignmentGroupId: r.teamId,
    assignmentGroup: r.team ? { id: r.team.id, key: r.team.key, name: r.team.name } : null,
    preferredAgentId: r.preferredAgentId,
    preferredAgent: r.preferredAgent
      ? {
          id: r.preferredAgent.id,
          name: r.preferredAgent.name,
          email: r.preferredAgent.email,
          skillLevel: r.preferredAgent.skillLevel,
          skillName: routingService.skillName(r.preferredAgent.skillLevel),
        }
      : null,
    minimumSkillLevel: r.minimumSkillLevel,
    minimumSkillName: r.minimumSkillLevel ? routingService.skillName(r.minimumSkillLevel) : null,
    priority: r.priority,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const RULE_INCLUDE = { team: true, preferredAgent: true };

/**
 * Validate a rule payload. `partial` allows omitted fields on update.
 * @returns {{errors:string[], data:object}}
 */
async function validateRule(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    else data.name = name.slice(0, 120);
  }

  if (body.keywords !== undefined) {
    data.keywords = routingService.serialiseKeywords(body.keywords);
  } else if (!partial) {
    data.keywords = '';
  }

  if (body.category !== undefined) {
    if (body.category === null || body.category === '') {
      data.category = null; // applies to every category
    } else if (!CATEGORIES.includes(body.category)) {
      errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
    } else {
      data.category = body.category;
    }
  }

  const groupId = body.assignmentGroupId ?? body.teamId;
  if (groupId !== undefined) {
    const id = Number(groupId);
    if (!Number.isInteger(id)) errors.push('assignmentGroupId must be an integer');
    else {
      const team = await prisma.team.findUnique({ where: { id } });
      if (!team) errors.push(`unknown assignment group ${id}`);
      else data.teamId = team.id;
    }
  } else if (!partial) {
    errors.push('assignmentGroupId is required');
  }

  if (body.preferredAgentId !== undefined) {
    if (body.preferredAgentId === null) data.preferredAgentId = null;
    else {
      const id = Number(body.preferredAgentId);
      if (!Number.isInteger(id)) errors.push('preferredAgentId must be an integer or null');
      else {
        const agent = await prisma.agent.findUnique({ where: { id } });
        if (!agent) errors.push(`unknown preferred agent ${id}`);
        else data.preferredAgentId = agent.id;
      }
    }
  }

  if (body.minimumSkillLevel !== undefined) {
    if (body.minimumSkillLevel === null || body.minimumSkillLevel === '') {
      data.minimumSkillLevel = null;
    } else {
      const level = routingService.skillValue(body.minimumSkillLevel);
      if (level === null || level < SKILL_MIN || level > SKILL_MAX) {
        errors.push('minimumSkillLevel must be JUNIOR, MID, SENIOR (or 1-3)');
      } else {
        data.minimumSkillLevel = level;
      }
    }
  }

  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 0) errors.push('priority must be a non-negative integer');
    else data.priority = p;
  }

  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

  return { errors, data };
}

/* ---- assignment groups --------------------------------------------- */

// GET /api/routing/groups
router.get('/groups', async (req, res) => {
  try {
    const groups = await prisma.team.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { agents: true, routingRules: true } } },
    });
    res.json({
      groups: groups.map((g) => ({
        id: g.id,
        key: g.key,
        name: g.name,
        description: g.description,
        isActive: g.isActive,
        isDefault: g.isDefault,
        agentCount: g._count.agents,
        ruleCount: g._count.routingRules,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/routing/groups/:id — description / active / default
router.patch('/groups/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Assignment group not found' });
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Assignment group not found' });

    const data = {};
    if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim();
    if (req.body.description !== undefined) {
      data.description = req.body.description ? String(req.body.description).trim() : null;
    }
    if (req.body.isActive !== undefined) {
      data.isActive = Boolean(req.body.isActive);
      // The fallback group must stay usable, or tickets that match no rule
      // would have nowhere to go.
      if (!data.isActive && existing.isDefault) {
        return res.status(409).json({ error: 'The default assignment group cannot be deactivated' });
      }
    }
    if (req.body.isDefault === true) {
      await prisma.team.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      data.isDefault = true;
      data.isActive = true;
    }

    const updated = await prisma.team.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- routing rules -------------------------------------------------- */

// GET /api/routing/rules
router.get('/rules', async (req, res) => {
  try {
    const rules = await prisma.routingRule.findMany({
      include: RULE_INCLUDE,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    res.json({
      categories: CATEGORIES,
      skillLevels: routingService.SKILL_LEVELS,
      rules: rules.map(serialiseRule),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/routing/rules
router.post('/rules', async (req, res) => {
  try {
    const { errors, data } = await validateRule(req.body || {});
    if (errors.length) return res.status(400).json({ errors });

    const rule = await prisma.routingRule.create({ data, include: RULE_INCLUDE });
    await routingService.recordRuleAudit(
      { rule, action: 'created', changes: serialiseRule(rule), actor: req.agent },
    );
    res.status(201).json(serialiseRule(rule));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/routing/rules/:id
router.patch('/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Routing rule not found' });
    const existing = await prisma.routingRule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    const { errors, data } = await validateRule(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ errors: ['no supported fields to update'] });

    const updated = await prisma.routingRule.update({ where: { id }, data, include: RULE_INCLUDE });

    // Activation changes are their own audit action so they are easy to find.
    let action = 'updated';
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      action = data.isActive ? 'activated' : 'deactivated';
    }
    const changes = {};
    for (const key of Object.keys(data)) {
      if (existing[key] !== updated[key]) changes[key] = { from: existing[key], to: updated[key] };
    }
    await routingService.recordRuleAudit({ rule: updated, action, changes, actor: req.agent });

    res.json(serialiseRule(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/routing/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Routing rule not found' });
    const existing = await prisma.routingRule.findUnique({ where: { id }, include: RULE_INCLUDE });
    if (!existing) return res.status(404).json({ error: 'Routing rule not found' });

    await prisma.routingRule.delete({ where: { id } });
    // The audit row keeps the rule's name after the row itself is gone.
    await routingService.recordRuleAudit({
      rule: existing,
      action: 'deleted',
      changes: serialiseRule(existing),
      actor: req.agent,
    });
    res.json({ deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/routing/audit — rule administration history
router.get('/audit', async (req, res) => {
  try {
    const events = await prisma.routingRuleAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/routing/preview — what would this text route to?
// Read-only: creates nothing, useful for testing a rule set.
router.post('/preview', async (req, res) => {
  try {
    const text = String(req.body.text || '');
    const { classify } = require('../src/graph/categoryRules');
    const category = req.body.category || classify(text).category;
    const decision = await require('../src/services/assignmentEngine').decide({
      category,
      priority: req.body.priority || 'moderate',
      text,
    });
    res.json({
      category,
      matchedRule: decision.rule ? { id: decision.rule.id, name: decision.rule.name } : null,
      matchedKeywords: decision.matchedKeywords,
      assignmentGroup: decision.team
        ? { id: decision.team.id, key: decision.team.key, name: decision.team.name }
        : null,
      minimumSkillLevel: decision.minSkillLevel,
      minimumSkillName: routingService.skillName(decision.minSkillLevel),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
