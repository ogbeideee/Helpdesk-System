// Restore ONLY into the disposable loopback database created by testdb. Never
// accept a database URL from the caller and never restore over the application.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgEnvironment, run, counts } = require('./backup-database.cjs');
const backup = path.resolve(process.argv[2] || '');
const backupRoot = path.resolve(__dirname, '../../backups') + path.sep;
if (!backup.startsWith(backupRoot) || !backup.endsWith('.dump') || !fs.existsSync(backup)) throw new Error('Choose a .dump file from the private backups directory');
const fixture = require('./lib/testdb').use('recovery_rehearsal');
const target = new URL(fixture.url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.pathname.includes('ticketing_test_')) throw new Error('Recovery destination must be disposable and local');
const { PrismaClient } = require('@prisma/client');
let stage = 'restore';
async function main() {
  const env = pgEnvironment(fixture.url);
  run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--dbname', env.PGDATABASE, backup], env);
  stage = 'baseline counts';
  const beforeClient = new PrismaClient();
  const before = await counts(beforeClient);
  const columns = await beforeClient.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Agent' AND column_name = 'teamId'`;
  const baselinePrimary = columns.length
    ? await beforeClient.$queryRaw`SELECT "id" AS "agentId", "teamId" FROM "Agent" WHERE "teamId" IS NOT NULL`
    : await beforeClient.teamMembership.findMany({ where: { isPrimary: true }, select: { agentId: true, teamId: true } });
  await beforeClient.$disconnect();
  stage = 'migration';
  execFileSync(process.execPath, [path.join(__dirname, '../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'ignore', windowsHide: true });
  const client = new PrismaClient();
  stage = 'parity check';
  const after = await counts(client);
  const primary = await client.teamMembership.count({ where: { isPrimary: true } });
  const primaryRows = await client.teamMembership.findMany({ where: { isPrimary: true }, select: { agentId: true, teamId: true } });
  const primaryMap = new Map(primaryRows.map(row => [row.agentId, row.teamId]));
  const oversized = await client.$queryRaw`SELECT "agentId" FROM "TeamMembership" GROUP BY "agentId" HAVING COUNT(*) > 3`;
  const unchanged = ['Agent', 'Team', 'Ticket', 'Comment', 'Attachment', 'Setting', 'Notification', 'AuditEvent'].every(table => before[table] === after[table]);
  if (!unchanged || oversized.length || baselinePrimary.some(row => primaryMap.get(row.agentId) !== row.teamId)) throw new Error('Restored data or membership migration did not match');
  await client.$disconnect();
  fs.writeFileSync(`${backup}.recovery.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), restored: true, migrationsApplied: true, countsBefore: before, countsAfter: after, primaryMemberships: primary }, null, 2), { mode: 0o600 });
  console.log('Recovery rehearsal passed: restored snapshot, applied migrations, preserved core row counts and primary memberships. Disposable database removed on exit.');
}
main().catch(error => { console.error(`Recovery rehearsal failed at ${stage}${error.message.startsWith('pg_restore failed') ? ': ' + error.message : ''}; application database was never modified.`); process.exitCode = 1; });
