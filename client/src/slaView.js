/* Display model for the API's `sla` block — the single place the UI turns
   backend-provided SLA state into something to show.

   The rules live on the server. This module NEVER recomputes them: `breached`
   and `approaching` are read straight off the flags the API serialized,
   `remainingMs` is the backend-computed working time, and the only local
   arithmetic is formatting that number for display. When the display needs
   fresher numbers, the UI re-fetches from the API — it never derives them. */

const TONE_RANK = { muted: 0, ok: 1, warn: 2, bad: 3 };

/* Format a backend-provided working-time duration for display. Working time
   is what the server counts, so it is always shown as hours+minutes — never
   converted into days, which would silently equate a working day with 24h. */
export function fmtRemaining(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${hours}h`;
}

/* One SLA clock (response | resolution) as the UI should present it.

   `block`  — sla.response / sla.resolution from the API
   `ended`  — the cycle has ended (ticket resolved/closed)
   `clock`  — which clock this is; an ended cycle reads differently per clock
              (a met resolution is "Met", an unneeded response is "Not needed")
   Returns  — { status, tone, text, short } where `text` is the full wording
              for the detail panel and `short` the compact queue label. */
export function clockView(block, ended, clock = 'response') {
  const b = block || {};
  if (b.responded) {
    // The response clock is frozen at the recorded first response.
    return b.breached
      ? { status: 'answered-late', tone: 'bad', text: 'Answered late', short: 'Late' }
      : { status: 'answered', tone: 'ok', text: 'Answered on time', short: 'Answered' };
  }
  if (!b.dueAt) {
    // A cycle without an applicable target (e.g. a backfill stub) has nothing
    // to count down: show that plainly rather than inventing a state.
    return { status: 'no-target', tone: 'muted', text: 'No target', short: '—' };
  }
  if (ended) {
    return b.breached
      ? { status: 'missed', tone: 'bad', text: 'Missed', short: 'Missed' }
      : clock === 'resolution'
        ? { status: 'met', tone: 'ok', text: 'Met', short: 'Met' }
        : { status: 'not-needed', tone: 'muted', text: 'Not needed', short: '—' };
  }
  if (b.breached) {
    return { status: 'breached', tone: 'bad', text: 'Breached', short: 'Overdue' };
  }
  if (b.approaching) {
    return { status: 'approaching', tone: 'warn', text: 'Approaching breach', short: 'Approaching' };
  }
  return { status: 'on-track', tone: 'ok', text: 'On track', short: 'On track' };
}

/* The whole current-cycle SLA picture for a serialized ticket, or null when
   the ticket has no SLA cycles (created before the feature — the UI then
   falls back to the legacy dueAt display). */
export function slaOverview(ticket) {
  const sla = ticket?.sla;
  if (!sla) return null;
  const ended = sla.cycleEndedAt != null;
  const response = { key: 'response', label: 'Response SLA', ...clockView(sla.response, ended, 'response') };
  const resolution = { key: 'resolution', label: 'Resolution SLA', ...clockView(sla.resolution, ended, 'resolution') };
  for (const c of [response, resolution]) {
    // Detail text: the backend's remainingMs, verbatim, where it still runs.
    if (c.status === 'on-track' || c.status === 'approaching') {
      const left = fmtRemaining(sla[c.key]?.remainingMs);
      c.remaining = left;
      c.text = left ? `${c.text} — ${left} working time left` : c.text;
    }
  }
  const worst = [response, resolution].reduce(
    (w, c) => (TONE_RANK[c.tone] > TONE_RANK[w] ? c.tone : w),
    'muted'
  );
  return {
    cycleNumber: sla.cycleNumber,
    cycleStartedAt: sla.cycleStartedAt,
    cycleEndedAt: sla.cycleEndedAt,
    response,
    resolution,
    worst,
    // One-pill summary for the header. The queue's pill reads the same way.
    badge: badgeFor(worst, ended, sla, response, resolution),
  };
}

function badgeFor(worst, ended, sla, response, resolution) {
  if (worst === 'bad') return { tone: 'bad', text: 'SLA breached' };
  if (ended) return { tone: 'ok', text: 'SLA met' };
  if (worst === 'warn') {
    const left = nearestRemaining(sla, response, resolution);
    return { tone: 'warn', text: left ? `SLA due in ${left}` : 'SLA approaching breach' };
  }
  const left = nearestRemaining(sla, response, resolution);
  return { tone: 'ok', text: left ? `SLA due in ${left}` : 'SLA on track' };
}

function nearestRemaining(sla, response, resolution) {
  const candidates = [sla.response?.remainingMs, sla.resolution?.remainingMs].filter(
    (ms) => ms != null
  );
  return candidates.length ? fmtRemaining(Math.min(...candidates)) : null;
}

/* A per-cycle line for the SLA history. Reads only the cycle row the API
   already exposes in sla.cycles — outcomes are the latched flags. */
export function cycleSummary(cycle) {
  const response = cycle.firstResponseAt
    ? cycle.responseBreached ? 'Answered late' : 'Answered'
    : cycle.responseBreached ? 'Missed' : '—';
  const resolution = cycle.resolutionBreached ? 'Missed' : 'Met';
  return { response, resolution };
}
