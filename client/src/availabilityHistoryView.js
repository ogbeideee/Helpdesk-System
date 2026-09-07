/* Pure view-model for the Agent Unavailability Timeline — no React, no DOM,
   so availability-history-check.mjs can pin every rendering rule. Vocabulary
   (state labels/dots) is imported from poolView.js, which mirrors the server's
   model; the period rows themselves come verbatim from the history API
   (server/src/services/availabilityHistoryService.js). */

import { AVAILABILITY_STATES, stateMeta } from './poolView.js';

export { AVAILABILITY_STATES, stateMeta };

export const SOURCE_META = {
  self: { label: 'Self', hint: 'The agent changed their own availability' },
  admin: { label: 'Admin', hint: 'An administrator changed the availability' },
};

export function sourceMeta(source) {
  return SOURCE_META[source] || { label: source || 'System', hint: '' };
}

const pad = (x) => String(x).padStart(2, '0');

/** Compact human duration: "45s", "12m 30s", "3h 05m", "2d 04h". */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${pad(h % 24)}h`;
}

/** Timestamp cell in the viewer's locale; '—' when there is nothing to show. */
export function formatStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Online → Unavailable"; the first recorded period has no predecessor. */
export function transitionLabel(period) {
  const to = stateMeta(period.state).label;
  if (!period.previousState) return `Started ${to.toLowerCase()}`;
  return `${stateMeta(period.previousState).label} → ${to}`;
}

/** Duration cell. The open period has no finished span: it renders live. */
export function durationLabel(period, now = Date.now()) {
  if (period.isOpen || !period.endedAt) {
    return formatDuration(now - new Date(period.startedAt).getTime());
  }
  return formatDuration(period.durationMs);
}

/** One row per period, newest first, ready for the timeline table. */
export function timelineRows(periods, now = Date.now()) {
  return (periods || []).map((p, i) => ({
    key: p.id ?? `p${i}`,
    agent: p.agent ? p.agent.name : '',
    state: p.state,
    meta: stateMeta(p.state),
    transition: transitionLabel(p),
    started: formatStamp(p.startedAt),
    ended: p.isOpen ? null : formatStamp(p.endedAt),
    isOpen: Boolean(p.isOpen),
    duration: durationLabel(p, now),
    actor: p.actor ? p.actor.name : 'System',
    source: sourceMeta(p.source).label,
    note: p.note || '',
  }));
}

/** One-line summary for a selected agent: current state + how long in it. */
export function historySummary(agent, periods = [], now = Date.now()) {
  const state = agent && agent.availabilityState
    ? stateMeta(agent.availabilityState).label
    : '—';
  if (!periods || periods.length === 0) {
    return `${state} · no recorded changes yet`;
  }
  const open = periods.find((p) => p.isOpen);
  if (open) {
    return `${state} · ${stateMeta(open.state).label.toLowerCase()} for ${formatDuration(now - new Date(open.startedAt).getTime())}`;
  }
  return `${state} · ${periods.length} recorded period${periods.length === 1 ? '' : 's'}`;
}
