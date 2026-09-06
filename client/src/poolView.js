/* Pure view-model for the assignment pool + availability state UI — no React,
   no DOM, so the assignment-pool-check.mjs harness can pin every rule the
   pages render. Mirrors the server's derivation in
   server/src/services/assignmentPoolService.js (the backend remains the only
   authority; this is display vocabulary only). */

export const AVAILABILITY_STATES = ['online', 'unavailable', 'offline'];

/** The one client-side derivation of an agent's availability state. */
export function availabilityStateOf(agent) {
  if (!agent || !agent.isActive) return 'offline';
  return agent.isAvailable ? 'online' : 'unavailable';
}

export const STATE_META = {
  online: { label: 'Online', dot: 'is-on', hint: 'Accepting new tickets' },
  unavailable: { label: 'Unavailable', dot: 'is-off', hint: 'Not accepting new tickets' },
  offline: { label: 'Offline', dot: 'is-offline', hint: 'Account offline — not receiving work' },
};

export function stateMeta(state) {
  return STATE_META[state] || STATE_META.offline;
}

const STATE_ORDER = { online: 0, unavailable: 1, offline: 2 };

/** Partition pool members into the three states, preserving server order. */
export function partitionByState(agents) {
  const out = { online: [], unavailable: [], offline: [] };
  for (const a of agents || []) {
    const state = a.availabilityState || availabilityStateOf(a);
    (out[state] || out.offline).push(a);
  }
  return out;
}

/** "2 of 5 online" — the one-line pool health sentence. */
export function poolSummaryLine(pool) {
  const p = pool && pool.pool;
  if (!p) return 'No agents in this pool';
  if (p.total === 0) return 'No agents in this pool';
  return `${p.online} of ${p.total} online`;
}

/** Grouped roster rows ready for rendering: one section per occupied state. */
export function rosterSections(agents) {
  const partitioned = partitionByState(agents);
  return AVAILABILITY_STATES.map((state) => ({
    state,
    meta: stateMeta(state),
    agents: partitioned[state],
  })).filter((section) => section.agents.length > 0);
}

export function loadLabel(count) {
  const n = Number(count) || 0;
  return n === 1 ? '1 open ticket' : `${n} open tickets`;
}

/** Short warning for a group whose automatic assignment would stall. */
export function poolWarning(pool) {
  if (!pool) return null;
  if (pool.pool.total === 0) return 'No agents belong to this group — tickets await manual assignment.';
  if (pool.pool.online === 0) return 'Nobody in this pool is online — automatic assignment will leave new tickets unassigned.';
  return null;
}
