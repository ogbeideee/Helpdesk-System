const express = require('express');
const prisma = require('../src/lib/prisma');
const { STATES, PRIORITIES, OPEN_STATES } = require('../src/states');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [total, byStateRows, byPriorityRows, openCritical, overdue, unassigned, byTeamRows, recentRaw] =
      await Promise.all([
        prisma.ticket.count(),
        prisma.ticket.groupBy({ by: ['state'], _count: { _all: true } }),
        prisma.ticket.groupBy({ by: ['priority'], _count: { _all: true } }),
        prisma.ticket.count({
          where: { priority: 'critical', state: { notIn: ['RESOLVED', 'CLOSED'] } },
        }),
        prisma.ticket.count({
          where: {
            dueAt: { lt: new Date() },
            state: { in: OPEN_STATES },
          },
        }),
        prisma.ticket.count({
          where: { assignedAgentId: null, state: { in: OPEN_STATES } },
        }),
        prisma.ticket.groupBy({
          by: ['teamId'],
          _count: { _all: true },
          where: { state: { in: OPEN_STATES } },
        }),
        prisma.ticket.findMany({
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            ticketNumber: true,
            shortDescription: true,
            state: true,
            priority: true,
            category: true,
            updatedAt: true,
          },
        }),
      ]);

    const teams = await prisma.team.findMany();
    const teamNameById = Object.fromEntries(teams.map((t) => [t.id, t.name]));

    const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const row of byStateRows) byState[row.state] = row._count._all;

    const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
    for (const row of byPriorityRows) byPriority[row.priority] = row._count._all;

    const byTeam = {};
    for (const t of teams) byTeam[t.name] = 0;
    for (const row of byTeamRows) {
      const name = teamNameById[row.teamId] || 'Unassigned / Triage';
      byTeam[name] = (byTeam[name] || 0) + row._count._all;
    }

    res.json({ total, byState, byPriority, openCritical, overdue, unassigned, byTeam, recent: recentRaw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
