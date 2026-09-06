// Workload, unattended-ticket claiming, and automatic rebalancing.
//
// Everything here is built on one definition of workload, shared with the
// dashboard and the assignment engine:
//
//   ACTIVE WORKLOAD = tickets the agent owns in NEW or IN_PROGRESS.
//
// RESOLVED and CLOSED never count: the work is finished. A ticket that is
// mid-handover does not count for the new owner until the move commits, which
// falls out of the compare-and-set below.
//
// Concurrency
// -----------
// Every ownership change goes through `moveTicket`, which uses a conditional
// update (`updateMany` with the expected current owner in the WHERE clause).
// If another worker moved the ticket first, zero rows match and we report the
// conflict instead of overwriting their decision. That makes the background
// rebalancer safe to run alongside live API traffic, and makes replaying the
// same move a no-op rather than a double-assignment.
const prisma = require('./../lib/prisma');
const { OPEN_STATES } = require('../states');
const assignmentEngine = require('./assignmentEngine');
const notificationService = require('../mailer');
const { ticketSubject } = require('../email/outbound');
const auditService = require('./auditService');

/** NEW + IN_PROGRESS. The single definition of "active work". */
const WORKLOAD_STATES = OPEN_STATES;

/** A NEW ticket becomes claimable by a teammate after this long. */
const CLAIM_THRESHOLD_MS = Number(process.env.UNATTENDED_CLAIM_HOURS || 4) * 60 * 60 * 1000;

/** Workload gap that counts as a significant imbalance. */
const IMBALANCE_THRESHOLD = Number(process.env.REBALANCE_THRESHOLD || 3);

/** Safety rail: never make more than this many moves in one cycle. */
const MAX_MOVES_PER_CYCLE = Number(process.env.REBALANCE_MAX_MOVES || 5);

const REBALANCE_INTERVAL_MS = Number(process.env.REBALANCE_INTERVAL_MS || 5 * 60 * 1000);

function actorLabel(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return `${actor.name} <${actor.email}>`;
}

/* ==================================================================== */
/* Workload                                                             */
/* ==================================================================== */

async function workloadFor(agentId, client = prisma) {
  return client.ticket.count({
    where: { assignedAgentId: agentId, state: { in: WORKLOAD_STATES } },
  });
}

/** Map(agentId -> open ticket count) for the given agents. */
async function workloadByAgent(agentIds, client = prisma) {
  if (!agentIds.length) return new Map();
  const rows = await client.ticket.groupBy({
    by: ['assignedAgentId'],
    _count: { _all: true },
    where: { assignedAgentId: { in: agentIds }, state: { in: WORKLOAD_STATES } },
  });
  const map = new Map(agentIds.map((id) => [id, 0]));
  for (const r of rows) map.set(r.assignedAgentId, r._count._all);
  return map;
}

/** Workload snapshot for every agent who can hold tickets. */
async function workloadSnapshot(client = prisma) {
  const { STAFF_ROLES } = require('./userService');
  const agents = await client.agent.findMany({
    where: { isActive: true, role: { in: STAFF_ROLES } },
    include: { team: true },
    orderBy: { name: 'asc' },
  });
  const counts = await workloadByAgent(agents.map((a) => a.id), client);

  const rows = agents.map((a) => ({
    agentId: a.id,
    name: a.name,
    email: a.email,
    skillLevel: a.skillLevel,
    available: a.isAvailable,
    active: a.isActive,
    teamId: a.teamId,
    assignmentGroup: a.team ? a.team.name : null,
    openTickets: counts.get(a.id) || 0,
  }));

  const available = rows.filter((r) => r.available);
  const loads = available.map((r) => r.openTickets);
  const max = loads.length ? Math.max(...loads) : 0;
  const min = loads.length ? Math.min(...loads) : 0;

  return {
    agents: rows,
    unassignedOpen: await client.ticket.count({
      where: { assignedAgentId: null, state: { in: WORKLOAD_STATES } },
    }),
    imbalance: { max, min, spread: max - min, threshold: IMBALANCE_THRESHOLD, significant: max - min >= IMBALANCE_THRESHOLD },
  };
}

/* ==================================================================== */
/* Unattended tickets                                                   */
/* ==================================================================== */

