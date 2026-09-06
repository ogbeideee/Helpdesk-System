// Pure display model for the admin Reports page.
//
// The backend (GET /api/reports) is the only source of truth: every metric,
// SLA value and aggregate arrives already computed. This module only shapes
// the payload into KPI cards, chart rows and table rows — presentation math
// (clamped percentages, bar scaling) and duration formatting via the shared
// SLA formatter, never metric calculation.
//
// Range query building and the range label are reused from the SLA reports
// view so both pages speak the identical range contract.
import { fmtRemaining } from './slaView.js';
import { pct, sourceRows } from './slaReportView.js';

const mean = (arr) => arr.reduce((m, v) => Math.max(m, v), 0);

/** KPI cards for the range-filtered operational figures. */
export function reportKpiCards(report) {
  const t = report?.totals ?? {};
  const created = t.created ?? 0;
  const resolved = t.resolved ?? 0;
  return [
    {
      tone: 'primary',
      label: 'Created',
      value: created,
      sub: 'Tickets created in range',
      segments: [],
      note: created ? 'Portal and email intake' : 'No tickets created in range',
    },
    {
      tone: 'ok',
      label: 'Resolved',
      value: resolved,
      sub: 'Resolved in range',
      segments: created
        ? [{ key: 'met', pct: pct(resolved, created), title: `${resolved} of ${created} created` }]
        : [],
      note: created ? `${resolved} of ${created} created tickets` : 'Nothing to resolve in range',
    },
    {
      tone: 'info',
      label: 'Avg Resolution',
      value: fmtRemaining(t.resolution?.avgMs ?? null),
      sub: 'Wall clock from creation to resolution',
      segments: [],
      note: t.resolution?.count ? `${t.resolution.count} resolved in range` : 'No resolutions in range',
    },
    {
      tone: 'info',
      label: 'First Response',
      value: fmtRemaining(t.firstResponse?.avgMs ?? null),
      sub: `${t.firstResponse?.rate ?? 0}% of created tickets answered`,
      segments: [],
      note: t.firstResponse?.eligible
        ? `${t.firstResponse.responded} of ${t.firstResponse.eligible} created tickets`
        : 'No first-response data in range',
    },
  ];
}

/**
 * Volume chart rows: created vs resolved per day, bars scaled to the largest
 * single value so quiet days stay visible next to busy ones.
 */
export function volumeRows(volume) {
  const rows = Array.isArray(volume) ? volume : [];
  const max = mean(rows.map((r) => Math.max(r.created, r.resolved)));
  return rows.map((r) => ({
    day: r.day,
    created: r.created,
    resolved: r.resolved,
    createdPct: max ? Math.round((r.created / max) * 100) : 0,
    resolvedPct: max ? Math.round((r.resolved / max) * 100) : 0,
  }));
}

/** Status / priority distribution rows with a clamped share of the total. */
export function distributionRows(buckets) {
  const rows = Array.isArray(buckets) ? buckets : [];
  const total = rows.reduce((n, r) => n + r.count, 0);
  return rows.map((r) => ({
    ...r,
    share: pct(r.count, total),
  }));
}

/** Group buckets; the no-group bucket is labelled rather than hidden. */
export function groupRows(byGroup) {
  return (Array.isArray(byGroup) ? byGroup : []).map((g) => ({
    id: g.teamId,
    name: g.team ?? 'No group',
    count: g.count,
    open: g.open,
    share: pct(g.count, (Array.isArray(byGroup) ? byGroup : []).reduce((n, r) => n + r.count, 0)),
  }));
}

/** Agent buckets; the unassigned bucket is labelled rather than hidden. */
export function agentRows(byAgent) {
  return (Array.isArray(byAgent) ? byAgent : []).map((a) => ({
    id: a.agentId,
    name: a.agent ?? 'Unassigned',
    count: a.count,
    open: a.open,
    share: pct(a.count, (Array.isArray(byAgent) ? byAgent : []).reduce((n, r) => n + r.count, 0)),
  }));
}

/** Current-queue snapshot cards — the right-now state, never range-filtered. */
export function currentCards(current) {
  const c = current ?? {};
  const byState = Array.isArray(c.byState) ? c.byState : [];
  const newCount = byState.find((s) => s.state === 'NEW')?.count ?? 0;
  const progressCount = byState.find((s) => s.state === 'IN_PROGRESS')?.count ?? 0;
  return [
    {
      tone: 'info',
      label: 'Open Tickets',
      value: c.open ?? 0,
      sub: 'NEW + in progress, right now',
      segments: [
        { key: 'progress', pct: pct(newCount, (c.open ?? 0)), title: `${newCount} NEW` },
        { key: 'met', pct: pct(progressCount, (c.open ?? 0)), title: `${progressCount} in progress` },
      ],
      note: 'Current state — unaffected by the date range',
    },
    {
      tone: 'warn',
      label: 'Unassigned',
      value: c.unassigned ?? 0,
      sub: 'Open tickets with no owner',
      segments: [{ key: 'met', pct: pct(c.unassigned ?? 0, c.open ?? 0), title: 'share of open' }],
      note: 'Awaiting claim or routing',
    },
    {
      tone: 'critical',
      label: 'Overdue',
      value: c.overdue ?? 0,
      sub: 'Open tickets past their due time',
      segments: [{ key: 'met', pct: pct(c.overdue ?? 0, c.open ?? 0), title: 'share of open' }],
      note: 'Live state — unaffected by the date range',
    },
  ];
}

/** The concise SLA summary: values straight from the SLA reporting service. */
export function slaSummary(sla) {
  const t = sla?.totals ?? {};
  const live = t.live ?? {};
  return {
    compliance: t.rate === null || t.rate === undefined ? null : `${t.rate}%`,
    met: t.met ?? 0,
    total: t.total ?? 0,
    responseBreached: t.response?.breached ?? 0,
    resolutionBreached: t.resolution?.breached ?? 0,
    avgResponse: fmtRemaining(t.response?.avgMs ?? null),
    avgResolution: fmtRemaining(t.resolution?.avgMs ?? null),
    liveOpen: live.openCycles ?? 0,
    liveBreaches: (live.responseBreaches ?? 0) + (live.resolutionBreaches ?? 0),
    liveApproaching: live.approaching ?? 0,
    sources: sourceRows(t.sources),
  };
}

/** Does the range contain any activity at all? */
export function hasRangeData(report) {
  return Boolean(report && report.totals && (report.totals.created > 0 || report.totals.resolved > 0));
}
