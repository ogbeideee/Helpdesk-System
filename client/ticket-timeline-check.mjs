/* Pins every rule the ticket activity rail renders — the event model behind
   the conversation. Pure module, checked the same way the other client view
   modules are (plain node, no DOM).
   Usage: node ticket-timeline-check.mjs */

import {
  buildTimeline, classifyAuditEvent, prettyActor, slaTimelineEvent,
  eventMeta, isMessageKind, handoverMeta, activeHandover, EVENT_META,
} from './src/ticketTimelineView.js';

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
function list(name, actual, expected) {
  const a = (actual || []).map((v) => String(v));
  check(name, a.join(',') === expected.join(','), `expected [${expected}], got [${a}]`);
}

const at = (s) => new Date(s).toISOString();

/* ---- A. the vocabulary ---------------------------------------------- */

check('A1 every event kind has a class, a glyph and a label',
  Object.values(EVENT_META).every((m) => m.cls && m.glyph && m.label));

check('A2 conversation kinds get a bubble, system kinds do not',
  ['requester', 'update', 'internal', 'resolution'].every(isMessageKind)
  && !['status', 'assignment', 'handover', 'sla', 'closed', 'reopened', 'audit'].some(isMessageKind));

check('A3 an unknown kind falls back to the system marker, never crashes',
  eventMeta('nonsense').cls === EVENT_META.audit.cls);

check('A4 an SLA breach and an SLA warning are told apart',
  slaTimelineEvent({ type: 'breach' }).kind === 'sla-breach'
  && slaTimelineEvent({ type: 'approaching_breach' }).kind === 'sla-warn'
  && slaTimelineEvent({ type: 'target_created' }).kind === 'sla');

check('A5 an unknown SLA event type is skipped, not guessed at',
  slaTimelineEvent({ type: 'invented_later' }) === null);

check('A6 the SLA title names the clock it belongs to',
  slaTimelineEvent({ type: 'breach', clock: 'resolution' }).title === 'Resolution SLA breached');

check('A7 an unnamed clock still yields a usable SLA title',
  slaTimelineEvent({ type: 'breach', clock: 'nonsense' }).title === 'SLA breached');

check('A8 an SLA event with no detail carries no empty line',
  slaTimelineEvent({ type: 'target_created', detail: '' }).detail === null);

/* ---- B. audit-log classification ------------------------------------- */

/* A creation row never reaches the classifier from buildTimeline (it is
   filtered there), so this pins the classifier's own fallback rather than a
   path the rail uses. */
eq('B1 an unknown starting state is printed verbatim, never blanked',
  classifyAuditEvent({ fromState: null, toState: 'NEW' }).title, 'Status: null → New');
eq('B2 starting work is named as such',
  classifyAuditEvent({ fromState: 'NEW', toState: 'IN_PROGRESS' }).title, 'Started work');
eq('B3 resolving is a resolution marker',
  classifyAuditEvent({ fromState: 'IN_PROGRESS', toState: 'RESOLVED' }).kind, 'resolution');
eq('B4 closing is a closed marker',
  classifyAuditEvent({ fromState: 'RESOLVED', toState: 'CLOSED' }).kind, 'closed');
eq('B5 reopening from RESOLVED says where it came from',
  classifyAuditEvent({ fromState: 'RESOLVED', toState: 'IN_PROGRESS' }).title,
  'Reopened (Resolved → In Progress)');
eq('B6 reopening from CLOSED is the same marker',
  classifyAuditEvent({ fromState: 'CLOSED', toState: 'IN_PROGRESS' }).kind, 'reopened');
eq('B7 an unknown state pair still reads as a status line',
  classifyAuditEvent({ fromState: 'A', toState: 'B' }).title, 'Status: A → B');
