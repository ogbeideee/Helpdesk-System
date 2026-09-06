// Agent-to-agent ticket handovers.
//
//   Agent A -> request handover -> Agent B -> accept / decline / suggest
//
// A handover is an OFFER. The ticket does not change owner until the target
// accepts, so a pending request never affects anybody's workload: workload is
// counted from Ticket.assignedAgentId, which this module only ever changes
// through workloadService.moveTicket.
//
// Nothing here re-implements existing behaviour:
//   * who may hand a ticket to whom -> assignmentPolicy.checkTarget
//   * how a ticket actually moves    -> workloadService.moveTicket (compare-and-set)
//   * how people are told            -> workloadService.notifyOwnershipChange
//                                       (in-app Notification + the existing mailer)
//   * configurable limits            -> settingsService
//
// Concurrency
// -----------
// Every state change is a conditional update (`updateMany` with the expected
// current status in the WHERE clause). Two recipients cannot both accept, an
// accept cannot race a cancel, and queue promotion is idempotent: replaying it
// simply finds no eligible row.
const prisma = require('./../lib/prisma');
const assignmentPolicy = require('./assignmentPolicy');
const assignmentEngine = require('./assignmentEngine');
const workloadService = require('./workloadService');
const settingsService = require('./settingsService');
const auditService = require('./auditService');
const { STAFF_ROLES } = require('./userService');
const { ticketSubject } = require('../email/outbound');

/** A request that is still waiting for an answer. */
const ACTIVE_STATES = ['PENDING', 'QUEUED'];
/** A request that has finished. Never deleted — it is the ticket's history. */
const TERMINAL_STATES = ['ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'];
const STATUSES = [...ACTIVE_STATES, ...TERMINAL_STATES];

/** A ticket in one of these states can no longer be handed over. */
const CLOSED_STATES = ['RESOLVED', 'CLOSED'];

const SWEEP_INTERVAL_MS = Number(process.env.HANDOVER_SWEEP_INTERVAL_MS || 60 * 1000);

const REQUEST_INCLUDE = {
  ticket: {
    select: { id: true, ticketNumber: true, shortDescription: true, state: true, priority: true, teamId: true },
  },
  requestedBy: { select: { id: true, name: true, email: true } },
  targetAgent: { select: { id: true, name: true, email: true } },
  suggestedAgent: { select: { id: true, name: true, email: true, skillLevel: true } },
};

function actorLabel(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return `${actor.name} <${actor.email}>`;
}

function actorName(actor) {
  if (!actor) return 'the system';
  if (typeof actor === 'string') return actor;
  return actor.name;
}

/** Ticket-history line. Uses the existing audit log so the timeline picks it up. */
async function recordHistory(ticket, actor, note, client = prisma) {
  await client.ticketAuditLog.create({
    data: {
      ticketId: ticket.id,
      fromState: ticket.state,
      toState: ticket.state,
      actor: actorLabel(actor),
      note,
    },
  });
}

/**
 * Unified trail entry for a handover state change, linked to its ticket so
 * auditService.forTicket() finds it. The TicketAuditLog line above stays the
 * ticket timeline's record; this is the cross-entity trail.
 */
async function recordAudit(
  action,
  request,
  ticket,
  actor,
  { from, to, description, metadata } = {},
  client = prisma
) {
  await auditService.record(client, {
    action,
    entityType: 'HandoverRequest',
    entityId: request.id,
    entityLabel: `Handover of ${ticket.ticketNumber} to ${
      request.targetAgent ? request.targetAgent.name : 'an agent'
    }`,
    ticketId: ticket.id,
    actor,
    from,
    to,
    description,
    metadata,
  });
}

/* ==================================================================== */
/* Expiry clock                                                         */
/* ==================================================================== */

/**
 * Milliseconds left before this request expires.
 * QUEUED requests have no clock — theirs starts when they are activated.
 * A paused request keeps its remaining time frozen.
 */
function timeRemainingMs(request, now = Date.now()) {
  if (request.status !== 'PENDING') return null;
  if (request.pausedAt) return request.remainingMs ?? null;
  if (!request.expiresAt) return null;
  return Math.max(0, new Date(request.expiresAt).getTime() - now);
}

function isExpired(request, now = Date.now()) {
  if (request.status !== 'PENDING' || request.pausedAt) return false;
  return Boolean(request.expiresAt) && new Date(request.expiresAt).getTime() <= now;
}

