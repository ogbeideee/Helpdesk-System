// GET /api/dashboard — operational overview for the helpdesk.
const express = require('express');
const prisma = require('../src/lib/prisma');
const { STATES, OPEN_STATES } = require('../src/states');
const slaService = require('../src/slaService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [
      totalOpen,
      byStateRows,
      unassigned,
      critical,
      agents,
      teams,
      perGroupRows,
      recentlyCreated,
      byPriorityRows,
      byCategoryRows,
      slaStats,
    ] = await Promise.all([
      prisma.ticket.count({ where: { state: { in: OPEN_STATES } } }),
      prisma.ticket.groupBy({ by: ['state'], _count: { _all: true } }),
      prisma.ticket.count({
        where: { state: { in: OPEN_STATES }, assignedAgentId: null },
      }),
      prisma.ticket.count({
        where: { priority: 'critical', state: { in: OPEN_STATES } },
      }),
      prisma.agent.findMany({
        where: { isActive: true },
        orderBy: [{ teamId: 'asc' }, { name: 'asc' }],
        include: {
          team: true,
          _count: {
            select: { assignedTickets: { where: { state: { in: OPEN_STATES } } } },
          },
        },
      }),
      prisma.team.findMany({ orderBy: { key: 'asc' } }),
      prisma.ticket.groupBy({
        by: ['teamId'],
        _count: { _all: true },
        where: { state: { in: OPEN_STATES } },
      }),
      prisma.ticket.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          ticketNumber: true,
          shortDescription: true,
          state: true,
          priority: true,
          category: true,
          requesterEmail: true,
          createdAt: true,
        },
      }),
      // Breakdowns over open tickets
      prisma.ticket.groupBy({
        by: ['priority'],
        _count: { _all: true },
        where: { state: { in: OPEN_STATES } },
      }),
      prisma.ticket.groupBy({
        by: ['category'],
        _count: { _all: true },
        where: { state: { in: OPEN_STATES } },
      }),
      // SLA KPIs — computed by the SLA service from the cycle table, so the
      // dashboard never re-derives cycle outcomes or working-time math.
      slaService.dashboardSlaStats(),
    ]);

    const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const row of byStateRows) byState[row.state] = row._count._all;

    const teamNameById = Object.fromEntries(teams.map((t) => [t.id, t.name]));
    const ticketsPerGroup = Object.fromEntries(teams.map((t) => [t.name, 0]));
    for (const row of perGroupRows) {
      const name = teamNameById[row.teamId] || 'Unassigned / Triage';
      ticketsPerGroup[name] = (ticketsPerGroup[name] || 0) + row._count._all;
    }

    const ticketsPerAgent = agents.map((a) => ({
      agentId: a.id,
      name: a.name,
      email: a.email,
      assignmentGroup: a.team ? a.team.name : null,
      skillLevel: a.skillLevel,
      openTickets: a._count.assignedTickets,
    }));

    const byPriority = Object.fromEntries(
      byPriorityRows.map((r) => [r.priority, r._count._all])
    );
    const byCategory = Object.fromEntries(
      byCategoryRows.map((r) => [r.category, r._count._all])
    );

    res.json({
      totalOpen,
      counts: {
        new: byState.NEW,
        inProgress: byState.IN_PROGRESS,
        resolved: byState.RESOLVED,
        closed: byState.CLOSED,
      },
      unassigned,
      critical,
      byPriority,
      byCategory,
      ticketsPerAgent,
      ticketsPerGroup,
      recentlyCreated: recentlyCreated.map((t) => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        shortDescription: t.shortDescription,
        state: t.state,
        priority: t.priority,
        category: t.category,
        requesterEmail: t.requesterEmail,
        createdAt: t.createdAt,
      })),
      sla: slaStats,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