function ageMs(ticket, now = Date.now()) {
  return now - new Date(ticket.createdAt).getTime();
}

/**
 * Has this ticket been sitting long enough that a teammate may take it?
 * The clock starts at creation and runs whether or not it is assigned.
 */
function isUnattended(ticket, now = Date.now()) {
  return ticket.state === 'NEW' && ageMs(ticket, now) >= CLAIM_THRESHOLD_MS;
}

function hoursUntilClaimable(ticket, now = Date.now()) {
  if (ticket.state !== 'NEW') return null;
  const remaining = CLAIM_THRESHOLD_MS - ageMs(ticket, now);
  return remaining <= 0 ? 0 : remaining / 3600000;
}

/**
 * May `actor` take this ticket?
 *
 * An admin may always assign. An agent may take an unassigned ticket in their
 * own group at any time, or one assigned to somebody else only once it has
 * been unattended for the threshold.
 */
function checkClaim(ticket, actor, now = Date.now()) {
  const { isAdmin } = require('./assignmentPolicy');
  if (!actor) return { ok: false, status: 401, error: 'Authentication required' };

  if (['RESOLVED', 'CLOSED'].includes(ticket.state)) {
    return { ok: false, status: 400, error: `Cannot take a ${ticket.state.toLowerCase()} ticket` };
  }
  if (ticket.assignedAgentId === actor.id) {
    return { ok: false, status: 400, error: 'This ticket is already yours' };
  }

  // Administrators are not subject to the waiting period.
  if (isAdmin(actor)) return { ok: true, reason: 'administrator override' };

  if (!actor.isActive || !actor.isAvailable) {
    return { ok: false, status: 403, error: 'You must be active and available to take tickets' };
  }
  if (ticket.teamId && actor.teamId !== ticket.teamId) {
    return { ok: false, status: 403, error: 'You can only take tickets in your own assignment group' };
  }

  if (ticket.assignedAgentId) {
    if (ticket.state !== 'NEW') {
      return {
        ok: false,
        status: 403,
        error: 'Only a NEW ticket can be taken from another agent',
      };
    }
    if (!isUnattended(ticket, now)) {
      const hours = hoursUntilClaimable(ticket, now);
      return {
        ok: false,
        status: 403,
        error:
          `This ticket is still with its assignee. It becomes available to the team ` +
          `in ${hours < 1 ? `${Math.ceil(hours * 60)} minute(s)` : `${hours.toFixed(1)} hour(s)`}.`,
      };
    }
    return { ok: true, reason: 'unattended for the claim threshold' };
  }

  return { ok: true, reason: 'unassigned' };
}

/* ==================================================================== */
/* Notifications                                                        */
/* ==================================================================== */

/**
 * Tell an agent their ticket moved: in-app row plus the existing email path.
 * Never throws — losing a notification must not roll back the move.
 */
async function notifyOwnershipChange(
  { agent, ticket, type, title, body, emailSubject, emailBody },
  client = prisma
) {
  if (!agent) return;
  try {
    await client.notification.create({
      data: { agentId: agent.id, ticketId: ticket.id, type, title, body: body || null },
    });
  } catch (err) {
    console.error(`[workload] in-app notification failed for ${agent.email}: ${err.message}`);
  }
  try {
    await notificationService.sendMailSafe({
      subject: emailSubject || title,
      body: emailBody || body || title,
      toRecipients: [{ emailAddress: { address: agent.email } }],
    });
  } catch (err) {
    console.error(`[workload] email notification failed for ${agent.email}: ${err.message}`);
  }
}

/* ==================================================================== */
/* Ownership changes                                                    */
/* ==================================================================== */

/**
 * Move one ticket to a new owner, safely against concurrent workers.
 *
 * The update is conditional on the ticket still having the owner we read, so
 * two workers racing on the same ticket cannot both succeed.
 *
 * @returns {{moved:boolean, reason?:string, ticket?:object}}
 */
