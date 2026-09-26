/* Self-service profile settings (routes/profile.js).

   Covers the whole surface against the REAL server over an isolated database:
     A. authentication — every endpoint refuses anonymous callers
     B. display name — change, trimming, auth/me reflection, audit trail,
        validation (empty / over-length), no-op without audit noise
     C. admin-governed fields cannot be smuggled through the self-service route
     D. password change — field validation, current-password verification,
        no-reuse rule, sign-in with old vs new password, audit without the
        credential itself, the no-password (identity-provisioned) 409 path
     E. no response shape ever carries passwordHash */

process.env.PORT = process.env.PORT || '4196';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('profile');

const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const PASSWORD = 'Profile!123';
const NEW_PASSWORD = 'Profile!456';
const DOMAIN = 'profile.test';

// Spawn the REAL server.js against this suite's database (testdb.use has
// already pointed DATABASE_URL/DIRECT_URL at it; the spawn inherits env).
async function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`http://localhost:${process.env.PORT}/api/health`)).ok) return proc; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

async function stopServer(proc) {
  proc.kill();
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
}

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`http://localhost:${process.env.PORT}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const agent = await prisma.agent.create({
    data: {
      name: 'Pat Profile',
      email: `pat@${DOMAIN}`,
      role: 'agent',
      isActive: true,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
  const server = await startServer();

  const login = await req('/api/auth/login', { method: 'POST', body: { email: `pat@${DOMAIN}`, password: PASSWORD } });
  eq('0. sign-in works', login.status, 200);
  const token = login.data.token;

  /* ---- A. authentication --------------------------------------------- */
  console.log('\n--- A. anonymous callers are refused ---');
  eq('A1 PATCH /api/profile without a token is 401',
    (await req('/api/profile', { method: 'PATCH', body: { name: 'X' } })).status, 401);
  eq('A2 POST /api/profile/password without a token is 401',
    (await req('/api/profile/password', { method: 'POST', body: {} })).status, 401);

  /* ---- B. display name ------------------------------------------------ */
  console.log('\n--- B. display name ---');
  const renamed = await req('/api/profile', { method: 'PATCH', token, body: { name: '  Patricia Profile  ' } });
  eq('B1 rename answers 200', renamed.status, 200);
  eq('B2 the name is trimmed and saved', renamed.data.name, 'Patricia Profile');
  const meAfter = await req('/api/auth/me', { token });
  eq('B3 /api/auth/me reflects the new name', meAfter.data.name, 'Patricia Profile');
  check('B4 the rename joined the unified trail',
    Boolean(await prisma.auditEvent.findFirst({ where: { action: 'agent.updated', entityId: agent.id } })));
  eq('B5 an empty name is rejected',
    (await req('/api/profile', { method: 'PATCH', token, body: { name: '   ' } })).status, 400);
  eq('B6 a name over 80 characters is rejected',
    (await req('/api/profile', { method: 'PATCH', token, body: { name: 'x'.repeat(81) } })).status, 400);
  const sameName = await req('/api/profile', { method: 'PATCH', token, body: { name: 'Patricia Profile' } });
  eq('B7 an unchanged name is a no-op 200', sameName.status, 200);
  eq('B8 the no-op wrote no extra audit row',
    await prisma.auditEvent.count({ where: { action: 'agent.updated', entityId: agent.id } }), 1);

  /* ---- C. admin-governed fields cannot be smuggled in ----------------- */
  console.log('\n--- C. role/activation stay admin-only ---');
  const sneaky = await req('/api/profile', {
    method: 'PATCH', token, body: { name: 'Patricia Profile', role: 'admin', isActive: false, skillLevel: 3 },
  });
  eq('C1 extra fields are ignored, request still answers 200', sneaky.status, 200);
  const afterSneaky = await prisma.agent.findUnique({ where: { id: agent.id } });
  eq('C2 the role did not change', afterSneaky.role, 'agent');
  eq('C3 the account was not deactivated', afterSneaky.isActive, true);
  eq('C4 the skill level did not change', afterSneaky.skillLevel, agent.skillLevel);

  /* ---- D. password change -------------------------------------------- */
  console.log('\n--- D. password change ---');
  eq('D1 missing fields are rejected',
    (await req('/api/profile/password', { method: 'POST', token, body: { currentPassword: PASSWORD } })).status, 400);
  eq('D2 a short new password is rejected',
    (await req('/api/profile/password', { method: 'POST', token, body: { currentPassword: PASSWORD, newPassword: 'short' } })).status, 400);
  eq('D3 a wrong current password is refused',
    (await req('/api/profile/password', { method: 'POST', token, body: { currentPassword: 'nope-nope-nope', newPassword: NEW_PASSWORD } })).status, 403);
  eq('D4 reusing the current password is rejected',
    (await req('/api/profile/password', { method: 'POST', token, body: { currentPassword: PASSWORD, newPassword: PASSWORD } })).status, 400);
  const changed = await req('/api/profile/password', {
    method: 'POST', token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  eq('D5 a valid change answers 200', changed.status, 200);
  check('D6 the change is audited',
    Boolean(await prisma.auditEvent.findFirst({ where: { action: 'agent.password_changed', entityId: agent.id } })));
  eq('D7 the old password no longer signs in',
    (await req('/api/auth/login', { method: 'POST', body: { email: `pat@${DOMAIN}`, password: PASSWORD } })).status, 401);
  const relogin = await req('/api/auth/login', { method: 'POST', body: { email: `pat@${DOMAIN}`, password: NEW_PASSWORD } });
  eq('D8 the new password signs in', relogin.status, 200);
  eq('D9 the password hash actually changed in the database',
    (await prisma.agent.findUnique({ where: { id: agent.id } })).passwordHash === agent.passwordHash, false);

  // Identity-provisioned accounts have no password: the route must say so.
  const nopass = await prisma.agent.create({
    data: { name: 'No Pass', email: `nopass@${DOMAIN}`, role: 'agent', isActive: true, isAvailable: true, passwordHash: null },
  });
  const { signToken } = require('../src/authMiddleware');
  const nopassToken = signToken(nopass);
  eq('D10 an account with no password gets a clear 409',
    (await req('/api/profile/password', { method: 'POST', token: nopassToken, body: { currentPassword: 'x', newPassword: NEW_PASSWORD } })).status, 409);

  /* ---- E. nothing secret leaks ---------------------------------------- */
  console.log('\n--- E. no credential material in responses or the trail ---');
  const responses = [login, renamed, meAfter, sameName, sneaky, changed, relogin];
  check('E1 no response carried passwordHash',
    responses.every((r) => !('passwordHash' in (r.data || {}))));
  const pwEvent = await prisma.auditEvent.findFirst({ where: { action: 'agent.password_changed', entityId: agent.id } });
  check('E2 the audit row contains no credential material',
    pwEvent && ![pwEvent.fromValue, pwEvent.toValue, pwEvent.description].join(' ').includes(NEW_PASSWORD));
  check('E3 the raw responses contain no plaintext password',
    responses.every((r) => !JSON.stringify(r.data).includes(NEW_PASSWORD)));

  await stopServer(server);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
