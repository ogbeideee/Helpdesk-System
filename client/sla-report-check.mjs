/* Unit checks for src/slaReportView.js — the pure display model behind the
   admin SLA Reports page. Plain node, no framework, following the repo's
   check-script pattern. The fixture mirrors the numbers pinned by the server
   suite (scripts/test-sla-report.js), so the model is exercised against the
   exact payload the API returns: the model only formats and scales — every
   SLA figure arrives already computed.

   Run: node sla-report-check.mjs  (from client/) */
import {
  reportKpiCards, bucketRows, overTimeRows, sourceRows, hasReportData,
  buildReportQuery, rangeLabel, priorityLabel, pct,
} from './src/slaReportView.js';

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

const MIN = 60000;
const H = 60 * MIN;

/* The payload shape GET /api/sla/report returns for the server suite's final
   fixture state (4 completed cycles: 3 met; 1 backfilled breach; 2 open
   cycles, one approaching). */
const REPORT = {
  range: { from: null, to: null, generatedAt: '2026-09-10T12:30:00.000Z' },
  totals: {
    total: 4,
    met: 3,
    rate: 75,
    response: { applicable: 4, breached: 1, avgMs: 40 * MIN, count: 4, targetMs: 3600000 },
    resolution: { applicable: 4, breached: 1, avgMs: 12 * H, count: 4, avgTargetMs: Math.round((24 + 24 + 17 + 4) * H / 4) },
    live: { openCycles: 2, responseBreaches: 1, resolutionBreaches: 1, approaching: 1 },
    sources: { live: { total: 3, met: 3, rate: 100 }, backfill: { total: 1, met: 0, rate: 0 } },
  },
  byPriority: [
    { priority: 'low', total: 0, met: 0, rate: null, response: { applicable: 0, breached: 0, avgMs: null, count: 0 }, resolution: { applicable: 0, breached: 0, avgMs: null, count: 0, avgTargetMs: null } },
    { priority: 'moderate', total: 3, met: 2, rate: 67, response: { applicable: 3, breached: 1, avgMs: (30 * MIN + 90 * MIN + 20 * MIN) / 3, count: 3 }, resolution: { applicable: 3, breached: 1, avgMs: (4 * H + 27 * H + 15 * H) / 3, count: 3, avgTargetMs: Math.round((24 + 24 + 17) * H / 3) } },
    { priority: 'high', total: 0, met: 0, rate: null, response: { applicable: 0, breached: 0, avgMs: null, count: 0 }, resolution: { applicable: 0, breached: 0, avgMs: null, count: 0, avgTargetMs: null } },
    { priority: 'critical', total: 1, met: 1, rate: 100, response: { applicable: 1, breached: 0, avgMs: 20 * MIN, count: 1 }, resolution: { applicable: 1, breached: 0, avgMs: 2 * H, count: 1, avgTargetMs: 4 * H } },
  ],
  byGroup: [
    { teamId: 1, team: 'Service Desk', total: 3, met: 2, rate: 67, response: { applicable: 3, breached: 1, avgMs: 140 * MIN / 3, count: 3 }, resolution: { applicable: 3, breached: 1, avgMs: 46 * H / 3, count: 3, avgTargetMs: Math.round((24 + 24 + 17) * H / 3) } },
    { teamId: 2, team: 'Network Ops', total: 1, met: 1, rate: 100, response: { applicable: 1, breached: 0, avgMs: 20 * MIN, count: 1 }, resolution: { applicable: 1, breached: 0, avgMs: 2 * H, count: 1, avgTargetMs: 4 * H } },
  ],
  byAgent: [
    { agentId: 7, agent: 'Ada Report', total: 3, met: 2, rate: 67, response: { applicable: 3, breached: 1, avgMs: 140 * MIN / 3, count: 3 }, resolution: { applicable: 3, breached: 1, avgMs: 46 * H / 3, count: 3, avgTargetMs: 21 * H } },
    { agentId: 8, agent: 'Ben Report', total: 1, met: 1, rate: 100, response: { applicable: 1, breached: 0, avgMs: 20 * MIN, count: 1 }, resolution: { applicable: 1, breached: 0, avgMs: 2 * H, count: 1, avgTargetMs: 4 * H } },
  ],
  overTime: [
    { day: '2026-09-07', started: 4, completed: 2, met: 2, breached: 0 },
    { day: '2026-09-08', started: 1, completed: 0, met: 0, breached: 0 },
    { day: '2026-09-09', started: 0, completed: 1, met: 1, breached: 0 },
    { day: '2026-09-10', started: 2, completed: 1, met: 0, breached: 1 },
  ],
};

/* ---- helpers ----------------------------------------------------------- */
eq('priority labels are display names', priorityLabel('moderate'), 'Moderate');
eq('unknown priority passes through', priorityLabel('medium'), 'medium');
eq('pct clamps at 100', pct(5, 4), 100);
eq('pct of nothing is 0', pct(1, 0), 0);

/* ---- reportKpiCards: the six cards -------------------------------------- */
const { historical, live } = reportKpiCards(REPORT);
eq('three historical cards', historical.length, 3);
eq('three live cards', live.length, 3);

const compliance = historical[0];
eq('compliance value is the API rate', compliance.value, '75%');
eq('compliance sub counts met of total', compliance.sub, '3 of 4 completed cycles met');
eq('compliance meter met share', compliance.segments[0].pct, 75);
eq('compliance meter missed share', compliance.segments[1].pct, 25);

const firstResponse = historical[1];
eq('avg first response formatted by the shared formatter', firstResponse.value, '40m');
eq('avg first response share of the API-provided target', firstResponse.segments[0].pct, 67);
eq('avg first response note quotes the API target', firstResponse.note, 'Target 1h');
eq('avg first response sub counts answered and breached', firstResponse.sub, '4 answered · 1 breached');