async function moveTicket(
  { ticket, toAgentId, actor, note, notifyPrevious = true, notificationType = 'ticket_reassigned' },
  client = prisma
) {
  const expectedOwner = ticket.assignedAgentId ?? null;

  const result = await client.ticket.updateMany({
    where: {
      id: ticket.id,
      // Compare-and-set: bail out if somebody moved it since we read it.
      assignedAgentId: expectedOwner,
      state: { in: WORKLOAD_STATES },
    },
    data: { assignedAgentId: toAgentId },
  });

  if (result.count === 0) {
    return { moved: false, reason: 'ticket was changed by another process' };
  }

  const [previous, next, fresh] = await Promise.all([
    expectedOwner ? client.agent.findUnique({ where: { id: expectedOwner } }) : null,
    toAgentId ? client.agent.findUnique({ where: { id: toAgentId } }) : null,
    client.ticket.findUnique({ where: { id: ticket.id }, include: { team: true, assignedAgent: true } }),
  ]);

  await client.ticketAuditLog.create({
    data: {
      ticketId: ticket.id,
      fromState: fresh.state,
      toState: fresh.state,
      actor: actorLabel(actor),
      note:
        `Reassigned from ${previous ? previous.name : 'nobody'} to ${next ? next.name : 'nobody'}` +
        (note ? ` — ${note}` : ''),
    },
  });

  // Unified trail: every ownership change funnels through here (claims,
  // handover accepts, availability reassignment), so one action covers them.
  await auditService.record(client, {
    action: 'ticket.assigned',
    entityType: 'Ticket',
    entityId: fresh.id,
    entityLabel: fresh.ticketNumber,
    ticketId: fresh.id,
    actor,
    from: {
      assignedAgentId: expectedOwner,
      assignedAgent: previous ? previous.name : null,
    },
    to: { assignedAgentId: toAgentId, assignedAgent: next ? next.name : null },
    description:
      `${fresh.ticketNumber} moved from ${previous ? previous.name : 'nobody'} ` +
      `to ${next ? next.name : 'nobody'}`,
    metadata: note ? { note } : null,
  });

  if (toAgentId) {
    await client.agent.update({ where: { id: toAgentId }, data: { lastAssignedAt: new Date() } });
  }

  // The agent who lost the ticket is told why.
  if (notifyPrevious && previous && previous.id !== toAgentId) {
    await notifyOwnershipChange(
      {
        agent: previous,
        ticket: fresh,
        type: notificationType,
        title: `${fresh.ticketNumber} was reassigned`,
        body:
          `${fresh.ticketNumber} (${fresh.shortDescription}) is now with ` +
          `${next ? next.name : 'nobody'}.` + (note ? ` Reason: ${note}` : ''),
        emailSubject: ticketSubject(fresh, `Reassigned: ${fresh.shortDescription}`),
        emailBody: [
          `Hi ${previous.name},`,
          '',
          `${fresh.ticketNumber} is no longer assigned to you.`,
          '',
          `Now with: ${next ? next.name : 'nobody (awaiting assignment)'}`,
          `Group:    ${fresh.team ? fresh.team.name : 'n/a'}`,
          note ? `Reason:   ${note}` : '',
          '',
          `Subject: ${fresh.shortDescription}`,
        ].filter(Boolean).join('\r\n'),
      },
      client
    );
  }

  return { moved: true, ticket: fresh, previous, next };
}

/**
 * Requirement 7: a ticket whose current group is not where it started is
 * returned to its originating group before we look for a new owner, so the
 * right team picks it up. originatingTeamId itself is never modified.
 */
async function returnToOriginatingGroup(ticket, actor, client = prisma) {
  if (!ticket.originatingTeamId || ticket.originatingTeamId === ticket.teamId) return ticket;

  const origin = await client.team.findUnique({ where: { id: ticket.originatingTeamId } });
  if (!origin || !origin.isActive) return ticket;

  const updated = await client.ticket.update({
    where: { id: ticket.id },
    data: { teamId: origin.id },
    include: { team: true, assignedAgent: true },
  });
  await client.ticketAuditLog.create({
    data: {
      ticketId: ticket.id,
      fromState: updated.state,
      toState: updated.state,
      actor: actorLabel(actor),
      note: `Returned to its originating assignment group (${origin.name}) before reassignment`,
    },
  });
  await auditService.record(client, {
    action: 'ticket.group_changed',
    entityType: 'Ticket',
    entityId: ticket.id,
    entityLabel: ticket.ticketNumber,
    ticketId: ticket.id,
    actor,
    from: { groupId: ticket.teamId },
    to: { groupId: origin.id, group: origin.name },
    description: `${ticket.ticketNumber} returned to its originating assignment group (${origin.name})`,
  });
  return updated;
}

