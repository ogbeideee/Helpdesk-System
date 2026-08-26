// One-time data migration for the v2 workflow model:
//   - priority "medium"  -> "moderate"
//   - state ASSIGNED     -> NEW        (routed but not started)
//   - state ON_HOLD      -> IN_PROGRESS
//   - seeds the global INC- sequence past any legacy HD- numbers
//
// Usage: npm run db:migrate-v2   (from server/)
const prisma = require('../src/lib/prisma');

async function main() {
  const prio = await prisma.ticket.updateMany({
    where: { priority: 'medium' },
    data: { priority: 'moderate' },
  });
  console.log(`priority medium -> moderate: ${prio.count} ticket(s)`);

  const assigned = await prisma.ticket.updateMany({
    where: { state: 'ASSIGNED' },
    data: { state: 'NEW' },
  });
  console.log(`state ASSIGNED -> NEW: ${assigned.count} ticket(s)`);

  const hold = await prisma.ticket.updateMany({
    where: { state: 'ON_HOLD' },
    data: { state: 'IN_PROGRESS' },
  });
  console.log(`state ON_HOLD -> IN_PROGRESS: ${hold.count} ticket(s)`);

  // Continue the INC numbering after the highest existing numeric suffix.
  const tickets = await prisma.ticket.findMany({ select: { ticketNumber: true } });
  let maxSuffix = 0;
  for (const t of tickets) {
    const m = /-(\d+)$/.exec(t.ticketNumber || '');
    if (m) maxSuffix = Math.max(maxSuffix, Number(m[1]));
  }
  if (maxSuffix > 0) {
    await prisma.ticketSequence.upsert({
      where: { year: 0 },
      create: { year: 0, last: maxSuffix },
      update: { last: maxSuffix },
    });
  }
  console.log(`INC sequence positioned at ${maxSuffix}`);

  // Legacy per-year HD rows are no longer used by the generator.
  console.log('Migration complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
