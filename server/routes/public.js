// Public (unauthenticated) requester-facing endpoints.
//
// Two surfaces, both token-gated and rate-limited:
//   GET  /api/public/ticket-status      — the self-service status view the
//                                         acknowledgement email's link opens.
//   POST /api/public/confirm-resolution — the requester's "yes, it's resolved"
//                                         button; closes their RESOLVED ticket.
//
// The token is the credential, the responses carry only the ticket's public
// face, and the limiter makes blind token probing impractical. A wrong or
// forged token is indistinguishable from an unknown ticket (404) on both.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { rateLimit } = require('../src/rateLimit');
const statusLink = require('../src/email/statusLink');
const auditService = require('../src/services/auditService');
const notificationService = require('../src/mailer');

const router = express.Router();

const statusLimiter = rateLimit({
  windowMs: Number(process.env.STATUS_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000,
  max: Number(process.env.STATUS_RATE_LIMIT_MAX) || 30,
  keyFn: (req) => `status|${req.ip}`,
  message: 'Too many requests — wait a few minutes and try again',
});

/**
 * The public face of a ticket for both endpoints — the same fields the status
 * page already showed requesters, never bodies, comments or agent details.
 */
const PUBLIC_SELECT = {
  id: true,
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
};

// GET /api/public/ticket-status?token=… — the requester's live view of their
// own ticket. A wrong or forged token is indistinguishable from an unknown
// ticket (404), so probing learns nothing.
router.get('/ticket-status', statusLimiter, async (req, res) => {
  try {
    const claims = statusLink.verifyToken(req.query.token);
    if (!claims) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = await prisma.ticket.findFirst({
      where: { id: claims.ticketId, requesterEmail: { equals: claims.email, mode: 'insensitive' } },
      select: PUBLIC_SELECT,
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/public/confirm-resolution { token } — the "Yes, it's resolved"
// button on the confirmation page.
//
// Closes the ticket ONLY from RESOLVED, by compare-and-set: a concurrent
// reopen (a requester reply arriving first), a manual agent close, or the
// auto-close sweep racing the same click cannot be overwritten. The winner's
// state stands; the loser is told the ticket is no longer awaiting their
// confirmation rather than silently "succeeding".
//
// The GET that shows the page closes nothing (mail scanners prefetch links);
// only this POST does.
router.post('/confirm-resolution', statusLimiter, async (req, res) => {
  try {
    const claims = statusLink.verifyToken(req.body && req.body.token);
    if (!claims) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = await prisma.ticket.findFirst({
      where: { id: claims.ticketId, requesterEmail: { equals: claims.email, mode: 'insensitive' } },
      select: { id: true, ticketNumber: true },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // A requester cannot use an agent's close route (it is authenticated), and
    // cannot confirm a NEW/IN_PROGRESS ticket: the token proves mailbox access,
    // not the right to move an unfinished ticket. CAS closes from RESOLVED only.
    const closed = await prisma.ticket.updateMany({
      where: { id: ticket.id, state: 'RESOLVED' },
      data: {
        state: 'CLOSED',
        closedAt: new Date(),
      },
    });
    if (closed.count === 0) {
      const current = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        select: { state: true },
      });
      return res.status(409).json({
        error:
          current && current.state === 'CLOSED'
            ? 'Ticket is already closed'
            : 'Ticket is no longer awaiting confirmation',
      });
    }

    // The same trail an agent close writes, with the requester (an email, not
    // an Agent row) as the string actor — the intake reopen path's convention.
    await prisma.ticketAuditLog.create({
      data: {
        ticketId: ticket.id,
        fromState: 'RESOLVED',
        toState: 'CLOSED',
        actor: claims.email,
        note: 'Closed by requester confirmation',
      },
    });
    await auditService.record(prisma, {
      action: 'ticket.closed',
      entityType: 'Ticket',
      entityId: ticket.id,
      entityLabel: ticket.ticketNumber,
      ticketId: ticket.id,
      actor: claims.email,
      from: { state: 'RESOLVED' },
      to: { state: 'CLOSED' },
      description: `${ticket.ticketNumber} closed by requester confirmation`,
      metadata: { via: 'resolution_confirmation' },
    });

    // Tell the currently assigned agent (if any) their ticket was confirmed —
    // same target policy as the reply alert: assignee first, no DL fallback
    // for confirmation (it is not urgent). In-app notification only; the
    // requester receives no email back (the page itself is the receipt).
    const full = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { assignedAgent: { select: { id: true, email: true, name: true } } },
    });
    if (full && full.assignedAgent && full.assignedAgent.email) {
      await prisma.notification.create({
        data: {
          agentId: full.assignedAgent.id,
          ticketId: full.id,
          type: 'ticket_closed_by_requester',
          title: `${full.ticketNumber} confirmed resolved by the requester`,
          body: 'The requester confirmed the resolution — the ticket is now closed.',
        },
      }).catch(() => {});
    }

    res.json({
      state: 'CLOSED',
      ticketNumber: ticket.ticketNumber,
      shortDescription: full ? full.shortDescription : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
