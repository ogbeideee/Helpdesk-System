/* Unit checks for src/slaView.js and src/slaKpis.js — the pure display models
   that turn backend-provided SLA state into UI. Plain node, no framework,
   following the repo's existing check-script pattern (live-check / ssr-check).
   These tests pin the contract the components rely on: statuses, remainingMs
   and the KPI figures are read verbatim from the backend and nothing
   SLA-related is derived here.

   Run: npm test  (from client/) */
import { fmtRemaining, clockView, slaOverview, cycleSummary } from './src/slaView.js';
import { slaKpiCards } from './src/slaKpis.js';

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

/* ---- fmtRemaining: formatting a backend-provided duration ------------ */
eq('null stays null', fmtRemaining(null), null);
eq('sub-minute', fmtRemaining(0), 'under a minute');
eq('minutes', fmtRemaining(45 * 60000), '45m');
eq('hours + minutes', fmtRemaining(90 * 60000), '1h 30m');
eq('whole hours', fmtRemaining(120 * 60000), '2h');
eq('long spans stay in hours (working time ≠ days)', fmtRemaining(30 * 3600000), '30h');

/* ---- clockView: response lifecycle, statuses verbatim from flags ----- */
const base = { dueAt: '2026-09-07T09:00:00Z', remainingMs: 45 * 60000, approaching: false, breached: false, responded: false };
eq('open + untouched = on track', clockView(base, false).status, 'on-track');
eq('approaching flag → warn tone', clockView({ ...base, approaching: true }, false).tone, 'warn');
eq('approaching text', clockView({ ...base, approaching: true }, false).text, 'Approaching breach');
eq('breached flag → breached', clockView({ ...base, breached: true, remainingMs: null }, false).status, 'breached');
eq('answered = ok', clockView({ ...base, responded: true }, false).text, 'Answered on time');
eq('answered late = bad', clockView({ ...base, responded: true, breached: true }, false).short, 'Late');
eq('ended after the clock ran out = missed', clockView({ ...base, breached: true }, true).status, 'missed');
eq('ended before the clock ran out = not needed', clockView(base, true).text, 'Not needed');
eq('ended resolution that was met = Met', clockView(base, true, 'resolution').text, 'Met');
eq('ended missed resolution = Missed', clockView({ ...base, breached: true }, true, 'resolution').text, 'Missed');
eq('no applicable target = muted, no invented state', clockView({ dueAt: null }, false).status, 'no-target');

/* ---- slaOverview: badge picks the worst clock ------------------------ */
const okBlock = { dueAt: 1, remainingMs: 45 * 60000, approaching: false, breached: false, responded: false };
const approaching = { ...okBlock, approaching: true };
const breached = { ...okBlock, breached: true, remainingMs: null };
const mk = (response, resolution, slaExtra = {}, ticketExtra = {}) => ({
  id: 1,
  state: 'NEW',
  overdue: false,
  ...ticketExtra,
  sla: {
    cycleNumber: 1,
    cycleStartedAt: 1,
    cycleEndedAt: null,
    response,
    resolution,
    cycles: [],
    ...slaExtra,
  },
});

eq('ticket without sla → null (legacy path)', slaOverview({ id: 1, state: 'NEW' }), null);
eq('badge reads the nearest due clock', slaOverview(mk(okBlock, { dueAt: 2, remainingMs: 3 * 3600000, approaching: false, breached: false })).badge.text, 'SLA due in 45m');
eq('approaching → warn badge', slaOverview(mk(approaching, okBlock)).badge.tone, 'warn');
eq('breached response wins the badge', slaOverview(mk(breached, okBlock)).badge.text, 'SLA breached');
eq('breached resolution wins the badge', slaOverview(mk(okBlock, breached)).badge.text, 'SLA breached');
eq('ended clean cycle → SLA met', slaOverview(mk(okBlock, okBlock, { cycleEndedAt: 9 })).badge.text, 'SLA met');
eq('ended breached cycle → SLA breached', slaOverview(mk(breached, breached, { cycleEndedAt: 9 })).badge.text, 'SLA breached');
eq('remaining time flows into the detail text', slaOverview(mk(approaching, okBlock)).response.text, 'Approaching breach — 45m working time left');
eq('cycle number is surfaced', slaOverview(mk(okBlock, okBlock, { cycleNumber: 3 })).cycleNumber, 3);

