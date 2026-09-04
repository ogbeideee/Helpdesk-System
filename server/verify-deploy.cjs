// Post-deployment verification (read-only):
// 1) all expected tables exist in public
// 2) TeamMembership_single_lead partial unique index exists (with definition)
// 3) _prisma_migrations contains the applied baseline
// 4) row counts are zero (schema only, no data migrated)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EXPECTED = ['Agent','AuditEvent','Comment','GraphSubscription','HandoverRequest',
  'Notification','RoutingRule','RoutingRuleAuditLog','Setting','Team','TeamMembership',
  'Ticket','TicketAuditLog','TicketSequence','UserAuditLog'];

(async () => {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const names = tables.map(t => t.tablename);
  const appTables = names.filter(n => !n.startsWith('_prisma'));
  const missing = EXPECTED.filter(e => !appTables.includes(e));
  console.log(`tables found: ${appTables.length} (expected ${EXPECTED.length})`);
  console.log(`tables: ${appTables.join(', ')}`);
  console.log(`missing: ${missing.length ? missing.join(', ') : 'NONE'}`);
  console.log(`prisma system tables: ${names.filter(n => n.startsWith('_prisma')).join(', ') || 'NONE'}`);

  const idx = await prisma.$queryRawUnsafe(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='TeamMembership_single_lead'");
  console.log(`\nTeamMembership_single_lead: ${idx.length === 1 ? 'EXISTS' : 'MISSING'}`);
  if (idx.length) console.log(`  def: ${idx[0].indexdef}`);

  const mig = await prisma.$queryRawUnsafe(
    "SELECT migration_name, finished_at IS NOT NULL AS finished, applied_steps_count FROM _prisma_migrations ORDER BY started_at");
  console.log(`\n_prisma_migrations rows: ${mig.length}`);
  mig.forEach(m => console.log(`  ${m.migration_name} | finished=${m.finished} | steps=${m.applied_steps_count}`));

  const counts = await prisma.$queryRawUnsafe(
    "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname");
  const total = counts.reduce((a, c) => a + Number(c.n_live_tup), 0);
  console.log(`\nrow counts across all tables (estimated): ${total} ${total === 0 ? '(schema only, no data — as expected)' : '(DATA PRESENT!)'}`);
})()
  .catch(e => { console.error('VERIFICATION ERROR:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
