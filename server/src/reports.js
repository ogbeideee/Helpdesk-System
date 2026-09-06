// Operational reports aggregate (read-only).
//
// The operational counterpart to src/slaReport.js, over the Ticket table
// itself. Same reporting conventions, so the two stay mentally consistent:
//
//   - `from`/`to` filter CREATED metrics (volume, status/priority/group/agent
//     breakdowns, first-response) by ticket creation, and RESOLUTION metrics
//     (resolved volume, resolution time) by the resolution instant. A ticket
//     created in the range and resolved later appears in the created figures;
//     one created earlier and resolved in the range appears in the resolved
//     figures — each series answers its own question.
//   - The `current` section is the right-now snapshot (open / unassigned /
//     overdue / state distribution) and is deliberately NOT range-filtered:
//     "what is the queue like now" has no historical answer.
//   - Durations here are plain wall-clock spans between Ticket columns
//     (createdAt → firstResponseAt / resolvedAt). They intentionally say
//     nothing about working time or SLA targets: SLA performance is delegated
//     wholesale to the existing slaReport service and returned under `sla`,
//     so no SLA calculation is duplicated anywhere.
//   - byPriority zero-fills the four canonical priorities and buckets the
//     legacy schema default 'medium' into 'moderate', exactly like the SLA
//     engine's DEFAULT_PRIORITY handling.
//   - Day rows use the configured working-calendar day key, so the operational
//     volume series and the SLA overTime series slice time identically.
//
// Every query is a read; nothing here writes, notifies, or touches tickets.
const prisma = require('./lib/prisma');
const slaService = require('./slaService');
const calendar = require('./slaClock');
const { slaReport } = require('./slaReport');
const { STATES, PRIORITIES, OPEN_STATES } = require('./states');

const CREATED_SELECT = {
  state: true,
  priority: true,
  teamId: true,
  assignedAgentId: true,
  createdAt: true,
  firstResponseAt: true,
  team: { select: { name: true } },
  assignedAgent: { select: { name: true } },
};

const mean = (sum, count) => (count ? Math.round(sum / count) : null);

function dayOf(instant, policyCalendar) {
  return calendar.dayKeyToDate(policyCalendar.dayKey(instant)).toISOString().slice(0, 10);
}

function emptyVolumeRow(day) {
  return { day, created: 0, resolved: 0 };
}

/** Zero-filled status/priority buckets keep every enum position present. */
function zeroMap(keys) {
  return new Map(keys.map((k) => [k, 0]));
}

/**
 * The operational reports aggregate. `from`/`to` are optional Dates (the
 * route validates them); `now` is injectable so tests can pin the snapshot.
 */
