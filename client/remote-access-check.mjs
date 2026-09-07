/* Pins every rule the Remote Access card renders — mirrors of the server's
   rules in remoteAccessView.js, checked the same way the other client view
   modules are (plain node, no DOM). Usage: node remote-access-check.mjs */

import {
  SESSION_STATUSES, STATUS_META, statusMeta, isLive, liveSession,
  durationLabel, summaryLine, minutesLeft, canRequest, allowedActions, historyRows,
} from './src/remoteAccessView.js';

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

const NOW = new Date('2026-09-07T12:00:00.000Z').getTime();
const ISO = (ms) => new Date(ms).toISOString();
const M = 60_000;

const meAgent = { id: 7, role: 'agent' };
const meAdmin = { id: 9, role: 'admin' };
const meUser = { id: 5, role: 'user' };
const openTicket = { state: 'NEW', assignedAgentId: 7 };
const unassigned = { state: 'NEW', assignedAgentId: null };
const closedTicket = { state: 'CLOSED', assignedAgentId: 7 };
const resolvedTicket = { state: 'RESOLVED', assignedAgentId: 7 };

/* ---- vocabulary ---- */
eq('V1 the five statuses exist', JSON.stringify(SESSION_STATUSES),
  JSON.stringify(['requested', 'active', 'ended', 'cancelled', 'expired']));
for (const s of SESSION_STATUSES) {
  check(`V2 ${s} has meta (label + pill)`, Boolean(STATUS_META[s]?.label && STATUS_META[s]?.pill));
}
eq('V3 an unknown status falls back to expired', statusMeta('weird').label, 'Expired');

/* ---- isLive / liveSession ---- */
eq('L1 requested is live', isLive({ status: 'requested' }), true);
eq('L2 active is live', isLive({ status: 'active' }), true);
for (const s of ['ended', 'cancelled', 'expired']) {
  eq(`L3 ${s} is not live`, isLive({ status: s }), false);
}
eq('L4 liveSession picks the one live row', liveSession([
  { id: 1, status: 'ended' }, { id: 2, status: 'requested' },
]).id, 2);
eq('L5 liveSession of nothing is null', liveSession([]), null);

/* ---- durationLabel ---- */
const DUR = {
  id: 1, status: 'ended', startedAt: ISO(NOW - 30 * M), endedAt: ISO(NOW - 10 * M),
  durationMs: 20 * M,
};
eq('D1 an ended session shows its exact duration', durationLabel(DUR, NOW), '20m 00s');
eq('D2 an active session counts live', durationLabel({
  id: 2, status: 'active', startedAt: ISO(NOW - 90 * M), endedAt: null, durationMs: null,
}, NOW), '1h 30m so far');
eq('D3 a requested session has no duration', durationLabel({
  id: 3, status: 'requested', startedAt: null, endedAt: null, durationMs: null,
}, NOW), '—');
eq('D4 a cancel-before-start has no duration', durationLabel({
  id: 4, status: 'cancelled', startedAt: null, endedAt: ISO(NOW), durationMs: null,
}, NOW), '—');
eq('D5 an expired request has no duration', durationLabel({
  id: 5, status: 'expired', startedAt: null, endedAt: ISO(NOW), durationMs: null,
}, NOW), '—');
eq('D6 a cancelled-after-start keeps its span', durationLabel({
  id: 6, status: 'cancelled', startedAt: ISO(NOW - 5 * M), endedAt: ISO(NOW - M), durationMs: 4 * M,
}, NOW), '4m 00s');

/* ---- summaryLine ---- */
eq('S1 no sessions at all', summaryLine([]), 'No remote-access sessions on this ticket yet');
eq('S2 a live active session', summaryLine([
  { status: 'active', agent: { name: 'Ria' } },
]), 'Remote session active — Ria is connected');
eq('S3 a live request', summaryLine([
  { status: 'requested', agent: { name: 'Theo' } },
]), 'Remote session requested — waiting for Theo to start it');
eq('S4 history only', summaryLine([{ status: 'ended' }, { status: 'cancelled' }]),
  'No live session · 2 sessions on record');
eq('S5 singular history', summaryLine([{ status: 'ended' }]), 'No live session · 1 session on record');

/* ---- minutesLeft ---- */
eq('M1 a pending request has minutes left', minutesLeft({
  status: 'requested', expiresAt: ISO(NOW + 12.4 * M),
}, NOW), 13);
eq('M2 a lapsed request clamps at zero', minutesLeft({
  status: 'requested', expiresAt: ISO(NOW - 5 * M),
}, NOW), 0);
eq('M3 a started session has no countdown', minutesLeft({ status: 'active' }, NOW), null);

