// Handover endpoints.
//
// All rules live in src/services/handoverService.js; this router only
// authenticates, authorises the caller against the request in front of it, and
// shapes responses.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { requireAuth } = require('../src/authMiddleware');
const handoverService = require('../src/services/handoverService');
const settingsService = require('../src/services/settingsService');
const { isAdmin } = require('../src/services/assignmentPolicy');

const router = express.Router();
router.use(requireAuth);

/* ---- settings (limit + expiry) --------------------------------------- */

// GET /api/handovers/settings — anybody may read them (the UI shows the limit)
router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await settingsService.getAll(), definitions: settingsService.describe() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/handovers/settings — administrators only
router.patch('/settings', async (req, res) => {
  try {
    if (!isAdmin(req.agent)) return res.status(403).json({ error: 'Administrator role required' });
    const result = await settingsService.update(req.body || {}, `${req.agent.name} <${req.agent.email}>`);
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json({ settings: result.settings, definitions: settingsService.describe() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- my requests ----------------------------------------------------- */

// GET /api/handovers/inbox — requests waiting for me to answer, plus my queue
router.get('/inbox', async (req, res) => {
  try {
    res.json(await handoverService.inboxFor(req.agent.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/handovers/outbox — requests I raised that are still open
router.get('/outbox', async (req, res) => {
  try {
    res.json({ requests: await handoverService.outboxFor(req.agent.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- responding ------------------------------------------------------ */

/**
 * Load the request and check the caller may act on it.
 * `who` is 'target' (accept/decline/suggest) or 'requester' (cancel).
 * An administrator may always act — requirement 8.
 */
async function loadFor(req, res, who) {
  const id = Number(req.params.id);
  const request = await handoverService.findById(id);
  if (!request) {
    res.status(404).json({ error: 'Handover request not found' });
    return null;
  }
  if (isAdmin(req.agent)) return request;

  if (who === 'target' && request.targetAgentId !== req.agent.id) {
    res.status(403).json({ error: 'Only the agent this handover was sent to can answer it' });
    return null;
  }
  if (who === 'requester' && request.requestedById !== req.agent.id) {
    res.status(403).json({ error: 'Only the agent who raised this handover can cancel it' });
    return null;
  }
  return request;
}

// POST /api/handovers/:id/accept — ownership transfers immediately
router.post('/:id/accept', async (req, res) => {
  try {
    const request = await loadFor(req, res, 'target');
    if (!request) return;
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: `This handover is ${request.status.toLowerCase()}` });
    }
    const result = await handoverService.accept({ request, actor: req.agent, note: req.body && req.body.note });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/handovers/:id/decline — the ticket stays with the original agent
router.post('/:id/decline', async (req, res) => {
  try {
    const request = await loadFor(req, res, 'target');
    if (!request) return;
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: `This handover is ${request.status.toLowerCase()}` });
    }
    const result = await handoverService.decline({
      request,
      actor: req.agent,
      note: req.body && req.body.note,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/handovers/:id/suggest — decline, but propose somebody else.
 *
 * Deliberately does NOT create a request for the suggested agent: it is shown
 * to the original agent, who decides whether to ask them (requirement 2).
 */
router.post('/:id/suggest', async (req, res) => {
  try {
    const request = await loadFor(req, res, 'target');
    if (!request) return;
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: `This handover is ${request.status.toLowerCase()}` });
    }
    if (!Number.isInteger(req.body && req.body.agentId)) {
      return res.status(400).json({ error: 'agentId is required' });
    }
    const result = await handoverService.decline({
      request,
      actor: req.agent,
      note: req.body.note,
      suggestedAgentId: req.body.agentId,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ...result, suggestionOnly: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/handovers/:id/cancel — requester (or an admin) withdraws it
router.post('/:id/cancel', async (req, res) => {
  try {
    const request = await loadFor(req, res, 'requester');
    if (!request) return;
    const result = await handoverService.cancel({
      request,
      actor: req.agent,
      reason: req.body && req.body.reason,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/handovers/:id/override — ADMIN forces the transfer through
router.post('/:id/override', async (req, res) => {
  try {
    if (!isAdmin(req.agent)) return res.status(403).json({ error: 'Administrator role required' });
    const request = await handoverService.findById(Number(req.params.id));
    if (!request) return res.status(404).json({ error: 'Handover request not found' });
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: `This handover is ${request.status.toLowerCase()}` });
    }
    const result = await handoverService.override({ request, actor: req.agent });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/handovers/sweep — run the expiry sweep now (admin; used by tests)
router.post('/sweep', async (req, res) => {
  try {
    if (!isAdmin(req.agent)) return res.status(403).json({ error: 'Administrator role required' });
    res.json(await handoverService.sweepExpired({ client: prisma }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
