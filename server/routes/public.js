// Public (unauthenticated) requester-facing endpoints.
//
// Currently: the self-service ticket-status lookup the acknowledgement and
// status-update emails link to. Everything here is reachable without a
// session, so keep it minimal and rate-limited: the token is the credential,
// the response carries only the ticket's public face, and the limiter makes
// blind token probing impractical.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { rateLimit } = require('../src/rateLimit');
const statusLink = require('../src/email/statusLink');

const router = express.Router();

const statusLimiter = rateLimit({
  windowMs: Number(process.env.STATUS_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000,
  max: Number(process.env.STATUS_RATE_LIMIT_MAX) || 30,
  keyFn: (req) => `status|${req.ip}`,
  message: 'Too many requests — wait a few minutes and try again',
});

// GET /api/public/ticket-status?token=… — the requester's live view of their
// own ticket. A wrong or forged token is indistinguishable from an unknown
// ticket (404), so probing learns nothing.
router.get('/ticket-status', statusLimiter, async (req, res) => {
  try {
    const claims = statusLink.verifyToken(req.query.token);
    if (!claims) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = await prisma.ticket.findFirst({
      where: { id: claims.ticketId, requesterEmail: { equals: claims.email, mode: 'insensitive' } },
      select: {
        ticketNumber: true,
        shortDescription: true,
        category: true,
        priority: true,
        state: true,
        resolution: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
        dueAt: true,
      },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
