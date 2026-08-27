/* Production users, roles and administrator management.

   Runs against a live ephemeral server so every rule is exercised at the HTTP
   surface an agent could call directly. No Graph, no email, no credentials.

   Usage: npm run test:users  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4199';

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const userService = require('../src/services/userService');

const BASE = `http://localhost:${process.env.PORT}`;
const DOMAIN = 'usertest.example';
const PASSWORD = 'UserTestPass!123';
const { ROLES } = userService;

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

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

async function cleanup() {
  const users = await prisma.agent.findMany({
    where: { email: { endsWith: `@${DOMAIN}` } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.ticket.updateMany({ where: { assignedAgentId: { in: ids } }, data: { assignedAgentId: null } });
    await prisma.userAuditLog.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.comment.deleteMany({ where: { authorAgentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  }
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const mkUser = (name, email, role, extra = {}) =>
  prisma.agent.create({
    data: {
      name, email: `${email}@${DOMAIN}`, role,
      isActive: true, isAvailable: true, skillLevel: 2,
      passwordHash: hash, ...extra,
    },
  });

/**
 * Administrators that belong to the real database rather than this test.
 * Captured once, restored unconditionally at the end: several checks need
 * "only one administrator exists", and getting that wrong must never leave the
 * developer's database locked out.
 */
let realAdminIds = [];
async function parkRealAdmins() {
  const rows = await prisma.agent.findMany({
    where: { role: ROLES.ADMIN, isActive: true, NOT: { email: { endsWith: `@${DOMAIN}` } } },
    select: { id: true },
  });
  realAdminIds = rows.map((r) => r.id);
  if (realAdminIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: realAdminIds } }, data: { role: ROLES.AGENT } });
  }
  return realAdminIds;
}
async function restoreRealAdmins() {
  if (!realAdminIds.length) return;
  await prisma.agent.updateMany({
    where: { id: { in: realAdminIds } },
    data: { role: ROLES.ADMIN, isActive: true },
  });
}