async function reportsOverview({ from = null, to = null, now = new Date(), client = prisma } = {}) {
  const policy = await slaService.loadSlaPolicy(client);
  const from2 = from ? new Date(from) : null;
  const to2 = to ? new Date(to) : null;

  const createdWhere = {
    ...(from2 || to2 ? { createdAt: { ...(from2 ? { gte: from2 } : {}), ...(to2 ? { lte: to2 } : {}) } } : {}),
  };
  const resolvedWhere = {
    resolvedAt: { not: null, ...(from2 ? { gte: from2 } : {}), ...(to2 ? { lte: to2 } : {}) },
  };

  const [created, resolved, byStateRows, openCount, unassigned, overdue, sla] = await Promise.all([
    client.ticket.findMany({ where: createdWhere, select: CREATED_SELECT }),
    client.ticket.findMany({
      where: resolvedWhere,
      select: { createdAt: true, resolvedAt: true },
    }),
    // Current snapshot — the whole table, never range-filtered.
    client.ticket.groupBy({ by: ['state'], _count: { _all: true } }),
    client.ticket.count({ where: { state: { in: OPEN_STATES } } }),
    client.ticket.count({ where: { state: { in: OPEN_STATES }, assignedAgentId: null } }),
    client.ticket.count({
      where: { state: { in: OPEN_STATES }, dueAt: { lt: new Date(now) } },
    }),
    slaReport({ from: from2, to: to2, now, client }),
  ]);

  // ---- created-in-range breakdowns ----------------------------------------
  const byStatus = zeroMap(STATES);
  const byPriority = zeroMap(PRIORITIES);
  const byGroup = new Map(); // teamId -> { name, count, open }
  const byAgent = new Map(); // agentId -> { name, count, open }
  const days = new Map(); // day -> { day, created, resolved }

  let firstResponseSum = 0;
  let firstResponseCount = 0;

  for (const t of created) {
    byStatus.set(t.state, (byStatus.get(t.state) || 0) + 1);
    // Unknown/legacy priority values bucket into moderate (engine default).
    const priorityKey = byPriority.has(t.priority) ? t.priority : 'moderate';
    byPriority.set(priorityKey, byPriority.get(priorityKey) + 1);

    const group = (id, name) => {
      if (!byGroup.has(id)) byGroup.set(id, { name, count: 0, open: 0 });
      return byGroup.get(id);
    };
    const g = t.teamId != null
      ? group(t.teamId, t.team?.name || null)
      : group(null, null);
    g.count += 1;
    if (OPEN_STATES.includes(t.state)) g.open += 1;

    const agent = (id, name) => {
      if (!byAgent.has(id)) byAgent.set(id, { name, count: 0, open: 0 });
      return byAgent.get(id);
    };
    const a = t.assignedAgentId != null
      ? agent(t.assignedAgentId, t.assignedAgent?.name || null)
      : agent(null, null);
    a.count += 1;
    if (OPEN_STATES.includes(t.state)) a.open += 1;

    if (t.firstResponseAt) {
      firstResponseSum += new Date(t.firstResponseAt).getTime() - new Date(t.createdAt).getTime();
      firstResponseCount += 1;
    }

    const day = dayOf(t.createdAt, policy.calendar);
    if (!days.has(day)) days.set(day, emptyVolumeRow(day));
    days.get(day).created += 1;
  }

  // ---- resolution metrics (resolvedAt in range) ----------------------------
  let resolutionSum = 0;
  for (const t of resolved) {
    resolutionSum += new Date(t.resolvedAt).getTime() - new Date(t.createdAt).getTime();
    const day = dayOf(t.resolvedAt, policy.calendar);
    if (!days.has(day)) days.set(day, emptyVolumeRow(day));
    days.get(day).resolved += 1;
  }

  const byCountThenName = (a, b) =>
    (b.count - a.count) ||
    String(a.team ?? a.agent ?? '').localeCompare(String(b.team ?? b.agent ?? ''));

  const currentByState = zeroMap(STATES);
  for (const row of byStateRows) {
    currentByState.set(row.state, (currentByState.get(row.state) || 0) + row._count._all);
  }

  return {
    range: {
      from: from2 ? from2.toISOString() : null,
      to: to2 ? to2.toISOString() : null,
      generatedAt: new Date(now).toISOString(),
    },
    totals: {
      created: created.length,
      resolved: resolved.length,
      firstResponse: {
        // Every created ticket is eligible for a first response; the rate is
        // how many have one recorded yet.
        eligible: created.length,
        responded: firstResponseCount,
        rate: created.length ? Math.round((firstResponseCount / created.length) * 100) : null,
        avgMs: mean(firstResponseSum, firstResponseCount),
      },
      resolution: {
        count: resolved.length,
        avgMs: mean(resolutionSum, resolved.length),
      },
    },
    volume: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byStatus: STATES.map((state) => ({ state, count: byStatus.get(state) })),
    byPriority: PRIORITIES.map((priority) => ({ priority, count: byPriority.get(priority) })),
    byGroup: [...byGroup.entries()]
      .map(([teamId, { name, count, open }]) => ({ teamId, team: name, count, open }))
      .sort(byCountThenName),
    byAgent: [...byAgent.entries()]
      .map(([agentId, { name, count, open }]) => ({ agentId, agent: name, count, open }))
      .sort(byCountThenName),
    current: {
      byState: STATES.map((state) => ({ state, count: currentByState.get(state) })),
      open: openCount,
      unassigned,
      overdue,
    },
    // The SLA view of the same window, computed by the existing SLA reporting
    // service — working-time durations, compliance and breaches live there.
    sla,
  };
}

module.exports = { reportsOverview };
