/* Pure view-model for the Remote Access section of the ticket detail page —
   no React, no DOM, so remote-access-check.mjs can pin every rendering rule.
   Session rows come verbatim from the sessions API
   (server/src/services/remoteAccessService.js shapeSession); the backend
   remains the only authority on status and permissions — these helpers only
   mirror its rules for display, never decide them. */

import { formatDuration } from './availabilityHistoryView.js';

export { formatDuration };

export const SESSION_STATUSES = ['requested', 'active', 'ended', 'cancelled', 'expired'];

/* Pill classes reuse the existing SLA/state vocabulary so the card blends
   into the ticket design. */
export const STATUS_META = {
  requested: { label: 'Requested', pill: 'pill-sla-warn', hint: 'Waiting to be started' },
  active: { label: 'Active', pill: 'pill-sla', hint: 'Remote session in progress' },
  ended: { label: 'Ended', pill: 'pill-state-closed', hint: 'Session completed' },
  cancelled: { label: 'Cancelled', pill: 'pill-state-closed', hint: 'Session cancelled' },
  expired: { label: 'Expired', pill: 'pill-state-closed', hint: 'Request expired unstarted' },
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.expired;
}

/** A session still standing — it is the ticket's current session. */
export function isLive(session) {
  return Boolean(session && (session.status === 'requested' || session.status === 'active'));
}

/** The one live session of a ticket, if any (the API guarantees at most one). */
export function liveSession(sessions) {
  return (sessions || []).find(isLive) || null;
}

/**
 * Duration cell. A session only has a span once started: an active session
 * renders live ("12m 30s so far"); one cancelled or expired before it ever
 * started has no duration at all.
 */
export function durationLabel(session, now = Date.now()) {
  if (!session) return '—';
  if (session.status === 'active' && session.startedAt) {
    return `${formatDuration(now - new Date(session.startedAt).getTime())} so far`;
  }
  if (session.durationMs !== null && session.durationMs !== undefined) {
    return formatDuration(session.durationMs);
  }
  return '—';
}

/**
 * How the current status reads in one line: the ticket's remote-access state
 * at a glance, above the history.
 */
export function summaryLine(sessions) {
  const live = liveSession(sessions);
  if (live) {
    return live.status === 'active'
      ? `Remote session active — ${live.agent ? live.agent.name : 'an agent'} is connected`
      : `Remote session requested — waiting for ${live.agent ? live.agent.name : 'an agent'} to start it`;
  }
  const n = (sessions || []).length;
  if (n === 0) return 'No remote-access sessions on this ticket yet';
  return `No live session · ${n} ${n === 1 ? 'session' : 'sessions'} on record`;
}

/**
 * Minutes left before a pending request lapses (display only — the server
 * expires lazily on read and owns the truth). Null when not applicable.
 */
export function minutesLeft(session, now = Date.now()) {
  if (!session || session.status !== 'requested' || !session.expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(session.expiresAt).getTime() - now) / 60000));
}

/**
 * May `me` ask for a session on this ticket? Mirrors the service's
 * checkTicketAccess: open tickets only; an administrator, the assignee, or
 * anybody working an unassigned ticket. A user-role account never can.
 */
export function canRequest(ticket, me) {
  if (!ticket || !me) return false;
  if (!['NEW', 'IN_PROGRESS'].includes(ticket.state)) return false;
  if (me.role === 'admin') return true;
  if (me.role === 'user') return false;
  return !ticket.assignedAgentId || ticket.assignedAgentId === me.id;
}

/**
 * Which buttons this card may show for one session. Mirrors the service's
 * per-transition authorization exactly — the server still refuses anything
 * the UI gets wrong.
 */
export function allowedActions(session, me) {
  const out = { canStart: false, canEnd: false, canCancel: false };
  if (!session || !me) return out;
  const admin = me.role === 'admin';
  const isAgent = Boolean(session.agent && session.agent.id === me.id);
  const isRequester = Boolean(session.requestedBy && session.requestedBy.id === me.id);
  if (session.status === 'requested') {
    out.canStart = admin || isAgent;
    out.canCancel = admin || isAgent || isRequester;
  } else if (session.status === 'active') {
    out.canEnd = admin || isAgent;
    out.canCancel = admin || isAgent || isRequester;
  }
  return out;
}

/** One row per finished session, ready for the card's history list. */
export function historyRows(sessions) {
  return (sessions || [])
    .filter((s) => !isLive(s))
    .map((s) => ({
      id: s.id,
      status: s.status,
      statusLabel: statusMeta(s.status).label,
      pill: statusMeta(s.status).pill,
      agentName: s.agent ? s.agent.name : 'an agent',
      requestedAt: s.requestedAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      endReason: s.endReason || null,
      endedByName: s.endedBy ? s.endedBy.name : null,
    }));
}
