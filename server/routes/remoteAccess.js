// Remote access session endpoints.
//
// All rules live in src/services/remoteAccessService.js; this router only
// authenticates, parses parameters, and shapes responses. Reads follow the
// ticket rule — any authenticated agent who can read the ticket sees its
// sessions — while every write is authorized per transition in the service.
//
// There is deliberately no endpoint that accepts connection data: the
// foundation stores no credentials, hosts or connection strings anywhere.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { requireAuth } = require('../src/authMiddleware');
const remoteAccessService = require('../src/services/remoteAccessService');

const router = express.Router();
router.use(requireAuth);

/** Optional free-text field: trim to nothing -> undefined (null at rest). */
function optionalText(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || undefined;
}

// POST /api/remote-access — request a session: { ticketId, agentId?, note? }
// agentId (who conducts it) defaults to the caller; only an administrator
// may name somebody else.
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const ticketId = Number(body.ticketId);
    if (!Number.isInteger(ticketId)) {
      return res.status(400).json({ error: 'ticketId must be a ticket id' });
    }
    let agentId = null;
    if (body.agentId !== undefined && body.agentId !== null && body.agentId !== '') {
      agentId = Number(body.agentId);
      if (!Number.isInteger(agentId)) {
        return res.status(400).json({ error: 'agentId must be an agent id' });
      }
    }
    const result = await remoteAccessService.createSession({
      ticketId,
      agentId,
      actor: req.agent,
      note: optionalText(body.note),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/remote-access/ticket/:ticketId — the ticket's session history,
// newest first. Stale unstarted requests are expired lazily on read.
router.get('/ticket/:ticketId', async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    if (!Number.isInteger(ticketId)) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ sessions: await remoteAccessService.listForTicket(ticketId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/remote-access/:id/start — requested -> active (agent or admin)
router.post('/:id/start', async (req, res) => {
  try {
    const result = await remoteAccessService.startSession({
      sessionId: Number(req.params.id),
      actor: req.agent,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/remote-access/:id/end — active -> ended (agent or admin)
router.post('/:id/end', async (req, res) => {
  try {
    const result = await remoteAccessService.endSession({
      sessionId: Number(req.params.id),
      actor: req.agent,
      reason: optionalText(req.body && req.body.reason),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/remote-access/:id/cancel — live -> cancelled
// (the session's agent, its requester, or an administrator)
router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await remoteAccessService.cancelSession({
      sessionId: Number(req.params.id),
      actor: req.agent,
      reason: optionalText(req.body && req.body.reason),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
