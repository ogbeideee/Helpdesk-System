// SLA reporting aggregates (read-only).
//
// Builds on the same semantics as the dashboard aggregate — every cycle is
// evaluated with slaService.cycleLiveState, so a reporting number can never
// disagree with what a ticket's own SLA view or the dashboard says:
//
//   - Compliance counts COMPLETED cycles only (endedAt set) that carry at
//     least one target; a met cycle is one with no breach on any applicable
//     clock. Cycles without applicable targets never enter a denominator.
//   - Breach/approach counts over OPEN cycles are the live, right-now state
//     and are reported separately from completed-cycle compliance. They are
//     not filtered by the report range: "who is breaching right now" has no
//     historical answer.
//   - Averages use the stored effective working-time durations. The average
//     resolution TARGET is recovered exactly from the frozen instants via
//     the configured calendar (addWorkingMs and workingMsBetween are
//     inverses), so no consumer ever hard-codes targets.
//   - byPriority / byGroup / byAgent attribute the same completed cycles
//     through the ticket's current priority, group and owner (historical
//     re-attribution was never recorded structurally). Cycles without a
//     group/owner simply do not appear in that dimension's buckets.
//   - overTime buckets cycles by calendar day in the configured timezone:
//     `started` counts every cycle whose window opened that day (open ones
//     included — it is a volume series), while completed/met/breached count
//     the cycles that ENDED that day.
//   - The `sources` split distinguishes `live` from `backfill` data.
//
// Date range: `from`/`to` filter COMPLETED metrics by cycle END and the
// volume series by cycle START. Nothing here writes, notifies, or touches
// ticket data — the queries are read-only.
const prisma = require('./lib/prisma');
const slaService = require('./slaService');
const calendar = require('./slaClock');
const { PRIORITIES } = require('./states');

// Fields the live evaluation needs on an open cycle.
const LIVE_SELECT = {
  responseDueAt: true,
  responseApproachAt: true,
  resolutionDueAt: true,
  resolutionApproachAt: true,
  firstResponseAt: true,
  endedAt: true,
  resolvedAt: true,
};

function newBucket() {
  return {
    total: 0,
    met: 0,
    responseApplicable: 0,
    responseBreached: 0,
    responseMsSum: 0,
    responseMsCount: 0,
    resolutionApplicable: 0,
    resolutionBreached: 0,
    resolutionMsSum: 0,
    resolutionMsCount: 0,
    resolutionTargetSum: 0,
  };
}

function mean(sum, count) {
  return count ? Math.round(sum / count) : null;
}

/** Accumulator → API shape. Every dimension (and the totals) shares it. */
function finalizeBucket(b) {
  return {
    total: b.total,
    met: b.met,
    rate: b.total ? Math.round((b.met / b.total) * 100) : null,
    response: {
      applicable: b.responseApplicable,
      breached: b.responseBreached,
      avgMs: mean(b.responseMsSum, b.responseMsCount),
      count: b.responseMsCount,
    },
    resolution: {
      applicable: b.resolutionApplicable,
      breached: b.resolutionBreached,
      avgMs: mean(b.resolutionMsSum, b.resolutionMsCount),
      count: b.resolutionMsCount,
      avgTargetMs: mean(b.resolutionTargetSum, b.resolutionMsCount),
    },
  };
}

/** Fold one COMPLETED cycle into a bucket. `state` comes from cycleLiveState. */
function accumulate(bucket, c, state, policy) {
  if (state.hasResponse) {
    bucket.responseApplicable += 1;
    if (state.responseBreached) bucket.responseBreached += 1;
  }
  if (state.hasResolution) {
    bucket.resolutionApplicable += 1;
    if (state.resolutionBreached) bucket.resolutionBreached += 1;
  }
  if (state.hasResponse || state.hasResolution) {
    bucket.total += 1;
    if (!state.responseBreached && !state.resolutionBreached) bucket.met += 1;
  }
  if (c.responseDurationMs != null) {
    bucket.responseMsSum += c.responseDurationMs;
    bucket.responseMsCount += 1;
  }
  if (c.resolutionDurationMs != null) {
    bucket.resolutionMsSum += c.resolutionDurationMs;
    bucket.resolutionMsCount += 1;
    if (state.hasResolution) {
      // The frozen target recovered as working time under the current
      // calendar — the same recovery the dashboard uses.
      bucket.resolutionTargetSum += policy.calendar.workingMsBetween(c.startedAt, c.resolutionDueAt);
    }
  }
}

function dayOf(instant, policyCalendar) {
  return calendar.dayKeyToDate(policyCalendar.dayKey(instant)).toISOString().slice(0, 10);
}

/**
 * The reporting aggregate. `from`/`to` are optional Dates (the route
 * validates them); `now` is injectable so tests can pin the live evaluation.
 */
