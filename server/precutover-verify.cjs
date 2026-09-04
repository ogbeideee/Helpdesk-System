// Pre-cutover verification (read-only). Prints no credentials.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EXPECTED = ['Agent','AuditEvent','Comment','GraphSubscription','HandoverRequest',
  'Notification','RoutingRule','RoutingRuleAuditLog','Setting','Team','TeamMembership',
  'Ticket','TicketAuditLog','TicketSequence','UserAuditLog'];

(async () => {
  // 1. Health
  const ping = await prisma.$queryRawUnsafe('SELECT version() AS v, now() AS ts');
  console.log('HEALTH: connected OK');
  console.log('  server time:', ping[0].ts);

  // 2. Tables + exact row counts
  const tables = await prisma.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const names = tables.map(t => t.tablename).filter(n => !n.startsWith('_prisma'));
  const missing = EXPECTED.filter(e => !names.includes(e));
  console.log(`\nTABLES: ${names.length} found, expected ${EXPECTED.length}, missing: ${missing.length ? missing.join(',') : 'NONE'}`);

  let total = 0;
  for (const t of EXPECTED.sort()) {
    const r = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "${t}"`);
    total += r[0].c;
    console.log(`  ${t}: ${r[0].c}`);
  }
  console.log(`  TOTAL rows: ${total}`);

  // 3. TicketSequence
  const seq = await prisma.$queryRawUnsafe('SELECT "year", "last" FROM "TicketSequence" ORDER BY "year"');
  console.log('\nTICKET SEQUENCE:');
  seq.forEach(s => console.log(`  year=${s.year} last=${s.last}`));

  // 4. Partial unique index
  const idx = await prisma.$queryRawUnsafe(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='TeamMembership_single_lead'");
  console.log(`\nTeamMembership_single_lead: ${idx.length === 1 ? 'EXISTS' : 'MISSING'}`);
  if (idx.length) console.log(`  def: ${idx[0].indexdef}`);

  // 5. Migration status
  const mig = await prisma.$queryRawUnsafe(
    "SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY started_at");
  console.log('\nMIGRATIONS:');
  mig.forEach(m => console.log(`  ${m.migration_name} finished=${m.finished}`));
})()
  .catch(e => { console.error('VERIFY ERROR:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
