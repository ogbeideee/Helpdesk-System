// SLA service layer.
//
// Builds on the SLA foundation schema (migration 20260905000000_sla_foundation)
// and implements the approved policy:
//   - Response SLA: 1 working hour from the cycle start to the first public
//     agent response. Internal notes and requester messages never count, and
//     only the first qualifying response per cycle is recorded.
//   - Resolution SLA: the existing priority targets (critical 4h, high 8h,
//     moderate 24h, low 72h), measured in working time like the response SLA.
//   - Working calendar: Mon–Fri 08:00–17:00 Africa/Lagos; evenings, weekends
//     and SlaHoliday dates do not count (see slaClock.js). The targets and
//     the calendar are administrator-configurable through SLA settings
//     (settingsService group 'sla'); the values here are the built-in
//     defaults a fresh install runs on.
//   - Agent unavailability and handovers do not pause any clock; there is no
//     waiting state.
//   - Every reopen preserves the previous cycle and starts the next one.
//   - A priority change recomputes the open cycle's resolution target from
//     the cycle start, not from the change instant.
//   - Approaching breach = 25% of the applicable SLA time still remaining
//     (fixed rule, not configurable).
//
// Ticket.dueAt and Ticket.responseDueAt / firstResponseAt / responseBreached
// are live mirrors of the current cycle (the schema's stated convention), so
// dashboards and list filters keep working without joining the cycle table.
//
// Out of scope here (later phases): the approaching-breach/breach sweeper,
// notifications, reports, backfill and admin UI. serializeSla computes
// approaching/breached live from timestamps, so it is correct without a
// sweeper; the sweeper will only add the corresponding TicketSlaEvent rows.

const prisma = require('./lib/prisma');
const calendar = require('./slaClock');
const settingsService = require('./services/settingsService');

// Built-in defaults — the approved policy. Administrators override these
// through SLA settings (Setting table via settingsService); loadSlaPolicy()
// resolves the effective values and the calendar they imply. Cycle rows
// freeze the instants computed from the policy that applied when the cycle
// started, so a settings change never rewrites an existing cycle.
const RESPONSE_TARGET_MS = 60 * 60 * 1000;
const RESOLUTION_TARGET_HOURS = { critical: 4, high: 8, moderate: 24, low: 72 };
const DEFAULT_PRIORITY = 'moderate';
// "Approaching breach" fires when this fraction of the SLA time remains. Not
// administrator-configurable — an approved, fixed rule.
const APPROACHING_REMAINING_FRACTION = 0.25;
// Holiday rows loaded this far ahead of a cycle start; comfortably beyond the
// longest target (72 working hours ≈ 16 calendar days) plus holiday slack.
const HOLIDAY_HORIZON_MS = 120 * 24 * 60 * 60 * 1000;
// TicketSlaCycle duration columns are Int (ms). A cycle would have to accrue
// ~2^31 ms of WORKING time (≈66 working days) to overflow; clamp rather than
// crash on an absurd historical span.
const MAX_INT_MS = 2147483647;

/**
 * The SLA policy currently in force: the configured targets plus the working
 * calendar they imply (built by slaClock.createCalendar from the sla* keys in
 * the Setting table, falling back to the built-in defaults).
 */
async function loadSlaPolicy(client = prisma) {
  const s = await settingsService.getAll(client, 'sla');
  let cal;
  try {
    cal = calendar.createCalendar({
      timeZone: s.slaTimezone,
      workdayStartHour: s.slaWorkdayStartHour,
      workdayEndHour: s.slaWorkdayEndHour,
      workingDays: s.slaWorkingDays,
    });
  } catch (err) {
    // The settings API validates before saving, so an invalid calendar can
    // only come from a bad deployment-time env override. The engine must keep
    // working — fall back to the approved default calendar.
    console.error(`[sla] invalid configured calendar (${err.message}) — using the default calendar`);
    cal = calendar.defaultCalendar;
  }
  return {
    responseTargetMs: s.slaResponseTargetMinutes * 60000,
    resolutionTargetHours: {
      critical: s.slaResolutionHoursCritical,
      high: s.slaResolutionHoursHigh,
      moderate: s.slaResolutionHoursModerate,
      low: s.slaResolutionHoursLow,
    },
    calendar: cal,
  };
}