async function slaReport({ from = null, to = null, now = new Date(), client = prisma } = {}) {
  const policy = await slaService.loadSlaPolicy(client);
  const from2 = from ? new Date(from) : null;
  const to2 = to ? new Date(to) : null;

  const completedWhere = {
    endedAt: {
      not: null,
      ...(from2 ? { gte: from2 } : {}),
      ...(to2 ? { lte: to2 } : {}),
    },
  };
  const startedFilter = {};
  if (from2) startedFilter.gte = from2;
  if (to2) startedFilter.lte = to2;
  // Live cycles are never range-filtered: the live section is the current
  // state, and "currently breaching" has no historical answer.
  const openWhere = { endedAt: null };

  const [completed, started, open] = await Promise.all([
    client.ticketSlaCycle.findMany({
      where: completedWhere,
      include: {
        ticket: {
          select: {
            priority: true,
            teamId: true,
            assignedAgentId: true,
            team: { select: { name: true } },
            assignedAgent: { select: { name: true } },
          },
        },
      },
    }),
    client.ticketSlaCycle.findMany({
      where: Object.keys(startedFilter).length ? { startedAt: startedFilter } : {},
      select: { startedAt: true },
    }),
    client.ticketSlaCycle.findMany({ where: openWhere, select: LIVE_SELECT }),
  ]);

  // ---- completed-cycle buckets -------------------------------------------
  const totals = newBucket();
  const byPriority = new Map(PRIORITIES.map((p) => [p, newBucket()]));
  const byGroup = new Map();
  const byAgent = new Map();
  const bySource = new Map();
  const days = new Map();

  for (const c of completed) {
    const state = slaService.cycleLiveState(c, now);
    accumulate(totals, c, state, policy);

    // The engine treats an unknown priority as moderate (DEFAULT_PRIORITY) —
    // legacy rows with the schema default 'medium' bucket there too.
    const priorityKey = byPriority.has(c.ticket.priority) ? c.ticket.priority : 'moderate';
    accumulate(byPriority.get(priorityKey), c, state, policy);
    if (c.ticket.teamId != null) {
      if (!byGroup.has(c.ticket.teamId)) {
        byGroup.set(c.ticket.teamId, { bucket: newBucket(), name: c.ticket.team?.name || null });
      }
      accumulate(byGroup.get(c.ticket.teamId).bucket, c, state, policy);
    }
    if (c.ticket.assignedAgentId != null) {
      if (!byAgent.has(c.ticket.assignedAgentId)) {
        byAgent.set(c.ticket.assignedAgentId, { bucket: newBucket(), name: c.ticket.assignedAgent?.name || null });
      }
      accumulate(byAgent.get(c.ticket.assignedAgentId).bucket, c, state, policy);
    }
    const source = c.source || 'live';
    if (!bySource.has(source)) bySource.set(source, newBucket());
    accumulate(bySource.get(source), c, state, policy);

    const day = dayOf(c.endedAt, policy.calendar);
    if (!days.has(day)) days.set(day, { day, started: 0, completed: 0, met: 0, breached: 0 });
    const row = days.get(day);
    // Outcomes need an applicable target — a target-less cycle contributes
    // volume but no met/breached outcome.
    if (state.hasResponse || state.hasResolution) {
      row.completed += 1;
      if (state.responseBreached || state.resolutionBreached) row.breached += 1;
      else row.met += 1;
    }
  }
  for (const s of started) {
    const day = dayOf(s.startedAt, policy.calendar);
    if (!days.has(day)) days.set(day, { day, started: 0, completed: 0, met: 0, breached: 0 });
    days.get(day).started += 1;
  }

  // ---- live section (current state; deliberately not range-filtered) -----
  const live = { openCycles: 0, responseBreaches: 0, resolutionBreaches: 0, approaching: 0 };
  for (const c of open) {
    const state = slaService.cycleLiveState(c, now);
    live.openCycles += 1;
    if (state.responseBreached) live.responseBreaches += 1;
    if (state.resolutionBreached) live.resolutionBreaches += 1;
    if (state.responseApproaching || state.resolutionApproaching) live.approaching += 1;
  }

  const byTotalThenName = (a, b) =>
    (b.total - a.total) || String(a.team || a.agent || '').localeCompare(String(b.team || b.agent || ''));

  const totalsShaped = finalizeBucket(totals);
  return {
    range: {
      from: from2 ? from2.toISOString() : null,
      to: to2 ? to2.toISOString() : null,
      generatedAt: new Date(now).toISOString(),
    },
    totals: {
      ...totalsShaped,
      response: { ...totalsShaped.response, targetMs: policy.responseTargetMs },
      live,
      sources: Object.fromEntries(
        [...bySource.entries()].map(([source, b]) => [
          source,
          { total: b.total, met: b.met, rate: b.total ? Math.round((b.met / b.total) * 100) : null },
        ])
      ),
    },
    byPriority: PRIORITIES.map((priority) => ({ priority, ...finalizeBucket(byPriority.get(priority)) })),
    byGroup: [...byGroup.entries()]
      .map(([teamId, { bucket, name }]) => ({ teamId, team: name, ...finalizeBucket(bucket) }))
      .sort(byTotalThenName),
    byAgent: [...byAgent.entries()]
      .map(([agentId, { bucket, name }]) => ({ agentId, agent: name, ...finalizeBucket(bucket) }))
      .sort(byTotalThenName),
    overTime: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

module.exports = { slaReport, newBucket, finalizeBucket, accumulate };
