/* Unit checks for src/ticketQueueView.js — the queue's filter vocabulary.
   Plain node, no framework, following the repo's check-script pattern
   (sla-check / mobile-check).

   What this pins: the quick views are a closed, named set; a filter key that
   is absent from the URL reads as "not set" rather than undefined; and the
   request path carries the view the same way it carries every other filter.
   What it deliberately does NOT pin: what any quick view MEANS. That is a
   server rule (ticketReadService.queueWhere) and the client only ever sends
   the name.

   Run: npm test  (from client/) */
import {
  PAGE_SIZE, EMPTY_FILTERS, SORTS, QUICK_VIEWS, DENSITIES, activeQuickView, queueCounts,
  queueColumns, readDensity, writeDensity, readShowActivity, writeShowActivity, fromQuery, queuePath,
} from './src/ticketQueueView.js';

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

/* ---- quick views: the closed set the queue renders ------------------- */
eq('four quick views', QUICK_VIEWS.length, 4);
eq('the views are in the order they are read', QUICK_VIEWS.map((v) => v.key).join(','),
  'mine,unassigned,needs-response,sla-overdue');
check('every view is labelled', QUICK_VIEWS.every((v) => typeof v.label === 'string' && v.label.length > 0));
check('every view explains its own empty state',
  QUICK_VIEWS.every((v) => typeof v.empty === 'string' && v.empty.length > 0));
check('no view key collides with a plain status value',
  QUICK_VIEWS.every((v) => !['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(v.key)));

/* ---- activeQuickView: one lookup, so the control, the header and the
        empty state can never name the view differently ------------------ */
eq('no view selected', activeQuickView(EMPTY_FILTERS), undefined);
eq('undefined filters are tolerated', activeQuickView(undefined), undefined);
eq('an unknown view selects nothing', activeQuickView({ view: 'nope' }), undefined);
eq('a known view resolves to its entry', activeQuickView({ view: 'needs-response' }).label, 'Needs response');

/* ---- fromQuery: a filter key absent from the URL is empty, not undefined */
eq('view is part of the filter set', 'view' in EMPTY_FILTERS, true);
eq('an absent view reads as unset', fromQuery({}).view, '');
eq('an absent status reads as unset', fromQuery({}).status, '');
eq('a view in the URL is carried through', fromQuery({ view: 'mine' }).view, 'mine');
eq('an unknown URL key is ignored', Object.keys(fromQuery({ junk: 'x' })).includes('junk'), false);
eq('a non-string value is dropped', fromQuery({ view: 7 }).view, '');

/* ---- queuePath: the request carries only what is set ----------------- */
eq('an unfiltered queue asks for nothing', queuePath(EMPTY_FILTERS), '/tickets/queue?');
eq('the view rides in the path', queuePath({ ...EMPTY_FILTERS, view: 'unassigned' }),
  '/tickets/queue?view=unassigned');
eq('the page is carried', queuePath({ ...EMPTY_FILTERS, page: 2 }), '/tickets/queue?page=2');
eq('empty values are dropped, not sent as blanks',
  queuePath({ ...EMPTY_FILTERS, view: 'mine', status: '', priority: '' }), '/tickets/queue?view=mine');
eq('a view and a status never travel together from the UI',
  queuePath({ ...EMPTY_FILTERS, view: 'mine', status: 'CLOSED' }), '/tickets/queue?view=mine&status=CLOSED');

/* ---- sorts: the labels the column headers print --------------------- */
eq('sort keys are stable', Object.keys(SORTS).join(','), 'updated,created,priority,status,ticket');
eq('created is labelled for what it measures', SORTS.created.label, 'Created');
eq('page size is the API contract', PAGE_SIZE, 25);

/* ---- queueCounts: every tab has a number, counts never break the queue - */
const zero = queueCounts(null);
eq('a missing block is all zeroes, not a crash', zero.matching, 0);
eq('every status gets a number', Object.keys(zero.byStatus).join(','), 'NEW,IN_PROGRESS,RESOLVED,CLOSED');
eq('every view gets a number', Object.keys(zero.views).join(','), 'mine,unassigned,needs-response,sla-overdue');
eq('a missing block has no grand total', zero.everything, 0);

const partial = queueCounts({ byStatus: { NEW: 18 }, views: { unassigned: 7 }, all: 240 });
eq('a status the API left out reads as zero', partial.byStatus.CLOSED, 0);
eq('the statuses the API sent are carried', partial.byStatus.NEW, 18);
eq('All is the sum of the statuses', partial.matching, 18);
eq('a view count is carried', partial.views.unassigned, 7);
eq('a view the API left out reads as zero', partial.views.mine, 0);
eq('the grand total is the denominator the header needs', partial.everything, 240);

const full = queueCounts({
  byStatus: { NEW: 18, IN_PROGRESS: 12, RESOLVED: 5, CLOSED: 51 },
  views: { mine: 4, unassigned: 7, 'needs-response': 3, 'sla-overdue': 2 },
  all: 86,
});
eq('All sums every status', full.matching, 86);
eq('a partial block never renders undefined',
  Object.values(full.byStatus).every((n) => Number.isFinite(n)), true);
eq('junk counts fall back to zero rather than NaN',
  queueCounts({ byStatus: { NEW: 'lots' }, all: null }).matching, 0);

/* ---- density and the optional column: the subject pays for them ------ */
eq('two densities', DENSITIES.map((d) => d.key).join(','), 'comfortable,compact');
eq('comfortable shows every column',
  Object.values(queueColumns('comfortable')).join(','), 'true,true,true,false');
eq('compact drops the secondary columns',
  Object.values(queueColumns('compact')).join(','), 'false,false,false,false');
eq('an unknown density is comfortable, not column-less',
  Object.values(queueColumns('nonsense')).join(','), 'true,true,true,false');
eq('an unset density is comfortable',
  Object.values(queueColumns(undefined)).join(','), 'true,true,true,false');
eq('the subject is never one of the droppable columns',
  Object.keys(queueColumns('compact')).includes('subject'), false);

// Last activity is opt-in, and only where there is room for it.
eq('Last activity is off unless asked for',
  queueColumns('comfortable').activity, false);
eq('Last activity can be added', queueColumns('comfortable', true).activity, true);
eq('compact has no room for Last activity', queueColumns('compact', true).activity, false);

// No localStorage under plain node — a blocked preference must not throw, and
// must not stop the queue rendering.
eq('a blocked storage read falls back to comfortable', readDensity(), 'comfortable');
eq('a blocked activity read falls back to off', readShowActivity(), false);
check('a blocked storage write does not throw', (() => {
  try { writeDensity('compact'); writeShowActivity(true); return true; } catch { return false; }
})());

/* ---- the Created column says what it measures ------------------------ */
eq('the created sort is labelled for what it measures', SORTS.created.label, 'Created');
eq('the activity sort matches the column it drives', SORTS.updated.label, 'Last activity');
check('no sort is labelled "Age"',
  Object.values(SORTS).every((s) => s.label !== 'Age'));

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nticket-queue-check: ALL PASS');