/* ---- canRequest ---- */
eq('R1 the assignee may request', canRequest(openTicket, meAgent), true);
eq('R2 an admin may always request', canRequest(openTicket, meAdmin), true);
eq('R3 another agent may not', canRequest(openTicket, { id: 8, role: 'agent' }), false);
eq('R4 a user-role account never may', canRequest(unassigned, meUser), false);
eq('R5 an unassigned open ticket is requestable', canRequest(unassigned, meAgent), true);
eq('R6 a closed ticket is not', canRequest(closedTicket, meAgent), false);
eq('R7 a resolved ticket is not', canRequest(resolvedTicket, meAgent), false);
eq('R8 nothing without a ticket', canRequest(null, meAgent), false);

/* ---- allowedActions ---- */
const requested = { status: 'requested', agent: { id: 7 }, requestedBy: { id: 7 } };
const active = { status: 'active', agent: { id: 7 }, requestedBy: { id: 9 } };
const ended = { status: 'ended', agent: { id: 7 }, requestedBy: { id: 7 } };
const expired = { status: 'expired', agent: { id: 7 }, requestedBy: { id: 7 } };

let a = allowedActions(requested, meAgent);
check('A1 the session agent may start a request', a.canStart && !a.canEnd && a.canCancel);
a = allowedActions(requested, meAdmin);
check('A2 an admin may start a request', a.canStart && a.canCancel);
a = allowedActions(requested, { id: 9, role: 'agent' });
check('A3 an uninvolved agent may do nothing to a request', !a.canStart && !a.canEnd && !a.canCancel);
a = allowedActions(active, meAgent);
check('A4 the session agent may end or cancel', a.canEnd && a.canCancel && !a.canStart);
a = allowedActions(active, meAdmin);
check('A5 an admin may end or cancel an active session', a.canEnd && a.canCancel);
a = allowedActions({ ...active, agent: { id: 8 }, requestedBy: { id: 8 } }, { id: 7, role: 'agent' });
check('A6 an uninvolved agent may not touch an active session', !a.canStart && !a.canEnd && !a.canCancel);
a = allowedActions(ended, meAgent);
check('A7 an ended session has no actions', !a.canStart && !a.canEnd && !a.canCancel);
a = allowedActions(ended, meAdmin);
check('A8 not even an admin may act on an ended session', !a.canStart && !a.canEnd && !a.canCancel);
a = allowedActions(expired, meAgent);
check('A9 an expired session has no actions', !a.canStart && !a.canEnd && !a.canCancel);
a = allowedActions({ ...requested, agent: { id: 8 }, requestedBy: { id: 9 } }, { id: 9, role: 'agent' });
check('A10 the requester may cancel a request they cannot start', !a.canStart && a.canCancel);
eq('A11 nothing without a session', JSON.stringify(allowedActions(null, meAgent)),
  JSON.stringify({ canStart: false, canEnd: false, canCancel: false }));

/* ---- historyRows ---- */
const rows = historyRows([
  { id: 12, status: 'ended', agent: { name: 'Ria' }, requestedAt: ISO(NOW - 60 * M), startedAt: ISO(NOW - 50 * M), endedAt: ISO(NOW - 30 * M), durationMs: 20 * M, endReason: 'done', endedBy: { name: 'Ria' } },
  { id: 11, status: 'active', agent: { name: 'Live' }, requestedAt: ISO(NOW), startedAt: null, endedAt: null, durationMs: null },
  { id: 10, status: 'cancelled', agent: { name: 'Theo' }, requestedAt: ISO(NOW - 90 * M), startedAt: null, endedAt: ISO(NOW - 80 * M), durationMs: null, endReason: null, endedBy: null },
]);
eq('H1 live sessions stay out of the history', rows.length, 2);
eq('H2 newest finished session first', rows[0].id, 12);
eq('H3 the row carries the status label + pill', `${rows[0].statusLabel}/${rows[0].pill}`, 'Ended/pill-state-closed');
eq('H4 the agent name travels', rows[1].agentName, 'Theo');
eq('H5 the end reason travels', rows[0].endReason, 'done');
check('H6 a never-started row keeps its ISO stamps for the card',
  rows[1].startedAt === null && rows[1].requestedAt === ISO(NOW - 90 * M));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
