/* Unit checks for src/reportsView.js — the pure display model behind the
   admin Reports page. Plain node, no framework, following the repo's
   check-script pattern. The fixture mirrors the numbers pinned by the server
   suite (scripts/test-reports.js), so the model is exercised against the
   exact payload the API returns: every metric arrives already computed and
   the model only formats, scales and labels.

   Run: node reports-check.mjs  (from client/) */
import { buildReportQuery, rangeLabel } from './src/slaReportView.js';
import {
  reportKpiCards, volumeRows, distributionRows, groupRows, agentRows,
  currentCards, slaSummary, hasRangeData,
} from './src/reportsView.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const HOUR = 3600 * 1000;

// The exact numbers the server suite pins for the Sep 1–4 2026 window.
const REPORT = {
  range: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z', generatedAt: '2026-09-05T09:00:00.000Z' },
  totals: {
    created: 6,
    resolved: 3,
    firstResponse: { eligible: 6, responded: 2, rate: 33, avgMs: 2.5 * HOUR },
    resolution: { count: 3, avgMs: 16 * HOUR },
  },
  volume: [
    { day: '2026-09-01', created: 2, resolved: 0 },
    { day: '2026-09-02', created: 3, resolved: 1 },
    { day: '2026-09-03', created: 1, resolved: 2 },
  ],
  byStatus: [
    { state: 'NEW', count: 1 },
    { state: 'IN_PROGRESS', count: 2 },
    { state: 'RESOLVED', count: 2 },
    { state: 'CLOSED', count: 1 },
  ],
  byPriority: [
    { priority: 'low', count: 1 },
    { priority: 'moderate', count: 3 },
    { priority: 'high', count: 1 },
    { priority: 'critical', count: 1 },
  ],
  byGroup: [
    { teamId: 1, team: 'Alpha Team', count: 3, open: 2 },
    { teamId: 2, team: 'Beta Team', count: 3, open: 1 },
    { teamId: null, team: null, count: 2, open: 1 },
  ],
  byAgent: [
    { agentId: 1, agent: 'Agent One', count: 3, open: 2 },
    { agentId: null, agent: null, count: 2, open: 1 },
  ],
  current: {
    byState: [
      { state: 'NEW', count: 2 },
      { state: 'IN_PROGRESS', count: 2 },
      { state: 'RESOLVED', count: 3 },
      { state: 'CLOSED', count: 1 },
    ],
    open: 4,
    unassigned: 1,
    overdue: 1,
  },
  sla: {
    totals: {
      total: 3, met: 2, rate: 67,
      response: { applicable: 3, breached: 1, avgMs: 1.5 * HOUR, count: 3 },
      resolution: { applicable: 3, breached: 1, avgMs: 17 * HOUR, count: 3, avgTargetMs: 24 * HOUR },
      live: { openCycles: 4, responseBreaches: 1, resolutionBreaches: 1, approaching: 1 },
      sources: { live: { total: 2, met: 2, rate: 100 }, backfill: { total: 1, met: 0, rate: 0 } },
    },
  },
};

/* ---- range helpers are the shared SLA-report ones ---------------------- */
eq('range query builder is the shared implementation',
  buildReportQuery({ from: '2026-09-07', to: '2026-09-01' }).error,
  'The start date must be on or before the end date');
eq('range label is the shared implementation', rangeLabel(REPORT.range), '2026-09-01 → 2026-09-04');
eq('all-time label', rangeLabel({ from: null, to: null }), 'All time');

/* ---- KPI cards ---------------------------------------------------------- */
const cards = reportKpiCards(REPORT);
eq('four range cards', cards.length, 4);
eq('created value', cards[0].value, 6);
eq('resolved value with share note', cards[1].value === 3 && cards[1].note.includes('3 of 6'), true);
eq('avg resolution uses the shared formatter', cards[2].value, '16h');
eq('first response formatted', cards[3].value, '2h 30m');
check('first response sub carries the rate', cards[3].sub.includes('33%'));

