const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const tickets = await prisma.ticket.count();
  const agents = await prisma.agent.count();
  console.log('tickets:', tickets, ' agents:', agents);
  const byState = await prisma.ticket.groupBy({ by: ['state'], _count: { _all: true } });
  console.log(byState.map((r) => `${r.state}=${r._count._all}`).join('  '));
})()
  .finally(() => prisma.$disconnect());
