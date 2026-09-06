// Historical SLA backfill.
//
// Tickets that existed before the SLA foundation (migration
// 20260905000000_sla_foundation) have no SLA cycles: serializeSla returns
// null for them and their history is invisible to every SLA figure. This
// module reconstructs that history from the evidence the system kept all
// along — and from nothing else:
//
//   TicketAuditLog   state transitions, including the requester-reply reopen
//                    rows (RESOLVED/CLOSED -> IN_PROGRESS). These carve a
//                    ticket's lifetime into cycles exactly like the live
//                    paths do: RESOLVED closes the open cycle, a reopen
//                    starts the next one.
//   Comment          the first public agent comment (isRequester=false,
//                    isInternal=false) inside a cycle's window is that
//                    cycle's first response — the same qualification the
//                    live note path applies.
//   Ticket           createdAt starts cycle 1; resolvedAt / closedAt close
//                    the final cycle when the resolve transition itself was
//                    not audited. Ticket.firstResponseAt is NOT used: the
//                    column was added by the SLA migration itself, so it is
//                    null for exactly the tickets this backfill targets.
//
// What is deliberately NOT reconstructed (nothing is invented):
//   - A first response with no qualifying comment stays unanswered.
//   - A cycle whose end cannot be established (resolved ticket with no
//     audit trail and no resolvedAt/closedAt) stays OPEN with no resolution
//     outcome, and is counted in the summary as an open-ended cycle.
//   - When only the reopen or close instant proves a cycle had ended, the
//     cycle ends at that real historical instant and is counted as an
//     approximated end; the cycle's events say so.
//
// Policy: historical settings cannot be recovered (the Setting table holds
// only current overrides), so targets are computed from the documented
// default policy — slaService.defaultSlaPolicy() — and the SlaHoliday data.
// The applicable priority is the ticket's current priority; historical
// priority changes were never recorded structurally.
//
// Safety properties:
//   - Only tickets with ZERO cycles are touched; a re-run finds nothing.
//   - Ticket rows are never written. startCycle runs with syncTicket:false,
//     so dueAt/responseDueAt/firstResponseAt/responseBreached mirrors and
//     every other column keep their historical values.
//   - Only NEW cycle rows are created; existing TicketSlaCycle rows are
//     never updated or deleted.
//   - Cycles are created with source = 'backfill' and every event with
//     actor = 'backfill'.
//   - Breach / approaching events ARE written for past-due clocks — that is
//     what makes the timeline complete AND keeps the live sweeper away from
//     these cycles (it records only when the matching event is absent), so
//     a backfill never triggers an SLA notification. The notifier is never
//     called.
//   - Each ticket is written in one transaction; tickets are scanned in
//     id-keyed batches, so memory stays bounded on large tables.
//   - The backfill targets the configured PostgreSQL DATABASE_URL only.
//     There is no SQLite database in this system to modify.
const prisma = require('./lib/prisma');
const slaService = require('./slaService');
const { OPEN_STATES } = require('./states');

const CLOSED_STATES = ['RESOLVED', 'CLOSED'];

/**
 * Reconstruct a ticket's cycle windows from its audit trail.
 * Returns [{ cycleNumber, startedAt, endedAt, resolvedAt, approximatedEnd }].
 * The last window's endedAt/resolvedAt are null while the cycle is open.
 */
