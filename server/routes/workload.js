// Workload, availability and rebalancing endpoints.
//
// All rules live in src/services/workloadService.js; this router validates,
// authorises and shapes responses.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { requireAuth, sanitizeAgent } = require('../src/authMiddleware');
const workloadService = require('../src/services/workloadService');
const { isAdmin } = require('../src/services/assignmentPolicy');
const handoverService = require('../src/services/handoverService');

const router = express.Router();
router.use(requireAuth);

/* ---- workload ------------------------------------------------------- */

// GET /api/workload — every agent's active workload plus the imbalance figure
router.get('/', async (req, res) => {
  try {
    res.json(await workloadService.workloadSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workload/me — the caller's own workload
router.get('/me', async (req, res) => {
  try {
    const openTickets = await workloadService.workloadFor(req.agent.id);
    const [inProgress, newCount] = await Promise.all([
      prisma.ticket.count({ where: { assignedAgentId: req.agent.id, state: 'IN_PROGRESS' } }),
      prisma.ticket.count({ where: { assignedAgentId: req.agent.id, state: 'NEW' } }),
    ]);
    res.json({
      agentId: req.agent.id,
      openTickets,
      newTickets: newCount,
      inProgressTickets: inProgress,
      available: req.agent.isAvailable,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- availability (self-service) ------------------------------------ */

// GET /api/workload/availability/preview — what happens if I go unavailable?
router.get('/availability/preview', async (req, res) => {
  try {
    res.json(await workloadService.previewUnavailability(req.agent.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/workload/availability
 * Body: { available: boolean, confirmReassign?: boolean }
 *
 * An agent controls their own availability. Going unavailable is blocked while
 * they hold IN_PROGRESS work, and requires confirmation when NEW tickets would
 * be handed over. An administrator uses PATCH /api/agents/:id (with force) for
 * anyone else.
 */
router.post('/availability', async (req, res) => {
  try {
    const wantAvailable = Boolean(req.body.available);

    if (wantAvailable) {
      const updated = await prisma.agent.update({
        where: { id: req.agent.id },
        data: { isAvailable: true },
        include: { team: true },
      });
      await prisma.userAuditLog.create({
        data: {
          agentId: req.agent.id,
          action: 'availability_changed',
          field: 'isAvailable',
          fromValue: 'false',
          toValue: 'true',
          actor: `${req.agent.name} <${req.agent.email}>`,
          note: 'Marked themselves available',
        },
      });
      // Any handover request that was waiting for them resumes its clock.
      await handoverService.onAvailabilityChanged(req.agent.id, true);
      return res.json({ ...sanitizeAgent(updated), isAvailable: updated.isAvailable, reassigned: null });
    }

    const preview = await workloadService.previewUnavailability(req.agent.id);

    // In-progress work blocks the change: it should be finished or handed over
    // deliberately, not dropped.
    if (preview.blocked) {
      return res.status(409).json({
        error: preview.message,
        blocked: true,
        inProgress: preview.inProgress,
        // Where to go to deal with them.
        findThemAt: '/tickets?assignee=me&state=IN_PROGRESS',
      });
    }

    // NEW tickets will move, so the agent confirms first.
    if (preview.requiresConfirmation && req.body.confirmReassign !== true) {
      return res.status(409).json({
        error: preview.message,
        confirmationRequired: true,
        newTickets: preview.newTickets,
      });
    }

    const summary = await workloadService.reassignOpenTicketsFor(req.agent.id, {
      actor: req.agent,
      reason: `${req.agent.name} marked themselves unavailable`,
      states: ['NEW'],
      notificationType: 'self',
    });

    const updated = await prisma.agent.update({
      where: { id: req.agent.id },
      data: { isAvailable: false },
      include: { team: true },
    });
    await prisma.userAuditLog.create({
      data: {
        agentId: req.agent.id,
        action: 'availability_changed',
        field: 'isAvailable',
        fromValue: 'true',
        toValue: 'false',
        actor: `${req.agent.name} <${req.agent.email}>`,
        note: `Marked themselves unavailable; ${summary.moved} ticket(s) reassigned, ${summary.unassigned} left for triage`,
      },
    });

    // Requirement 4: time away must not cost somebody a handover request, so
    // the expiry clock on anything waiting for them is paused.
    await handoverService.onAvailabilityChanged(req.agent.id, false);

    res.json({ ...sanitizeAgent(updated), isAvailable: updated.isAvailable, reassigned: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- notifications --------------------------------------------------- */

// GET /api/workload/notifications — the caller's in-app feed
router.get('/notifications', async (req, res) => {
  try {
    const events = await prisma.notification.findMany({
      where: { agentId: req.agent.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { ticket: { select: { id: true, ticketNumber: true, shortDescription: true, state: true } } },
    });
    res.json({
      unread: events.filter((e) => !e.readAt).length,
      notifications: events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workload/notifications/read — mark all (or some) as read
router.post('/notifications/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Number.isInteger) : null;
    const result = await prisma.notification.updateMany({
      where: { agentId: req.agent.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    res.json({ marked: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---- rebalancing (admin) -------------------------------------------- */

// POST /api/workload/rebalance — run one bounded balancing cycle now
router.post('/rebalance', async (req, res) => {
  try {
    if (!isAdmin(req.agent)) {
      return res.status(403).json({ error: 'Administrator role required' });
    }
    const dryRun = req.body && req.body.dryRun === true;
    if (dryRun) {
      const preview = await workloadService.rebalanceOnce({ actor: req.agent, client: prisma, dryRun: true });
      return res.json({ dryRun: true, next: preview });
    }
    const maxMoves = Number.isInteger(req.body && req.body.maxMoves)
      ? Math.min(req.body.maxMoves, workloadService.MAX_MOVES_PER_CYCLE)
      : undefined;
    const result = await workloadService.rebalanceCycle({ actor: req.agent, maxMoves });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
