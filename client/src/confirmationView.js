// Pure display model for the requester resolution-confirmation indicator.
//
// The backend is the source of truth: a serialized ticket carries
// `awaitingConfirmation` (true while it sits RESOLVED waiting for the
// requester's click) and, when auto-close is enabled, an absolute
// `confirmationAutoCloseAt` deadline. This module only shapes those fields
// for rendering — the countdown text and the urgency tone — so the queue, the
// detail header and the inspector read identically. It never decides WHO is
// waiting or WHAT happens at the deadline; the server already did.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Everything the UI needs to show one indicator, or null when the ticket is
 * not awaiting confirmation (including old payloads that predate the field).
 *
 * @param {object} ticket a serialized ticket from the API
 * @param {Date|number|string} [now] injectable clock for tests
 * @returns {null | {
 *   pending: boolean,            // still waiting (deadline not passed)
 *   label: string,               // "awaiting confirmation" | "closing…"
 *   chip: string,                // the chip text the queue/detail render
 *   detail: string,              // when auto-close fires, human phrased
 *   overdue: boolean,            // past the deadline, sweep hasn't run yet
 *   soon: boolean,               // inside the final 24h
 *   autoCloseAt: string|null,    // ISO deadline as the API sent it
 * }}
 */
export function confirmationIndicator(ticket, now = new Date()) {
  if (!ticket || ticket.awaitingConfirmation !== true) return null;
  const t0 = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const iso = ticket.confirmationAutoCloseAt || null;
  if (!iso) {
    // Auto-close disabled (window 0) or a payload without the deadline:
    // the ticket still shows as awaiting, with no clock attached.
    return {
      pending: true,
      label: 'awaiting confirmation',
      chip: 'awaiting confirmation',
      detail: 'waiting for the requester to confirm',
      overdue: false,
      soon: false,
      autoCloseAt: null,
    };
  }
  const due = new Date(iso).getTime();
  const remaining = due - t0;
  const overdue = remaining <= 0;
  const soon = !overdue && remaining <= DAY_MS;
  return {
    pending: !overdue,
    label: overdue ? 'closing…' : 'awaiting confirmation',
    chip: overdue ? 'awaiting confirmation' : 'awaiting confirmation',
    detail: overdue
      ? 'closes automatically on the next sweep'
      : `closes automatically ${formatIn(remaining)}`,
    overdue,
    soon,
    autoCloseAt: iso,
  };
}

/** "in 2 days" / "in 5 hours" / "in 20 minutes" / "in less than a minute". */
function formatIn(remainingMs) {
  if (remainingMs <= 60_000) return 'in less than a minute';
  if (remainingMs < HOUR_MS) {
    const m = Math.max(1, Math.round(remainingMs / 60_000));
    return `in ${m} minute${m === 1 ? '' : 's'}`;
  }
  if (remainingMs < DAY_MS) {
    const h = Math.round(remainingMs / HOUR_MS);
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(remainingMs / DAY_MS);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

/** Chip tone: 'overdue' past the deadline, 'soon' inside the last 24h, else ''. */
export function confirmationTone(indicator) {
  if (!indicator) return '';
  if (indicator.overdue) return 'overdue';
  if (indicator.soon) return 'soon';
  return '';
}