const emptyCards = reportKpiCards({ totals: {} });
check('empty payload renders dashes, never NaN',
  emptyCards[2].value === null && emptyCards[3].value === null &&
  emptyCards[0].value === 0 && emptyCards[1].value === 0);
eq('empty first-response note', emptyCards[3].note, 'No first-response data in range');

/* ---- volume rows --------------------------------------------------------- */
const volume = volumeRows(REPORT.volume);
eq('busiest day is the 100% bar', volume[1].createdPct, 100);
eq('quieter days scale against the same max', volume[0].createdPct, 67);
eq('resolved scaling', volume[2].resolvedPct, 67);
eq('zero resolved bar', volume[0].resolvedPct, 0);
eq('missing volume renders no rows', volumeRows(undefined).length, 0);
eq('all-zero volume guards the divide', volumeRows([{ day: 'd', created: 0, resolved: 0 }])[0].createdPct, 0);

/* ---- distributions -------------------------------------------------------- */
const status = distributionRows(REPORT.byStatus);
eq('status shares are clamped percentages', status[1].share, 33);
check('status shares total ~100', status.reduce((n, r) => n + r.share, 0) >= 99 && status.reduce((n, r) => n + r.share, 0) <= 101);
const priority = distributionRows(REPORT.byPriority);
eq('moderate carries the legacy medium share', priority[1].share, 50);
eq('empty distribution renders no rows', distributionRows(undefined).length, 0);

/* ---- group / agent attribution -------------------------------------------- */
const groups = groupRows(REPORT.byGroup);
eq('named group passes through', groups[0].name, 'Alpha Team');
eq('null group is labelled, not hidden', groups[2].name, 'No group');
const agents = agentRows(REPORT.byAgent);
eq('null agent is labelled, not hidden', agents[1].name, 'Unassigned');
eq('agent share math', agents[0].share, 60);
check('open sub-counts survive', groups[0].open === 2 && agents[0].open === 2);

/* ---- current snapshot cards ------------------------------------------------ */
const snapshot = currentCards(REPORT.current);
eq('open card value', snapshot[0].value, 4);
eq('open card splits NEW vs in progress', `${snapshot[0].segments[0].pct}/${snapshot[0].segments[1].pct}`, '50/50');
eq('unassigned card', snapshot[1].value, 1);
eq('overdue card tone', snapshot[2].tone, 'critical');
check('snapshot notes flag it as live', snapshot.every((c) => c.note.includes('date range') || c.note.includes('claim')));

/* ---- SLA summary ------------------------------------------------------------ */
const sla = slaSummary(REPORT.sla);
eq('compliance comes straight from the SLA service', sla.compliance, '67%');
eq('met/total pass through', sla.met === 2 && sla.total === 3, true);
eq('completed breaches pass through', sla.responseBreached === 1 && sla.resolutionBreached === 1, true);
check('working-time averages formatted by the shared formatter',
  sla.avgResponse === '1h 30m' && sla.avgResolution === '17h');
eq('live figures sum the two breach clocks', sla.liveBreaches, 2);
eq('live open/approaching pass through', sla.liveOpen === 4 && sla.liveApproaching === 1, true);
eq('source split rows reuse the SLA report implementation',
  sla.sources.map((s) => s.key).join(','), 'live,backfill');
const emptySla = slaSummary(null);
check('missing SLA payload degrades to zeros and nulls',
  emptySla.compliance === null && emptySla.total === 0 && emptySla.liveOpen === 0 && emptySla.avgResponse === null);

/* ---- hasRangeData ------------------------------------------------------------ */
check('range with activity is reportable', hasRangeData(REPORT));
check('empty range shows the empty state',
  !hasRangeData({ totals: { created: 0, resolved: 0 } }) && !hasRangeData(null));

console.log(failures === 0 ? 'reports-check: ALL PASS' : `reports-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
