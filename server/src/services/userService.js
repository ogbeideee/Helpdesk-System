// User, role and administrator management.
//
// Every rule about who may hold or change a role lives here, so the API,
// future Entra provisioning and the seed scripts all enforce the same thing.
//
// Roles
//   USER  — can sign in, but is not IT staff: never receives ticket assignments
//   AGENT — normal IT staff; the default for anyone signing in for the first time
//   ADMIN — AGENT plus user administration
//
// The stored values are lower-case ('user' | 'agent' | 'admin'), which is what
// the existing JWTs, assignment policy and routes already use. The uppercase
// names in the requirements map onto these one-to-one.
//
// Invariants enforced here:
//   1. Nobody can change their own role — not even an admin.
//   2. Nobody can grant themselves ADMIN; only an existing admin can promote,
//      or the one-time initial-admin bootstrap.
//   3. At least one active ADMIN always remains: the final admin can be
//      neither demoted nor deactivated.
const prisma = require('./../lib/prisma');
const auditService = require('./auditService');

const ROLES = { USER: 'user', AGENT: 'agent', ADMIN: 'admin' };
const ROLE_VALUES = [ROLES.USER, ROLES.AGENT, ROLES.ADMIN];
/** Roles that can be assigned helpdesk work. A USER never receives tickets. */
const STAFF_ROLES = [ROLES.AGENT, ROLES.ADMIN];

const AUDIT_ACTIONS = {
  CREATED: 'created',
  ROLE_CHANGED: 'role_changed',
  ACTIVATED: 'activated',
  DEACTIVATED: 'deactivated',
  AVAILABILITY_CHANGED: 'availability_changed',
  GROUP_CHANGED: 'group_changed',
  SKILL_CHANGED: 'skill_changed',
};

function isValidRole(role) {
  return ROLE_VALUES.includes(role);
}

function isAdminRole(role) {
  return role === ROLES.ADMIN;
}

/** Label for an actor in the audit trail. Never includes secrets. */
function actorLabel(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return `${actor.name} <${actor.email}>`;
}

/**
 * How many admins can still administer the system.
 * Only active admins count: a deactivated admin cannot sign in, so they
 * cannot be the one remaining administrator.
 */
function countActiveAdmins(client = prisma, excludeId = null) {
  return client.agent.count({
    where: {
      role: ROLES.ADMIN,
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

/**
 * Validate a requested change to one user.
 *
 * @param {object} target   the user being changed
 * @param {object} actor    the authenticated user making the change
 * @param {object} changes  { role?, isActive?, isAvailable?, teamId?, skillLevel? }
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
async function checkUserUpdate(target, actor, changes, client = prisma) {
  if (!actor) return { ok: false, status: 401, error: 'Authentication required' };
  if (!isAdminRole(actor.role)) {
    return { ok: false, status: 403, error: 'Administrator role required' };
  }
  if (!target) return { ok: false, status: 404, error: 'User not found' };

  const isSelf = target.id === actor.id;

  // --- role changes -------------------------------------------------
  if (changes.role !== undefined && changes.role !== target.role) {
    if (!isValidRole(changes.role)) {
      return { ok: false, status: 400, error: `role must be one of: ${ROLE_VALUES.join(', ')}` };
    }
    // Invariant 1: never your own role, in either direction. This is what
    // stops an account from quietly escalating itself.
    if (isSelf) {
      return { ok: false, status: 403, error: 'You cannot change your own role' };
    }
    // Invariant 3: demoting the last remaining admin would lock everyone out.
    if (isAdminRole(target.role) && !isAdminRole(changes.role)) {
      const others = await countActiveAdmins(client, target.id);
      if (others === 0) {
        return {
          ok: false,
          status: 409,
          error: 'Cannot demote the last remaining administrator',
        };
      }
    }
  }

  // --- deactivation --------------------------------------------------
  if (changes.isActive === false && target.isActive) {
    if (isSelf) {
      return { ok: false, status: 403, error: 'You cannot deactivate your own account' };
    }
    if (isAdminRole(target.role)) {
      const others = await countActiveAdmins(client, target.id);
      if (others === 0) {
        return {
          ok: false,
          status: 409,
          error: 'Cannot deactivate the last remaining administrator',
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Persist a validated update and write one audit row per changed field.
 * Returns the updated user.
 */
async function applyUserUpdate(target, actor, changes, client = prisma) {
  const events = [];
  const auditEvents = [];
  const data = {};

  if (changes.name !== undefined && changes.name !== target.name) {
    data.name = changes.name;
    auditEvents.push({
      action: 'agent.updated',
      from: { name: target.name },
      to: { name: changes.name },
      description: `${target.name}: name changed to ${changes.name}`,
    });
  }
  if (changes.passwordHash !== undefined) {
    data.passwordHash = changes.passwordHash;
    // Record that the credential changed — never the credential itself.
    auditEvents.push({
      action: 'agent.password_changed',
      description: `${target.name}: password changed`,
    });
  }

  if (changes.role !== undefined && changes.role !== target.role) {
    data.role = changes.role;
    events.push({
      action: AUDIT_ACTIONS.ROLE_CHANGED,
      field: 'role',
      fromValue: target.role,
      toValue: changes.role,
      note:
        isAdminRole(changes.role)
          ? 'Promoted to administrator'
          : isAdminRole(target.role)
            ? 'Demoted from administrator'
            : `Role changed to ${changes.role}`,
    });
  }

  if (changes.isActive !== undefined && changes.isActive !== target.isActive) {
    data.isActive = changes.isActive;
    events.push({
      action: changes.isActive ? AUDIT_ACTIONS.ACTIVATED : AUDIT_ACTIONS.DEACTIVATED,
      field: 'isActive',
      fromValue: String(target.isActive),
      toValue: String(changes.isActive),
      note: changes.isActive ? 'Account activated' : 'Account deactivated',
    });
  }

  if (changes.isAvailable !== undefined && changes.isAvailable !== target.isAvailable) {
    data.isAvailable = changes.isAvailable;
    events.push({
      action: AUDIT_ACTIONS.AVAILABILITY_CHANGED,
      field: 'isAvailable',
      fromValue: String(target.isAvailable),
      toValue: String(changes.isAvailable),
      note: changes.isAvailable ? 'Marked available' : 'Marked unavailable',
    });
  }

  if (changes.teamId !== undefined && changes.teamId !== target.teamId) {
    data.teamId = changes.teamId;
    events.push({
      action: AUDIT_ACTIONS.GROUP_CHANGED,
      field: 'teamId',
      fromValue: target.teamId === null ? 'none' : String(target.teamId),
      toValue: changes.teamId === null ? 'none' : String(changes.teamId),
      note: 'Assignment group changed',
    });
  }

  if (changes.skillLevel !== undefined && changes.skillLevel !== target.skillLevel) {
    data.skillLevel = changes.skillLevel;
    events.push({
      action: AUDIT_ACTIONS.SKILL_CHANGED,
      field: 'skillLevel',
      fromValue: String(target.skillLevel),
      toValue: String(changes.skillLevel),
      note: 'Skill level changed',
    });
  }

  const updated = await client.agent.update({
    where: { id: target.id },
    data,
    include: { team: true },
  });

  if (events.length) {
    await client.userAuditLog.createMany({
      data: events.map((e) => ({ ...e, agentId: target.id, actor: actorLabel(actor) })),
    });
    // The same field changes join the unified trail, one event per field,
    // actioned agent.<userAuditAction>.
    auditEvents.push(
      ...events.map((e) => ({
        action: `agent.${e.action}`,
        from: { [e.field]: e.fromValue },
        to: { [e.field]: e.toValue },
        description: `${target.name}: ${e.note}`,
      }))
    );
  }
  if (auditEvents.length) {
    await auditService.recordMany(
      client,
      auditEvents.map((e) => ({
        ...e,
        entityType: 'Agent',
        entityId: target.id,
        entityLabel: `${target.name} <${target.email}>`,
        actor,
      }))
    );
  }

  // Availability timeline: a PATCH that flips isActive/isAvailable is a real
  // availability transition (offline <-> online/unavailable) and joins the
  // same period history the presence-only state endpoint writes. Same-state
  // updates record nothing. Lazy requires: assignmentPoolService is upstream
  // of this module through assignmentPolicy.
  if (data.isActive !== undefined || data.isAvailable !== undefined) {
    const { availabilityStateOf } = require('./assignmentPoolService');
    const { recordTransition } = require('./availabilityHistoryService');
    const from = availabilityStateOf(target);
    const to = availabilityStateOf(updated);
    if (from !== to) {
      await recordTransition({
        agentId: target.id,
        from,
        to,
        actorId: actor ? actor.id : null,
        source: 'admin',
        note: events.map((e) => e.note).join('; ') || null,
        client,
      });
    }
  }

  return { user: updated, events };
}

/** Record the creation of a user. */
async function recordUserCreated(user, actor, client = prisma) {
  await client.userAuditLog.create({
    data: {
      agentId: user.id,
      action: AUDIT_ACTIONS.CREATED,
      field: 'role',
      fromValue: null,
      toValue: user.role,
      actor: actorLabel(actor),
      note: `Account provisioned as ${user.role}`,
    },
  });
  await auditService.record(client, {
    action: 'agent.created',
    entityType: 'Agent',
    entityId: user.id,
    entityLabel: `${user.name} <${user.email}>`,
    actor,
    to: { role: user.role },
    description: `Account ${user.email} provisioned as ${user.role}`,
  });
}

/* ==================================================================== */
/* Initial administrator bootstrap                                      */
/* ==================================================================== */
//
// The very first administrator cannot be created through the admin API,
// because that API requires an administrator. INITIAL_ADMIN_EMAIL closes that
// gap exactly once.
//
// Guard: the bootstrap only acts while there are ZERO active admins. As soon
// as one exists, it is inert — re-running it, or changing the environment
// variable, can never mint a second admin. The email lives in configuration,
// never in business logic.

function initialAdminEmail() {
  return String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
}

/**
 * Promote (or provision) the configured initial administrator, but only while
 * no administrator exists.
 *
 * @returns {Promise<{status:string, email?:string, reason?:string}>}
 */
async function bootstrapInitialAdmin({ logger = console, client = prisma } = {}) {
  const email = initialAdminEmail();
  if (!email) {
    return { status: 'skipped', reason: 'INITIAL_ADMIN_EMAIL not set' };
  }

  const existingAdmins = await countActiveAdmins(client);
  if (existingAdmins > 0) {
    // Deliberately silent about the configured address: nothing to do, and
    // the mechanism must not look like a way in.
    return { status: 'inert', reason: `${existingAdmins} administrator(s) already exist` };
  }

  const existing = await client.agent.findUnique({ where: { email } });

  if (existing) {
    if (existing.role === ROLES.ADMIN && existing.isActive) {
      return { status: 'inert', reason: 'already an active administrator', email };
    }
    const { user } = await applyUserUpdate(
      existing,
      'system (initial-admin bootstrap)',
      { role: ROLES.ADMIN, isActive: true },
      client
    );
    logger.log(`[users] Bootstrapped initial administrator: ${user.email}`);
    return { status: 'promoted', email: user.email };
  }

  // No account yet. Create one without a password: it becomes usable when the
  // identity provider is connected, or when a password is set explicitly.
  const created = await client.agent.create({
    data: {
      name: email.split('@')[0],
      email,
      role: ROLES.ADMIN,
      isActive: true,
      isAvailable: true,
      passwordHash: null,
    },
  });
  await recordUserCreated(created, 'system (initial-admin bootstrap)', client);
  logger.log(
    `[users] Bootstrapped initial administrator: ${created.email} ` +
      '(no password set — sign-in requires the identity provider or an admin-set password)'
  );
  return { status: 'created', email: created.email };
}

/**
 * Provision a user seen for the first time from an identity provider.
 *
 * Not wired to anything yet — Microsoft Entra authentication is NOT
 * implemented. This is the seam it will use, and it encodes the rule that a
 * first sign-in yields AGENT and never ADMIN.
 */
async function provisionUserFromIdentity(
  { email, name, externalId, provider = 'entra' },
  { logger = console, client = prisma } = {}
) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('email is required to provision a user');

  const existing = externalId
    ? await client.agent.findFirst({ where: { OR: [{ externalId }, { email: normalized }] } })
    : await client.agent.findUnique({ where: { email: normalized } });

  if (existing) {
    // Link the identity on first federated sign-in; never touch the role.
    if (externalId && existing.externalId !== externalId) {
      await client.agent.update({
        where: { id: existing.id },
        data: { externalId, externalProvider: provider },
      });
    }
    return { user: existing, created: false };
  }

  // First sign-in: always AGENT. There is no path here that yields ADMIN.
  const created = await client.agent.create({
    data: {
      name: String(name || normalized.split('@')[0]).trim(),
      email: normalized,
      role: ROLES.AGENT,
      isActive: true,
      isAvailable: true,
      externalId: externalId || null,
      externalProvider: externalId ? provider : null,
      passwordHash: null,
    },
  });
  await recordUserCreated(created, `system (${provider} sign-in)`, client);
  logger.log(`[users] Provisioned ${created.email} as ${created.role} on first sign-in`);

  // A brand-new account may be the configured initial admin, but only while
  // no administrator exists at all.
  await bootstrapInitialAdmin({ logger, client });

  return { user: await client.agent.findUnique({ where: { id: created.id } }), created: true };
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  STAFF_ROLES,
  AUDIT_ACTIONS,
  isValidRole,
  isAdminRole,
  actorLabel,
  countActiveAdmins,
  checkUserUpdate,
  applyUserUpdate,
  recordUserCreated,
  bootstrapInitialAdmin,
  provisionUserFromIdentity,
  initialAdminEmail,
};
