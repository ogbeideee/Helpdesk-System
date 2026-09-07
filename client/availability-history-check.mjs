/* Agent Unavailability Timeline — pure view-model checks (no React, no DOM).
   Pins the rendering rules of availabilityHistoryView.js: durations,
   transition labels, the open-period treatment, source attribution and the
   per-agent summary line. Vocabulary is shared with poolView.js. */
import {
  AVAILABILITY_STATES, stateMeta, sourceMeta, formatDuration, formatStamp,
  transitionLabel, durationLabel, timelineRows, historySummary,
} from './src/availabilityHistoryView.js';
import { stateMeta as poolStateMeta } from './src/poolView.js';

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* --- shared vocabulary ---------------------------------------------------- */
eq('V1 exactly the three states exist',
  JSON.stringify(AVAILABILITY_STATES), JSON.stringify(['online', 'unavailable', 'offline']));
eq('V2 the timeline vocabulary is poolView\'s vocabulary',
  stateMeta('offline'), poolStateMeta('offline'));

/* --- durations ------------------------------------------------------------ */
eq('D1 sub-second reads as seconds', formatDuration(500), '0s');
eq('D2 forty-five seconds', formatDuration(45_400), '45s');
eq('D3 twelve and a half minutes', formatDuration(750_000), '12m 30s');
eq('D4 three and a quarter hours', formatDuration(11_700_000), '3h 15m');
eq('D5 two days and change', formatDuration(2 * 86_400_000 + 3 * 3_600_000), '2d 03h');
eq('D6 a missing duration reads as a dash', formatDuration(null), '—');
eq('D7 a nonsense duration reads as a dash', formatDuration('soon'), '—');
eq('D8 a negative duration reads as a dash', formatDuration(-5), '—');

/* --- timestamps ------------------------------------------------------------ */
eq('T1 no timestamp reads as a dash', formatStamp(null), '—');
eq('T2 a nonsense timestamp reads as a dash', formatStamp('whenever'), '—');
check('T3 a real timestamp renders digits',
  /\d/.test(formatStamp('2026-09-06T09:00:00.000Z')));

/* --- transition labels ------------------------------------------------------ */
eq('X1 a chain link reads "from → to"',
  transitionLabel({ state: 'unavailable', previousState: 'online' }), 'Online → Unavailable');
eq('X2 the offline link reads "Online → Offline"',
  transitionLabel({ state: 'offline', previousState: 'unavailable' }), 'Unavailable → Offline');
eq('X3 the first recorded period has no predecessor',
  transitionLabel({ state: 'online', previousState: null }), 'Started online');
eq('X4 an unknown state still renders something sane',
  transitionLabel({ state: 'mystery', previousState: 'online' }), 'Online → Offline');

/* --- the open period --------------------------------------------------------- */
const T0 = '2026-09-06T09:00:00.000Z';
const open = { id: 1, state: 'unavailable', previousState: 'online', startedAt: T0, endedAt: null, isOpen: true, actor: { id: 7, name: 'Ada' }, source: 'admin' };
const NOW = Date.parse('2026-09-06T10:30:00.000Z');
eq('O1 the open period renders live against now', durationLabel(open, NOW), '1h 30m');
eq('O2 a closed period uses the server duration',
  durationLabel({ ...open, isOpen: false, endedAt: '2026-09-06T10:00:00.000Z', durationMs: 3_600_000 }, NOW), '1h 00m');

/* --- source attribution -------------------------------------------------------- */
eq('S1 self-service reads "Self"', sourceMeta('self').label, 'Self');
eq('S2 admin action reads "Admin"', sourceMeta('admin').label, 'Admin');
eq('S3 an unknown source falls back to System', sourceMeta(undefined).label, 'System');

/* --- timeline rows --------------------------------------------------------------- */
const rows = timelineRows([
  open,
  { id: 2, state: 'online', previousState: 'unavailable', startedAt: T0, endedAt: '2026-09-06T10:00:00.000Z', isOpen: false, durationMs: 3_600_000, actor: { id: 7, name: 'Ada' }, source: 'self', agent: { id: 3, name: 'Mia' }, note: 'Marked available' },
], NOW);
eq('R1 two periods make two rows', rows.length, 2);
eq('R2 row 1 is the open one', rows[0].isOpen, true);
eq('R3 the open row has no end cell', rows[0].ended, null);
eq('R4 the closed row keeps its end', rows[1].ended !== null, true);
eq('R5 the wide feed carries the agent name', rows[1].agent, 'Mia');
eq('R6 the actor is surfaced', rows[0].actor, 'Ada');
eq('R7 the note travels with the row', rows[1].note, 'Marked available');
check('R8 rows carry the state dot vocabulary', rows.every((r) => typeof r.meta.dot === 'string'));
eq('R9 an empty history makes no rows', timelineRows([]).length, 0);
eq('R10 a missing history makes no rows', timelineRows(null).length, 0);
eq('R11 an actor-less period reads as System',
  timelineRows([{ ...open, actor: null }], NOW)[0].actor, 'System');

/* --- summary line ------------------------------------------------------------------- */
eq('U1 no history says so',
  historySummary({ availabilityState: 'online' }, [], NOW), 'Online · no recorded changes yet');
eq('U2 an open period reports how long in it',
  historySummary({ availabilityState: 'unavailable' }, [open], NOW), 'Unavailable · unavailable for 1h 30m');
eq('U3 a fully closed history counts the periods',
  historySummary({ availabilityState: 'online' }, [{ ...open, isOpen: false, endedAt: T0, durationMs: 1 }], NOW),
  'Online · 1 recorded period');
eq('U4 a missing agent reads as a dash state', historySummary(null, []), '— · no recorded changes yet');

console.log(`\n${failures === 0 ? `ALL ${passes} CHECKS PASSED` : `${failures} CHECK(S) FAILED, ${passes} passed`}`);
process.exitCode = failures === 0 ? 0 : 1;