const resolution = historical[2];
eq('avg resolution formatted', resolution.value, '12h');
eq('avg resolution share of recovered targets', resolution.segments[0].pct, 70);
eq('avg resolution note quotes the recovered target', resolution.note, 'Target 17h 15m');

const openCycles = live[0];
eq('open cycles value', openCycles.value, 2);
const breaches = live[1];
eq('live breaches sum both clocks', breaches.value, 2);
eq('live breaches sub splits the clocks', breaches.sub, 'Response 1 · Resolution 1');
eq('approaching value', live[2].value, 1);
check('every meter percentage is finite (no NaN reaches the DOM)',
  [...historical, ...live].every((c) => c.segments.every((s) => Number.isFinite(s.pct))));
check('tones use the existing card language',
  compliance.tone === 'ok' && firstResponse.tone === 'primary' && resolution.tone === 'info' &&
  openCycles.tone === 'primary' && breaches.tone === 'critical' && live[2].tone === 'warn');

/* ---- empty report: clean no-data state ---------------------------------- */
const EMPTY = {
  range: { from: null, to: null, generatedAt: 'x' },
  totals: {
    total: 0, met: 0, rate: null,
    response: { applicable: 0, breached: 0, avgMs: null, count: 0, targetMs: 3600000 },
    resolution: { applicable: 0, breached: 0, avgMs: null, count: 0, avgTargetMs: null },
    live: { openCycles: 0, responseBreaches: 0, resolutionBreaches: 0, approaching: 0 },
    sources: {},
  },
  byPriority: [], byGroup: [], byAgent: [], overTime: [],
};
const emptyCards = reportKpiCards(EMPTY);
eq('empty compliance renders an em dash', emptyCards.historical[0].value, null);
eq('empty compliance says so', emptyCards.historical[0].note, 'No completed cycles in range');
eq('empty averages render null (the card shows —)', emptyCards.historical[1].value, null);
eq('empty live breaches are a real zero', emptyCards.live[1].value, 0);
check('empty report has finite meters',
  emptyCards.historical.concat(emptyCards.live).every((c) => c.segments.every((s) => Number.isFinite(s.pct))));
eq('missing payload yields no cards', reportKpiCards(null).historical.length, 0);
eq('hasReportData false for the empty report', hasReportData(EMPTY), false);
eq('hasReportData true once cycles exist', hasReportData(REPORT), true);

/* ---- bucketRows: table rows --------------------------------------------- */
const groupRows = bucketRows(REPORT.byGroup, 'group');
eq('group row keeps the API name', groupRows[0].name, 'Service Desk');
eq('group rate formatted', groupRows[0].rate, '67%');
eq('group avg first response formatted', groupRows[0].avgResponse, '47m');
eq('group avg resolution formatted', groupRows[0].avgResolution, '15h 20m');
const priorityRows = bucketRows(REPORT.byPriority, 'priority');
eq('priority row uses display names', priorityRows[1].name, 'Moderate');
eq('null rate renders an em dash', priorityRows[0].rate, '—');
eq('null duration renders an em dash', priorityRows[0].avgResponse, '—');
eq('agent rows key on the agent id', bucketRows(REPORT.byAgent, 'agent')[0].key, 7);

/* ---- overTimeRows: chart bars ------------------------------------------- */
const chart = overTimeRows(REPORT);
eq('busiest day scales the bars (4 started Monday)', chart[0].startedPct, 100);
eq('Monday met bar is half the busiest day', chart[0].metPct, 50);
eq('Thursday started bar', chart[3].startedPct, 50);
eq('Thursday breached bar', chart[3].breachedPct, 25);
eq('quiet day keeps zero-width bars', chart[1].metPct, 0);
eq('empty overTime yields no rows', overTimeRows(EMPTY).length, 0);

/* ---- sourceRows: live vs backfill --------------------------------------- */
const sources = sourceRows(REPORT.totals.sources);
eq('live first, backfill second', sources.map((s) => s.key).join(','), 'live,backfill');
eq('live label', sources[0].label, 'Live cycles');
eq('backfill rate formatted', sources[1].rate, '0%');
eq('missing sources render nothing', sourceRows(undefined).length, 0);

/* ---- buildReportQuery: server-side filtering ---------------------------- */
eq('no dates → no query', buildReportQuery({}).query, '');
eq('from only', buildReportQuery({ from: '2026-09-01' }).query, 'from=2026-09-01');
eq('both dates', buildReportQuery({ from: '2026-09-01', to: '2026-09-30' }).query, 'from=2026-09-01&to=2026-09-30');
eq('empty strings are omitted', buildReportQuery({ from: '', to: '2026-09-30' }).query, 'to=2026-09-30');
eq('reversed range is rejected client-side', buildReportQuery({ from: '2026-09-30', to: '2026-09-01' }).ok, false);
check('reversed range explains why', /before/i.test(buildReportQuery({ from: '2026-09-30', to: '2026-09-01' }).error));
eq('equal bounds are fine', buildReportQuery({ from: '2026-09-01', to: '2026-09-01' }).ok, true);
eq('dates are trimmed', buildReportQuery({ from: ' 2026-09-01 ' }).query, 'from=2026-09-01');

/* ---- rangeLabel ---------------------------------------------------------- */
eq('no range reads all time', rangeLabel({ from: null, to: null }), 'All time');
eq('applied range reads from → to', rangeLabel({ from: '2026-09-07T00:00:00.000Z', to: '2026-09-10T23:59:59.000Z' }), '2026-09-07 → 2026-09-10');
eq('open-ended range', rangeLabel({ from: '2026-09-07T00:00:00.000Z', to: null }), '2026-09-07 → …');

process.exit(failures ? 1 : 0);
