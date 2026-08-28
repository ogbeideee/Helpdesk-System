// One-time database initialization for a real installation:
//   1. Seeds the assignment groups (including the General IT Support fallback)
//   2. Seeds the default routing rules, if none exist yet
//   3. Runs the initial-administrator bootstrap from INITIAL_ADMIN_EMAIL
//   4. Backfills ticketNumber for any pre-existing tickets
//
// Usage: npm run db:init   (from server/)
//
// It deliberately creates NO sample agents and sets NO default passwords. The
// only account it can produce is the one named by INITIAL_ADMIN_EMAIL, created
// without a password: sign-in then needs either the identity provider or a
// password set explicitly by an administrator. Demo data lives in
// scripts/seed-demo.js and is never run from here.
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');
const userService = require('../src/services/userService');

// Only tickets that have NO number at all. The old condition skipped anything
// already starting with "HD-", which meant re-running db:init renumbered every
// ticket created under the current INC- scheme — destroying the reference
// customers and agents have been given. ticketNumber is non-nullable now, so
// in practice this finds nothing and exists only for pre-numbering databases.
async function backfillTicketNumbers() {
  const legacy = await prisma.ticket.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  let assigned = 0;
  for (const t of legacy) {
    if (t.ticketNumber && t.ticketNumber.trim()) continue;
    const year = new Date(t.createdAt).getFullYear();
    const seq = await prisma.ticketSequence.upsert({
      where: { year },
      create: { year, last: 1 },
      update: { last: { increment: 1 } },
    });
    await prisma.ticket.update({
      where: { id: t.id },
      data: {
        ticketNumber: `HD-${year}-${String(seq.last).padStart(6, '0')}`,
      },
    });
    assigned += 1;
  }
  return assigned;
}

async function main() {
  console.log('Seeding assignment groups…');
  await ensureTeams(prisma);
  const teams = await prisma.team.findMany();

  console.log('Seeding default routing rules…');
  await ensureDefaultRoutingRules({ client: prisma, logger: console });

  console.log('Running the initial-administrator bootstrap…');
  const bootstrap = await userService.bootstrapInitialAdmin({ logger: console });

  console.log('Backfilling ticket numbers for legacy tickets…');
  const count = await backfillTicketNumbers();

  const fallback = teams.find((t) => t.isDefault);
  console.log('\nDone.');
  console.log(`  Assignment groups: ${teams.map((t) => t.name).join(', ')}`);
  console.log(`  Default group:     ${fallback ? fallback.name : '(none)'}`);
  console.log(`  Administrator:     ${bootstrap.status}${bootstrap.email ? ` — ${bootstrap.email}` : ''}`);
  if (bootstrap.status === 'skipped') {
    console.log('    Set INITIAL_ADMIN_EMAIL in server/.env and re-run to provision the first administrator.');
  }
  console.log(`  Ticket numbers backfilled: ${count}`);
  console.log('\nNo agents were created. Add real staff through Admin → Agents.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
