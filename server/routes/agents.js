const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { requireAdmin, sanitizeAgent } = require('../src/authMiddleware');
const { OPEN_STATES } = require('../src/states');
const userService = require('../src/services/userService');
const workloadService = require('../src/services/workloadService');
const handoverService = require('../src/services/handoverService');

const router = express.Router();
router.use(requireAdmin);

const SKILL_LEVELS = { min: 1, max: 3 };

function validateSkillLevel(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= SKILL_LEVELS.min && n <= SKILL_LEVELS.max ? n : null;
}

// GET /api/agents — agents with group, skill, availability and open workload
router.get('/', async (req, res) => {
  try {
    const [agents, teams] = await Promise.all([
      prisma.agent.findMany({
        orderBy: [{ teamId: 'asc' }, { name: 'asc' }],
        include: {
          team: true,
          _count: {
            select: { assignedTickets: { where: { state: { in: OPEN_STATES } } } },
          },
        },
      }),
      prisma.team.findMany({ orderBy: { key: 'asc' } }),
    ]);
    res.json({
      teams,
      roles: userService.ROLE_VALUES,
      agents: agents.map((a) => ({
        ...sanitizeAgent(a),
        isActive: a.isActive,
        isAvailable: a.isAvailable,
        skillLevel: a.skillLevel,
        assignmentGroup: a.team ? a.team.name : null,
        assignmentGroupKey: a.team ? a.team.key : null,
        externalIdentityId: a.externalId,
        externalProvider: a.externalProvider,
        lastAssignedAt: a.lastAssignedAt,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        openWorkload: a._count.assignedTickets,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents
router.post('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    // Default to AGENT. An admin may provision any valid role explicitly;
    // there is no path for a non-admin to reach this route at all.
    let role = userService.ROLES.AGENT;
    if (req.body.role !== undefined) {
      if (!userService.isValidRole(req.body.role)) {
        return res
          .status(400)
          .json({ error: `role must be one of: ${userService.ROLE_VALUES.join(', ')}` });
      }
      role = req.body.role;
    }
    const teamKey = req.body.teamKey || req.body.assignmentGroup || null;
    let skillLevel = 1;
    if (req.body.skillLevel !== undefined) {
      const parsed = validateSkillLevel(req.body.skillLevel);
      if (!parsed) {
        return res
          .status(400)
          .json({ error: `skillLevel must be an integer between ${SKILL_LEVELS.min} and ${SKILL_LEVELS.max}` });
      }
      skillLevel = parsed;
    }
    if (!name || !email || password.length < 8) {
      return res
        .status(400)
        .json({ error: 'name, email and a password of at least 8 characters are required' });
    }
    const team = teamKey ? await prisma.team.findUnique({ where: { key: String(teamKey) } }) : null;
    if (teamKey && !team) return res.status(400).json({ error: `unknown assignment group "${teamKey}"` });

    const agent = await prisma.agent.create({
      data: {
        name,
        email,
        role,
        teamId: team ? team.id : null,
        skillLevel,
        passwordHash: bcrypt.hashSync(password, 10),
      },
      include: { team: true },
    });
    await userService.recordUserCreated(agent, req.agent);
    res.status(201).json(sanitizeAgent(agent));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'An agent with that email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/agents/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Agent not found' });
    const existing = await prisma.agent.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Agent not found' });

    const changes = {};
    const errors = [];

    // isActive = may sign in at all. isAvailable = accepting new work.
    // They are separate concepts and each has its own field.
    if (req.body.isActive !== undefined) changes.isActive = Boolean(req.body.isActive);
    if (req.body.isAvailable !== undefined) changes.isAvailable = Boolean(req.body.isAvailable);
    if (req.body.available !== undefined) changes.isAvailable = Boolean(req.body.available); // alias

    if (req.body.name !== undefined && String(req.body.name).trim()) {
      changes.name = String(req.body.name).trim();
    }
    if (req.body.role !== undefined) {
      if (!userService.isValidRole(req.body.role)) {
        errors.push(`role must be one of: ${userService.ROLE_VALUES.join(', ')}`);
      } else {
        changes.role = req.body.role;
      }
    }
    if (req.body.skillLevel !== undefined) {
      const parsed = validateSkillLevel(req.body.skillLevel);
      if (!parsed) errors.push(`skillLevel must be an integer between ${SKILL_LEVELS.min} and ${SKILL_LEVELS.max}`);
      else changes.skillLevel = parsed;
    }
    if (req.body.teamKey !== undefined || req.body.assignmentGroup !== undefined) {
      const key = req.body.teamKey ?? req.body.assignmentGroup;
      if (key === null) changes.teamId = null;
      else {
        const team = await prisma.team.findUnique({ where: { key: String(key) } });
        if (!team) errors.push(`unknown assignment group "${key}"`);
        else changes.teamId = team.id;
      }
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) errors.push('password must be at least 8 characters');
      else changes.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
    }
    if (errors.length) return res.status(400).json({ errors });

    // Role and administrator-count rules live in userService so the API, the
    // seed scripts and future Entra provisioning cannot disagree.
    const verdict = await userService.checkUserUpdate(existing, req.agent, changes);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    // Requirement 9: an administrator CAN force an agent off even with work in
    // progress, but it is disruptive, so it takes an explicit `force` flag.
    // Deactivation is already an explicit act and needs no second confirmation.
    if (changes.isAvailable === false && existing.isAvailable && req.body.force !== true) {
      const preview = await workloadService.previewUnavailability(id);
      if (preview.blocked) {
        return res.status(409).json({
          error:
            `${existing.name} has ${preview.inProgress.length} ticket(s) in progress. ` +
            'Re-send with { "force": true } to override and reassign them.',
          blocked: true,
          inProgress: preview.inProgress,
          newTickets: preview.newTickets,
        });
      }
    }

    const { user: updated } = await userService.applyUserUpdate(existing, req.agent, changes);

    // Work is handed on through the normal assignment algorithm rather than
    // simply dropped, so tickets keep an owner wherever one exists.
    let reassigned = null;
    const deactivated = changes.isActive === false && existing.isActive;
    const forcedUnavailable = changes.isAvailable === false && existing.isAvailable;

    if (deactivated || forcedUnavailable) {
      reassigned = await workloadService.reassignOpenTicketsFor(id, {
        actor: req.agent,
        reason: deactivated
          ? `${existing.name} was deactivated by an administrator`
          : `${existing.name} was marked unavailable by an administrator`,
        notificationType: 'availability_forced',
      });
    }

    // Handovers follow the same two rules: a deactivated recipient cannot
    // answer, so their requests are routed on; a merely unavailable one keeps
    // theirs with the expiry clock paused.
    let handovers = null;
    if (deactivated) {
      handovers = await handoverService.onAgentDeactivated(id, req.agent);
    } else if (changes.isAvailable !== undefined && changes.isAvailable !== existing.isAvailable) {
      handovers = await handoverService.onAvailabilityChanged(id, changes.isAvailable);
    }

    if (changes.teamId !== undefined && changes.teamId !== existing.teamId && !deactivated && !forcedUnavailable) {
      await prisma.ticket.updateMany({
        where: { assignedAgentId: id, state: 'NEW' },
        data: { assignedAgentId: null },
      });
    }
    res.json({
      ...sanitizeAgent(updated),
      isActive: updated.isActive,
      isAvailable: updated.isAvailable,
      skillLevel: updated.skillLevel,
      // Present when this change handed work on to other agents.
      reassigned,
      // Present when this change affected outstanding handover requests.
      handovers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/audit — administrative history for one user
router.get('/:id/audit', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'User not found' });
    const events = await prisma.userAuditLog.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ agentId: id, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
