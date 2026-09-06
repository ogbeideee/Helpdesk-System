// SLA background sweeper.
//
// The service layer (slaService.js) records SLA events as ticket traffic
// happens — responses, resolutions, reopens, priority changes — but nothing in
// that traffic says "this clock is now 75% consumed" or "this clock just ran
// out" on a ticket nobody is touching. Detecting those moments is this
// sweeper's job. It periodically inspects open tickets with active SLA cycles
// and records, at most once per clock per cycle:
//   approaching_breach  — 25% of the target's working time still remains
//                         (the frozen responseApproachAt / resolutionApproachAt)
//   breach              — the target instant has passed with the response clock
//                         unanswered / the ticket unresolved
//
// Approved policy this implements (see the slaService.js header):
//   - Targets are FROZEN on the cycle row when the cycle starts, already
//     computed on the Africa/Lagos working calendar with SlaHoliday dates. The
//     sweeper compares instants only: it never recomputes targets and never
//     loads the holiday table, so evenings, weekends and holidays are honored
//     by construction (nothing becomes "due" during them).
//   - Agent unavailability, handovers and queue position never pause a clock;
//     the sweeper consults none of them.
//   - The sweeper writes TicketSlaCycle latch flags (responseApproached /
//     responseBreached / resolutionApproached / resolutionBreached) and
//     TicketSlaEvent rows ONLY. It never changes ticket state and never
//     touches the Ticket mirrors (dueAt / responseDueAt / responseBreached) —
//     those stay governed by the service paths, and serializeSla computes
//     approach/breach live from timestamps anyway.
//   - Notifications ride the exactly-once event claim (see below): the sweep
//     that records an approaching_breach/breach event immediately alerts the
//     assigned agent and the group lead through the existing notification
//     feed + mailer (src/slaNotifier.js). Repeated sweeps therefore cannot
//     re-notify for the same SLA moment.
//
// Exactly-once recording, without schema changes. The gate for "this event
// still needs recording" is the ABSENCE of the event row (a NOT EXISTS on
// TicketSlaEvent via a relation filter), not a latch boolean: booleans can be
// pre-latched by other paths (e.g. a priority change that lands past the
// recomputed target sets resolutionBreached immediately, before any sweep ran)
// and would then suppress the event forever. The write itself is claimed with
// an optimistic lock — updateMany(..., where { id, updatedAt }) — so only the
// sweep that owns that exact row version may insert the event. Two overlapping
// sweeps (or a sweep racing recordFirstResponse / finalizeOpenCycle, both of
// which rewrite the cycle row and check hasBreachEvent before writing) can
// therefore never both write: the loser's claim matches zero rows. A crash
// between claim and insert self-heals: the event is still absent, so the next
// sweep re-claims the row at its new version.
//
// Scan shape (bounded, index-led). Four findMany queries on TicketSlaCycle —
// endedAt IS NULL (active cycle) with the ticket restricted to an open state —
// each led by the responseDueAt / resolutionDueAt indexes plus the cycleId
// index behind the event filter, and each limited to SWEEP_BATCH rows. A
// sweep's cost is proportional to what actually needs recording, never to the
// ticket table, and cycles whose targets are null (possible for future
// backfill rows) fall out of the range predicates and are skipped by
// construction. A clock that jumps straight from "before approach" to "past
// due" between two sweeps records only its breach event — correct, because
// like serializeSla it is no longer "approaching", it is breached.

const prisma = require('./lib/prisma');
const { OPEN_STATES } = require('./states');
const slaNotifier = require('./slaNotifier');

// Like HANDOVER_SWEEP_INTERVAL_MS / REBALANCE_INTERVAL_MS: 0 disables the
// timer entirely (kill switch).
const SWEEP_INTERVAL_MS = Number(process.env.SLA_SWEEP_INTERVAL_MS || 60 * 1000);
// Per-scan row cap: a single sweep processes at most SWEEP_BATCH cycles per
// clock/condition (4 scans), so even a large backlog advances in bounded
// slices and one slow sweep cannot balloon.
const SWEEP_BATCH = 500;

