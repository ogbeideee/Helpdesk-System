const prisma = require('../lib/prisma');
const { STATES, OPEN_STATES } = require('../states');
const slaService = require('../slaService');

async function snapshot(client = prisma) {
  const [rows, agents, teams, recent, sla] = await Promise.all([
    // One aggregate supplies all queue breakdowns from the same read instead
    // of eight independent counts competing with the ticket queue.
    client.ticket.groupBy({ by: ['state', 'priority', 'category', 'teamId', 'assignedAgentId'], _count: { _all: true } }),
    client.agent.findMany({ where: { isActive: true }, orderBy: [{ teamId: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, email: true, skillLevel: true, teamId: true, team: true } }),
    client.team.findMany({ orderBy: { key: 'asc' } }),
    client.ticket.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: {
      id: true, ticketNumber: true, shortDescription: true, state: true, priority: true,
      category: true, requesterEmail: true, createdAt: true,
    } }),
    slaService.dashboardSlaStats({ client }),
  ]);
  const byState = Object.fromEntries(STATES.map(state => [state, 0]));
  const teamNames = new Map(teams.map(team => [team.id, team.name]));
  const ticketsPerGroup = Object.fromEntries(teams.map(team => [team.name, 0]));
  const perAgent = new Map();
  const byPriority = {};
  const byCategory = {};
  let totalOpen = 0;
  let unassigned = 0;
  let critical = 0;
  for (const row of rows) {
    const count = row._count._all;
    byState[row.state] = (byState[row.state] || 0) + count;
    if (!OPEN_STATES.includes(row.state)) continue;
    totalOpen += count;
    if (row.assignedAgentId === null) unassigned += count;
    if (row.priority === 'critical') critical += count;
    byPriority[row.priority] = (byPriority[row.priority] || 0) + count;
    byCategory[row.category] = (byCategory[row.category] || 0) + count;
    const group = teamNames.get(row.teamId) || 'Unassigned / Triage';
    ticketsPerGroup[group] = (ticketsPerGroup[group] || 0) + count;
    perAgent.set(row.assignedAgentId, (perAgent.get(row.assignedAgentId) || 0) + count);
  }
  return { totalOpen, counts: { new: byState.NEW, inProgress: byState.IN_PROGRESS, resolved: byState.RESOLVED, closed: byState.CLOSED },
    unassigned, critical, byPriority, byCategory, ticketsPerGroup,
    ticketsPerAgent: agents.map(agent => ({ agentId: agent.id, name: agent.name, email: agent.email,
      assignmentGroup: agent.team?.name || null, skillLevel: agent.skillLevel, openTickets: perAgent.get(agent.id) || 0 })),
    recentlyCreated: recent, sla, generatedAt: new Date().toISOString(),
  };
}
module.exports = { snapshot };
