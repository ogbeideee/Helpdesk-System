// Admin CRUD for the email parsing rules (keyword rules the parser evaluates
// on inbound mail). Mounted behind requireAdmin in server.js. Responses carry
// the structured rule rows only — no message content ever flows through here.
const express = require('express');
const prisma = require('../src/lib/prisma');
const ruleService = require('../src/services/emailParsingRuleService');

const router = express.Router();

function actorLabel(agent) {
  return agent ? `${agent.name} <${agent.email}>` : 'system';
}

function handleValidationError(res, err) {
  if (err instanceof ruleService.RuleValidationError) {
    return res.status(400).json({ errors: err.errors });
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    res.json({ rules: await ruleService.listRules(prisma) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const rule = await ruleService.getRule(req.params.id, prisma);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const rule = await ruleService.createRule(req.body || {}, req.agent, prisma);
    res.status(201).json({ rule });
  } catch (err) {
    if (handleValidationError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const rule = await ruleService.updateRule(req.params.id, req.body || {}, req.agent, prisma);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule });
  } catch (err) {
    if (handleValidationError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await ruleService.deleteRule(req.params.id, req.agent, prisma);
    if (!result) return res.status(404).json({ error: 'Rule not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
