// Agent Unavailability Timeline.
//
// Persistent history for availability state changes, built on the existing
// three-state model (online / unavailable / offline — see
// assignmentPoolService.js, which remains the only authority on what the
// states are and how they map to Agent columns).
//
// One row per span of state: a period OPENS when the agent's state really
// changes and stays open (endedAt null) until the next transition closes it.
//
//   - Repeated same-state updates record nothing: recordTransition() refuses
//     a from === to write, so a period is never closed and reopened for a
//     state it already holds.
//   - The first recorded transition for an agent simply opens a period — no
//     earlier period is invented for states that predate the timeline; the
//     period's previousState column preserves where it came from.
//   - The current period stays open until the next transition; closed
//     periods are never written again.
//   - A partial unique index (see the migration) allows at most ONE open
//     period per agent, so concurrent or replayed transitions cannot open a
//     second "current" period. Everything is committed rows: a server
//     restart neither loses nor duplicates history.
//
// Pure history: nothing here writes tickets, assignments, handovers or SLA
// records, and nothing in those subsystems reads this table.
const prisma = require('../lib/prisma');

/** Who can drive a transition: the agent themselves or an administrator. */
const SOURCES = ['self', 'admin'];

/**
 * Close the agent's currently open period (if any) and open the next one.
 * Called only from the availability transition paths — applyAvailabilityState
 * and the user-update path — and only for a real state change.
 *
 * @returns the created period, or null when from === to (no transition).
 */
async function recordTransition({
  agentId,
  from,
  to,
  at = new Date(),
  actorId = null,
  source = 'admin',
  note = null,
  client = prisma,
}) {
  if (from === to) return null;
  if (!SOURCES.includes(source)) {
    throw new Error(`unknown availability history source "${source}"`);
  }

  // Close whatever period is currently open — normally exactly one, whose
  // state is `from`; zero rows on the very first recorded transition. Closing
  // an already-closed history changes nothing, so a replayed transition is
  // idempotent. Close and open run as one transaction: the partial unique
  // index turns a concurrent double-open into a loud failure instead of a
  // duplicated current period.
  const closeOpen = client.agentAvailabilityPeriod.updateMany({
    where: { agentId, endedAt: null },
    data: { endedAt: at },
  });
  const openNext = client.agentAvailabilityPeriod.create({
    data: {
      agentId,
      state: to,
      previousState: from,
      startedAt: at,
      actorId: actorId ?? null,
      source,
      note: note ?? null,
    },
  });
  if (typeof client.$transaction === 'function') {
    // The batch resolves to [closeCount, createdPeriod]. The promises must be
    // consumed by the transaction alone: awaiting a PrismaPromise a second
    // time re-executes it, which would insert the period twice.
    const [, created] = await client.$transaction([closeOpen, openNext]);
    return created;
  }
  await closeOpen;
  return await openNext;
}

/** API shape for one period: ISO timestamps, computed duration, open flag. */
function shapePeriod(period) {
  const endedAt = period.endedAt ? period.endedAt : null;
  return {
    id: period.id,
    agentId: period.agentId,
    ...(period.agent
      ? { agent: { id: period.agent.id, name: period.agent.name, email: period.agent.email } }
      : {}),
    state: period.state,
    previousState: period.previousState ?? null,
    startedAt: period.startedAt.toISOString(),
    endedAt: endedAt ? endedAt.toISOString() : null,
    // Closed periods: exact span. The open period's duration is null here —
    // it is "ongoing", and the client renders it against the current time.
    durationMs: endedAt ? endedAt.getTime() - period.startedAt.getTime() : null,
    isOpen: !endedAt,
    actor: period.actor ? { id: period.actor.id, name: period.actor.name } : null,
    source: period.source,
    note: period.note ?? null,
  };
}

/**
 * One agent's availability history: the agent's current state plus every
 * recorded period, newest first.
 *
 * @returns {{ agent, periods }} or null when the agent does not exist.
 */
async function agentHistory(agentId, { take = 500, client = prisma } = {}) {
  const agent = await client.agent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true, email: true, isActive: true, isAvailable: true },
  });
  if (!agent) return null;

  const rows = await client.agentAvailabilityPeriod.findMany({
    where: { agentId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take,
    include: { actor: { select: { id: true, name: true } } },
  });

  // Lazy require: assignmentPoolService pulls this module at load time.
  const { availabilityStateOf } = require('./assignmentPoolService');
  return {
    agent: { ...agent, availabilityState: availabilityStateOf(agent) },
    periods: rows.map(shapePeriod),
  };
}

/**
 * Admin-wide history with filters. All bounds are inclusive; periods are
 * matched on startedAt. Newest first.
 *
 * @param {object} filters  { agentId?, state?, from?, to?, page?, pageSize? }
 */
async function listHistory(filters = {}, { client = prisma } = {}) {
  const where = {};
  if (Number.isInteger(filters.agentId)) where.agentId = filters.agentId;
  if (filters.state) where.state = filters.state;
  const startedAt = {};
  if (filters.from) startedAt.gte = new Date(filters.from);
  if (filters.to) startedAt.lte = new Date(filters.to);
  if (Object.keys(startedAt).length) where.startedAt = startedAt;

  const page = Math.max(1, Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1);
  const pageSize = Math.min(
    200,
    Math.max(1, Number.isInteger(filters.pageSize) && filters.pageSize > 0 ? filters.pageSize : 50)
  );

  const [total, rows] = await Promise.all([
    client.agentAvailabilityPeriod.count({ where }),
    client.agentAvailabilityPeriod.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        agent: { select: { id: true, name: true, email: true } },
        actor: { select: { id: true, name: true } },
      },
    }),
  ]);

  return { total, page, pageSize, periods: rows.map(shapePeriod) };
}

module.exports = { SOURCES, recordTransition, agentHistory, listHistory };