/**
 * The documented default policy (the approved constants above, on the approved
 * calendar). The historical backfill uses this: what an admin configures today
 * says nothing about the policy that governed a cycle years ago, so the
 * documented policy is the only defensible reconstruction baseline.
 */
function defaultSlaPolicy() {
  return {
    responseTargetMs: RESPONSE_TARGET_MS,
    resolutionTargetHours: RESOLUTION_TARGET_HOURS,
    calendar: calendar.defaultCalendar,
  };
}

function clampIntMs(ms) {
  return ms > MAX_INT_MS ? MAX_INT_MS : ms;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Calendar access
// ---------------------------------------------------------------------------

/**
 * SlaHoliday rows between two instants, as Dates (UTC-midnight calendar days).
 * Both bounds are interpreted as calendar days in the configured timezone.
 * Pass a loaded `policy` to avoid re-reading the settings on hot paths.
 */
async function loadHolidaysBetween(from, to, client = prisma, policy = null) {
  const cal = (policy || (await loadSlaPolicy(client))).calendar;
  const firstKey = cal.dayKey(from);
  const lastKey = cal.dayKey(to);
  if (lastKey < firstKey) return [];
  const rows = await client.slaHoliday.findMany({
    where: { date: { gte: calendar.dayKeyToDate(firstKey), lte: calendar.dayKeyToDate(lastKey) } },
    select: { date: true },
    orderBy: { date: 'asc' },
  });
  return rows.map((r) => r.date);
}

async function holidaysForCycle(startedAt, client = prisma, policy = null) {
  return loadHolidaysBetween(
    startedAt,
    new Date(new Date(startedAt).getTime() + HOLIDAY_HORIZON_MS),
    client,
    policy
  );
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Response + resolution targets for a cycle starting at `from` with the given
 * priority, under `policy` (defaults to the built-in policy when a caller has
 * no loaded settings). The approach instants mark where 25% of the applicable
 * SLA time still remains, i.e. 75% of the target has been consumed in working
 * time.
 */
function computeTargets({ priority, from, holidays = [], policy = null }) {
  const p = policy || {
    responseTargetMs: RESPONSE_TARGET_MS,
    resolutionTargetHours: RESOLUTION_TARGET_HOURS,
    calendar: calendar.defaultCalendar,
  };
  const resolutionHours =
    (p.resolutionTargetHours[priority] || p.resolutionTargetHours[DEFAULT_PRIORITY]) * 3600000;
  return {
    responseDueAt: p.calendar.addWorkingMs(from, p.responseTargetMs, holidays),
    responseApproachAt: p.calendar.addWorkingMs(
      from,
      Math.round(p.responseTargetMs * (1 - APPROACHING_REMAINING_FRACTION)),
      holidays
    ),
    resolutionDueAt: p.calendar.addWorkingMs(from, resolutionHours, holidays),
    resolutionApproachAt: p.calendar.addWorkingMs(
      from,
      Math.round(resolutionHours * (1 - APPROACHING_REMAINING_FRACTION)),
      holidays
    ),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function recordEvent(
  client,
  { ticketId, cycleId = null, type, clock = null, at, actor = 'system', detail = null, metadata = null }
) {
  return client.ticketSlaEvent.create({
    data: {
      ticketId,
      cycleId,
      type,
      clock,
      at,
      actor,
      detail,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

async function hasBreachEvent(client, cycleId, clock) {
  const count = await client.ticketSlaEvent.count({
    where: { cycleId, type: 'breach', clock },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

async function latestCycleFor(ticketId, client = prisma) {
  return client.ticketSlaCycle.findFirst({
    where: { ticketId },
    orderBy: { cycleNumber: 'desc' },
  });
}

async function openCycleFor(ticketId, client = prisma) {
  return client.ticketSlaCycle.findFirst({
    where: { ticketId, endedAt: null },
    orderBy: { cycleNumber: 'desc' },
  });
}

/**
 * Start an SLA cycle: compute and freeze this cycle's targets from the cycle
 * start, snapshot the ticket's current attribution, write the target_created
 * event, and sync the Ticket live mirrors (dueAt, responseDueAt, and a reset
 * response outcome for the new cycle).
 *
 * `syncTicket: false` skips the mirror write — for the historical backfill,
 * which creates cycles that are not the ticket's live state and must never
 * touch ticket data. `policy`/`holidays` let a caller pin the policy (the
 * backfill pins the documented default); without them the currently
 * configured policy and the loaded holiday table apply, as before.
 */
async function startCycle(
  ticket,
  {
    cycleNumber,
    startedAt,
    client = prisma,
    actor = 'system',
    source = 'live',
    syncTicket = true,
    policy = null,
    holidays = null,
  } = {}
) {
  const at = startedAt ? new Date(startedAt) : new Date();
  // The policy (and therefore the calendar) that applies at cycle start —
  // frozen into this cycle's targets.
  const activePolicy = policy || (await loadSlaPolicy(client));
  const cycleHolidays = holidays || (await holidaysForCycle(at, client, activePolicy));
  const targets = computeTargets({ priority: ticket.priority, from: at, holidays: cycleHolidays, policy: activePolicy });

  const cycle = await client.ticketSlaCycle.create({
    data: {
      ticketId: ticket.id,
      cycleNumber,
      startedAt: at,
      responseDueAt: targets.responseDueAt,
      responseApproachAt: targets.responseApproachAt,
      resolutionDueAt: targets.resolutionDueAt,
      resolutionApproachAt: targets.resolutionApproachAt,
      assignedAgentId: ticket.assignedAgentId ?? null,
      teamId: ticket.teamId ?? null,
      source,
    },
  });

  await recordEvent(client, {
    ticketId: ticket.id,
    cycleId: cycle.id,
    type: 'target_created',
    at,
    actor,
    detail: `SLA cycle ${cycleNumber} targets set (priority ${ticket.priority})`,
    metadata: {
      priority: ticket.priority,
      responseDueAt: iso(targets.responseDueAt),
      resolutionDueAt: iso(targets.resolutionDueAt),
    },
  });

  if (syncTicket) {
    await client.ticket.update({
      where: { id: ticket.id },
      data: {
        dueAt: targets.resolutionDueAt,
        responseDueAt: targets.responseDueAt,
        firstResponseAt: null,
        responseBreached: false,
      },
    });
  }
  return cycle;
}

/**
 * Record the first public agent response on the latest cycle. Idempotent:
 * only the first qualifying response per cycle is recorded; the caller (route
 * or intake) decides which comments qualify.
 */
async function recordFirstResponse(
  ticket,
  { at, responderId = null, actor = 'system', client = prisma } = {}
) {
  const cycle = await latestCycleFor(ticket.id, client);
  if (!cycle || cycle.firstResponseAt) return null;
  const at2 = at ? new Date(at) : new Date();
  const policy = await loadSlaPolicy(client);

  const holidays = await loadHolidaysBetween(cycle.startedAt, at2, client, policy);
  const breached = cycle.responseDueAt ? at2 > cycle.responseDueAt : false;
  const cycleBreached = breached || cycle.responseBreached;

  const updated = await client.ticketSlaCycle.update({
    where: { id: cycle.id },
    data: {
      firstResponseAt: at2,
      firstResponderId: responderId ?? null,
      responseDurationMs: clampIntMs(policy.calendar.workingMsBetween(cycle.startedAt, at2, holidays)),
      responseBreached: cycleBreached,
      // Refresh attribution so the response is accounted to the owner at the
      // time it happened.
      assignedAgentId: ticket.assignedAgentId ?? cycle.assignedAgentId,
      teamId: ticket.teamId ?? cycle.teamId,
    },
  });

  await client.ticket.update({
    where: { id: ticket.id },
    data: { firstResponseAt: at2, responseBreached: cycleBreached },
  });

  await recordEvent(client, {
    ticketId: ticket.id,
    cycleId: cycle.id,
    type: 'response_recorded',
    clock: 'response',
    at: at2,
    actor,
    detail: `First public agent response recorded for cycle ${cycle.cycleNumber}`,
    metadata: { responderId, responseDueAt: iso(cycle.responseDueAt), breached },
  });

  if (breached && !(await hasBreachEvent(client, cycle.id, 'response'))) {
    await recordEvent(client, {
      ticketId: ticket.id,
      cycleId: cycle.id,
      type: 'breach',
      clock: 'response',
      at: cycle.responseDueAt,
      actor: 'system',
      detail: `Response SLA breached in cycle ${cycle.cycleNumber} — first response arrived late`,
      metadata: { firstResponseAt: iso(at2), responseDueAt: iso(cycle.responseDueAt) },
    });
  }
  return updated;
}

/**
 * Close out the open cycle when its ticket reaches RESOLVED. The row keeps
 * its outcome forever; a later reopen starts a new cycle rather than
 * rewriting this one. If the response clock was never answered and had
 * already run out, the breach is latched here.
 */
async function finalizeOpenCycle(
  ticket,
  { at, actor = 'system', client = prisma, include = null } = {}
) {
  const cycle = await openCycleFor(ticket.id, client);
  if (!cycle) return null;
  const at2 = at ? new Date(at) : new Date();
  const policy = await loadSlaPolicy(client);

  const holidays = await loadHolidaysBetween(cycle.startedAt, at2, client, policy);
  const resolutionBreached = cycle.resolutionDueAt ? at2 > cycle.resolutionDueAt : false;
  const responseLatched =
    !cycle.firstResponseAt && cycle.responseDueAt ? at2 > cycle.responseDueAt : false;

  const updated = await client.ticketSlaCycle.update({
    where: { id: cycle.id },
    data: {
      endedAt: at2,
      resolvedAt: at2,
      resolutionDurationMs: clampIntMs(policy.calendar.workingMsBetween(cycle.startedAt, at2, holidays)),
      resolutionBreached,
      // Attribution: the owner and group the cycle ended with (approved
      // policy 11).
      assignedAgentId: ticket.assignedAgentId ?? cycle.assignedAgentId,
      teamId: ticket.teamId ?? cycle.teamId,
      ...(responseLatched ? { responseBreached: true } : {}),
    },
  });

  if (responseLatched) {
    await client.ticket.update({
      where: { id: ticket.id },
      data: { responseBreached: true },
    });
    if (!(await hasBreachEvent(client, cycle.id, 'response'))) {
      await recordEvent(client, {
        ticketId: ticket.id,
        cycleId: cycle.id,
        type: 'breach',
        clock: 'response',
        at: cycle.responseDueAt,
        actor: 'system',
        detail: `Response SLA breached in cycle ${cycle.cycleNumber} — no agent response before the cycle ended`,
        metadata: { endedAt: iso(at2), responseDueAt: iso(cycle.responseDueAt) },
      });
    }
  }
  if (resolutionBreached && !(await hasBreachEvent(client, cycle.id, 'resolution'))) {
    await recordEvent(client, {
      ticketId: ticket.id,
      cycleId: cycle.id,
      type: 'breach',
      clock: 'resolution',
      at: cycle.resolutionDueAt,
      actor: 'system',
      detail: `Resolution SLA breached in cycle ${cycle.cycleNumber}`,
      metadata: { resolvedAt: iso(at2), resolutionDueAt: iso(cycle.resolutionDueAt) },
    });
  }
  // The cycle row was finalized after the caller loaded its ticket, so a
  // caller that serializes the result needs the fresh rows.
  return include ? client.ticket.findUnique({ where: { id: ticket.id }, include }) : updated;
}

/**
 * Reopen: preserve the previous cycle and start the next one. The fresh
 * cycle's targets run from the reopen instant, and the Ticket mirrors reset
 * to the new cycle's state.
 */
async function restartCycle(
  ticket,
  { at, actor = 'system', reason = null, client = prisma, include = null } = {}
) {
  const at2 = at ? new Date(at) : new Date();
  const previous = await latestCycleFor(ticket.id, client);
  if (previous && previous.endedAt === null) {
    // Reopens always follow RESOLVED, which finalizes the cycle; close any
    // dangling open cycle defensively so history can never show two.
    await client.ticketSlaCycle.update({
      where: { id: previous.id },
      data: { endedAt: at2 },
    });
  }

  const cycle = await startCycle(ticket, {
    cycleNumber: (previous ? previous.cycleNumber : 0) + 1,
    startedAt: at2,
    client,
    actor,
  });

  await recordEvent(client, {
    ticketId: ticket.id,
    cycleId: cycle.id,
    type: 'cycle_restarted',
    at: at2,
    actor,
    detail: reason || 'Ticket reopened — previous SLA cycle preserved',
    metadata: { previousCycleNumber: previous ? previous.cycleNumber : null },
  });

  return include
    ? client.ticket.findUnique({ where: { id: ticket.id }, include })
    : cycle;
}

/**
 * Priority change on an open ticket: recompute the open cycle's resolution
 * target from the CYCLE START (approved policy 8), not from the change
 * instant. The response target is priority-independent and untouched.
 * Returns the refreshed ticket (with slaCycles) or null when the ticket has
 * no open cycle (legacy ticket — the caller keeps its calendar dueAt).
 */
async function onPriorityChanged(
  ticket,
  { actor = 'system', previousPriority = null, at, client = prisma, include = null } = {}
) {
  const cycle = await openCycleFor(ticket.id, client);
  if (!cycle) return null;
  const at2 = at ? new Date(at) : new Date();

  // Priority changes recompute with the policy currently in force — the
  // existing recalculation behaviour, now fed by the configured targets.
  const policy = await loadSlaPolicy(client);
  const holidays = await holidaysForCycle(cycle.startedAt, client, policy);
  const targets = computeTargets({ priority: ticket.priority, from: cycle.startedAt, holidays, policy });
  const resolutionBreached = targets.resolutionDueAt ? at2 > targets.resolutionDueAt : false;

  await client.ticketSlaCycle.update({
    where: { id: cycle.id },
    data: {
      resolutionDueAt: targets.resolutionDueAt,
      resolutionApproachAt: targets.resolutionApproachAt,
      resolutionBreached,
    },
  });
  await client.ticket.update({
    where: { id: ticket.id },
    data: { dueAt: targets.resolutionDueAt },
  });

  await recordEvent(client, {
    ticketId: ticket.id,
    cycleId: cycle.id,
    type: 'target_changed',
    clock: 'resolution',
    at: at2,
    actor,
    detail:
      `Priority changed to ${ticket.priority} — resolution target recomputed from the ` +
      `cycle ${cycle.cycleNumber} start`,
    metadata: {
      previousPriority,
      priority: ticket.priority,
      previousResolutionDueAt: iso(cycle.resolutionDueAt),
      resolutionDueAt: iso(targets.resolutionDueAt),
      breached: resolutionBreached,
    },
  });

  return client.ticket.findUnique({
    where: { id: ticket.id },
    include: include || { slaCycles: { orderBy: { cycleNumber: 'asc' } } },
  });
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * SLA view of a ticket for the API. `ticket.slaCycles` must be loaded
 * (ordered by cycleNumber); returns null for tickets without cycles (created
 * before the SLA feature — no backfill yet).
 *
 * `approaching` / `breached` are computed live from timestamps against the
 * calendar, so they stay correct without a sweeper. `remainingMs` is working
 * time from `now` to the target (null once answered / ended / breached-past).
 * `holidays` makes the remaining-time math holiday-exact; callers that don't
 * supply one still get exact due/breach values. `calendar` overrides the
 * working calendar for that math — callers pass the configured calendar (see
 * loadSlaPolicy); the approved default is used when absent. Due instants and
 * breach comparisons are timestamp-only and need no calendar.
 */
function serializeSla(ticket, { now, holidays = [], calendar: cal = calendar.defaultCalendar } = {}) {
  const cycles = ticket.slaCycles;
  if (!cycles || cycles.length === 0) return null;
  const ordered = [...cycles].sort((a, b) => a.cycleNumber - b.cycleNumber);
  const current = ordered[ordered.length - 1];
  const now2 = now ? new Date(now) : new Date();
  const open = current.endedAt == null;

  const responseEffective = current.firstResponseAt
    ? current.firstResponseAt
    : open
      ? now2
      : current.endedAt || now2;
  const responseBreached = Boolean(current.responseDueAt && responseEffective > current.responseDueAt);
  const responsePending = !current.firstResponseAt && open;
  const responseRemainingMs =
    responsePending && current.responseDueAt && now2 < current.responseDueAt
      ? cal.workingMsBetween(now2, current.responseDueAt, holidays)
      : null;
  const responseApproaching = Boolean(
    responsePending &&
      !responseBreached &&
      current.responseApproachAt &&
      now2 >= current.responseApproachAt
  );

  const resolutionEffective = open ? now2 : current.resolvedAt || current.endedAt || now2;
  const resolutionBreached = Boolean(
    current.resolutionDueAt && resolutionEffective > current.resolutionDueAt
  );
  const resolutionRemainingMs =
    open && current.resolutionDueAt && now2 < current.resolutionDueAt
      ? cal.workingMsBetween(now2, current.resolutionDueAt, holidays)
      : null;
  const resolutionApproaching = Boolean(
    open &&
      !resolutionBreached &&
      current.resolutionApproachAt &&
      now2 >= current.resolutionApproachAt
  );

  return {
    cycleNumber: current.cycleNumber,
    cycleStartedAt: current.startedAt,
    cycleEndedAt: current.endedAt,
    source: current.source,
    response: {
      dueAt: current.responseDueAt,
      remainingMs: responseRemainingMs,
      approaching: responseApproaching,
      breached: responseBreached,
      responded: Boolean(current.firstResponseAt),
      firstResponseAt: current.firstResponseAt,
      firstResponderId: current.firstResponderId,
    },
    resolution: {
      dueAt: current.resolutionDueAt,
      remainingMs: resolutionRemainingMs,
      approaching: resolutionApproaching,
      breached: resolutionBreached,
    },
    cycles: ordered.map((c) => ({
      cycleNumber: c.cycleNumber,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      resolvedAt: c.resolvedAt,
      responseDueAt: c.responseDueAt,
      resolutionDueAt: c.resolutionDueAt,
      firstResponseAt: c.firstResponseAt,
      firstResponderId: c.firstResponderId,
      assignedAgentId: c.assignedAgentId,
      teamId: c.teamId,
      responseDurationMs: c.responseDurationMs,
      resolutionDurationMs: c.resolutionDurationMs,
      responseBreached: c.responseBreached,
      resolutionBreached: c.resolutionBreached,
      source: c.source,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

/**
 * Live SLA state of one cycle, evaluated exactly like serializeSla: breach /
 * approach are recomputed from timestamps against the stored targets, so
 * stored latch flags never matter. Shared by the dashboard aggregate and the
 * reporting API so the two can never drift.
 *
 *   open                 the cycle has not reached RESOLVED
 *   hasResponse/…        the cycle carries that target at all
 *   responseBreached     the effective response instant (first response, else
 *                        cycle end, else now while open) is past the target
 *   responseApproaching  open, unanswered, not breached, inside the 25%-window
 *   …resolution          same, with the resolved/end instant
 */
function cycleLiveState(c, now) {
  const open = c.endedAt == null;
  const hasResponse = c.responseDueAt != null;
  const hasResolution = c.resolutionDueAt != null;

  let responseBreached = false;
  let responseApproaching = false;
  if (hasResponse) {
    const effective = c.firstResponseAt || (open ? null : c.endedAt);
    responseBreached = effective ? effective > c.responseDueAt : now > c.responseDueAt;
    responseApproaching =
      open &&
      !c.firstResponseAt &&
      !responseBreached &&
      c.responseApproachAt != null &&
      now >= c.responseApproachAt;
  }

  let resolutionBreached = false;
  let resolutionApproaching = false;
  if (hasResolution) {
    const effective = open ? null : c.resolvedAt || c.endedAt;
    resolutionBreached = effective ? effective > c.resolutionDueAt : now > c.resolutionDueAt;
    resolutionApproaching =
      open &&
      !resolutionBreached &&
      c.resolutionApproachAt != null &&
      now >= c.resolutionApproachAt;
  }

  return {
    open,
    hasResponse,
    hasResolution,
    responseBreached,
    responseApproaching,
    resolutionBreached,
    resolutionApproaching,
  };
}

/**
 * SLA KPIs for the dashboard, aggregated over every recorded cycle.
 *
 * Per-cycle outcomes use exactly the serializeSla semantics (live computation
 * from timestamps against the stored targets), so the dashboard always agrees
 * with what a ticket's own SLA view says:
 *   - Only applicable cycles join a figure: a cycle counts toward a clock's
 *     stats only when that clock has a target at all.
 *   - Compliance counts COMPLETED cycles only — an open cycle is never met or
 *     missed until its ticket resolves.
 *   - Breach counts include live breaches on open cycles (a ticket past its
 *     target is breaching right now), matching the red badge in the UI.
 *   - Approaching-breach counts distinct tickets whose open cycle has a clock
 *     inside the 25%-remaining window and not already breached.
 *   - Averages are effective working time over the cycles that recorded a
 *     duration (recorded first responses / completed resolutions), and the
 *     average resolution target is the exact working-time target of those
 *     same cycles so the UI can show the average as a share of the target.
 */
async function dashboardSlaStats({ now, client = prisma, policy = null } = {}) {
  const now2 = now ? new Date(now) : new Date();
  // The configured policy: its response target is reported as the current
  // target, and its calendar expresses each cycle's frozen due instant as
  // working time. A cycle measured under an older calendar recovers the
  // target as the current calendar expresses it — the stored instants
  // themselves are never rewritten.
  const activePolicy = policy || (await loadSlaPolicy(client));
  const cycles = await client.ticketSlaCycle.findMany({
    select: {
      ticketId: true,
      startedAt: true,
      endedAt: true,
      resolvedAt: true,
      responseDueAt: true,
      resolutionDueAt: true,
      responseApproachAt: true,
      resolutionApproachAt: true,
      firstResponseAt: true,
      responseDurationMs: true,
      resolutionDurationMs: true,
    },
  });

  let complianceTotal = 0; // completed cycles with at least one target
  let complianceMet = 0; // …with no breach on any applicable clock
  let responseBreaches = 0;
  let resolutionBreaches = 0;
  let responseApplicable = 0; // cycles carrying a response target
  let resolutionApplicable = 0; // cycles carrying a resolution target
  const approachingTickets = new Set();
  const responseDurations = [];
  const resolutionDurations = [];
  const resolutionTargets = [];

  for (const c of cycles) {
    const state = cycleLiveState(c, now2);
    if (state.hasResponse) responseApplicable += 1;
    if (state.hasResolution) resolutionApplicable += 1;

    if (state.responseBreached) responseBreaches += 1;
    if (state.resolutionBreached) resolutionBreaches += 1;
    if (state.responseApproaching || state.resolutionApproaching) approachingTickets.add(c.ticketId);

    if (!state.open && (state.hasResponse || state.hasResolution)) {
      complianceTotal += 1;
      if (!state.responseBreached && !state.resolutionBreached) complianceMet += 1;
    }

    if (c.responseDurationMs != null) responseDurations.push(c.responseDurationMs);
    if (c.resolutionDurationMs != null) {
      resolutionDurations.push(c.resolutionDurationMs);
      if (state.hasResolution) {
        // The target of the cycle as frozen working time; addWorkingMs and
        // workingMsBetween are inverses, so this recovers it exactly.
        resolutionTargets.push(activePolicy.calendar.workingMsBetween(c.startedAt, c.resolutionDueAt));
      }
    }
  }

  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    compliance: {
      met: complianceMet,
      total: complianceTotal,
      rate: complianceTotal ? Math.round((complianceMet / complianceTotal) * 100) : null,
    },
    breaches: {
      response: responseBreaches,
      resolution: resolutionBreaches,
      responseApplicable,
      resolutionApplicable,
    },
    approachingTickets: approachingTickets.size,
    avgFirstResponseMs: mean(responseDurations),
    firstResponseCount: responseDurations.length,
    avgResolutionMs: mean(resolutionDurations),
    resolutionCount: resolutionDurations.length,
    avgResolutionTargetMs: mean(resolutionTargets),
    responseTargetMs: activePolicy.responseTargetMs,
  };
}

module.exports = {
  RESPONSE_TARGET_MS,
  RESOLUTION_TARGET_HOURS,
  APPROACHING_REMAINING_FRACTION,
  loadSlaPolicy,
  defaultSlaPolicy,
  cycleLiveState,
  loadHolidaysBetween,
  computeTargets,
  recordEvent,
  startCycle,
  openCycleFor,
  latestCycleFor,
  recordFirstResponse,
  finalizeOpenCycle,
  restartCycle,
  onPriorityChanged,
  serializeSla,
  dashboardSlaStats,
};
