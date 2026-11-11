import { STATES } from './constants.js';

export const PAGE_SIZE = 25;
export const EMPTY_FILTERS = { view: '', status: '', priority: '', category: '', group: '', agentId: '' };

/* The one-click questions an agent actually asks of the queue. The label and
   the empty-state copy live here; what each key MEANS is decided by the
   server (ticketReadService.queueWhere), so nothing on this side
   re-implements a filter — the client sends a name and reads the rows back. */
export const QUICK_VIEWS = [
  { key: 'mine', label: 'My open tickets', empty: 'Nothing open is assigned to you.' },
  { key: 'unassigned', label: 'Unassigned', empty: 'Every open ticket has an owner.' },
  { key: 'needs-response', label: 'Needs response', empty: 'Nobody is waiting on a reply.' },
  { key: 'sla-overdue', label: 'SLA overdue', empty: 'No open ticket is past its SLA target.' },
];

/* The active quick view, or undefined. One lookup, used by the control, the
   header line and the empty state so the three can never name it differently. */
export function activeQuickView(filters) {
  return QUICK_VIEWS.find((v) => v.key === filters?.view);
}

/* The API's `counts` block, normalised for rendering.
 *
 * The arithmetic is the server's — this only fills gaps so a tab never has to
 * print "undefined": every status gets a number, and `matching` is their sum,
 * which is what the "All" tab means (everything the other filters allow, with
 * no status restriction). `everything` is the whole table, the denominator
 * that lets the header say "12 of 240" instead of a bare "12" that could mean
 * either the filtered result or the queue.
 *
 * A missing or partial block reads as all zeroes rather than throwing: the
 * queue is useful without counts, so counts must never be able to break it. */
export function queueCounts(raw) {
  const byStatus = {};
  let matching = 0;
  for (const s of STATES) {
    const n = Number(raw?.byStatus?.[s.value]) || 0;
    byStatus[s.value] = n;
    matching += n;
  }
  const views = {};
  for (const v of QUICK_VIEWS) views[v.key] = Number(raw?.views?.[v.key]) || 0;
  return { byStatus, matching, views, everything: Number(raw?.all) || 0 };
}

/* Row density and the optional columns.
 *
 * The queue's secondary columns are all fixed-width, so the subject — the main
 * clue for deciding what to open — is whatever is left over. Compact drops the
 * columns you only need once you have already decided to look at a ticket, and
 * hands their width to the subject.
 *
 * "Last activity" is opt-in rather than default: the column beside it measures
 * when the ticket was CREATED, which is what its label now says, and the two
 * answer different questions. Someone working the queue usually wants the
 * second one; someone auditing intake wants the first. */
export const DENSITY_KEY = 'td_queue_density';
export const ACTIVITY_KEY = 'td_queue_activity';
export const DENSITIES = [
  { key: 'comfortable', label: 'Comfortable' },
  { key: 'compact', label: 'Compact' },
];

/** Which secondary columns are shown, given the density and the activity flag. */
export function queueColumns(density, showActivity = false) {
  const compact = density === 'compact';
  return {
    group: !compact,
    agent: !compact,
    // Created is what the default sort and the ticket's own age mean, so it
    // goes with the other secondary columns; Last activity is the extra.
    age: !compact,
    activity: !compact && Boolean(showActivity),
  };
}

/** The stored density, or the comfortable default. Never throws: storage can
 *  be blocked, and a blocked preference is not a reason to lose the queue. */
export function readDensity() {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function writeDensity(density) {
  try { localStorage.setItem(DENSITY_KEY, density); } catch { /* storage blocked */ }
}

export function readShowActivity() {
  try {
    return localStorage.getItem(ACTIVITY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeShowActivity(on) {
  try { localStorage.setItem(ACTIVITY_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
}

export const SORTS = {
  updated: { label: 'Last activity', dir: 'desc' },
  created: { label: 'Created', dir: 'desc' },
  priority: { label: 'Priority', dir: 'asc' },
  status: { label: 'Status', dir: 'asc' },
  ticket: { label: 'Ticket number', dir: 'asc' },
};
export function fromQuery(query) {
  return Object.fromEntries(Object.keys(EMPTY_FILTERS).map(key => [key,
    typeof query?.[key] === 'string' ? query[key] : '',
  ]));
}
export function queuePath(params) {
  return `/tickets/queue?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null))}`;
}
