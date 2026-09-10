// Give a test suite its own throw-away PostgreSQL database.
//
// Every suite used to run against server/prisma/dev.db — the same database the
// application uses. That made the tests destructive by construction: a suite
// that failed half way through left real rows deleted or agents parked
// unavailable, and one did once leave the database with no administrator.
// (The very first fix moved suites onto per-suite SQLite files; since the
// production schema is PostgreSQL, tests now run on PostgreSQL too.)
//
// `use('name')` points DATABASE_URL at a dedicated PostgreSQL database
// (<TEST_DATABASE_URL db>_name) on the test server, resets the schema into it
// using the committed Prisma migration history, and returns a handle that
// drops the database afterwards. The application code is untouched:
// src/lib/prisma.js and server.js both load their .env with dotenv, which
// never overrides a variable that is already set, so the values below win for
// the test process AND for any server it spawns with `env: process.env`.
//
// SAFETY. The test server is configured once, out of band, in
// server/.env.test (gitignored — see .env.test.example) via TEST_DATABASE_URL.
// It must never be the application's Supabase database, so use() enforces
// that in code:
//   - Supabase hosts are refused outright.
//   - Loopback addresses (the bundled disposable cluster from
//     `npm run test:pg:up`) are the supported setup.
//   - Any other remote host requires ALLOW_REMOTE_TEST_DATABASE=1 in
//     .env.test, an explicit acknowledgement that tests DROP and CREATE
//     databases there.
//   - TEST_DATABASE_URL is refused when it resolves to the same database as
//     the application's DATABASE_URL or DIRECT_URL.
// Additionally DIRECT_URL is overridden to the test database: Prisma's CLI
// (migrate deploy below) prefers directUrl for DDL, and leaving the
// production DIRECT_URL in place would send schema commands there.
//
// IMPORTANT: call this BEFORE requiring anything that pulls in the Prisma
// client — the connection string is read when the client is constructed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const testpg = require('./testpg');

const SERVER_DIR = path.join(__dirname, '..', '..');

// Resolve the Prisma CLI binary wherever npm hoisted it (workspaces may lift it
// to the root node_modules). Tries the classic path first, then require.resolve.
function resolvePrismaCli() {
  const classic = path.join(SERVER_DIR, 'node_modules', 'prisma', 'build', 'index.js');
  if (fs.existsSync(classic)) return classic;
  // Workspace-hoisted: prisma lives in the root workspace node_modules.
  // Starting from a known module in the server tree, walk up to find the
  // prisma CLI that is hoisted above this package.
  const resolved = require.resolve('prisma/build/index.js', { paths: [SERVER_DIR] });
  if (fs.existsSync(resolved)) return resolved;
  throw new Error(
    `Cannot locate prisma CLI — expected at ${classic} or resolvable via require.resolve('prisma/build/index.js')`
  );
}
const PRISMA_CLI = resolvePrismaCli();
const ENV_TEST_FILE = path.join(SERVER_DIR, '.env.test');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_PG_IDENTIFIER = 63;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  require('dotenv').config({ path: file });
}

// Read an env file WITHOUT injecting it into process.env — used for the
// application's .env, which the production guard compares against. Test
// processes should not inherit production secrets through the back door.
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// Keep credentials out of failure output: execFileSync errors embed the full
// command line, and PostgreSQL URLs carry the password.
function redact(text) {
  return String(text).replace(/(:\/\/[^:/@]+:)[^@/]+@/g, '$1<redacted>@');
}

