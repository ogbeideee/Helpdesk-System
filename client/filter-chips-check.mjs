/* Unit checks for src/filterChipsView.js — the chips that keep a collapsed
   filter panel honest. Plain node, no framework, following the repo's
   check-script pattern (ticket-queue-check / sla-check).

   What this pins: one chip per active secondary filter, in a stable order; a
   value always has text to show, even when its option list has not loaded or
   the option no longer exists; and a filter key with no control of its own
   never grows a chip.

   Run: npm test  (from client/) */
import { filterChips } from './src/filterChipsView.js';

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

const GROUPS = [{ key: 'network', name: 'Network' }, { key: 'software', name: 'Software' }];
const AGENTS = [{ agentId: 7, name: 'Dare Adeyemi' }, { agentId: 9, name: 'Ada Okoro' }];
const ctx = { groups: GROUPS, agents: AGENTS };

/* ---- nothing set → no chips ------------------------------------------ */
eq('an empty filter set has no chips', filterChips({}, ctx).length, 0);
eq('undefined filters do not throw', filterChips(undefined, ctx).length, 0);
eq('missing lookup lists do not throw', filterChips({ priority: 'high' }).length, 1);

/* ---- one chip per set filter, in the panel's own order ---------------- */
eq('chips follow the panel order',
  filterChips({ priority: 'high', category: 'Hardware', group: 'network', agentId: '7' }, ctx)
    .map((c) => c.key).join(','),
  'priority,category,group,agentId');

const priority = filterChips({ priority: 'critical' }, ctx)[0];
eq('a priority chip is labelled and spelled out', `${priority.label} ${priority.text}`, 'Priority Critical');

const category = filterChips({ category: 'Inquiry / Help' }, ctx)[0];
eq('a category chip prints the category itself', category.text, 'Inquiry / Help');

const group = filterChips({ group: 'software' }, ctx)[0];
eq('a group chip resolves the display name, not the key', group.text, 'Software');

const agent = filterChips({ agentId: '9' }, ctx)[0];
eq('an agent chip resolves the name', agent.text, 'Ada Okoro');
eq('a numeric agent id still resolves', filterChips({ agentId: 7 }, ctx)[0].text, 'Dare Adeyemi');
eq('the unassigned pseudo-value is spelled out', filterChips({ agentId: 'unassigned' }, ctx)[0].text, 'Unassigned');

/* ---- a filter you cannot see is a filter you cannot remove ----------- */
eq('a group whose option list has not loaded still shows its key',
  filterChips({ group: 'network' }, { groups: [], agents: [] })[0].text, 'network');
eq('a deleted group still shows its stale key',
  filterChips({ group: 'retired' }, ctx)[0].text, 'retired');
eq('an unknown agent still shows its id',
  filterChips({ agentId: '404' }, ctx)[0].text, '404');
check('a chip is never blank',
  filterChips({ priority: 'x', category: 'y', group: 'z', agentId: 'q' }, ctx)
    .every((c) => c.text && c.text.length > 0));

/* ---- keys that have their own visible control never grow a chip ------ */
const viewAndStatus = filterChips({ view: 'mine', status: 'NEW', priority: 'high' }, ctx);
eq('a quick view is not a chip', viewAndStatus.some((c) => c.key === 'view'), false);
eq('a status is not a chip', viewAndStatus.some((c) => c.key === 'status'), false);
eq('only the secondary filter survives', viewAndStatus.length, 1);
eq('an unknown key never produces a chip', filterChips({ nonsense: 'x' }, ctx).length, 0);

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nfilter-chips-check: ALL PASS');