eq('B8 a handover note is a handover event',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW', note: 'Handover requested to Ada' }).kind, 'handover');
eq('B9 a reassignment note is a reassignment event',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW', note: 'Reassigned from Ada — on leave' }).kind, 'reassign');
eq('B10 a group change is a group event',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW', note: 'Assignment group changed to Hardware' }).kind, 'group');
eq('B11 a claim is an assignment event',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW', note: 'Ticket claimed by Ada' }).kind, 'assignment');
eq('B12 an unreadable note is never dropped — it becomes a system entry',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW' }).title, 'Updated');
eq('B13 a note that is not a state change becomes the title, verbatim',
  classifyAuditEvent({ fromState: 'NEW', toState: 'NEW', note: 'Something happened' }).title, 'Something happened');

/* ---- C. actors ------------------------------------------------------- */

eq('C1 no actor is no actor', prettyActor(null), null);
eq('C2 the system is automation, not "system"', prettyActor('system'), 'automation');
eq('C3 an email address is trimmed off the name', prettyActor('Ada Lovelace <ada@example.com>'), 'Ada Lovelace');
eq('C4 a bare name passes through', prettyActor('Ada Lovelace'), 'Ada Lovelace');

/* ---- D. handovers ---------------------------------------------------- */

eq('D1 a pending handover reads as awaiting an answer', handoverMeta('PENDING').label, 'awaiting answer');
eq('D2 a queued handover reads as queued', handoverMeta('QUEUED').label, 'queued');
eq('D3 an accepted handover is an ok chip', handoverMeta('ACCEPTED').cls, 'chip-ok');
eq('D4 an unknown status is lowercased, never dropped',
  handoverMeta('SOMETHING').label, 'something');
eq('D5 the active handover is the live one', activeHandover([
  { id: 1, active: false }, { id: 2, active: true }, { id: 3, active: true },
])?.id, 2);
eq('D6 no handovers means no active one', activeHandover([]), null);
eq('D7 a missing list is safe', activeHandover(undefined), null);

/* ---- E. the assembled timeline --------------------------------------- */

const ticket = {
  id: 42,
  ticketNumber: 'INC-000042',
  requesterName: 'Ada',
  requesterEmail: 'ada@example.com',
  createdAt: '2026-09-20T08:00:00.000Z',
  state: 'IN_PROGRESS',
  auditLogs: [
    // The creation row is drawn as the original message, so it is filtered.
    { id: 1, fromState: null, toState: 'NEW', createdAt: '2026-09-20T08:00:00.000Z' },
    { id: 2, fromState: 'NEW', toState: 'IN_PROGRESS', createdAt: '2026-09-20T09:30:00.000Z', note: 'Looking now' },
    { id: 3, fromState: 'NEW', toState: 'NEW', createdAt: '2026-09-20T10:00:00.000Z', note: 'Handover requested to Grace' },
  ],
  comments: [
    { id: 10, isInternal: false, isRequester: true, authorName: 'Ada', body: 'Still down', createdAt: '2026-09-20T11:00:00.000Z' },
    { id: 11, isInternal: true, authorName: 'Grace', body: 'Needs a part', createdAt: '2026-09-20T11:30:00.000Z' },
    { id: 12, isInternal: false, isRequester: true, authorName: null, authorEmail: 'ada@example.com', body: 'Any news?', createdAt: '2026-09-20T12:00:00.000Z' },
    { id: 13, isInternal: false, authorName: 'Grace', body: 'Fixed', createdAt: '2026-09-20T13:00:00.000Z' },
  ],
  attachments: [
    { id: 100, commentId: null, filename: 'photo.png' },
    { id: 101, commentId: 12, filename: 'error.png' },
    { id: 102, commentId: 12, filename: 'trace.log' },
    { id: 103, commentId: 11, filename: 'internal.txt' },
  ],
  slaEvents: [
    { id: 200, type: 'target_created', at: '2026-09-20T08:00:05.000Z' },
    { id: 201, type: 'approaching_breach', clock: 'response', at: '2026-09-20T08:50:00.000Z', detail: '10 minutes left' },
  ],
};

const tl = buildTimeline(ticket);

eq('E1 the creation row never appears on the rail',
  tl.some((e) => e.at === at('2026-09-20T08:00:00.000Z') && e.kind === 'status'), false);
check('E2 every event has a kind, a time and a title',
  tl.every((e) => e.kind && e.at && e.title));
check('E3 the rail is oldest first',
  tl.every((e, i) => i === 0 || new Date(tl[i - 1].at) <= new Date(e.at)));
eq('E4 a requester reply is a requester comment',
  tl.find((e) => e.title.startsWith('Requester reply'))?.kind, 'update');
eq('E5 an internal note is its own kind',
  tl.find((e) => e.detail === 'Needs a part')?.kind, 'internal');
eq('E6 an unnamed agent still gets a title',
  tl.find((e) => e.detail === 'Any news?')?.title, 'Requester reply — ada@example.com');
eq('E7 a named agent reads as the sender updating the requester',
  tl.find((e) => e.detail === 'Fixed')?.title, 'Grace updated the requester');
list('E8 each comment carries only its own attachments',
  tl.find((e) => e.detail === 'Any news?')?.attachments.map((a) => a.id), ['101', '102']);
eq('E9 a comment with no attachments carries an empty list, not undefined',
  tl.find((e) => e.detail === 'Still down')?.attachments.length, 0);
eq('E10 the SLA warning keeps the server detail',
  tl.find((e) => e.kind === 'sla-warn')?.detail, '10 minutes left');
eq('E11 a state change carries its note as the second line',
  tl.find((e) => e.kind === 'status' && e.title === 'Started work')?.detail, 'Looking now');
eq('E12 a handover note is the title, so it is not repeated as a detail',
  tl.find((e) => e.kind === 'handover')?.detail, null);
eq('E12b the handover title is the note verbatim',
  tl.find((e) => e.kind === 'handover')?.title, 'Handover requested to Grace');
eq('E13 an open ticket has no resolution event',
  tl.some((e) => e.kind === 'resolution'), false);

const resolved = {
  ...ticket,
  state: 'RESOLVED',
  resolvedAt: '2026-09-20T14:00:00.000Z',
  resolution: 'Replaced the part',
  auditLogs: [
    ...ticket.auditLogs,
    { id: 4, fromState: 'IN_PROGRESS', toState: 'RESOLVED', createdAt: '2026-09-20T14:00:00.000Z' },
  ],
};
const rtl = buildTimeline(resolved);
eq('E14 the RESOLVED transition carries the resolution text',
  rtl.find((e) => e.kind === 'resolution')?.detail, 'Replaced the part');
eq('E15 no duplicate "Resolved" entry is appended',
  rtl.filter((e) => e.kind === 'resolution').length, 1);

const resolvedNoAudit = { ...resolved, auditLogs: [] };
eq('E16 a missing audit entry still yields exactly one resolution',
  buildTimeline(resolvedNoAudit).filter((e) => e.kind === 'resolution').length, 1);

const resolvedWithNote = {
  ...resolved,
  auditLogs: [{ id: 4, fromState: 'IN_PROGRESS', toState: 'RESOLVED', createdAt: '2026-09-20T14:00:00.000Z', note: 'own note' }],
};
eq('E17 an existing note is not overwritten by the resolution text',
  buildTimeline(resolvedWithNote).find((e) => e.kind === 'resolution')?.detail, 'own note');
list('E18 the whole rail, oldest first',
  tl.map((e) => e.kind),
  ['sla', 'sla-warn', 'status', 'handover', 'update', 'internal', 'update', 'update']);

/* ---- F. degenerate input --------------------------------------------- */

eq('F1 no ticket yields no events', buildTimeline(null).length, 0);
eq('F2 a bare ticket yields no events', buildTimeline({ id: 1 }).length, 0);
eq('F3 null collections are safe', buildTimeline({
  id: 1, auditLogs: null, comments: null, attachments: null, slaEvents: null,
}).length, 0);

console.log(failures === 0 ? '\nticket-timeline-check: ALL PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