/** Shape one request for an API response. */
function serialize(request, now = Date.now()) {
  const remaining = timeRemainingMs(request, now);
  return {
    ...request,
    remainingMs: remaining,
    remainingMinutes: remaining === null ? null : Math.round(remaining / 60000),
    paused: Boolean(request.pausedAt),
    active: ACTIVE_STATES.includes(request.status),
  };
}

/* ==================================================================== */
/* Notifications — the existing feed + mailer, never a second system    */
/* ==================================================================== */

async function notify({ agent, ticket, type, title, body }, client = prisma) {
  await workloadService.notifyOwnershipChange(
    {
      agent,
      ticket,
      type,
      title,
      body,
      emailSubject: ticketSubject(ticket, title),
      emailBody: [`Hi ${agent.name},`, '', body, '', `Subject: ${ticket.shortDescription}`].join('\r\n'),
    },
    client
  );
}

/* ==================================================================== */
/* Queue                                                                */
/* ==================================================================== */

async function activeCountFor(targetAgentId, client = prisma) {
  return client.handoverRequest.count({
    where: { targetAgentId, status: 'PENDING' },
  });
}

/**
 * Turn a QUEUED request into a live PENDING one and start its expiry clock.
 * If the target happens to be unavailable the clock starts paused, so nobody
 * loses a request while they are away.
 */
async function activate(request, { expiryMinutes, client = prisma, announce = true }) {
  const target = await client.agent.findUnique({ where: { id: request.targetAgentId } });
  const paused = target ? !(target.isActive && target.isAvailable) : false;
  const totalMs = expiryMinutes * 60000;

  // Conditional: only a QUEUED (or already-PENDING, on retry) row is activated.
  const result = await client.handoverRequest.updateMany({
    where: { id: request.id, status: 'QUEUED' },
    data: {
      status: 'PENDING',
      activatedAt: new Date(),
      queuedAt: null,
      expiresAt: paused ? null : new Date(Date.now() + totalMs),
      pausedAt: paused ? new Date() : null,
      remainingMs: paused ? totalMs : null,
    },
  });
  if (result.count === 0) return null;

  const fresh = await client.handoverRequest.findUnique({ where: { id: request.id }, include: REQUEST_INCLUDE });
  if (announce && target) {
    await notify(
      {
        agent: target,
        ticket: fresh.ticket,
        type: 'handover_requested',
        title: `Handover request for ${fresh.ticket.ticketNumber}`,
        body:
          `${fresh.requestedBy.name} has asked you to take ${fresh.ticket.ticketNumber} ` +
          `(${fresh.ticket.shortDescription}). A slot has opened, so this request is now waiting for your answer.`,
      },
      client
    );
  }
  return fresh;
}

/**
 * Fill any free slots for one recipient from their FIFO queue.
 *
 * Idempotent and bounded: it activates the oldest queued requests until the
 * limit is reached or the queue is empty, and replaying it does nothing.
 */
async function promoteQueue(targetAgentId, client = prisma) {
  const limit = await settingsService.get('handoverPendingLimit', client);
  const expiryMinutes = await settingsService.get('handoverExpiryMinutes', client);
  const promoted = [];

  // Bounded by the limit itself: at most `limit` slots can ever be free.
  for (let i = 0; i < limit; i++) {
    const live = await activeCountFor(targetAgentId, client);
    if (live >= limit) break;

    const next = await client.handoverRequest.findFirst({
      where: { targetAgentId, status: 'QUEUED' },
      orderBy: { id: 'asc' }, // FIFO
    });
    if (!next) break;

    const activated = await activate(next, { expiryMinutes, client });
    if (!activated) break; // somebody else promoted it — nothing to do
    promoted.push(activated);
  }
  return promoted;
}

/** 1-based FIFO position of a queued request. */
async function queuePosition(request, client = prisma) {
  if (request.status !== 'QUEUED') return null;
  const ahead = await client.handoverRequest.count({
    where: { targetAgentId: request.targetAgentId, status: 'QUEUED', id: { lt: request.id } },
  });
  return ahead + 1;
}

/* ==================================================================== */
/* Creating a request                                                   */
/* ==================================================================== */

/**
 * May `actor` hand `ticket` to `target`?
 *
 * The group/ownership/availability rules are assignmentPolicy's, unchanged:
 * an AGENT may only offer their own ticket to an available teammate in the
 * same assignment group; an ADMIN may offer any open ticket to anyone.
 */
