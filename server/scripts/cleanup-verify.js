const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const t = await prisma.ticket.findFirst({ where: { graphMessageId: 'final-verify-001' } });
  if (t) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
  }
  console.log('cleaned:', t ? t.ticketNumber : 'nothing to clean');
})()
  .finally(() => prisma.$disconnect());