async function main() {
  await ensureTeams(prisma);
  await cleanup();

  const hardware = await prisma.team.findUnique({ where: { key: 'hardware' } });

  /* ================================================================== */
  /* 1. Initial administrator bootstrap                                 */
  /* ================================================================== */
  {
    const email = `boot.admin@${DOMAIN}`;
    const saved = process.env.INITIAL_ADMIN_EMAIL;
    process.env.INITIAL_ADMIN_EMAIL = email;
    const quiet = { log() {}, warn() {}, error() {} };

    // Simulate "no administrators exist" without touching the real ones:
    // run the bootstrap against a transaction-scoped view is not possible with
    // SQLite here, so temporarily demote real admins and restore afterwards.
    await parkRealAdmins();

    try {
      eq('bootstrap: no administrators to start with', await userService.countActiveAdmins(), 0);

      const first = await userService.bootstrapInitialAdmin({ logger: quiet });
      eq('bootstrap: provisions the configured initial administrator', first.status, 'created');
      const created = await prisma.agent.findUnique({ where: { email } });
      eq('bootstrap: created account holds the ADMIN role', created.role, ROLES.ADMIN);
      eq('bootstrap: created account is active', created.isActive, true);
      check('bootstrap: created without a password (identity provider or admin sets one)', created.passwordHash === null);
      const auditRows = await prisma.userAuditLog.count({ where: { agentId: created.id } });
      check('bootstrap: creation is audited', auditRows >= 1, String(auditRows));

      // Second run must be inert now that an admin exists.
      const second = await userService.bootstrapInitialAdmin({ logger: quiet });
      eq('bootstrap: inert once an administrator exists', second.status, 'inert');
      eq('bootstrap: still exactly one administrator', await userService.countActiveAdmins(), 1);

      // Pointing the variable at somebody else must NOT mint a second admin.
      const other = await mkUser('Would Be Admin', 'wouldbe', ROLES.AGENT);
      process.env.INITIAL_ADMIN_EMAIL = other.email;
      const third = await userService.bootstrapInitialAdmin({ logger: quiet });
      eq('bootstrap: cannot be re-pointed to create a second admin', third.status, 'inert');
      eq('bootstrap: the other account is still an AGENT',
        (await prisma.agent.findUnique({ where: { id: other.id } })).role, ROLES.AGENT);

      // Promotion path: an existing agent becomes the first admin.
      await prisma.agent.update({ where: { id: created.id }, data: { role: ROLES.AGENT } });
      process.env.INITIAL_ADMIN_EMAIL = email;
      eq('bootstrap: administrators removed again', await userService.countActiveAdmins(), 0);
      const promoted = await userService.bootstrapInitialAdmin({ logger: quiet });
      eq('bootstrap: promotes an existing account when it is already present', promoted.status, 'promoted');
      eq('bootstrap: promoted account is ADMIN',
        (await prisma.agent.findUnique({ where: { id: created.id } })).role, ROLES.ADMIN);

      // No configuration -> no bootstrap at all.
      delete process.env.INITIAL_ADMIN_EMAIL;
      await prisma.agent.update({ where: { id: created.id }, data: { role: ROLES.AGENT } });
      const none = await userService.bootstrapInitialAdmin({ logger: quiet });
      eq('bootstrap: skipped when INITIAL_ADMIN_EMAIL is unset', none.status, 'skipped');
      eq('bootstrap: no administrator was invented', await userService.countActiveAdmins(), 0);

      // The email is configuration, not business logic.
      const svcSrc = require('fs').readFileSync(require.resolve('../src/services/userService'), 'utf8');
      check('bootstrap: initial admin address is not hardcoded anywhere',
        !/bestaftechnologies/i.test(svcSrc));
      const routesSrc = require('fs').readFileSync(require.resolve('../routes/agents'), 'utf8');
      check('bootstrap: address not hardcoded in the admin routes either',
        !/bestaftechnologies/i.test(routesSrc));
    } finally {
      await restoreRealAdmins();
      if (saved === undefined) delete process.env.INITIAL_ADMIN_EMAIL;
      else process.env.INITIAL_ADMIN_EMAIL = saved;
    }
    check('bootstrap: pre-existing administrators restored', (await userService.countActiveAdmins()) >= 1);
  }

  /* ================================================================== */
  /* 2. First sign-in provisioning                                      */
  /* ================================================================== */
  {
    const quiet = { log() {}, warn() {}, error() {} };
    const { user, created } = await userService.provisionUserFromIdentity(
      { email: `newstaff@${DOMAIN}`, name: 'New Staff', externalId: 'entra-obj-1' },
      { logger: quiet }
    );
    check('provisioning: a first sign-in creates the account', created === true);
    eq('provisioning: new staff become AGENT', user.role, ROLES.AGENT);
    eq('provisioning: never ADMIN on first sign-in', user.role === ROLES.ADMIN, false);
    eq('provisioning: account is active', user.isActive, true);
    eq('provisioning: external identity recorded', user.externalId, 'entra-obj-1');
    eq('provisioning: provider recorded', user.externalProvider, 'entra');

    const again = await userService.provisionUserFromIdentity(
      { email: `newstaff@${DOMAIN}`, name: 'New Staff', externalId: 'entra-obj-1' },
      { logger: quiet }
    );
    check('provisioning: repeat sign-in does not duplicate the account', again.created === false);
    eq('provisioning: repeat sign-in does not change the role', again.user.role, ROLES.AGENT);

    // An existing password account keeps its role when it federates.
    const existingAdmin = await mkUser('Federating Admin', 'federating', ROLES.ADMIN);
    const fed = await userService.provisionUserFromIdentity(
      { email: existingAdmin.email, name: 'Federating Admin', externalId: 'entra-obj-2' },
      { logger: quiet }
    );
    eq('provisioning: linking an identity preserves an existing ADMIN', fed.user.role, ROLES.ADMIN);
    eq('provisioning: identity linked to the existing record', fed.user.id, existingAdmin.id);
  }

  /* ================================================================== */
  /* HTTP: roles and administrator management                           */
  /* ================================================================== */
  const admin1 = await mkUser('Admin One', 'admin1', ROLES.ADMIN);
  const admin2 = await mkUser('Admin Two', 'admin2', ROLES.ADMIN);
  const agent1 = await mkUser('Agent One', 'agent1', ROLES.AGENT, { teamId: hardware.id });
  const plainUser = await mkUser('Plain User', 'plain', ROLES.USER);

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, INITIAL_ADMIN_EMAIL: '' },
    stdio: 'ignore',
  });

  try {
    await waitForServer(server);
    const login = async (email) =>
      (await req('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).data.token;

    const admin1T = await login(admin1.email);
    const admin2T = await login(admin2.email);
    const agent1T = await login(agent1.email);
    const userT = await login(plainUser.email);
    check('setup: all four accounts can sign in', Boolean(admin1T && admin2T && agent1T && userT));

    /* ---------------------------------------------------------------- */
    /* 3. Backend authorization                                          */
    /* ---------------------------------------------------------------- */
    {
      eq('authz: AGENT gets 403 listing users', (await req('/api/agents', { token: agent1T })).status, 403);
      eq('authz: USER gets 403 listing users', (await req('/api/agents', { token: userT })).status, 403);
      eq('authz: unauthenticated gets 401', (await req('/api/agents')).status, 401);
      eq('authz: ADMIN can list users', (await req('/api/agents', { token: admin1T })).status, 200);

      const agentCreate = await req('/api/agents', {
        method: 'POST', token: agent1T,
        body: { name: 'Sneaky', email: `sneaky@${DOMAIN}`, password: 'LongEnough1!' },
      });
      eq('authz: AGENT cannot create users', agentCreate.status, 403);

      const agentPatch = await req(`/api/agents/${agent1.id}`, {
        method: 'PATCH', token: agent1T, body: { role: ROLES.ADMIN },
      });
      eq('authz: AGENT cannot promote themselves to ADMIN', agentPatch.status, 403);
      eq('authz: the attempt changed nothing',
        (await prisma.agent.findUnique({ where: { id: agent1.id } })).role, ROLES.AGENT);

      const userPatch = await req(`/api/agents/${plainUser.id}`, {
        method: 'PATCH', token: userT, body: { role: ROLES.ADMIN },
      });
      eq('authz: USER cannot promote themselves', userPatch.status, 403);
    }

    /* ---------------------------------------------------------------- */
    /* 4. Admin management of roles                                      */
    /* ---------------------------------------------------------------- */
    {
      const promote = await req(`/api/agents/${agent1.id}`, {
        method: 'PATCH', token: admin1T, body: { role: ROLES.ADMIN },
      });
      eq('roles: ADMIN can promote an AGENT', promote.status, 200);
      eq('roles: promotion applied', promote.data.role, ROLES.ADMIN);

      const audit = await prisma.userAuditLog.findFirst({
        where: { agentId: agent1.id, action: 'role_changed' }, orderBy: { id: 'desc' },
      });
      check('audit: promotion recorded', Boolean(audit));
      eq('audit: records the previous role', audit.fromValue, ROLES.AGENT);
      eq('audit: records the new role', audit.toValue, ROLES.ADMIN);
      check('audit: records the actor', audit.actor.includes('Admin One'), audit.actor);
      check('audit: records a timestamp', Boolean(audit.createdAt));

      // Any admin can manage any other admin — not only the first one.
      const demoteByOther = await req(`/api/agents/${agent1.id}`, {
        method: 'PATCH', token: admin2T, body: { role: ROLES.AGENT },
      });
      eq('roles: any ADMIN can demote another ADMIN', demoteByOther.status, 200);
      eq('roles: demotion applied', demoteByOther.data.role, ROLES.AGENT);

      const promoteBack = await req(`/api/agents/${agent1.id}`, {
        method: 'PATCH', token: admin2T, body: { role: ROLES.ADMIN },
      });
      eq('roles: second ADMIN has the same management rights', promoteBack.status, 200);

      // Nobody changes their own role.
      const selfDemote = await req(`/api/agents/${admin1.id}`, {
        method: 'PATCH', token: admin1T, body: { role: ROLES.AGENT },
      });
      eq('roles: an ADMIN cannot change their own role', selfDemote.status, 403);
      eq('roles: self-demotion changed nothing',
        (await prisma.agent.findUnique({ where: { id: admin1.id } })).role, ROLES.ADMIN);

      const selfDeactivate = await req(`/api/agents/${admin1.id}`, {
        method: 'PATCH', token: admin1T, body: { isActive: false },
      });
      eq('roles: an ADMIN cannot deactivate their own account', selfDeactivate.status, 403);

      const badRole = await req(`/api/agents/${agent1.id}`, {
        method: 'PATCH', token: admin1T, body: { role: 'superadmin' },
      });
      eq('roles: unknown role rejected', badRole.status, 400);

      // USER role is a first-class option.
      const toUser = await req(`/api/agents/${plainUser.id}`, {
        method: 'PATCH', token: admin1T, body: { role: ROLES.AGENT },
      });
      eq('roles: USER can be promoted to AGENT', toUser.status, 200);
      await req(`/api/agents/${plainUser.id}`, { method: 'PATCH', token: admin1T, body: { role: ROLES.USER } });
    }

    /* ---------------------------------------------------------------- */
    /* 5. The final administrator is protected                           */
    /* ---------------------------------------------------------------- */
    {
      // Park the real administrators FIRST (captured, then demoted), so they
      // are always restorable, then reduce this test's own admins to one.
      await parkRealAdmins();
      await prisma.agent.updateMany({
        where: { role: ROLES.ADMIN, email: { endsWith: `@${DOMAIN}` }, id: { not: admin1.id } },
        data: { role: ROLES.AGENT },
      });

      try {
        eq('last admin: exactly one administrator remains', await userService.countActiveAdmins(), 1);

        // admin1 is now the only admin; admin2 was demoted, so use a fresh
        // admin token is impossible — verify through the service directly and
        // through a second admin promoted for the purpose.
        const helper = await prisma.agent.update({
          where: { id: admin2.id }, data: { role: ROLES.ADMIN },
        });
        const helperT = await login(helper.email);
        // Now demote admin1 down to the last one again by demoting the helper.
        await req(`/api/agents/${helper.id}`, { method: 'PATCH', token: admin1T, body: { role: ROLES.AGENT } });
        eq('last admin: back to one administrator', await userService.countActiveAdmins(), 1);

        // The final admin cannot be demoted, even by themselves via another admin token.
        const verdict = await userService.checkUserUpdate(
          await prisma.agent.findUnique({ where: { id: admin1.id } }),
          { id: 999999, role: ROLES.ADMIN, name: 'Other Admin', email: 'other@x' },
          { role: ROLES.AGENT }
        );
        eq('last admin: demotion refused', verdict.ok, false);
        eq('last admin: refusal uses 409 conflict', verdict.status, 409);
        check('last admin: refusal explains why', /last remaining administrator/i.test(verdict.error), verdict.error);

        const deactivateVerdict = await userService.checkUserUpdate(
          await prisma.agent.findUnique({ where: { id: admin1.id } }),
          { id: 999999, role: ROLES.ADMIN, name: 'Other Admin', email: 'other@x' },
          { isActive: false }
        );
        eq('last admin: deactivation refused', deactivateVerdict.ok, false);
        eq('last admin: deactivation refusal uses 409', deactivateVerdict.status, 409);

        eq('last admin: still an administrator after both attempts',
          (await prisma.agent.findUnique({ where: { id: admin1.id } })).role, ROLES.ADMIN);
        eq('last admin: still active', (await prisma.agent.findUnique({ where: { id: admin1.id } })).isActive, true);

        // Promote a second admin over HTTP, then the original may be demoted.
        const second = await req(`/api/agents/${helper.id}`, {
          method: 'PATCH', token: admin1T, body: { role: ROLES.ADMIN },
        });
        eq('last admin: a second administrator can be promoted', second.status, 200);
        const secondT = await login(helper.email);
        const nowDemotable = await req(`/api/agents/${admin1.id}`, {
          method: 'PATCH', token: secondT, body: { role: ROLES.AGENT },
        });
        eq('last admin: with two admins, one may be demoted', nowDemotable.status, 200);
      } finally {
        await restoreRealAdmins();
        await prisma.agent.update({ where: { id: admin1.id }, data: { role: ROLES.ADMIN } });
      }
    }

    /* ---------------------------------------------------------------- */
    /* 6. Activation, availability, group, skill + audit                 */
    /* ---------------------------------------------------------------- */
    {
      const adminT = await login(admin1.email);
      // Created through the admin API so the 'created' audit row is exercised
      // the way production provisioning does it.
      const createRes = await req('/api/agents', {
        method: 'POST', token: adminT,
        body: {
          name: 'Managed Person', email: `managed@${DOMAIN}`, password: PASSWORD,
          role: ROLES.AGENT, assignmentGroup: 'hardware', skillLevel: 2,
        },
      });
      eq('manage: ADMIN can provision a new agent', createRes.status, 201);
      eq('manage: provisioned with the AGENT role', createRes.data.role, ROLES.AGENT);
      const target = await prisma.agent.findUnique({ where: { email: `managed@${DOMAIN}` } });

      const deact = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { isActive: false } });
      eq('manage: ADMIN can deactivate a user', deact.status, 200);
      eq('manage: user is inactive', deact.data.isActive, false);

      const react = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { isActive: true } });
      eq('manage: ADMIN can reactivate a user', react.status, 200);

      const unavail = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { isAvailable: false } });
      eq('manage: availability can be changed independently of active', unavail.status, 200);
      eq('manage: user is unavailable', unavail.data.isAvailable, false);
      eq('manage: but still active', unavail.data.isActive, true);
      await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { isAvailable: true } });

      const group = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { assignmentGroup: 'software' } });
      eq('manage: assignment group can be changed', group.status, 200);

      const skill = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { skillLevel: 3 } });
      eq('manage: skill level can be changed', skill.status, 200);
      eq('manage: skill level applied', skill.data.skillLevel, 3);

      const badSkill = await req(`/api/agents/${target.id}`, { method: 'PATCH', token: adminT, body: { skillLevel: 9 } });
      eq('manage: invalid skill level rejected', badSkill.status, 400);

      const auditRes = await req(`/api/agents/${target.id}/audit`, { token: adminT });
      eq('audit: history endpoint responds', auditRes.status, 200);
      const actions = auditRes.data.events.map((e) => e.action);
      for (const expected of ['created', 'deactivated', 'activated', 'availability_changed', 'group_changed', 'skill_changed']) {
        check(`audit: ${expected} recorded`, actions.includes(expected), actions.join(','));
      }
      check('audit: every entry names an actor', auditRes.data.events.every((e) => Boolean(e.actor)));
      check('audit: every entry has a timestamp', auditRes.data.events.every((e) => Boolean(e.createdAt)));
      eq('audit: agents cannot read user history', (await req(`/api/agents/${target.id}/audit`, { token: agent1T })).status, 403);
    }

    /* ---------------------------------------------------------------- */
    /* 7. Who can receive tickets                                        */
    /* ---------------------------------------------------------------- */
    {
      const adminT = await login(admin1.email);
      const engine = require('../src/services/assignmentEngine');
      const quiet = { log() {}, warn() {} };

      // Park every other hardware agent so the engine has one obvious choice.
      const parked = await prisma.agent.findMany({ where: { teamId: hardware.id }, select: { id: true } });
      await prisma.agent.updateMany({
        where: { id: { in: parked.map((p) => p.id) } }, data: { isAvailable: false },
      });
      const candidate = await mkUser('Eligible Tech', 'eligible', ROLES.AGENT, { teamId: hardware.id, skillLevel: 3 });

      const ok = await engine.assign({ category: 'Hardware', priority: 'moderate' }, prisma, quiet);
      eq('eligibility: an active, available agent is selected', ok.agent && ok.agent.id, candidate.id);

      // Inactive users cannot receive tickets.
      await prisma.agent.update({ where: { id: candidate.id }, data: { isActive: false } });
      const whenInactive = await engine.assign({ category: 'Hardware', priority: 'moderate' }, prisma, quiet);
      check('eligibility: an INACTIVE user is never selected', !whenInactive.agent || whenInactive.agent.id !== candidate.id);

      // Unavailable users cannot receive tickets either.
      await prisma.agent.update({ where: { id: candidate.id }, data: { isActive: true, isAvailable: false } });
      const whenUnavailable = await engine.assign({ category: 'Hardware', priority: 'moderate' }, prisma, quiet);
      check('eligibility: an UNAVAILABLE user is never selected', !whenUnavailable.agent || whenUnavailable.agent.id !== candidate.id);

      // A USER-role account is never selected, however available.
      await prisma.agent.update({ where: { id: candidate.id }, data: { isAvailable: true, role: ROLES.USER } });
      const whenUserRole = await engine.assign({ category: 'Hardware', priority: 'moderate' }, prisma, quiet);
      check('eligibility: a USER-role account is never selected', !whenUserRole.agent || whenUserRole.agent.id !== candidate.id);

      await prisma.agent.updateMany({
        where: { id: { in: parked.map((p) => p.id) } }, data: { isAvailable: true },
      });
    }

    /* ---------------------------------------------------------------- */
    /* 8. Admin listing exposes the production user model                */
    /* ---------------------------------------------------------------- */
    {
      const adminT = await login(admin1.email);
      const list = await req('/api/agents', { token: adminT });
      eq('model: listing responds', list.status, 200);
      check('model: roles advertised', Array.isArray(list.data.roles) && list.data.roles.length === 3, JSON.stringify(list.data.roles));
      const row = list.data.agents.find((a) => a.email === admin1.email);
      for (const field of ['id', 'name', 'email', 'role', 'isActive', 'isAvailable', 'skillLevel', 'createdAt', 'updatedAt']) {
        check(`model: ${field} exposed`, row[field] !== undefined, JSON.stringify(Object.keys(row)));
      }
      check('model: assignment group exposed', 'assignmentGroup' in row);
      check('model: external identity exposed', 'externalIdentityId' in row && 'externalProvider' in row);
      check('model: password hash never exposed', !('passwordHash' in row));
    }
  } finally {
    server.kill();
    await restoreRealAdmins();
    await cleanup();
  }

  // Safety net: this suite must never leave the database without an admin.
  const adminsLeft = await userService.countActiveAdmins();
  check('teardown: the database still has at least one administrator', adminsLeft >= 1, String(adminsLeft));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => { console.error(err); failures += 1; })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