function checkRequest(ticket, actor, target) {
  if (!actor) return { ok: false, status: 401, error: 'Authentication required' };
  if (CLOSED_STATES.includes(ticket.state)) {
    return { ok: false, status: 400, error: `Cannot hand over a ${ticket.state.toLowerCase()} ticket` };
  }
  if (!ticket.assignedAgentId) {
    return {
      ok: false,
      status: 400,
      error: 'This ticket has no owner to hand over — assign it first',
    };
  }
  if (!assignmentPolicy.isAdmin(actor) && ticket.assignedAgentId !== actor.id) {
    return { ok: false, status: 403, error: 'You can only hand over tickets assigned to you' };
  }
  if (target && target.id === ticket.assignedAgentId) {
    return { ok: false, status: 400, error: 'This ticket is already with that agent' };
  }
  return assignmentPolicy.checkTarget(ticket, actor, target);
}

/**
 * Create a handover request. PENDING when the recipient has a free slot,
 * QUEUED otherwise.
 *
 * The slot count and the insert happen in one transaction so two simultaneous
 * requests cannot both claim the last slot.
 */
async function createRequest({ ticket, actor, targetAgentId, note }, client = prisma) {
  const target = await client.agent.findUnique({ where: { id: targetAgentId } });
  const verdict = checkRequest(ticket, actor, target);
  if (!verdict.ok) return verdict;

  // One offer at a time per ticket: the requester waits for an answer, or
  // cancels, before trying somebody else.
  const existing = await client.handoverRequest.findFirst({
    where: { ticketId: ticket.id, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
  });
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: `${ticket.ticketNumber} already has a handover awaiting ${existing.targetAgent.name}. Cancel it first.`,
    };
  }

  const limit = await settingsService.get('handoverPendingLimit', client);
  const expiryMinutes = await settingsService.get('handoverExpiryMinutes', client);
  const owner = await client.agent.findUnique({ where: { id: ticket.assignedAgentId } });

  const created = await client.$transaction(async (tx) => {
    const live = await tx.handoverRequest.count({
      where: { targetAgentId, status: 'PENDING' },
    });
    const queued = live >= limit;
    const paused = !(target.isActive && target.isAvailable);
    const totalMs = expiryMinutes * 60000;

    return tx.handoverRequest.create({
      data: {
        ticketId: ticket.id,
        // The person giving the ticket away is its owner, even when an admin
        // raises the request on their behalf.
        requestedById: ticket.assignedAgentId,
        targetAgentId,
        status: queued ? 'QUEUED' : 'PENDING',
        note: note ? String(note).trim().slice(0, 500) : null,
        queuedAt: queued ? new Date() : null,
        activatedAt: queued ? null : new Date(),
        expiresAt: queued || paused ? null : new Date(Date.now() + totalMs),
        pausedAt: !queued && paused ? new Date() : null,
        remainingMs: !queued && paused ? totalMs : null,
      },
      include: REQUEST_INCLUDE,
    });
  });

  const position = await queuePosition(created, client);

  await recordHistory(
    ticket,
    actor,
    created.status === 'QUEUED'
      ? `Handover requested: ${owner ? owner.name : 'unassigned'} → ${target.name} (queued, position ${position})`
      : `Handover requested: ${owner ? owner.name : 'unassigned'} → ${target.name}`,
    client
  );

  await recordAudit(
    'handover.created',
    created,
    ticket,
    actor,
    {
      to: { status: created.status, target: target.name },
      description:
        `${actorName(actor)} requested a handover of ${ticket.ticketNumber} to ${target.name}` +
        (created.status === 'QUEUED' ? ` (queued at position ${position})` : ''),
      metadata: { status: created.status, queuePosition: position },
    },
    client
  );

  if (created.status === 'PENDING') {
    await notify(
      {
        agent: target,
        ticket: created.ticket,
        type: 'handover_requested',
        title: `Handover request for ${ticket.ticketNumber}`,
        body:
          `${created.requestedBy.name} has asked you to take ${ticket.ticketNumber} ` +
          `(${ticket.shortDescription}).` + (created.note ? ` Note: ${created.note}` : ''),
      },
      client
    );
  } else {
    await notify(
      {
        agent: target,
        ticket: created.ticket,
        type: 'handover_queued',
        title: `Handover queued for ${ticket.ticketNumber}`,
        body:
          `${created.requestedBy.name} has asked you to take ${ticket.ticketNumber}. ` +
          `You are at your limit of ${limit} active request(s), so this is queued at position ${position} ` +
          'and will be activated automatically.',
      },
      client
    );
  }

  return { ok: true, request: { ...serialize(created), queuePosition: position } };
}

