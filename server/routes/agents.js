const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { requireAdmin, sanitizeAgent } = require('../src/authMiddleware');
const { OPEN_STATES } = require('../src/states');

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
      agents: agents.map((a) => ({
        ...sanitizeAgent(a),
        isActive: a.isActive,
        skillLevel: a.skillLevel,
        lastAssignedAt: a.lastAssignedAt,
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
    const role = req.body.role === 'admin' ? 'admin' : 'agent';
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

    const data = {};
    const errors = [];
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body.available !== undefined) data.isActive = Boolean(req.body.available); // alias
    if (req.body.name !== undefined && String(req.body.name).trim()) data.name = String(req.body.name).trim();
    if (req.body.role !== undefined) {
      if (!['agent', 'admin'].includes(req.body.role)) errors.push('role must be agent|admin');
      else data.role = req.body.role;
    }
    if (req.body.skillLevel !== undefined) {
      const parsed = validateSkillLevel(req.body.skillLevel);
      if (!parsed) errors.push(`skillLevel must be an integer between ${SKILL_LEVELS.min} and ${SKILL_LEVELS.max}`);
      else data.skillLevel = parsed;
    }
    if (req.body.teamKey !== undefined || req.body.assignmentGroup !== undefined) {
      const key = req.body.teamKey ?? req.body.assignmentGroup;
      if (key === null) data.teamId = null;
      else {
        const team = await prisma.team.findUnique({ where: { key: String(key) } });
        if (!team) errors.push(`unknown assignment group "${key}"`);
        else data.teamId = team.id;
      }
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) errors.push('password must be at least 8 characters');
      else data.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
    }
    if (errors.length) return res.status(400).json({ errors });

    const updated = await prisma.agent.update({
      where: { id },
      data,
      include: { team: true },
    });

    // Deactivating an agent releases their open tickets for reassignment;
    // moving them to another group releases only not-yet-started assignments.
    if (data.isActive === false) {
      await prisma.ticket.updateMany({
        where: { assignedAgentId: id, state: { in: OPEN_STATES } },
        data: { assignedAgentId: null },
      });
    } else if (data.teamId !== undefined) {
      await prisma.ticket.updateMany({
        where: { assignedAgentId: id, state: 'NEW' },
        data: { assignedAgentId: null },
      });
    }
    res.json(sanitizeAgent(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