function reconstructCycles(ticket, auditLogs) {
  const windows = [];
  let current = {
    startedAt: new Date(ticket.createdAt),
    endedAt: null,
    resolvedAt: null,
    approximatedEnd: false,
  };

  const closeCurrent = (at, approximated) => {
    current.endedAt = at;
    if (!approximated) current.resolvedAt = at;
    current.approximatedEnd = approximated;
    windows.push(current);
    current = null;
  };

  const rows = [...(auditLogs || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const row of rows) {
    if (row.toState === 'RESOLVED' && current) {
      // The resolve transition ends the open cycle at its recorded instant.
      closeCurrent(new Date(row.createdAt), false);
    } else if (CLOSED_STATES.includes(row.fromState) && OPEN_STATES.includes(row.toState)) {
      // A reopen starts the next cycle. If the previous cycle was never
      // closed by an audited resolve, the reopen instant is the best
      // supported end: the fromState proves the ticket had been resolved.
      if (current) closeCurrent(new Date(row.createdAt), true);
      current = { startedAt: new Date(row.createdAt), endedAt: null, resolvedAt: null, approximatedEnd: false };
    }
    // Anything else (creation row, reassignment/annotation rows with
    // fromState === toState, closes) does not bound a cycle.
  }

  if (current) {
    if (CLOSED_STATES.includes(ticket.state) && (ticket.resolvedAt || ticket.closedAt)) {
      // Final resolution: the ticket column is the recorded instant; when
      // only closedAt survives, the resolve instant is approximated by it.
      const exact = Boolean(ticket.resolvedAt);
      closeCurrent(new Date(ticket.resolvedAt || ticket.closedAt), !exact);
    } else {
      // Still open, or resolved with no recoverable end — stays open.
      windows.push(current);
    }
  }
  return windows.map((w, i) => ({ cycleNumber: i + 1, ...w }));
}

/** The first public agent comment inside [start, end] — the cycle's first response. */
function firstResponseFor(comments, start, end) {
  for (const c of comments || []) {
    const at = new Date(c.createdAt);
    if (at >= new Date(start) && (!end || at <= new Date(end))) return c;
  }
  return null;
}

/**
 * Build the full write plan for one ticket. Pure apart from one holiday
 * lookup. Returns null when the ticket already has cycles (never touched).
 */
async function planTicket(ticket, { now, policy = slaService.defaultSlaPolicy(), client = prisma } = {}) {
  if (ticket.slaCycles && ticket.slaCycles.length > 0) return null;
  const now2 = new Date(now);

  const windows = reconstructCycles(ticket, ticket.auditLogs);
  const spanStart = windows[0].startedAt;
  const spanEnd = windows[windows.length - 1].endedAt || now2;
  const holidays = await slaService.loadHolidaysBetween(spanStart, spanEnd, client, policy);

  const cycles = [];
  for (const w of windows) {
    const targets = slaService.computeTargets({
      priority: ticket.priority,
      from: w.startedAt,
      holidays,
      policy,
    });
    const response = firstResponseFor(ticket.comments, w.startedAt, w.endedAt);
    const open = w.endedAt == null;

    // Response outcome: the recorded response, else the cycle end, else the
    // running clock — the same effective instants the live paths use.
    const responseEffective = response ? new Date(response.createdAt) : open ? null : w.endedAt;
    const responseBreached = responseEffective
      ? responseEffective > targets.responseDueAt
      : now2 > targets.responseDueAt;
    const responseApproaching =
      open && !response && !responseBreached &&
      targets.responseApproachAt != null &&
      now2 >= targets.responseApproachAt && now2 < targets.responseDueAt;

    const resolutionBreached = w.endedAt
      ? w.endedAt > targets.resolutionDueAt
      : now2 > targets.resolutionDueAt;
    const resolutionApproaching =
      open && !resolutionBreached &&
      targets.resolutionApproachAt != null &&
      now2 >= targets.resolutionApproachAt && now2 < targets.resolutionDueAt;

    cycles.push({
      ...w,
      targets,
      holidays,
      firstResponse: response || null,
      responseDurationMs: response
        ? policy.calendar.workingMsBetween(w.startedAt, response.createdAt, holidays)
        : null,
      resolutionDurationMs: w.endedAt
        ? policy.calendar.workingMsBetween(w.startedAt, w.endedAt, holidays)
        : null,
      responseBreached,
      resolutionBreached,
      responseApproaching,
      resolutionApproaching,
    });
  }
  return { ticket, cycles };
}

/** Event rows for one planned cycle (minus target_created, written by startCycle). */
function eventsForCycle(planned) {
  const events = [];
  const { cycleNumber, startedAt, endedAt, targets, firstResponse } = planned;
  if (cycleNumber > 1) {
    events.push({
      type: 'cycle_restarted',
      clock: null,
      at: startedAt,
      detail: `Reopen reconstructed from ticket history — cycle ${cycleNumber} starts here`,
      metadata: { previousCycleNumber: cycleNumber - 1, backfill: true },
    });
  }
  if (firstResponse) {
    events.push({
      type: 'response_recorded',
      clock: 'response',
      at: firstResponse.createdAt,
      detail: `First public agent response reconstructed from comment history for cycle ${cycleNumber}`,
      metadata: { firstResponseAt: new Date(firstResponse.createdAt).toISOString(), backfill: true },
    });
  }
  if (planned.responseBreached) {
    events.push({
      type: 'breach',
      clock: 'response',
      at: targets.responseDueAt,
      detail: firstResponse
        ? `Response SLA breached in cycle ${cycleNumber} — reconstructed first response arrived late`
        : endedAt
          ? `Response SLA breached in cycle ${cycleNumber} — no agent response before the cycle ended`
          : `Response SLA breached in cycle ${cycleNumber} — still unanswered past the target`,
      metadata: { responseDueAt: targets.responseDueAt.toISOString(), backfill: true },
    });
  }
  if (planned.resolutionBreached) {
    events.push({
      type: 'breach',
      clock: 'resolution',
      at: targets.resolutionDueAt,
      detail: endedAt
        ? `Resolution SLA breached in cycle ${cycleNumber}`
        : `Resolution SLA breached in cycle ${cycleNumber} — ticket still open past the target`,
      metadata: { resolutionDueAt: targets.resolutionDueAt.toISOString(), backfill: true },
    });
  }
  if (planned.responseApproaching) {
    events.push({
      type: 'approaching_breach',
      clock: 'response',
      at: targets.responseApproachAt,
      detail: `Response SLA approaching breach in cycle ${cycleNumber} — 25% of the response window remains`,
      metadata: { responseDueAt: targets.responseDueAt.toISOString(), backfill: true },
    });
  }
  if (planned.resolutionApproaching) {
    events.push({
      type: 'approaching_breach',
      clock: 'resolution',
      at: targets.resolutionApproachAt,
      detail: `Resolution SLA approaching breach in cycle ${cycleNumber} — 25% of the resolution window remains`,
      metadata: { resolutionDueAt: targets.resolutionDueAt.toISOString(), backfill: true },
    });
  }
  return events;
}

/** One planned ticket → rows. Runs inside a transaction; writes ONLY new SLA rows. */
async function writeTicket(tx, planned, { policy }) {
  const { ticket, cycles } = planned;
  for (const c of cycles) {
    const cycle = await slaService.startCycle(ticket, {
      cycleNumber: c.cycleNumber,
      startedAt: c.startedAt,
      client: tx,
      actor: 'backfill',
      source: 'backfill',
      // The ticket keeps its historical mirrors and every other column.
      syncTicket: false,
      policy,
      holidays: c.holidays,
    });
    await tx.ticketSlaCycle.update({
      where: { id: cycle.id },
      data: {
        endedAt: c.endedAt,
        resolvedAt: c.endedAt ? (c.resolvedAt || c.endedAt) : null,
        firstResponseAt: c.firstResponse ? c.firstResponse.createdAt : null,
        firstResponderId: c.firstResponse?.authorAgentId ?? null,
        responseDurationMs: c.responseDurationMs,
        resolutionDurationMs: c.resolutionDurationMs,
        responseBreached: c.responseBreached,
        resolutionBreached: c.resolutionBreached,
        responseApproached: c.responseApproaching,
        resolutionApproached: c.resolutionApproaching,
      },
    });
    // startCycle has already written the target_created event (authored by
    // 'backfill'); everything below appends the reconstructed history.
    for (const e of eventsForCycle(c)) {
      await slaService.recordEvent(tx, {
        ticketId: ticket.id,
        cycleId: cycle.id,
        actor: 'backfill',
        ...e,
      });
    }
  }
}

/**
 * Run the backfill. Idempotent: only tickets with zero cycles are eligible,
 * so a second call plans and writes nothing. Returns a summary; in dry-run
 * mode nothing is written and the summary describes what a real run would do.
 */
async function backfillSla({
  client = prisma,
  dryRun = false,
  batchSize = 50,
  ticketId = null,
  now = new Date(),
  policy = slaService.defaultSlaPolicy(),
  logger = console,
} = {}) {
  const summary = {
    dryRun,
    ticketsScanned: 0,
    ticketsEligible: 0,
    cyclesCreated: 0,
    eventsCreated: 0,
    responsesReconstructed: 0,
    responseBreaches: 0,
    resolutionBreaches: 0,
    approachingEvents: 0,
    openEndedCycles: 0,
    approximatedEnds: 0,
    raced: 0,
  };

  let cursor = 0;
  for (;;) {
    const batch = await client.ticket.findMany({
      where: {
        slaCycles: { none: {} },
        ...(ticketId != null ? { id: ticketId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      include: {
        auditLogs: { orderBy: { createdAt: 'asc' } },
        comments: {
          where: { isRequester: false, isInternal: false },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (batch.length === 0) break;

    for (const ticket of batch) {
      cursor = ticket.id;
      summary.ticketsScanned += 1;
      const planned = await planTicket(ticket, { now, policy, client });
      if (!planned) continue; // raced a live cycle into existence — leave it alone
      summary.ticketsEligible += 1;

      // Deltas apply to the summary only once the rows actually exist (or in
      // dry-run, where the summary describes the plan).
      const deltas = {
        cyclesCreated: 0,
        eventsCreated: 0,
        responsesReconstructed: 0,
        responseBreaches: 0,
        resolutionBreaches: 0,
        approachingEvents: 0,
        openEndedCycles: 0,
        approximatedEnds: 0,
      };
      for (const c of planned.cycles) {
        deltas.cyclesCreated += 1;
        deltas.eventsCreated += 1; // target_created
        if (c.firstResponse) deltas.responsesReconstructed += 1;
        if (c.responseBreached) deltas.responseBreaches += 1;
        if (c.resolutionBreached) deltas.resolutionBreaches += 1;
        if (c.responseApproaching) deltas.approachingEvents += 1;
        if (c.resolutionApproaching) deltas.approachingEvents += 1;
        deltas.eventsCreated += eventsForCycle(c).length;
        if (!c.endedAt) deltas.openEndedCycles += 1;
        if (c.approximatedEnd) deltas.approximatedEnds += 1;
      }

      const describe = (c) =>
        `#${c.cycleNumber} ${c.startedAt.toISOString().slice(0, 16)} → ` +
        (c.endedAt ? c.endedAt.toISOString().slice(0, 16) : 'open') +
        ` [response ${c.firstResponse ? 'reconstructed' : 'unknown'}]` +
        `${c.responseBreached ? ' response-breach' : ''}${c.resolutionBreached ? ' resolution-breach' : ''}`;

      if (dryRun) {
        logger.log(`[sla-backfill] would backfill ${ticket.ticketNumber}: ${planned.cycles.map(describe).join(' | ')}`);
        for (const [k, v] of Object.entries(deltas)) summary[k] += v;
        continue;
      }

      try {
        await client.$transaction(async (tx) => writeTicket(tx, planned, { policy }));
        logger.log(`[sla-backfill] backfilled ${ticket.ticketNumber}: ${planned.cycles.map(describe).join(' | ')}`);
        for (const [k, v] of Object.entries(deltas)) summary[k] += v;
      } catch (err) {
        // A live path started a cycle between the scan and the write (the
        // unique [ticketId, cycleNumber] row exists) — the live cycle wins,
        // the ticket is simply not backfilled, and the run continues.
        if (err && err.code === 'P2002') {
          summary.raced = (summary.raced || 0) + 1;
          summary.ticketsEligible -= 1;
          logger.log(`[sla-backfill] ${ticket.ticketNumber} gained a live cycle mid-run — skipped`);
          continue;
        }
        throw err;
      }
    }
    if (batch.length < batchSize) break;
  }
  return summary;
}

module.exports = {
  reconstructCycles,
  firstResponseFor,
  planTicket,
  eventsForCycle,
  writeTicket,
  backfillSla,
};