/* ==================================================================== */
/* Responding                                                           */
/* ==================================================================== */

/** Claim a PENDING request for one outcome. Returns null if somebody beat us. */
async function claim(requestId, toStatus, data, client = prisma) {
  const result = await client.handoverRequest.updateMany({
    // Compare-and-set on status: exactly one caller can move it out of PENDING.
    where: { id: requestId, status: 'PENDING' },
    data: { status: toStatus, respondedAt: new Date(), ...data },
  });
  if (result.count === 0) return null;
  return client.handoverRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });
}

/**
 * Accept: ownership transfers immediately, the ticket's status is untouched,
 * the previous agent is told, and the handover is kept in history.
 */
async function accept({ request, actor, note, client = prisma }) {
  const ticket = await client.ticket.findUnique({
    where: { id: request.ticketId },
    include: { team: true },
  });
  if (!ticket) return { ok: false, status: 404, error: 'Ticket not found' };

  // The offer only makes sense while the requester still owns an open ticket.
  if (CLOSED_STATES.includes(ticket.state) || ticket.assignedAgentId !== request.requestedById) {
    await claim(request.id, 'CANCELLED', {
      resolvedBy: 'system',
      responseNote: 'The ticket moved on before this handover was answered',
    }, client);
    await recordAudit('handover.cancelled', request, ticket, null, {
      description: `Handover of ${ticket.ticketNumber} cancelled — the ticket moved on before it was answered`,
      metadata: { reason: 'The ticket moved on before this handover was answered' },
    }, client);
    await promoteQueue(request.targetAgentId, client);
    return { ok: false, status: 409, error: 'This ticket has already moved on — the handover was cancelled' };
  }

  const claimed = await claim(request.id, 'ACCEPTED', {
    resolvedBy: actorLabel(actor),
    responseNote: note ? String(note).trim().slice(0, 500) : null,
  }, client);
  if (!claimed) return { ok: false, status: 409, error: 'This handover has already been answered' };

  // The move itself is the existing compare-and-set: the ticket's state,
  // group and SLA are untouched, only its owner changes.
  const outcome = await workloadService.moveTicket(
    {
      ticket,
      toAgentId: request.targetAgentId,
      actor,
      note: `handover accepted by ${claimed.targetAgent.name}`,
      // The requester gets the handover-specific message below instead of the
      // generic reassignment one.
      notifyPrevious: false,
    },
    client
  );

  if (!outcome.moved) {
    await client.handoverRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED', responseNote: 'The ticket moved on before this handover was answered' },
    });
    await recordAudit('handover.cancelled', request, ticket, null, {
      description: `Handover of ${ticket.ticketNumber} cancelled — the ticket moved on before it was answered`,
      metadata: { reason: 'The ticket moved on before this handover was answered' },
    }, client);
    await promoteQueue(request.targetAgentId, client);
    return { ok: false, status: 409, error: 'This ticket has already moved on — the handover was cancelled' };
  }

  // The ownership move itself is audited by workloadService.moveTicket
  // (ticket.assigned); this event records the handover decision.
  await recordAudit('handover.accepted', claimed, ticket, actor, {
    to: { owner: claimed.targetAgent.name },
    description:
      `${claimed.targetAgent.name} accepted the handover of ${ticket.ticketNumber} ` +
      `from ${claimed.requestedBy.name}`,
    metadata: claimed.responseNote ? { note: claimed.responseNote } : null,
  }, client);

  await notify(
    {
      agent: claimed.requestedBy,
      ticket: claimed.ticket,
      type: 'handover_accepted',
      title: `${claimed.ticket.ticketNumber} handover accepted`,
      body:
        `${claimed.targetAgent.name} accepted your handover of ${claimed.ticket.ticketNumber} ` +
        `and now owns it.` + (claimed.responseNote ? ` Note: ${claimed.responseNote}` : ''),
    },
    client
  );

  // Accepting frees one of the recipient's slots.
  await promoteQueue(request.targetAgentId, client);
  return { ok: true, request: serialize(claimed), ticket: outcome.ticket };
}