const CYCLE_SELECT = {
  id: true,
  ticketId: true,
  cycleNumber: true,
  responseDueAt: true,
  responseApproachAt: true,
  resolutionDueAt: true,
  resolutionApproachAt: true,
  firstResponseAt: true,
  updatedAt: true,
  ticket: {
    select: {
      id: true,
      ticketNumber: true,
      state: true,
      shortDescription: true,
      priority: true,
      assignedAgentId: true,
      teamId: true,
    },
  },
};

// Active cycles of open tickets — the only cycles any sweep ever touches.
function openCycleWhere(extra = {}) {
  return {
    endedAt: null,
    ticket: { state: { in: OPEN_STATES } },
    ...extra,
  };
}

// The four candidate scans, in processing order. `gate` is the once-only
// event whose absence makes the row a candidate.
function scanDefinitions(now) {
  return [
    {
      key: 'breachedResponse',
      kind: 'breach',
      clock: 'response',
      latch: 'responseBreached',
      where: openCycleWhere({
        responseDueAt: { lt: now },
        firstResponseAt: null,
        ticketSlaEvents: { none: { type: 'breach', clock: 'response' } },
      }),
      orderBy: { responseDueAt: 'asc' },
      event: (c) => ({
        type: 'breach',
        clock: 'response',
        at: c.responseDueAt,
        detail: `Response SLA breached in cycle ${c.cycleNumber} — target passed without a response`,
        metadata: { responseDueAt: c.responseDueAt, ticketNumber: c.ticket.ticketNumber },
      }),
    },
    {
      key: 'approachingResponse',
      kind: 'approaching',
      clock: 'response',
      latch: 'responseApproached',
      where: openCycleWhere({
        responseApproachAt: { lte: now },
        responseDueAt: { gt: now },
        firstResponseAt: null,
        ticketSlaEvents: { none: { type: 'approaching_breach', clock: 'response' } },
      }),
      orderBy: { responseApproachAt: 'asc' },
      event: (c) => ({
        type: 'approaching_breach',
        clock: 'response',
        at: c.responseApproachAt,
        detail: `Response SLA approaching breach in cycle ${c.cycleNumber} — 25% of the response window remains`,
        metadata: {
          responseDueAt: c.responseDueAt,
          responseApproachAt: c.responseApproachAt,
          ticketNumber: c.ticket.ticketNumber,
        },
      }),
    },
    {
      key: 'breachedResolution',
      kind: 'breach',
      clock: 'resolution',
      latch: 'resolutionBreached',
      where: openCycleWhere({
        resolutionDueAt: { lt: now },
        ticketSlaEvents: { none: { type: 'breach', clock: 'resolution' } },
      }),
      orderBy: { resolutionDueAt: 'asc' },
      event: (c) => ({
        type: 'breach',
        clock: 'resolution',
        at: c.resolutionDueAt,
        detail: `Resolution SLA breached in cycle ${c.cycleNumber}`,
        metadata: { resolutionDueAt: c.resolutionDueAt, ticketNumber: c.ticket.ticketNumber },
      }),
    },
    {
      key: 'approachingResolution',
      kind: 'approaching',
      clock: 'resolution',
      latch: 'resolutionApproached',
      where: openCycleWhere({
        resolutionApproachAt: { lte: now },
        resolutionDueAt: { gt: now },
        ticketSlaEvents: { none: { type: 'approaching_breach', clock: 'resolution' } },
      }),
      orderBy: { resolutionApproachAt: 'asc' },
      event: (c) => ({
        type: 'approaching_breach',
        clock: 'resolution',
        at: c.resolutionApproachAt,
        detail: `Resolution SLA approaching breach in cycle ${c.cycleNumber} — 25% of the resolution window remains`,
        metadata: {
          resolutionDueAt: c.resolutionDueAt,
          resolutionApproachAt: c.resolutionApproachAt,
          ticketNumber: c.ticket.ticketNumber,
        },
      }),
    },
  ];
}

