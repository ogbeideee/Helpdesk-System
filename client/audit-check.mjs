/* Unit checks for src/auditView.js — the pure display model behind the admin
   Audit Trail page. Plain node, no framework, following the repo's check
   script pattern. Fixtures mirror the API shape served by GET /api/audit
   (pinned by server/scripts/test-audit.js): the model only shapes and formats
   — filtering and pagination happen server-side.

   Run: node audit-check.mjs  (from client/) */
import {
  ENTITY_TYPES,
  entityTypeLabel,
  entityDisplay,
  displayValue,
  buildAuditQuery,
  isFiltered,
  eventRows,
  changePairs,
  metadataPairs,
  resultRange,
} from './src/auditView.js';

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

/* ---- the entity catalogue --------------------------------------------- */
check('all trail entity kinds are listed',
  ['Ticket', 'Comment', 'HandoverRequest', 'Agent', 'Team', 'RoutingRule', 'Setting', 'SlaHoliday']
    .every((t) => ENTITY_TYPES.includes(t)));
eq('known kinds get human labels', entityTypeLabel('HandoverRequest'), 'Handover');
eq('unknown kinds pass through untouched', entityTypeLabel('Widget'), 'Widget');
eq('missing kind renders a dash', entityTypeLabel(null), '—');

/* ---- entity display, including deleted entities ------------------------ */
eq('labelled entity renders type + label',
  entityDisplay({ entityType: 'Ticket', entityLabel: 'INC-000042' }), 'Ticket · INC-000042');
eq('label-less entity falls back to the id',
  entityDisplay({ entityType: 'Agent', entityId: 7 }), 'User #7');
eq('entity with neither label nor id still renders',
  entityDisplay({ entityType: 'Team' }), 'Assignment group');
check('empty entity renders a dash', entityDisplay({}) === '—' && entityDisplay(null) === '—');
// A deleted ticket's event survives with the label intact and ids nulled:
eq('deleted ticket keeps its readable reference',
  entityDisplay({ entityType: 'Ticket', entityLabel: 'INC-000010', entityId: null, ticketId: null }),
  'Ticket · INC-000010');

/* ---- value rendering --------------------------------------------------- */
eq('strings render verbatim', displayValue('INC-1'), 'INC-1');
eq('numbers render as strings', displayValue(60), '60');
eq('booleans render as strings', displayValue(false), 'false');
eq('objects render as compact JSON', displayValue({ a: 1 }), '{"a":1}');
eq('null renders empty', displayValue(null), '');

/* ---- buildAuditQuery: the filter draft becomes the server query -------- */
check('empty draft sends no parameters',
  JSON.stringify(buildAuditQuery({}).query) === '{}',
  JSON.stringify(buildAuditQuery({}).query));
check('whitespace-only drafts send nothing',
  JSON.stringify(buildAuditQuery({ action: '   ', actor: '' }).query) === '{}');
check('text filters pass through trimmed',
  JSON.stringify(buildAuditQuery({ action: ' ticket. ', actor: ' ada ' }).query) ===
  JSON.stringify({ action: 'ticket.', actor: 'ada' }));
check('entity type passes through',
  JSON.stringify(buildAuditQuery({ entityType: 'Setting' }).query) ===
  JSON.stringify({ entityType: 'Setting' }));

let verdict = buildAuditQuery({ from: '2026-09-01', to: '2026-09-07' });
check('date range becomes ISO bounds',
  verdict.ok && verdict.query.from === '2026-09-01T00:00:00.000Z' &&
  verdict.query.to === '2026-09-07T23:59:59.999Z');
verdict = buildAuditQuery({ from: '2026-09-07', to: '2026-09-01' });
eq('reversed range is rejected with the shared wording',
  verdict.error, 'The start date must be on or before the end date');
check('unparseable start date is rejected',
  !buildAuditQuery({ from: 'not-a-date' }).ok);
check('unparseable end date is rejected',
  !buildAuditQuery({ to: 'also-not-a-date' }).ok);
verdict = buildAuditQuery({ to: '2026-09-05' });
check('end date alone covers one calendar day',
  verdict.ok && verdict.query.to === '2026-09-05T23:59:59.999Z' && verdict.query.from === undefined);