/** Decline: the ticket stays with the original agent. */
async function decline({ request, actor, note, suggestedAgentId, client = prisma }) {
  let suggested = null;
  if (suggestedAgentId !== undefined && suggestedAgentId !== null) {
    suggested = await client.agent.findUnique({ where: { id: suggestedAgentId } });
    if (!suggested) return { ok: false, status: 404, error: 'Suggested agent not found' };
    if (!STAFF_ROLES.includes(suggested.role) || !suggested.isActive) {
      return { ok: false, status: 400, error: `${suggested.name} cannot take tickets` };
    }
    if (suggested.id === request.targetAgentId) {
      return { ok: false, status: 400, error: 'Accept the handover rather than suggesting yourself' };
    }
    if (suggested.id === request.requestedById) {
      return { ok: false, status: 400, error: 'That agent already owns this ticket' };
    }
  }

  const claimed = await claim(request.id, 'DECLINED', {
    resolvedBy: actorLabel(actor),
    responseNote: note ? String(note).trim().slice(0, 500) : null,
    suggestedAgentId: suggested ? suggested.id : null,
  }, client);
  if (!claimed) return { ok: false, status: 409, error: 'This handover has already been answered' };

  const ticket = await client.ticket.findUnique({ where: { id: request.ticketId } });

  // Requirement 2: the exact wording the history should carry.
  await recordHistory(
    ticket,
    actor,
    `Handover declined by ${claimed.targetAgent.name}` +
      (suggested ? ` — suggested ${suggested.name} instead` : '') +
      (claimed.responseNote ? ` — ${claimed.responseNote}` : ''),
    client
  );

  await recordAudit('handover.declined', claimed, ticket, actor, {
    description:
      `${claimed.targetAgent.name} declined the handover of ${ticket.ticketNumber}` +
      (suggested ? ` — suggested ${suggested.name} instead` : ''),
    metadata: {
      suggested: suggested ? suggested.name : null,
      ...(claimed.responseNote ? { note: claimed.responseNote } : {}),
    },
  }, client);

  await notify(
    {
      agent: claimed.requestedBy,
      ticket: claimed.ticket,
      type: suggested ? 'handover_suggested' : 'handover_declined',
      title: `${claimed.ticket.ticketNumber} handover declined`,
      body: suggested
        ? `${claimed.targetAgent.name} declined your handover of ${claimed.ticket.ticketNumber} and ` +
          `suggested ${suggested.name} instead. No request has been sent — it is your decision whether to ask them.` +
          (claimed.responseNote ? ` Note: ${claimed.responseNote}` : '')
        : `${claimed.targetAgent.name} declined your handover of ${claimed.ticket.ticketNumber}. ` +
          `The ticket is still yours.` + (claimed.responseNote ? ` Note: ${claimed.responseNote}` : ''),
    },
    client
  );

  await promoteQueue(request.targetAgentId, client);
  return { ok: true, request: serialize(claimed), suggestion: suggested };
}

/**
 * Cancel a pending or queued request. Deliberately silent for the recipient:
 * requirement 5 says the recipient is not notified.
 */
async function cancel({ request, actor, reason, client = prisma }) {
  const result = await client.handoverRequest.updateMany({
    where: { id: request.id, status: { in: ACTIVE_STATES } },
    data: {
      status: 'CANCELLED',
      respondedAt: new Date(),
      resolvedBy: actorLabel(actor),
      responseNote: reason ? String(reason).trim().slice(0, 500) : null,
    },
  });
  if (result.count === 0) return { ok: false, status: 409, error: 'This handover is no longer active' };

  const fresh = await client.handoverRequest.findUnique({ where: { id: request.id }, include: REQUEST_INCLUDE });
  const ticket = await client.ticket.findUnique({ where: { id: request.ticketId } });

  // Retained in the ticket's history even though nobody is notified.
  await recordHistory(
    ticket,
    actor,
    `Handover to ${fresh.targetAgent.name} cancelled by ${actorName(actor)}` +
      (fresh.responseNote ? ` — ${fresh.responseNote}` : ''),
    client
  );

  await recordAudit('handover.cancelled', fresh, ticket, actor, {
    description:
      `Handover of ${ticket.ticketNumber} to ${fresh.targetAgent.name} cancelled by ${actorName(actor)}`,
    metadata: fresh.responseNote ? { reason: fresh.responseNote } : null,
  }, client);

  if (request.status === 'PENDING') await promoteQueue(request.targetAgentId, client);
  return { ok: true, request: serialize(fresh) };
}

