import { PRIORITIES } from './constants.js';

/* The removable chips for the queue's secondary filters.
 *
 * Why chips at all: the filter panel is collapsed by default, so a filter set
 * days ago and forgotten is invisible — the queue just quietly looks emptier
 * than it is. A chip puts the value back on screen next to the rows it is
 * hiding, and removes it in one click.
 *
 * Only the SECONDARY filters get chips (priority, category, group, assigned
 * to). Status and the quick views have controls of their own that are always
 * visible in the strip above, so a chip for them would be a second copy of
 * something already on screen — the duplication people stop trusting.
 *
 * A value whose option list has not loaded, or which no longer exists (a
 * deleted group, a deactivated agent), still produces a chip showing the raw
 * value: a filter you cannot see is a filter you cannot remove. */

/** One chip per active secondary filter, in the order the panel lists them. */
export function filterChips(filters, { groups = [], agents = [] } = {}) {
  const f = filters || {};
  const chips = [];
  // `text` falls back to the raw value so a chip is never blank.
  const add = (key, label, text) => {
    if (f[key]) chips.push({ key, label, text: text || String(f[key]) });
  };
  add('priority', 'Priority', PRIORITIES.find((p) => p.value === f.priority)?.label);
  add('category', 'Category', f.category);
  add('group', 'Group', groups.find((g) => g.key === f.group)?.name);
  add(
    'agentId',
    'Assigned to',
    f.agentId === 'unassigned'
      ? 'Unassigned'
      : agents.find((a) => String(a.agentId) === String(f.agentId))?.name
  );
  return chips;
}