function runPsql(url, args) {
  const psql = testpg.psqlPath();
  try {
    return execFileSync(psql, [url, '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch (err) {
    throw new Error(`psql failed: ${redact(err.message)}`);
  }
}

function urlTarget(url) {
  const parsed = new URL(url);
  return `${(parsed.hostname || '').toLowerCase()}:${parsed.port || 5432}:${parsed.pathname.replace(/^\//, '')}`;
}

// Fail loudly if TEST_DATABASE_URL could put test writes anywhere near
// production. Returns the parsed URL.
function guardProduction(testUrl) {
  let parsed;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid PostgreSQL connection string.');
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (/\.supabase\.(com|co|net)$/.test(host)) {
    throw new Error(
      `TEST_DATABASE_URL points at Supabase (${host}), which hosts the production database.\n` +
        'Automated tests DROP and CREATE databases; they may only run on a dedicated test server.\n' +
        `See ${ENV_TEST_FILE} / .env.test.example and "npm run test:pg:up".`
    );
  }
  if (!LOOPBACK_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DATABASE !== '1') {
    throw new Error(
      `TEST_DATABASE_URL host "${host}" is not loopback. Tests destroy the database they run against.\n` +
        'Use the bundled disposable local cluster (npm run test:pg:up), or, if the test server is\n' +
        'genuinely remote and disposable, set ALLOW_REMOTE_TEST_DATABASE=1 in .env.test.'
    );
  }

  // Belt and braces: even outside Supabase, refuse the application's own URLs
  // (server/.env values, or anything already exported in this process).
  const appEnv = parseEnvFile(path.join(SERVER_DIR, '.env'));
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    for (const candidate of [process.env[key], appEnv[key]]) {
      if (!candidate) continue;
      if (urlTarget(candidate) === urlTarget(testUrl)) {
        throw new Error(
          `TEST_DATABASE_URL resolves to the same database as the application's ${key}.\n` +
            'Refusing to run destructive tests against it.'
        );
      }
    }
  }
  return parsed;
}

// <base database>_handover, _users, ... — one schema-isolated database per
// suite, mirroring the old per-suite SQLite file. Reuses the base name from
// TEST_DATABASE_URL so a custom test server keeps its own naming.
function suiteDatabaseName(testUrl, suite) {
  const base = (new URL(testUrl).pathname.replace(/^\//, '') || 'test').replace(/[^a-zA-Z0-9]+/g, '_');
  const name = `${base}_${String(suite).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
  if (name.length > MAX_PG_IDENTIFIER) {
    throw new Error(`Suite database name "${name}" exceeds PostgreSQL's ${MAX_PG_IDENTIFIER}-character identifier limit.`);
  }
  return name;
}

// Recreate the suite database from scratch. DROP ... WITH (FORCE) (PostgreSQL
// 13+) terminates stragglers — e.g. a spawned server that has not exited yet —
// instead of leaving the drop blocked on idle connections.
function recreateDatabase(adminUrl, database) {
  runPsql(adminUrl, [
    '-c', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`,
    '-c', `CREATE DATABASE "${database}";`,
  ]);
}

// Apply the committed PostgreSQL migration history. Runs against the suite
// database only: both DATABASE_URL and DIRECT_URL in this process point there.
function migrateDeploy() {
  execFileSync(
    process.execPath,
    [PRISMA_CLI, 'migrate', 'deploy'],
    { cwd: SERVER_DIR, env: process.env, stdio: 'ignore', timeout: 300000 }
  );
}

/**
 * @param {string} name  suite name, e.g. 'handover' -> <base>_handover database
 * @returns {{database: string, url: string, cleanup: () => void}}
 */
function use(name) {
  // .env.test supplies TEST_DATABASE_URL; loading it first (dotenv never
  // overrides an existing variable) also lets a CI job export its own value.
  // The application's .env is only parsed read-only, for the guard below.
  loadEnvFile(ENV_TEST_FILE);

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Automated tests need a dedicated, disposable PostgreSQL server:\n' +
        '  npm run test:pg:up        (creates the local test cluster and server/.env.test)\n' +
        `or copy ${path.join(SERVER_DIR, '.env.test.example')} to ${ENV_TEST_FILE} and set TEST_DATABASE_URL.`
    );
  }
  guardProduction(testUrl);

  // If the URL targets the bundled local cluster and it is stopped (e.g. after
  // a reboot), bring it back up. No-op for any other test server.
  testpg.ensureRunningForTest(testUrl);

  const database = suiteDatabaseName(testUrl, name);
  const adminUrl = testUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres');
  const url = testUrl.replace(/\/[^/?]+(\?.*)?$/, `/${database}`);

  recreateDatabase(adminUrl, database);

  // No suite should inherit the real initial-administrator bootstrap: a
  // spawned server would otherwise create an admin the suite did not expect.
  // test-users.js sets this itself for the section that exercises it.
  process.env.INITIAL_ADMIN_EMAIL = '';
  process.env.DATABASE_URL = url;
  // Prisma's CLI reads directUrl for DDL — without this override, migrate
  // deploy would apply schema changes to whatever DIRECT_URL says (production).
  process.env.DIRECT_URL = url;

  migrateDeploy();

  const cleanup = () => {
    try {
      runPsql(adminUrl, ['-c', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`]);
    } catch {
      /* cluster gone or unreachable — nothing left to clean up */
    }
  };
  // Best effort if a suite dies without reaching its own cleanup.
  process.once('exit', cleanup);

  return { database, url, cleanup, drop: cleanup };
}

module.exports = { use };
