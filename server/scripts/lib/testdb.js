// Give a test suite its own throw-away SQLite database.
//
// Every suite used to run against server/prisma/dev.db — the same file the
// application uses. That made the tests destructive by construction: a suite
// that failed half way through left real rows deleted or agents parked
// unavailable, and one did once leave the database with no administrator.
//
// `use('name')` points DATABASE_URL at server/prisma/test-<name>.db, resets the
// schema into it, and returns a handle that deletes the file afterwards. The
// application code is untouched: src/lib/prisma.js and server.js both load
// their .env with dotenv, which never overrides a variable that is already
// set, so the value below wins for the test process AND for any server it
// spawns with `env: process.env`.
//
// IMPORTANT: call this BEFORE requiring anything that pulls in the Prisma
// client — the connection string is read when the client is constructed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..', '..');
const PRISMA_DIR = path.join(SERVER_DIR, 'prisma');
const PRISMA_CLI = path.join(SERVER_DIR, 'node_modules', 'prisma', 'build', 'index.js');

function removeFiles(base) {
  // SQLite leaves -journal / -wal / -shm siblings behind.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      /* not there — fine */
    }
  }
}

/**
 * @param {string} name  suite name, e.g. 'api' -> prisma/test-api.db
 * @returns {{file: string, cleanup: () => void}}
 */
function use(name) {
  const fileName = `test-${name}.db`;
  const file = path.join(PRISMA_DIR, fileName);

  // Relative SQLite paths resolve against the schema's directory (prisma/).
  process.env.DATABASE_URL = `file:./${fileName}`;
  // No suite should inherit the real initial-administrator bootstrap: a
  // spawned server would otherwise create an admin the suite did not expect.
  // test-users.js sets this itself for the section that exercises it.
  process.env.INITIAL_ADMIN_EMAIL = '';

  removeFiles(file);
  execFileSync(
    process.execPath,
    [PRISMA_CLI, 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: SERVER_DIR, env: process.env, stdio: 'ignore' }
  );

  const cleanup = () => removeFiles(file);
  // Best effort if a suite dies without reaching its own cleanup.
  process.once('exit', cleanup);

  return { file, cleanup };
}

module.exports = { use };