/**
 * Find a new owner for one ticket using the normal assignment rules, excluding
 * the agent we are moving it away from.
 */
async function findReplacement(ticket, excludeAgentId, client = prisma) {
  const decision = await assignmentEngine.assign(
    {
      category: ticket.category,
      priority: ticket.priority,
      text: `${ticket.shortDescription}\n${ticket.body || ''}`,
      forceTeamId: ticket.teamId || undefined,
      excludeAgentIds: excludeAgentId ? [excludeAgentId] : [],
    },
    client,
    { log: () => {}, warn: () => {} }
  );
  return decision.agent || null;
}

/**
 * Hand every open ticket of one agent to somebody else.
 *
 * Used when an agent goes unavailable, is deactivated, or is forced off by an
 * administrator. Tickets with no suitable replacement are left unassigned with
 * their assignment group intact, never dropped.
 *
 * @param {object} opts.states  which states to move (defaults to NEW + IN_PROGRESS)
 */
async function reassignOpenTicketsFor(
  agentId,
  { actor, reason, states = WORKLOAD_STATES, client = prisma, notificationType = 'ticket_reassigned' } = {}
) {
  const tickets = await client.ticket.findMany({
    where: { assignedAgentId: agentId, state: { in: states } },
    include: { team: true },
    orderBy: { id: 'asc' },
  });

  const summary = { considered: tickets.length, moved: 0, unassigned: 0, conflicts: 0, details: [] };

  for (const t of tickets) {
    const returned = await returnToOriginatingGroup(t, actor, client);
    const replacement = await findReplacement(returned, agentId, client);

    const outcome = await moveTicket(
      {
        ticket: returned,
        toAgentId: replacement ? replacement.id : null,
        actor,
        note: reason,
        notificationType,
        // The agent losing the tickets already knows why (they triggered it or
        // an admin told them), so only notify when somebody else caused it.
        notifyPrevious: notificationType !== 'self',
      },
      client
    );

    if (!outcome.moved) {
      summary.conflicts += 1;
      continue;
    }
    if (replacement) summary.moved += 1;
    else summary.unassigned += 1;
    summary.details.push({
      ticketId: t.id,
      ticketNumber: t.ticketNumber,
      state: t.state,
      to: replacement ? replacement.name : null,
    });
  }

  return summary;
}

/* ==================================================================== */
/* Availability                                                         */
/* ==================================================================== */

/**
 * What happens if this agent goes unavailable right now?
 *
 * IN_PROGRESS work blocks the change for the agent themselves — half-finished
 * work should not be silently handed on. NEW tickets are listed so the agent
 * can confirm the handover. An administrator can force it regardless.
 */
