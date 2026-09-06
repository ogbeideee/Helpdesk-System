/* Assignment pool + availability state UI — pure view-model checks (no React,
   no DOM). Pins the client-side derivation and rendering rules of poolView.js,
   which mirror the server's model in assignmentPoolService.js. */
import {
  availabilityStateOf, stateMeta, partitionByState, poolSummaryLine,
  rosterSections, loadLabel, poolWarning, AVAILABILITY_STATES,
} from './src/poolView.js';

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* --- state derivation (mirrors the server) -------------------------------- */
eq('S1 active+available is online', availabilityStateOf({ isActive: true, isAvailable: true }), 'online');
eq('S2 active+unavailable is unavailable', availabilityStateOf({ isActive: true, isAvailable: false }), 'unavailable');
eq('S3 inactive is offline', availabilityStateOf({ isActive: false, isAvailable: false }), 'offline');
eq('S4 inactive is offline regardless of the flag', availabilityStateOf({ isActive: false, isAvailable: true }), 'offline');
eq('S5 a missing agent reads as offline', availabilityStateOf(null), 'offline');
eq('S6 exactly three states exist', AVAILABILITY_STATES.length, 3);

/* --- display vocabulary ---------------------------------------------------- */
eq('L1 online reads Online', stateMeta('online').label, 'Online');
eq('L2 unavailable reads Unavailable', stateMeta('unavailable').label, 'Unavailable');
eq('L3 offline reads Offline', stateMeta('offline').label, 'Offline');
eq('L4 offline has its own hollow dot', stateMeta('offline').dot, 'is-offline');
eq('L5 an unknown state falls back to offline styling', stateMeta('nonsense').label, 'Offline');
check('L6 every state carries a hint', ['online', 'unavailable', 'offline'].every((s) => stateMeta(s).hint.length > 0));

/* --- partitioning ----------------------------------------------------------- */
const roster = [
  { id: 1, name: 'A', availabilityState: 'online' },
  { id: 2, name: 'B', availabilityState: 'offline' },
  { id: 3, name: 'C', availabilityState: 'online' },
  { id: 4, name: 'D', availabilityState: 'unavailable' },
];
const parts = partitionByState(roster);
eq('P1 two agents are online', parts.online.length, 2);
eq('P2 one agent is unavailable', parts.unavailable.length, 1);
eq('P3 one agent is offline', parts.offline.length, 1);
check('P4 server order is preserved inside a partition', parts.online.map((a) => a.id).join(','), '1,3');
const derived = partitionByState([{ id: 5, isActive: false }, { id: 6, isActive: true, isAvailable: true }]);
eq('P5 a missing state is derived from the columns', derived.offline[0].id, 5);
eq('P6 a null roster is safe', partitionByState(null).online.length, 0);

/* --- roster sections ---------------------------------------------------------- */
const sections = rosterSections(roster);
eq('R1 only occupied states render', sections.length, 3);
check('R2 sections appear online-first', sections[0].state === 'online' && sections[2].state === 'offline');
eq('R3 an empty roster renders nothing', rosterSections([]).length, 0);

/* --- summaries ------------------------------------------------------------------- */
eq('W1 the pool sentence counts online of total', poolSummaryLine({ pool: { total: 5, online: 2 } }), '2 of 5 online');
eq('W2 an empty pool says so plainly', poolSummaryLine({ pool: { total: 0, online: 0 } }), 'No agents in this pool');
eq('W3 a missing pool is safe', poolSummaryLine(null), 'No agents in this pool');

eq('T1 singular load label', loadLabel(1), '1 open ticket');
eq('T2 plural load label', loadLabel(3), '3 open tickets');
eq('T3 zero load label', loadLabel(0), '0 open tickets');

/* --- pool warnings ------------------------------------------------------------------ */
eq('N1 no members warns about manual assignment',
  poolWarning({ pool: { total: 0, online: 0 } }), 'No agents belong to this group — tickets await manual assignment.');
check('N2 nobody online warns about automatic assignment',
  /unassigned/.test(poolWarning({ pool: { total: 3, online: 0 } })));
eq('N3 a healthy pool warns about nothing', poolWarning({ pool: { total: 3, online: 1 } }), null);
eq('N4 a missing pool warns about nothing', poolWarning(null), null);

console.log(passes === 0 || failures > 0 ? `\n${failures} FAILURE(S)` : `\nALL PASS (${passes} checks)`);
process.exit(failures === 0 ? 0 : 1);
