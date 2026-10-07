// Read-only PostgreSQL backup. Credentials are passed in the subprocess
// environment, never on the command line or in output. Files stay git-ignored.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Prisma } = require('@prisma/client');
const TABLES = ['Agent', 'Team', 'TeamMembership', 'Ticket', 'Comment', 'Attachment', 'Setting', 'Notification', 'AuditEvent'];
function pgEnvironment(url) {
  const parsed = new URL(url);
  return { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432',
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password), PGSSLMODE: parsed.searchParams.get('sslmode') || (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ? 'disable' : 'require') };
}
function pgTool(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const configured = process.env.POSTGRES_BIN;
  const windows = path.join(process.env.ProgramFiles || 'C:/Program Files', 'PostgreSQL', '17', 'bin');
  return configured ? path.join(configured, name + suffix) : process.platform === 'win32' ? path.join(windows, name + suffix) : name;
}
function run(name, args, env) {
  const result = spawnSync(pgTool(name), args, { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    const reason = ['permission denied', 'does not exist', 'already exists', 'unsupported version', 'extension', 'authentication failed', 'connection refused'].find(label => String(result.stderr).toLowerCase().includes(label)) || 'execution error';
    throw new Error(`${name} failed (${reason}); credentials and provider output suppressed`);
  }
  return result.stdout;
}
async function counts(client) {
  const result = {};
  for (const table of TABLES) {
    const rows = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    result[table] = rows[0].count;
  }
  return result;
}
async function backup() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Database connection is not configured');
  const folder = path.resolve(__dirname, '../../backups');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `helpdesk-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const env = { ...pgEnvironment(url), PGOPTIONS: '-c default_transaction_read_only=on' };
  // Back up the application's tables and sequences, not provider-managed
  // authentication/storage extensions that cannot be restored to vanilla PG.
  const tables = [...Prisma.dmmf.datamodel.models.map(model => model.dbName || model.name), '_prisma_migrations'];
  run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--strict-names',
    ...tables.map(table => `--table=public."${table}"`), '--file', file], env);
  run('pg_restore', ['--list', file], env);
  // Counts are informative: production can change while the backup is taken.
  // Restoration checks derive their baseline from the restored dump itself.
  fs.writeFileSync(`${file}.json`, JSON.stringify({ createdAt: new Date().toISOString(), bytes: fs.statSync(file).size }, null, 2), { mode: 0o600 });
  console.log(`Verified backup file: ${file}`);
  return file;
}
if (require.main === module) backup().catch(() => { console.error('Backup failed. No application database changes were made.'); process.exitCode = 1; });
module.exports = { pgEnvironment, pgTool, run, counts, TABLES };
