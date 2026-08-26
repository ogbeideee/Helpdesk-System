// One-time DB initialization:
//   1. Seeds the four routing teams
//   2. Creates the admin account + sample agents per team
//   3. Backfills ticketNumber for any pre-existing tickets
//
// Usage: npm run db:init   (from server/)
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@noctincan.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe!123';
const AGENT_PASSWORD = process.env.AGENT_PASSWORD || 'ChangeMe!123';

const SAMPLE_AGENTS = [
  { name: 'Triage Desk', email: 'service.desk@noctincan.com', teamKey: 'service_desk', skillLevel: 1 },
  { name: 'Amara Osei', email: 'amara.osei@noctincan.com', teamKey: 'accounts', skillLevel: 2 },
  { name: 'Dev Patel', email: 'dev.patel@noctincan.com', teamKey: 'software', skillLevel: 2 },
  { name: 'Lena Fischer', email: 'lena.fischer@noctincan.com', teamKey: 'hardware', skillLevel: 2 },
];

async function backfillTicketNumbers() {
  const legacy = await prisma.ticket.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  let assigned = 0;
  for (const t of legacy) {
    if (t.ticketNumber && t.ticketNumber.startsWith('HD-')) continue;
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

async function upsertUser({ name, email, role, teamId, password, skillLevel = 1 }) {
  return prisma.agent.upsert({
    where: { email },
    create: {
      name,
      email,
      role,
      teamId,
      skillLevel,
      passwordHash: bcrypt.hashSync(password, 10),
    },
    update: {},
  });
}

async function main() {
  console.log('Seeding teams…');
  await ensureTeams(prisma);
  const teams = await prisma.team.findMany();
  const teamByKey = Object.fromEntries(teams.map((t) => [t.key, t]));

  console.log(`Creating admin ${ADMIN_EMAIL}…`);
  await upsertUser({
    name: 'IT Admin',
    email: ADMIN_EMAIL,
    role: 'admin',
    teamId: null,
    password: ADMIN_PASSWORD,
  });

  console.log('Creating sample agents…');
  for (const a of SAMPLE_AGENTS) {
    await upsertUser({
      name: a.name,
      email: a.email,
      role: 'agent',
      teamId: teamByKey[a.teamKey] ? teamByKey[a.teamKey].id : null,
      password: AGENT_PASSWORD,
      skillLevel: a.skillLevel,
    });
  }

  console.log('Backfilling ticket numbers for legacy tickets…');
  const count = await backfillTicketNumbers();

  console.log('\nDone.');
  console.log(`  Teams:            ${teams.map((t) => t.name).join(', ')}`);
  console.log(`  Admin login:      ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  Sample agent pwd: ${AGENT_PASSWORD}`);
  console.log(`  Ticket numbers backfilled: ${count}`);
  console.log('\nChange these passwords before real use (Admin > Agents, or re-run with ADMIN_PASSWORD/AGENT_PASSWORD env vars).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