/**
 * ADMIN override: transfer ownership without waiting for the recipient.
 * Requirement 1 — only an administrator can short-circuit the process.
 */
async function override({ request, actor, client = prisma }) {
  if (!assignmentPolicy.isAdmin(actor)) {
    return { ok: false, status: 403, error: 'Administrator role required' };
  }
  return accept({ request, actor, note: `Forced through by ${actorName(actor)}`, client });
}

/* ==================================================================== */
/* Ticket + agent lifecycle hooks                                       */
/* ==================================================================== */

/**
 * Requirement 5: a ticket that reaches RESOLVED or CLOSED cancels any handover
 * still awaiting an answer. The ticket itself is left exactly as it is.
 */
async function cancelForTicket(ticketId, actor, reason, client = prisma) {
  const active = await client.handoverRequest.findMany({
    where: { ticketId, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
  });
  if (!active.length) return { cancelled: 0 };

  const ticket = await client.ticket.findUnique({ where: { id: ticketId } });
  let cancelled = 0;
  for (const r of active) {
    const result = await client.handoverRequest.updateMany({
      where: { id: r.id, status: { in: ACTIVE_STATES } },
      data: {
        status: 'CANCELLED',
        respondedAt: new Date(),
        resolvedBy: actorLabel(actor),
        responseNote: reason || `Ticket was ${ticket.state.toLowerCase()}`,
      },
    });
    if (result.count === 0) continue;
    cancelled += 1;
    await recordHistory(
      ticket,
      actor,
      `Handover to ${r.targetAgent.name} cancelled — ticket was ${ticket.state.toLowerCase()}`,
      client
    );
    await recordAudit('handover.cancelled', r, ticket, actor, {
      description:
        `Handover of ${ticket.ticketNumber} to ${r.targetAgent.name} cancelled — ticket was ${ticket.state.toLowerCase()}`,
      metadata: { reason: reason || `Ticket was ${ticket.state.toLowerCase()}` },
    }, client);
    if (r.status === 'PENDING') await promoteQueue(r.targetAgentId, client);
  }
  return { cancelled };
}

/**
 * Requirement 4: the expiry timer pauses while the recipient is unavailable
 * and resumes when they are back, so time away never costs them a request.
 */
async function onAvailabilityChanged(agentId, isAvailable, client = prisma) {
  const pending = await client.handoverRequest.findMany({
    where: { targetAgentId: agentId, status: 'PENDING' },
  });
  const now = Date.now();
  let paused = 0;
  let resumed = 0;

  for (const r of pending) {
    if (!isAvailable && !r.pausedAt) {
      const remaining = r.expiresAt ? Math.max(0, new Date(r.expiresAt).getTime() - now) : null;
      await client.handoverRequest.updateMany({
        where: { id: r.id, status: 'PENDING', pausedAt: null },
        data: { pausedAt: new Date(), remainingMs: remaining, expiresAt: null },
      });
      paused += 1;
    } else if (isAvailable && r.pausedAt) {
      await client.handoverRequest.updateMany({
        where: { id: r.id, status: 'PENDING', NOT: { pausedAt: null } },
        data: {
          pausedAt: null,
          remainingMs: null,
          expiresAt: new Date(now + (r.remainingMs ?? 0)),
        },
      });
      resumed += 1;
    }
  }
  return { paused, resumed };
}

/**
 * Requirement 4: a deactivated recipient cannot answer, so their outstanding
 * requests are routed to another suitable available agent using the normal
 * assignment rules. If nobody is suitable the request is cancelled and the
 * original agent — who still owns the ticket — is told.
 *
 * Requests raised *by* the deactivated agent are cancelled: their tickets are
 * being reassigned, so the offer no longer means anything.
 */
async function onAgentDeactivated(agentId, actor, client = prisma) {
  const summary = { rerouted: 0, cancelled: 0, details: [] };

  const raised = await client.handoverRequest.findMany({
    where: { requestedById: agentId, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
  });
  for (const r of raised) {
    const outcome = await cancel({
      request: r,
      actor,
      reason: `${r.requestedBy.name} was deactivated`,
      client,
    });
    if (outcome.ok) summary.cancelled += 1;
  }

  const received = await client.handoverRequest.findMany({
    where: { targetAgentId: agentId, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
  });

  for (const r of received) {
    const ticket = await client.ticket.findUnique({ where: { id: r.ticketId } });
    if (!ticket || CLOSED_STATES.includes(ticket.state)) {
      const outcome = await cancel({ request: r, actor, reason: 'Recipient deactivated', client });
      if (outcome.ok) summary.cancelled += 1;
      continue;
    }

    // Same algorithm the assignment engine uses everywhere else, minus the
    // deactivated agent and the person who still owns the ticket.
    const decision = await assignmentEngine.assign(
      {
        category: ticket.category,
        priority: ticket.priority,
        text: `${ticket.shortDescription}\n${ticket.body || ''}`,
        forceTeamId: ticket.teamId || undefined,
        excludeAgentIds: [agentId, r.requestedById],
      },
      client,
      { log: () => {}, warn: () => {} }
    );
    const replacement = decision.agent || null;

    if (!replacement) {
      const outcome = await cancel({
        request: r,
        actor,
        reason: 'Recipient deactivated and no suitable agent was available',
        client,
      });
      if (outcome.ok) {
        summary.cancelled += 1;
        await notify(
          {
            agent: r.requestedBy,
            ticket: r.ticket,
            type: 'handover_cancelled',
            title: `${r.ticket.ticketNumber} handover cancelled`,
            body:
              `${r.targetAgent.name} was deactivated and no other suitable agent was available, ` +
              `so your handover of ${r.ticket.ticketNumber} was cancelled. The ticket is still yours.`,
          },
          client
        );
      }
      continue;
    }

    const limit = await settingsService.get('handoverPendingLimit', client);
    const expiryMinutes = await settingsService.get('handoverExpiryMinutes', client);
    const live = await activeCountFor(replacement.id, client);
    const queued = live >= limit;
    const paused = !(replacement.isActive && replacement.isAvailable);
    const totalMs = expiryMinutes * 60000;

    const moved = await client.handoverRequest.updateMany({
      where: { id: r.id, status: { in: ACTIVE_STATES }, targetAgentId: agentId },
      data: {
        targetAgentId: replacement.id,
        status: queued ? 'QUEUED' : 'PENDING',
        queuedAt: queued ? new Date() : null,
        activatedAt: queued ? null : new Date(),
        expiresAt: queued || paused ? null : new Date(Date.now() + totalMs),
        pausedAt: !queued && paused ? new Date() : null,
        remainingMs: !queued && paused ? totalMs : null,
      },
    });
    if (moved.count === 0) continue;

    summary.rerouted += 1;
    summary.details.push({ requestId: r.id, from: r.targetAgent.name, to: replacement.name });

    await recordHistory(
      ticket,
      actor,
      `Handover rerouted from ${r.targetAgent.name} to ${replacement.name} ` +
        `(${r.targetAgent.name} was deactivated)`,
      client
    );
    await recordAudit('handover.rerouted', r, ticket, actor, {
      from: { target: r.targetAgent.name },
      to: { target: replacement.name },
      description:
        `Handover of ${ticket.ticketNumber} rerouted from ${r.targetAgent.name} to ${replacement.name} ` +
        `(${r.targetAgent.name} was deactivated)`,
      metadata: { reason: 'Recipient deactivated', status: queued ? 'QUEUED' : 'PENDING' },
    }, client);
    if (!queued) {
      await notify(
        {
          agent: replacement,
          ticket: r.ticket,
          type: 'handover_requested',
          title: `Handover request for ${r.ticket.ticketNumber}`,
          body:
            `${r.requestedBy.name} asked ${r.targetAgent.name} to take ${r.ticket.ticketNumber}, ` +
            'but they were deactivated. The request has been routed to you.',
        },
        client
      );
    }
    await notify(
      {
        agent: r.requestedBy,
        ticket: r.ticket,
        type: 'handover_rerouted',
        title: `${r.ticket.ticketNumber} handover rerouted`,
        body:
          `${r.targetAgent.name} was deactivated, so your handover of ${r.ticket.ticketNumber} ` +
          `is now with ${replacement.name}.`,
      },
      client
    );
  }

  return summary;
}

/* ==================================================================== */
/* Expiry sweep                                                         */
/* ==================================================================== */

/**
 * Expire every request whose clock has run out. Paused requests are skipped by
 * construction: pausing clears expiresAt.
 */
async function sweepExpired({ client = prisma, now = new Date() } = {}) {
  const due = await client.handoverRequest.findMany({
    where: { status: 'PENDING', pausedAt: null, expiresAt: { lte: now } },
    include: REQUEST_INCLUDE,
  });

  const expired = [];
  for (const r of due) {
    const result = await client.handoverRequest.updateMany({
      where: { id: r.id, status: 'PENDING' },
      data: { status: 'EXPIRED', respondedAt: new Date(), resolvedBy: 'system' },
    });
    if (result.count === 0) continue;

    const ticket = await client.ticket.findUnique({ where: { id: r.ticketId } });
    if (ticket) {
      await recordHistory(
        ticket,
        'system',
        `Handover to ${r.targetAgent.name} expired — ticket remains with ${r.requestedBy.name}`,
        client
      );
      await recordAudit('handover.expired', r, ticket, 'system', {
        description:
          `Handover of ${ticket.ticketNumber} to ${r.targetAgent.name} expired — ` +
          `ticket remains with ${r.requestedBy.name}`,
      }, client);
    }
    await notify(
      {
        agent: r.requestedBy,
        ticket: r.ticket,
        type: 'handover_expired',
        title: `${r.ticket.ticketNumber} handover expired`,
        body:
          `${r.targetAgent.name} did not answer your handover of ${r.ticket.ticketNumber} in time. ` +
          'The ticket is still yours — you can ask somebody else.',
      },
      client
    );
    await promoteQueue(r.targetAgentId, client);
    expired.push(r.id);
  }
  return { expired: expired.length, ids: expired };
}

let sweepTimer = null;
let sweepRunning = false;

function startExpirySweeper({ logger = console } = {}) {
  if (SWEEP_INTERVAL_MS <= 0) {
    logger.log('[handover] expiry sweeping disabled (HANDOVER_SWEEP_INTERVAL_MS=0)');
    return false;
  }
  sweepTimer = setInterval(async () => {
    if (sweepRunning) return; // never overlap two sweeps
    sweepRunning = true;
    try {
      const { expired } = await sweepExpired({});
      if (expired) logger.log(`[handover] ${expired} request(s) expired`);
    } catch (err) {
      logger.error(`[handover] expiry sweep failed: ${err.message}`);
    } finally {
      sweepRunning = false;
    }
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.log(`[handover] expiry sweep every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);
  return true;
}

function stopExpirySweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepRunning = false;
}

/* ==================================================================== */
/* Reads                                                                */
/* ==================================================================== */

/** Requests waiting for this agent to answer, plus their queued backlog. */
async function inboxFor(agentId, client = prisma) {
  const rows = await client.handoverRequest.findMany({
    where: { targetAgentId: agentId, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
    orderBy: { id: 'asc' },
  });
  const now = Date.now();
  const out = [];
  let position = 0;
  for (const r of rows) {
    if (r.status === 'QUEUED') position += 1;
    out.push({ ...serialize(r, now), queuePosition: r.status === 'QUEUED' ? position : null });
  }
  return {
    pending: out.filter((r) => r.status === 'PENDING'),
    queued: out.filter((r) => r.status === 'QUEUED'),
    limit: await settingsService.get('handoverPendingLimit', client),
  };
}

/** Requests this agent has raised and is still waiting on. */
async function outboxFor(agentId, client = prisma) {
  const rows = await client.handoverRequest.findMany({
    where: { requestedById: agentId, status: { in: ACTIVE_STATES } },
    include: REQUEST_INCLUDE,
    orderBy: { id: 'desc' },
  });
  return rows.map((r) => serialize(r));
}

/**
 * The complete handover chain for one ticket, oldest first. Nothing is ever
 * removed, so an accepted handover stays visible permanently.
 */
async function historyForTicket(ticketId, client = prisma) {
  const rows = await client.handoverRequest.findMany({
    where: { ticketId },
    include: REQUEST_INCLUDE,
    orderBy: { id: 'asc' },
  });
  const now = Date.now();
  return rows.map((r) => serialize(r, now));
}

async function findById(id, client = prisma) {
  if (!Number.isInteger(id)) return null;
  return client.handoverRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
}

module.exports = {
  ACTIVE_STATES,
  TERMINAL_STATES,
  STATUSES,
  checkRequest,
  createRequest,
  accept,
  decline,
  cancel,
  override,
  cancelForTicket,
  onAvailabilityChanged,
  onAgentDeactivated,
  sweepExpired,
  startExpirySweeper,
  stopExpirySweeper,
  promoteQueue,
  queuePosition,
  activeCountFor,
  inboxFor,
  outboxFor,
  historyForTicket,
  findById,
  timeRemainingMs,
  isExpired,
  serialize,
};