/**
 * One bounded sweep. `now` defaults to the real clock; tests pass fixed
 * instants. `mailer` is forwarded to the notifier so tests can capture what
 * would have been sent. Returns a summary of what was scanned, recorded,
 * notified and lost to a concurrent writer.
 */
async function sweepSla({ client = prisma, now = new Date(), logger = console, mailer } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const summary = {
    at,
    scanned: 0,
    approachingResponse: 0,
    breachedResponse: 0,
    approachingResolution: 0,
    breachedResolution: 0,
    notified: 0,
    lostClaims: 0,
  };

  for (const scan of scanDefinitions(at)) {
    const candidates = await client.ticketSlaCycle.findMany({
      where: scan.where,
      select: CYCLE_SELECT,
      orderBy: scan.orderBy,
      take: SWEEP_BATCH,
    });
    summary.scanned += candidates.length;

    for (const cycle of candidates) {
      // Optimistic claim on the exact row version that was scanned. Any
      // concurrent write to the cycle (another sweep, a response, a
      // finalize, a priority change) invalidates the claim, and the loser
      // records nothing — the winner or a later sweep owns the event.
      const claim = await client.ticketSlaCycle.updateMany({
        where: { id: cycle.id, updatedAt: cycle.updatedAt },
        data: { [scan.latch]: true },
      });
      if (claim.count !== 1) {
        summary.lostClaims += 1;
        continue;
      }
      const event = scan.event(cycle);
      await client.ticketSlaEvent.create({
        data: {
          ticketId: cycle.ticketId,
          cycleId: cycle.id,
          type: event.type,
          clock: event.clock,
          at: event.at,
          actor: 'system',
          detail: event.detail,
          metadata: JSON.stringify({ ...event.metadata, detectedAt: at }),
        },
      });
      summary[scan.key] += 1;

      // Notifications ride the exactly-once event claim: they are sent only
      // by the sweep that recorded the event, so repeated sweeps (and
      // competing sweeps) can never re-notify for the same SLA moment. The
      // notifier never throws; the guard keeps a notification bug from
      // aborting the rest of the batch.
      try {
        summary.notified += await slaNotifier.notifySlaEvent({
          client,
          ticket: cycle.ticket,
          kind: scan.kind,
          clock: scan.clock,
          dueAt: scan.clock === 'response' ? cycle.responseDueAt : cycle.resolutionDueAt,
          now: at,
          mailer,
        });
      } catch (err) {
        logger.error(`[sla] notification failed for ${cycle.ticket.ticketNumber}: ${err.message}`);
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Timer — same shape as the handover expiry sweeper.
// ---------------------------------------------------------------------------

let sweepTimer = null;
let sweepRunning = false;

function startSlaSweeper({ logger = console } = {}) {
  if (SWEEP_INTERVAL_MS <= 0) {
    logger.log('[sla] sweeping disabled (SLA_SWEEP_INTERVAL_MS=0)');
    return false;
  }
  sweepTimer = setInterval(async () => {
    if (sweepRunning) return; // never overlap two sweeps
    sweepRunning = true;
    try {
      const s = await sweepSla({});
      const recorded =
        s.approachingResponse + s.breachedResponse + s.approachingResolution + s.breachedResolution;
      if (recorded) {
        logger.log(
          `[sla] ${recorded} SLA event(s) recorded, ${s.notified} notification(s) sent ` +
            `(approaching: ${s.approachingResponse} response / ${s.approachingResolution} resolution; ` +
            `breach: ${s.breachedResponse} response / ${s.breachedResolution} resolution)`
        );
      }
    } catch (err) {
      logger.error(`[sla] sweep failed: ${err.message}`);
    } finally {
      sweepRunning = false;
    }
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.log(`[sla] sweep every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);
  return true;
}

function stopSlaSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepRunning = false;
}

module.exports = {
  SWEEP_INTERVAL_MS,
  SWEEP_BATCH,
  sweepSla,
  startSlaSweeper,
  stopSlaSweeper,
};