/* ---- isFiltered drives the Clear button -------------------------------- */
eq('no filters, no clear', isFiltered({}), false);
check('any filter shows the clear action',
  isFiltered({ action: 'x' }) && isFiltered({ entityType: 'Ticket' }) &&
  isFiltered({ actor: 's' }) && isFiltered({ from: '2026-09-01' }) && isFiltered({ to: '2026-09-02' }));

/* ---- eventRows: table rows --------------------------------------------- */
const API_EVENT = {
  id: 12,
  createdAt: '2026-09-05T10:00:00.000Z',
  actorId: 3,
  actor: 'Ada Lovelace <ada@example.com>',
  action: 'ticket.priority_changed',
  entityType: 'Ticket',
  entityId: 42,
  entityLabel: 'INC-000042',
  ticketId: 42,
  from: { priority: 'moderate' },
  to: { priority: 'high' },
  description: 'INC-000042 priority changed from moderate to high',
  metadata: { slaTargetRecalculated: true },
};
const rows = eventRows([API_EVENT]);
eq('rows pass the event through once', rows.length, 1);
const row = rows[0];
eq('actor rendered with fallback', row.actor, 'Ada Lovelace <ada@example.com>');
eq('null actor falls back to system', eventRows([{ actor: null }])[0].actor, 'system');
eq('action prefix drives grouping', row.actionPrefix, 'ticket');
eq('entity display composed', row.entity, 'Ticket · INC-000042');
eq('description falls back to the action',
  eventRows([{ action: 'handover.accepted', description: null }])[0].description, 'handover.accepted');
eq('missing events array yields no rows', eventRows(undefined).length, 0);
eq('event ids survive for expansion keys', row.id, 12);

/* ---- changePairs: structured from/to ----------------------------------- */
eq('change pairs are keyed across both sides',
  JSON.stringify(changePairs(row)), '[{"key":"priority","from":"moderate","to":"high"}]');
const moved = eventRows([{
  ...API_EVENT, action: 'ticket.assigned',
  from: { assignedAgentId: null, assignedAgent: null },
  to: { assignedAgentId: 4, assignedAgent: 'Grace Hopper' },
}])[0];
check('absent and none-like values both read as the em-dash',
  JSON.stringify(changePairs(moved)) ===
  JSON.stringify([
    { key: 'assignedAgentId', from: '—', to: '4' },
    { key: 'assignedAgent', from: '—', to: 'Grace Hopper' },
  ]),
  JSON.stringify(changePairs(moved)));
check('no from/to means no change rows',
  changePairs(eventRows([{ from: null, to: null }])[0]).length === 0 &&
  changePairs(eventRows([{ from: 'a plain string', to: null }])[0]).length === 0);
const asymmetric = eventRows([{ from: null, to: { role: 'admin' } }])[0];
eq('creation-shaped events carry only the "to" side',
  JSON.stringify(changePairs(asymmetric)), '[{"key":"role","from":null,"to":"admin"}]');

/* ---- metadataPairs: structured metadata display ------------------------- */
eq('object metadata flattens to key/value pairs',
  JSON.stringify(metadataPairs(row)), '[{"key":"slaTargetRecalculated","value":"true"}]');
eq('string metadata becomes a single detail entry',
  JSON.stringify(metadataPairs(eventRows([{ metadata: 'handover note' }])[0])),
  '[{"key":"detail","value":"handover note"}]');
eq('nested values render as JSON, safely',
  JSON.stringify(metadataPairs(eventRows([{ metadata: { group: 'Audit Team', extra: { depth: [1, 2] } } }])[0])),
  '[{"key":"group","value":"Audit Team"},{"key":"extra","value":"{\\"depth\\":[1,2]}"}]');
check('absent metadata yields no pairs',
  metadataPairs(eventRows([{ metadata: null }])[0]).length === 0 &&
  metadataPairs(eventRows([{}])[0]).length === 0);

/* ---- resultRange: the pagination footer -------------------------------- */
eq('range math over a full middle page', resultRange({ page: 3, pageSize: 50, total: 243 }), '101–150 of 243');
eq('the last page is clamped to the total', resultRange({ page: 5, pageSize: 50, total: 243 }), '201–243 of 243');
eq('no results renders nothing', resultRange({ page: 1, pageSize: 50, total: 0 }), null);
eq('missing payload renders nothing', resultRange(null), null);

console.log(failures === 0 ? 'audit-check: ALL PASS' : `audit-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