/* ---- cycleSummary: per-cycle outcomes from latched flags ------------- */
eq('answered on time', cycleSummary({ firstResponseAt: 1, responseBreached: false, resolutionBreached: false }).response, 'Answered');
eq('answered late', cycleSummary({ firstResponseAt: 1, responseBreached: true, resolutionBreached: false }).response, 'Answered late');
eq('never answered, clock ran out', cycleSummary({ responseBreached: true, resolutionBreached: true }).response, 'Missed');
eq('resolution met', cycleSummary({ responseBreached: false, resolutionBreached: false }).resolution, 'Met');
eq('resolution missed', cycleSummary({ responseBreached: false, resolutionBreached: true }).resolution, 'Missed');

/* ---- slaKpiCards: dashboard figures verbatim from the API block ------- */

// No sla block at all → the whole row stays hidden.
eq('missing block renders no cards', slaKpiCards(null).length, 0);
eq('undefined block renders no cards', slaKpiCards(undefined, 0).length, 0);

// All-zero block: clean empty states, no invented percentages.
const emptyBlock = {
  compliance: { met: 0, total: 0, rate: null },
  breaches: { response: 0, resolution: 0, responseApplicable: 0, resolutionApplicable: 0 },
  approachingTickets: 0,
  avgFirstResponseMs: null,
  firstResponseCount: 0,
  avgResolutionMs: null,
  resolutionCount: 0,
  avgResolutionTargetMs: null,
  responseTargetMs: 3600000,
};
const empty = slaKpiCards(emptyBlock, 0);
eq('six cards for a valid block', empty.length, 6);
eq('no-data compliance shows a dash', empty[0].value, null);
eq('no-data compliance note', empty[0].note, 'No completed cycles yet');
eq('no-data compliance has an empty meter', empty[0].segments.length, 0);
eq('no applicable cycles → dash, not zero', empty[1].value, null);
eq('no-data breach note', empty[1].note, 'No SLA cycles yet');
eq('approaching is a real zero', empty[3].value, 0);
eq('no open tickets note', empty[3].note, 'No open tickets');
eq('no responses → dash average', empty[4].value, null);
eq('no responses note', empty[4].note, 'No responses recorded yet');
eq('no resolutions → dash average', empty[5].value, null);

// Populated block: values, shares and proportions straight from the numbers.
const full = slaKpiCards(
  {
    compliance: { met: 3, total: 4, rate: 75 },
    breaches: { response: 2, resolution: 1, responseApplicable: 10, resolutionApplicable: 8 },
    approachingTickets: 2,
    avgFirstResponseMs: 30 * 60000,
    firstResponseCount: 9,
    avgResolutionMs: 90 * 60000,
    resolutionCount: 4,
    avgResolutionTargetMs: 24 * 3600000,
    responseTargetMs: 3600000,
  },
  5
);
eq('compliance rate rendered as percent', full[0].value, '75%');
eq('compliance note counts cycles', full[0].note, '3 of 4 completed cycles met');
eq('compliance meter has met and missed segments', full[0].segments.length, 2);
eq('met segment share', full[0].segments[0].pct, 75);
eq('missed segment share', full[0].segments[1].pct, 25);
eq('breach count verbatim', full[1].value, 2);
eq('breach rate share', full[1].segments[0].pct, 20);
eq('resolution breach share', full[2].segments[0].pct, Math.round((1 / 8) * 100));
eq('approaching share of the open queue', full[3].segments[0].pct, 40);
eq('approaching note', full[3].note, '40% of the open queue');
eq('average first response uses working-time formatting', full[4].value, '30m');
eq('response average as a share of the target', full[4].segments[0].pct, 50);
eq('response sample note', full[4].note, 'Across 9 answered cycles');
eq('average resolution uses working-time formatting', full[5].value, '1h 30m');
eq('resolution average as a share of the average target', full[5].segments[0].pct, Math.round((90 / 1440) * 100));
eq('resolution sample note', full[5].note, 'Across 4 completed cycles');

// Proportions clamp at 100% instead of overfilling the meter.
const clamped = slaKpiCards(
  { ...emptyBlock, avgFirstResponseMs: 3 * 3600000, firstResponseCount: 1, responseTargetMs: 3600000 },
  0
);
eq('average over the target clamps the meter', clamped[4].segments[0].pct, 100);
eq('singular sample note', clamped[4].note, 'Across 1 answered cycle');

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nsla-check: ALL PASS');