async function previewUnavailability(agentId, client = prisma) {
  const [inProgress, newTickets] = await Promise.all([
    client.ticket.findMany({
      where: { assignedAgentId: agentId, state: 'IN_PROGRESS' },
      select: { id: true, ticketNumber: true, shortDescription: true, priority: true },
      orderBy: { id: 'asc' },
    }),
    client.ticket.findMany({
      where: { assignedAgentId: agentId, state: 'NEW' },
      select: { id: true, ticketNumber: true, shortDescription: true, priority: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  return {
    blocked: inProgress.length > 0,
    inProgress,
    newTickets,
    requiresConfirmation: inProgress.length === 0 && newTickets.length > 0,
    message: inProgress.length
      ? `You have ${inProgress.length} ticket(s) in progress. Resolve or hand them over first.`
      : newTickets.length
        ? `${newTickets.length} NEW ticket(s) will be reassigned to your team.`
        : 'No open tickets to hand over.',
  };
}

/* ==================================================================== */
/* Rebalancing                                                          */
/* ==================================================================== */

/**
 * Perform at most one move to reduce the largest workload gap.
 *
 * Deliberately one ticket at a time: after each move the workloads are
 * recalculated, so a single busy agent is drained gradually rather than
 * dumping their queue on the first idle colleague.
 *
 * Preference order for what to move:
 *   1. a NEW ticket from the busiest agent, in the receiving agent's group
 *   2. a NEW ticket from any group
 *   3. an IN_PROGRESS ticket, only when the gap is still at or above the
 *      threshold and no NEW ticket was available
 *
 * @returns {{moved:boolean, reason:string, ...}}
 */
async function rebalanceOnce({ actor = 'system (workload balancer)', client = prisma, dryRun = false } = {}) {
  const { STAFF_ROLES } = require('./userService');

  // Only agents who belong to an assignment group are part of the rota. A
  // team-less account (typically an administrator) would otherwise always look
  // like the quietest agent and attract every rebalanced ticket.
  const agents = await client.agent.findMany({
    where: {
      isActive: true,
      isAvailable: true,
      role: { in: STAFF_ROLES },
      teamId: { not: null },
    },
    include: { team: true },
  });
  if (agents.length < 2) return { moved: false, reason: 'fewer than two available agents in a group' };

  const counts = await workloadByAgent(agents.map((a) => a.id), client);
  const ranked = agents
    .map((a) => ({ agent: a, load: counts.get(a.id) || 0 }))
    .sort((x, y) => y.load - x.load || x.agent.id - y.agent.id);

  const busiest = ranked[0];

  // Receiver: the lightest load, and among equally light agents the one in the
  // busiest agent's own group, so a same-group move is possible before we
  // consider crossing teams. Round-robin then id keeps it deterministic.
  const quietest = ranked
    .slice()
    .sort((x, y) => {
      if (x.load !== y.load) return x.load - y.load;
      const xSame = x.agent.teamId === busiest.agent.teamId ? 0 : 1;
      const ySame = y.agent.teamId === busiest.agent.teamId ? 0 : 1;
      if (xSame !== ySame) return xSame - ySame;
      const xt = x.agent.lastAssignedAt ? new Date(x.agent.lastAssignedAt).getTime() : 0;
      const yt = y.agent.lastAssignedAt ? new Date(y.agent.lastAssignedAt).getTime() : 0;
      if (xt !== yt) return xt - yt;
      return x.agent.id - y.agent.id;
    })[0];

  if (quietest.agent.id === busiest.agent.id) {
    return { moved: false, reason: 'only one agent carries any load' };
  }

  const spread = busiest.load - quietest.load;

  if (spread < IMBALANCE_THRESHOLD) {
    return { moved: false, reason: `spread ${spread} is below the threshold ${IMBALANCE_THRESHOLD}`, spread };
  }

  const candidateTickets = await client.ticket.findMany({
    where: { assignedAgentId: busiest.agent.id, state: { in: WORKLOAD_STATES } },
    include: { team: true },
    orderBy: [{ createdAt: 'asc' }],
  });

  // The receiving agent must actually be qualified for the ticket, which means
  // asking the routing rules what skill it requires. Evaluated lazily, in
  // preference order, so we stop at the first ticket they can take.
  const qualified = async (t) => {
    const decision = await assignmentEngine.decide(
      { category: t.category, priority: t.priority, text: `${t.shortDescription}\n${t.body || ''}` },
      client
    );
    return quietest.agent.skillLevel >= decision.minSkillLevel;
  };

  // Preference: NEW in the receiver's own group, then NEW anywhere, then
  // IN_PROGRESS as a last resort.
  const buckets = [
    candidateTickets.filter((t) => t.state === 'NEW' && t.teamId === quietest.agent.teamId),
    candidateTickets.filter((t) => t.state === 'NEW' && t.teamId !== quietest.agent.teamId),
    candidateTickets.filter((t) => t.state === 'IN_PROGRESS'),
  ];

  let pick = null;
  let pickedBucket = -1;
  for (let b = 0; b < buckets.length && !pick; b++) {
    for (const t of buckets[b]) {
      if (await qualified(t)) {
        pick = t;
        pickedBucket = b;
        break;
      }
    }
  }

  if (!pick) {
    return { moved: false, reason: 'no movable ticket the receiving agent is qualified for', spread };
  }
  if (pickedBucket === 2 && spread < IMBALANCE_THRESHOLD) {
    // Belt and braces: IN_PROGRESS work only moves on a real imbalance.
    return { moved: false, reason: 'only IN_PROGRESS tickets available and the gap is too small', spread };
  }

  const note =
    `workload balancing: ${busiest.agent.name} had ${busiest.load} open, ` +
    `${quietest.agent.name} had ${quietest.load}`;

  // dryRun reports the move the balancer would make without touching anything.
  if (dryRun) {
    return {
      moved: false,
      dryRun: true,
      spread,
      ticketId: pick.id,
      ticketNumber: pick.ticketNumber,
      ticketState: pick.state,
      from: busiest.agent.name,
      to: quietest.agent.name,
      reason: note,
    };
  }

  const outcome = await moveTicket(
    {
      ticket: pick,
      toAgentId: quietest.agent.id,
      actor,
      note,
      // An IN_PROGRESS move is disruptive, so the original agent is always told.
      notifyPrevious: true,
      notificationType: 'ticket_rebalanced',
    },
    client
  );

  if (!outcome.moved) {
    return { moved: false, reason: outcome.reason, spread };
  }

  return {
    moved: true,
    spread,
    ticketId: pick.id,
    ticketNumber: pick.ticketNumber,
    ticketState: pick.state,
    from: busiest.agent.name,
    to: quietest.agent.name,
    reason: note,
  };
}

/**
 * Run rebalance moves until the spread is acceptable, bounded by
 * MAX_MOVES_PER_CYCLE so a pathological state can never spin forever.
 */
async function rebalanceCycle({ actor, client = prisma, maxMoves = MAX_MOVES_PER_CYCLE } = {}) {
  const moves = [];
  for (let i = 0; i < maxMoves; i++) {
    const result = await rebalanceOnce({ actor, client });
    if (!result.moved) {
      return { moves, stopped: result.reason };
    }
    moves.push(result);
  }
  return { moves, stopped: `reached the per-cycle limit of ${maxMoves} moves` };
}

let rebalanceTimer = null;
let cycleRunning = false;

function startRebalancer({ logger = console } = {}) {
  if (REBALANCE_INTERVAL_MS <= 0) {
    logger.log('[workload] automatic rebalancing disabled (REBALANCE_INTERVAL_MS=0)');
    return false;
  }
  rebalanceTimer = setInterval(async () => {
    // Never let two cycles overlap: the guard plus the compare-and-set in
    // moveTicket keeps concurrent work safe.
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      const { moves, stopped } = await rebalanceCycle({});
      if (moves.length) {
        logger.log(`[workload] rebalanced ${moves.length} ticket(s): ${stopped}`);
        for (const m of moves) {
          logger.log(`[workload]   ${m.ticketNumber} (${m.ticketState}) ${m.from} -> ${m.to}`);
        }
      }
    } catch (err) {
      logger.error(`[workload] rebalance cycle failed: ${err.message}`);
    } finally {
      cycleRunning = false;
    }
  }, REBALANCE_INTERVAL_MS);
  if (rebalanceTimer.unref) rebalanceTimer.unref();
  logger.log(
    `[workload] automatic rebalancing every ${Math.round(REBALANCE_INTERVAL_MS / 60000)} min ` +
      `(threshold ${IMBALANCE_THRESHOLD}, max ${MAX_MOVES_PER_CYCLE} moves/cycle)`
  );
  return true;
}

function stopRebalancer() {
  if (rebalanceTimer) clearInterval(rebalanceTimer);
  rebalanceTimer = null;
  cycleRunning = false;
}

module.exports = {
  WORKLOAD_STATES,
  CLAIM_THRESHOLD_MS,
  IMBALANCE_THRESHOLD,
  MAX_MOVES_PER_CYCLE,
  workloadFor,
  workloadByAgent,
  workloadSnapshot,
  isUnattended,
  hoursUntilClaimable,
  checkClaim,
  moveTicket,
  returnToOriginatingGroup,
  findReplacement,
  reassignOpenTicketsFor,
  previewUnavailability,
  rebalanceOnce,
  rebalanceCycle,
  startRebalancer,
  stopRebalancer,
  notifyOwnershipChange,
};
