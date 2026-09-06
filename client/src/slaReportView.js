// Pure display model for the admin SLA Reports page.
//
// GET /api/sla/report is the only source of report data: everything here is
// presentation — turning the API payload into KPI-card models, table rows and
// chart bars. No SLA durations, working hours, breach states or compliance
// are computed here; the only arithmetic is display scaling (percentages of
// provided totals, bar widths relative to the largest day) and formatting via
// the shared fmtRemaining used by the rest of the SLA UI.
import { fmtRemaining } from './slaView.js';

const PRIORITY_LABELS = { low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' };

export function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] || priority;
}

/** Display percentage, clamped — the same scaling the dashboard cards use. */
export function pct(part, whole) {
  if (!whole) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

function rateText(rate) {
  return rate === null || rate === undefined ? '—' : `${rate}%`;
}

/**
 * KPI cards in the Dashboard's exact visual language, split into the two
 * sections the page shows: completed historical cycles (range-filtered by
 * the API) and the current live state.
 */
export function reportKpiCards(report) {
  const t = report?.totals;
  if (!t) return { historical: [], live: [] };

  const historical = [
    {
      tone: 'ok',
      label: 'SLA Compliance',
      value: t.rate === null || t.rate === undefined ? null : `${t.rate}%`,
      sub: `${t.met} of ${t.total} completed cycles met`,
      segments: [
        { key: 'met', pct: pct(t.met, t.total), title: `${t.met} met` },
        { key: 'missed', pct: pct(t.total - t.met, t.total), title: `${t.total - t.met} missed` },
      ],
      note: t.total ? 'Completed cycles in range' : 'No completed cycles in range',
    },
    {
      tone: 'primary',
      label: 'Avg First Response',
      value: fmtRemaining(t.response?.avgMs ?? null),
      sub: `${t.response?.count ?? 0} answered · ${t.response?.breached ?? 0} breached`,
      segments: [
        {
          key: 'met',
          pct: pct(t.response?.avgMs ?? 0, t.response?.targetMs ?? 0),
          title: 'Average against the response target',
        },
      ],
      note: t.response?.targetMs ? `Target ${fmtRemaining(t.response.targetMs)}` : null,
    },
    {
      tone: 'info',
      label: 'Avg Resolution',
      value: fmtRemaining(t.resolution?.avgMs ?? null),
      sub: `${t.resolution?.count ?? 0} resolved · ${t.resolution?.breached ?? 0} breached`,
      segments: [
        {
          key: 'met',
          pct: pct(t.resolution?.avgMs ?? 0, t.resolution?.avgTargetMs ?? 0),
          title: 'Average against the resolved cycles\u2019 targets',
        },
      ],
      note: t.resolution?.avgTargetMs ? `Target ${fmtRemaining(t.resolution.avgTargetMs)}` : null,
    },
  ];

  const liveBreaches = (t.live?.responseBreaches ?? 0) + (t.live?.resolutionBreaches ?? 0);
  const live = [
    {
      tone: 'primary',
      label: 'Open Cycles',
      value: t.live?.openCycles ?? 0,
      sub: 'Cycles currently running',
      segments: [{ key: 'met', pct: 100, title: `${t.live?.openCycles ?? 0} open` }],
      note: 'Live state — unaffected by the date range',
    },
    {
      tone: 'critical',
      label: 'Live Breaches',
      value: liveBreaches,
      sub: `Response ${t.live?.responseBreaches ?? 0} · Resolution ${t.live?.resolutionBreaches ?? 0}`,
      segments: [{ key: 'missed', pct: 100, title: `${liveBreaches} past their target` }],
      note: 'Open cycles past a target right now',
    },
    {
      tone: 'warn',
      label: 'Approaching Breach',
      value: t.live?.approaching ?? 0,
      sub: 'Open · under 25% of SLA time left',
      segments: [{ key: 'progress', pct: 100, title: `${t.live?.approaching ?? 0} approaching` }],
      note: 'Inside the 25%-remaining window',
    },
  ];
  return { historical, live };
}

/**
 * Table rows for one dimension (byPriority / byGroup / byAgent buckets).
 * Null rates and durations render as em dashes; durations reuse the shared
 * working-time formatter.
 */
export function bucketRows(buckets, kind = 'group') {
  return (buckets || []).map((b) => ({
    key: kind === 'priority' ? b.priority : kind === 'group' ? b.teamId : b.agentId,
    name: kind === 'priority' ? priorityLabel(b.priority) : kind === 'group' ? b.team : b.agent,
    total: b.total,
    met: b.met,
    rate: rateText(b.rate),
    responseBreached: b.response?.breached ?? 0,
    avgResponse: fmtRemaining(b.response?.avgMs ?? null) ?? '—',
    resolutionBreached: b.resolution?.breached ?? 0,
    avgResolution: fmtRemaining(b.resolution?.avgMs ?? null) ?? '—',
  }));
}

/**
 * Chart rows for the over-time series. `metPct`/`breachedPct` are bar widths
 * relative to the busiest day (pure display scaling).
 */
export function overTimeRows(report) {
  const rows = report?.overTime || [];
  const max = Math.max(0, ...rows.map((r) => Math.max(r.completed, r.started)));
  return rows.map((r) => ({
    ...r,
    startedPct: pct(r.started, max),
    metPct: pct(r.met, max),
    breachedPct: pct(r.breached, max),
  }));
}

/** The live vs backfill split, in a stable display order. */
export function sourceRows(sources) {
  const order = ['live', 'backfill'];
  return order
    .filter((k) => sources && sources[k])
    .map((k) => ({
      key: k,
      label: k === 'live' ? 'Live cycles' : 'Backfilled cycles',
      total: sources[k].total,
      met: sources[k].met,
      rate: rateText(sources[k].rate),
    }));
}

/** True when the report carries anything at all worth showing. */
export function hasReportData(report) {
  if (!report?.totals) return false;
  return (
    report.totals.total > 0 ||
    report.overTime?.length > 0 ||
    report.totals.live?.openCycles > 0
  );
}

/**
 * The API query for the selected range. Date filtering happens server-side;
 * this only builds the query string and applies the cheap client-side check
 * (the API remains authoritative on invalid ranges).
 */
export function buildReportQuery({ from = '', to = '' } = {}) {
  const f = String(from).trim();
  const t = String(to).trim();
  if (f && t && f > t) return { ok: false, error: 'The start date must be on or before the end date' };
  const qs = new URLSearchParams(
    Object.entries({ from: f, to: t }).filter(([, v]) => v !== '')
  ).toString();
  return { ok: true, query: qs };
}

/** Human-readable applied range for the card headers. */
export function rangeLabel(range) {
  if (!range?.from && !range?.to) return 'All time';
  const fmt = (v) => (v ? String(v).slice(0, 10) : '…');
  return `${fmt(range.from)} → ${fmt(range.to)}`;
}
