// One-time data migration: Agent.teamId (single assignment group) -> the
// TeamMembership join table, so the multi-group model can take over without
// losing anyone's existing group.
//
//   - runs the same backfill as prisma/migrations/.../migration.sql
//   - creates the "one lead per group" partial unique index (needed when the
//     schema was applied through `prisma db push`, which cannot express it)
//   - idempotent: safe to re-run; never duplicates or deletes memberships
//   - does NOT touch teams, users, tickets or ticket assignment groups
//
// Usage: npm run db:migrate-assignment-groups   (from server/)
const prisma = require('../src/lib/prisma');
const { ensureSingleLeadIndex, backfillFromLegacyTeamId } = require('../src/services/groupMembershipService');

async function main() {
  await ensureSingleLeadIndex(prisma);

  const before = await prisma.teamMembership.count();
  const summary = await backfillFromLegacyTeamId(prisma);
  const after = await prisma.teamMembership.count();

  console.log(`Memberships before migration:    ${before}`);
  console.log(`Agents with a legacy teamId:     ${summary.total}`);
  console.log(`Memberships created:             ${summary.created}`);
  console.log(`Already present (kept):          ${summary.existing}`);
  console.log(`Memberships after migration:     ${after}`);
  console.log('Single-lead index "TeamMembership_single_lead": ensured.');

  const teams = await prisma.team.count();
  const users = await prisma.agent.count();
  const tickets = await prisma.ticket.count();
  console.log('Unchanged:');
  console.log(`  Assignment groups:             ${teams}`);
  console.log(`  Users (agents):                ${users}`);
  console.log(`  Tickets:                       ${tickets}`);

  const orphans = await prisma.agent.count({ where: { teamId: { not: null }, memberships: { none: {} } } });
  console.log(orphans === 0
    ? 'Consistency: every agent with a legacy teamId now has a membership.'
    : `Consistency CHECK FAILED: ${orphans} agent(s) with a teamId but no membership.`);

  if (before > after) {
    throw new Error('Refusing to continue: the migration removed memberships — you have hit a data-loss edge. Investigate before re-running.');
  }
  console.log('\nMigration complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });