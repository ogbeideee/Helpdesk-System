// Remote Access foundation: controlled remote-support sessions tied to one
// ticket, conducted by one agent.
//
// This is the APPLICATION-SIDE bookkeeping only. No remote-control transport
// exists here — no WebRTC/RDP/VNC, no host addresses, no connection strings,
// and no field anywhere in the model that a credential could live in. A later
// transport feature would hang its real connection data off a session id; it
// must never hang it off this table.
//
// Lifecycle (status + the only legal moves, enforced in canTransition):
//
//   requested ──> active ──> ended
//        │           │
//        └──> cancelled <──┘
//        └──> expired (a request nobody started before its expiresAt)
//
// Rules this module owns (mirroring the rest of the codebase, never
// re-implementing it):
//   * Who may request      -> the same gate as ticket lifecycle actions
//                             (admin, or the assignee, or an unassigned open
//                             ticket) — a non-admin always conducts it
//                             themselves.
//   * Who may start/end    -> the session's agent or an administrator.
//   * Who may cancel       -> the session's agent, the requester, or an admin.
//   * One live session per ticket and per agent -> partial unique indexes in
//                             the migration, so a replayed or concurrent
//                             create is refused by the database itself.
//   * Every transition     -> AuditEvent via auditService (append-only,
//                             credential-shaped values redacted) plus a
//                             TicketAuditLog line so the ticket timeline
//                             shows it, both inside the same transaction as
//                             the write.
//
// Deliberately untouched: ticket assignment, SLA, handovers, routing. A
// remote session is bookkeeping around a ticket, never a change to it.
const prisma = require('../lib/prisma');
const auditService = require('./auditService');
const { OPEN_STATES } = require('../states');
const { STAFF_ROLES, ROLES } = require('./userService');

/** Every status a session can hold. */
const STATUSES = ['requested', 'active', 'ended', 'cancelled', 'expired'];
/** A session that is still standing: it blocks new live sessions. */
const LIVE_STATUSES = ['requested', 'active'];
/** A finished session — history, never written again. */
const TERMINAL_STATUSES = ['ended', 'cancelled', 'expired'];

/** The only legal status moves. Anything else is an invalid transition. */
const TRANSITIONS = {
  requested: ['active', 'cancelled', 'expired'],
  active: ['ended', 'cancelled'],
  ended: [],
  cancelled: [],
  expired: [],
};

/** How long an unstarted request stays live before it expires. */
const REQUEST_TTL_MINUTES = Number(process.env.REMOTE_ACCESS_REQUEST_TTL_MINUTES || 30);

const SESSION_INCLUDE = {
  ticket: { select: { id: true, ticketNumber: true, state: true } },
  agent: { select: { id: true, name: true, email: true } },
  requestedBy: { select: { id: true, name: true, email: true } },
  endedBy: { select: { id: true, name: true, email: true } },
};

function isAdmin(actor) {
  return Boolean(actor && actor.role === ROLES.ADMIN);
}

function fail(status, error) {
  return { ok: false, status, error };
}

function actorName(actor) {
  if (!actor) return 'the system';
  if (typeof actor === 'string') return actor;
  return actor.name || 'the system';
}

/** API shape: ISO stamps, plain-name actors, derived duration, isLive. */
function shapeSession(s) {
  if (!s) return null;
  const durationMs =
    s.startedAt && s.endedAt
      ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
      : null;
  return {
    id: s.id,
    ticketId: s.ticketId,
    ticketNumber: s.ticket ? s.ticket.ticketNumber : null,
    ticketState: s.ticket ? s.ticket.state : null,
    status: s.status,
    isLive: LIVE_STATUSES.includes(s.status),
    agent: s.agent ? { id: s.agent.id, name: s.agent.name, email: s.agent.email } : null,
    requestedBy: s.requestedBy ? { id: s.requestedBy.id, name: s.requestedBy.name } : null,
    endedBy: s.endedBy ? { id: s.endedBy.id, name: s.endedBy.name } : null,
    requestedAt: s.requestedAt ? new Date(s.requestedAt).toISOString() : null,
    expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    note: s.note || null,
    endReason: s.endReason || null,
    durationMs,
  };
}

/** Ticket-timeline line (TicketAuditLog, same shape as handover history). */
async function recordHistory(ticket, actor, note, client = prisma) {
  await client.ticketAuditLog.create({
    data: {
      ticketId: ticket.id,
      fromState: ticket.state,
      toState: ticket.state,
      actor: actor ? `${actor.name} <${actor.email}>` : 'system',
      note,
    },
  });
}

/** Unified-trail entry for a lifecycle change, linked to its ticket. */
async function recordAudit(action, session, ticket, actor, { from, to, description, metadata } = {}, client = prisma) {
  await auditService.record(client, {
    action,
    entityType: 'RemoteAccessSession',
    entityId: session.id,
    entityLabel: `Remote access on ${ticket.ticketNumber} by ${
      session.agent ? session.agent.name : 'an agent'
    }`,
    ticketId: ticket.id,
    actor,
    from,
    to,
    description,
    metadata,
  });
}

/**
 * May `actor` ask for a remote session on `ticket`? The same gate as the
 * ticket lifecycle actions: an administrator, the assignee, or anybody
 * working an unassigned open ticket (so a ticket in triage is never stuck
 * without remote support). A non-admin always conducts the session
 * themselves; arranging one for somebody else is an admin power.
 */
function checkTicketAccess(ticket, actor) {
  if (!actor) return fail(401, 'Authentication required');
  // A user-role account can read tickets but never drives support work.
  if (!STAFF_ROLES.includes(actor.role)) {
    return fail(403, 'Only helpdesk agents can use remote access');
  }
  if (isAdmin(actor)) return { ok: true };
  if (!ticket.assignedAgentId) return { ok: true };
  if (ticket.assignedAgentId === actor.id) return { ok: true };
  return fail(403, 'Only the assigned agent or an administrator can request a remote session on this ticket');
}

/**
 * Request a session: create the row in 'requested', audit it, done. The
 * conductor is `agentId` (admin-only override) or the caller themself.
 */
async function createSession({
  ticketId,
  agentId = null,
  actor = null,
  note = null,
  at = null,
  client = prisma,
}) {
  const now = at ? new Date(at) : new Date();
  if (!Number.isInteger(ticketId)) return fail(404, 'Ticket not found');
  if (agentId !== null && !Number.isInteger(agentId)) return fail(400, 'agentId must be an agent id');
  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return fail(404, 'Ticket not found');

  const access = checkTicketAccess(ticket, actor);
  if (!access.ok) return access;

  // Remote support is work on a live problem — a resolved or closed ticket
  // cannot take one (ending an already-running session stays possible).
  if (!OPEN_STATES.includes(ticket.state)) {
    return fail(400, 'Remote sessions can only be requested on open tickets (NEW or IN_PROGRESS)');
  }

  const targetId = agentId || actor.id;
  if (targetId !== actor.id && !isAdmin(actor)) {
    return fail(403, 'Only an administrator can arrange a session for another agent');
  }
  const agent = await client.agent.findUnique({ where: { id: targetId } });
  if (!agent) return fail(404, 'Agent not found');
  if (!STAFF_ROLES.includes(agent.role)) {
    return fail(400, `${agent.name} is not a helpdesk agent`);
  }
  // A disabled account can never conduct a session, whatever an admin asks.
  if (!agent.isActive) {
    return fail(400, `${agent.name}'s account is deactivated`);
  }

  // One live session per ticket and per agent — checked here for a friendly
  // 409, and enforced regardless by the partial unique indexes.
  const ticketClash = await client.remoteAccessSession.findFirst({
    where: { ticketId: ticket.id, status: { in: LIVE_STATUSES } },
  });
  if (ticketClash) {
    return fail(409, `${ticket.ticketNumber} already has a live remote session — end or cancel it first`);
  }
  const agentClash = await client.remoteAccessSession.findFirst({
    where: { agentId: agent.id, status: { in: LIVE_STATUSES } },
  });
  if (agentClash) {
    return fail(409, `${agent.name} already has a live remote session — end or cancel it first`);
  }

  const requestedAt = now;
  const expiresAt = new Date(requestedAt.getTime() + REQUEST_TTL_MINUTES * 60_000);
  const cleanNote = note ? String(note).trim().slice(0, 500) || null : null;

  const created = await client.$transaction(async (tx) => {
    const session = await tx.remoteAccessSession.create({
      data: {
        ticketId: ticket.id,
        agentId: agent.id,
        requestedById: actor.id,
        status: 'requested',
        requestedAt,
        expiresAt,
        note: cleanNote,
      },
      include: SESSION_INCLUDE,
    });
    await recordAudit(
      'remote_access.requested', session, ticket, actor,
      { to: 'requested', description: `Remote access requested for ${agent.name}` },
      tx
    );
    await recordHistory(
      ticket, actor,
      `Remote access requested for ${agent.name}${cleanNote ? ` — ${cleanNote}` : ''}`,
      tx
    );
    return session;
  });
  return { ok: true, session: shapeSession(created) };
}

/** Load a session with its ticket (for the guards that need ticket state). */
async function loadSession(id, client = prisma) {
  if (!Number.isInteger(id)) return null;
  return client.remoteAccessSession.findUnique({
    where: { id },
    include: SESSION_INCLUDE,
  });
}

/**
 * Start a session: requested -> active. Expires the request first if it sat
 * past its expiresAt (lazy expiry — the status becomes 'expired' and the
 * start is refused). The write is conditional on the status it observed, so
 * two concurrent starts cannot both win.
 */
async function startSession({ sessionId, actor = null, at = null, client = prisma }) {
  const now = at ? new Date(at) : new Date();
  const session = await loadSession(sessionId, client);
  if (!session) return fail(404, 'Remote access session not found');
  if (!isAdmin(actor) && session.agentId !== actor.id) {
    return fail(403, 'Only the session agent or an administrator can start this session');
  }

  const stale =
    session.status === 'requested' && session.expiresAt && new Date(session.expiresAt) < now;
  if (stale) {
    await expireSession(session, client);
    return fail(409, 'The session request expired before it was started');
  }
  if (session.status !== 'requested') {
    return fail(409, `Only a requested session can be started (this one is ${session.status})`);
  }
  if (!OPEN_STATES.includes(session.ticket.state)) {
    return fail(400, 'The ticket is no longer open — the remote session cannot start');
  }

  const updated = await client.$transaction(async (tx) => {
    const moved = await tx.remoteAccessSession.updateMany({
      where: { id: session.id, status: 'requested' },
      data: { status: 'active', startedAt: now },
    });
    if (moved.count === 0) {
      return null; // a concurrent action changed it first
    }
    const fresh = await tx.remoteAccessSession.findUnique({
      where: { id: session.id },
      include: SESSION_INCLUDE,
    });
    await recordAudit(
      'remote_access.started', fresh, session.ticket, actor,
      { from: 'requested', to: 'active', description: `Remote access session started by ${actorName(actor)}` },
      tx
    );
    await recordHistory(session.ticket, actor, `Remote access session started (${session.agent.name})`, tx);
    return fresh;
  });
  if (!updated) return fail(409, 'This session changed state concurrently — reload and try again');
  return { ok: true, session: shapeSession(updated) };
}

/**
 * End a session: active -> ended, with who ended it and why. The natural
 * finish — the work is done.
 */
async function endSession({ sessionId, actor = null, reason = null, at = null, client = prisma }) {
  const now = at ? new Date(at) : new Date();
  const session = await loadSession(sessionId, client);
  if (!session) return fail(404, 'Remote access session not found');
  if (!isAdmin(actor) && session.agentId !== actor.id) {
    return fail(403, 'Only the session agent or an administrator can end this session');
  }
  if (session.status !== 'active') {
    return fail(409, `Only an active session can be ended (this one is ${session.status})`);
  }
  const endReason = reason ? String(reason).trim().slice(0, 500) || null : null;
  const updated = await client.$transaction(async (tx) => {
    const moved = await tx.remoteAccessSession.updateMany({
      where: { id: session.id, status: 'active' },
      data: { status: 'ended', endedAt: now, endReason, endedById: actor.id },
    });
    if (moved.count === 0) return null;
    const fresh = await tx.remoteAccessSession.findUnique({
      where: { id: session.id },
      include: SESSION_INCLUDE,
    });
    await recordAudit(
      'remote_access.ended', fresh, session.ticket, actor,
      {
        from: 'active', to: 'ended',
        description: `Remote access session ended by ${actorName(actor)}${endReason ? ` — ${endReason}` : ''}`,
      },
      tx
    );
    await recordHistory(session.ticket, actor, `Remote access session ended (${session.agent.name})`, tx);
    return fresh;
  });
  if (!updated) return fail(409, 'This session changed state concurrently — reload and try again');
  return { ok: true, session: shapeSession(updated) };
}

/**
 * Cancel a session: requested|active -> cancelled. A requested session is
 * cancelled before it ever started; an active one is abandoned part-way.
 * The session's agent, its requester, or an administrator may cancel.
 */
async function cancelSession({ sessionId, actor = null, reason = null, at = null, client = prisma }) {
  const now = at ? new Date(at) : new Date();
  const session = await loadSession(sessionId, client);
  if (!session) return fail(404, 'Remote access session not found');
  const involved =
    isAdmin(actor) || session.agentId === actor.id || session.requestedById === actor.id;
  if (!involved) {
    return fail(403, 'Only the session agent, the requester or an administrator can cancel this session');
  }
  if (!LIVE_STATUSES.includes(session.status)) {
    return fail(409, `Only a requested or active session can be cancelled (this one is ${session.status})`);
  }
  const from = session.status;
  const endReason = reason ? String(reason).trim().slice(0, 500) || null : null;
  const updated = await client.$transaction(async (tx) => {
    const moved = await tx.remoteAccessSession.updateMany({
      where: { id: session.id, status: { in: LIVE_STATUSES } },
      data: { status: 'cancelled', endedAt: now, endReason, endedById: actor.id },
    });
    if (moved.count === 0) return null;
    const fresh = await tx.remoteAccessSession.findUnique({
      where: { id: session.id },
      include: SESSION_INCLUDE,
    });
    await recordAudit(
      'remote_access.cancelled', fresh, session.ticket, actor,
      {
        from, to: 'cancelled',
        description: `Remote access session cancelled by ${actorName(actor)}${endReason ? ` — ${endReason}` : ''}`,
      },
      tx
    );
    await recordHistory(session.ticket, actor, `Remote access session cancelled (${session.agent.name})`, tx);
    return fresh;
  });
  if (!updated) return fail(409, 'This session changed state concurrently — reload and try again');
  return { ok: true, session: shapeSession(updated) };
}

/**
 * Expire one stale request (requested past its expiresAt): status -> expired,
 * endedAt pinned to the moment it actually lapsed. Audited, like every other
 * transition, with the system as the actor.
 */
async function expireSession(session, client = prisma) {
  const updated = await client.$transaction(async (tx) => {
    const moved = await tx.remoteAccessSession.updateMany({
      where: { id: session.id, status: 'requested' },
      data: { status: 'expired', endedAt: new Date(session.expiresAt) },
    });
    if (moved.count === 0) return null;
    const fresh = await tx.remoteAccessSession.findUnique({
      where: { id: session.id },
      include: SESSION_INCLUDE,
    });
    await recordAudit(
      'remote_access.expired', fresh, session.ticket, 'system',
      {
        from: 'requested', to: 'expired',
        description: `Remote access request expired unstarted`,
      },
      tx
    );
    await recordHistory(session.ticket, null, `Remote access request expired (${session.agent.name})`, tx);
    return fresh;
  });
  return updated;
}

/**
 * Expire every stale request (requested past expiresAt). Called lazily from
 * the read paths so the visible status never lies, and safe to call
 * repeatedly — a replay finds nothing left to expire.
 */
async function expireStaleSessions({ at = new Date(), client = prisma } = {}) {
  const stale = await client.remoteAccessSession.findMany({
    where: { status: 'requested', expiresAt: { lt: at } },
    include: SESSION_INCLUDE,
    orderBy: { id: 'asc' },
  });
  let count = 0;
  for (const session of stale) {
    const done = await expireSession(session, client);
    if (done) count += 1;
  }
  return count;
}

/**
 * The full session history for one ticket, newest first — after lazily
 * expiring any stale request so callers never see a live request that has
 * already lapsed.
 */
async function listForTicket(ticketId, { client = prisma } = {}) {
  if (!Number.isInteger(ticketId)) return [];
  await expireStaleSessions({ client });
  const rows = await client.remoteAccessSession.findMany({
    where: { ticketId },
    include: SESSION_INCLUDE,
    orderBy: [{ id: 'desc' }],
  });
  return rows.map(shapeSession);
}

module.exports = {
  STATUSES,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  REQUEST_TTL_MINUTES,
  SESSION_INCLUDE,
  shapeSession,
  createSession,
  startSession,
  endSession,
  cancelSession,
  expireSession,
  expireStaleSessions,
  listForTicket,
};
