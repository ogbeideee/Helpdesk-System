import { useCallback, useEffect, useRef, useState } from 'react';
import { OPEN_STATES } from '../constants.js';
import { slaOverview } from '../slaView.js';

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function fmtDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(value);
}

export function initials(nameOrEmail = '') {
  const parts = String(nameOrEmail).replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

const AVATAR_HUES = [212, 262, 152, 12, 32, 292, 182, 332];
export function avatarHue(seedText = '') {
  let h = 0;
  for (const c of String(seedText)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function Avatar({ name, size = 28 }) {
  const label = initials(name);
  const hue = avatarHue(name);
  return (
    <span
      className="avatar"
      // Only the hue is seeded from the name; saturation and lightness are
      // theme tokens, so the same avatar reads correctly in light and dark.
      style={{ width: size, height: size, fontSize: size * 0.38, '--avatar-h': hue }}
      title={name}
    >
      {label}
    </span>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="callout callout-error" role="alert">
      <div>
        <strong>Something went wrong.</strong>
        <div className="muted">{message}</div>
      </div>
      {onRetry && (
        <button className="btn btn-ghost" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

export function EmptyState({ icon = '🗂️', title, hint, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="muted">{hint}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }) {
  return <span className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/**
 * One line-icon set for the whole application: a single 16-unit grid, one
 * stroke weight, `currentColor` throughout. Icons were previously drawn inline
 * wherever they were needed, which is how a set drifts.
 */
const ICON_PATHS = {
  dashboard: <><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></>,
  tickets: <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /><circle cx="12.5" cy="11.5" r="1.5" /></>,
  handovers: <><path d="M2 8h10M8.5 4.5L12 8l-3.5 3.5" /><path d="M14 5v6" /></>,
  agents: <><circle cx="6" cy="6" r="2.5" /><path d="M2 13c.5-2 2-3 4-3s3.5 1 4 3" /><circle cx="11.5" cy="5.5" r="1.8" /><path d="M10 9.5c1.5 0 3 1 3.5 2.5" /></>,
  routing: <><circle cx="3" cy="8" r="1.5" /><path d="M4.5 8h3M11.5 8H8" /><circle cx="13" cy="8" r="1.5" /><path d="M6 8l2-3M10 8L8 5M6 8l2 3M10 8l-2 3" /></>,
  groups: <><rect x="2" y="2.5" width="5" height="5" rx="1.2" /><rect x="9" y="2.5" width="5" height="5" rx="1.2" /><rect x="5.5" y="9" width="5" height="4.5" rx="1.2" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.2" /><path d="M2.5 4.5l5.5 4 5.5-4" /></>,
  cloud: <><path d="M4.6 11.5a3.1 3.1 0 0 1-.4-6.2 4 4 0 0 1 7.8-.9 3.4 3.4 0 0 1-.3 6.8z" /><path d="M8 8.5V13M6.2 11.2L8 13l1.8-1.8" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.2M8 13.3v1.2M14.5 8h-1.2M2.7 8H1.5M12.6 3.4l-.85.85M4.25 11.75l-.85.85M12.6 12.6l-.85-.85M4.25 4.25l-.85-.85" /></>,
  moon: <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" />,
  monitor: <><rect x="1.75" y="3" width="12.5" height="8.5" rx="1.2" /><path d="M6 14h4" /></>,
  bell: <><path d="M4.5 6.8a3.5 3.5 0 0 1 7 0c0 3 1 3.9 1 3.9h-9s1-.9 1-3.9z" /><path d="M6.7 13a1.5 1.5 0 0 0 2.6 0" /></>,
  chevronDown: <path d="M4 6.25l4 3.5 4-3.5" />,
  chevronRight: <path d="M6 3l5 5-5 5" />,
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  userPlus: <><circle cx="6.5" cy="5.5" r="2.5" /><path d="M2 13c.4-2.2 2.2-3.4 4.5-3.4" /><path d="M11.5 8.5v4M9.5 10.5h4" /></>,
  check: <path d="M3 8.4l3.2 3.1L13 4.8" />,
  zap: <path d="M8.8 1.5L3.7 9h3.6l-.9 5.5L12.3 7H8.7z" />,
  folder: <path d="M1.9 4.2c0-.7.5-1.2 1.2-1.2h2.6l1.3 1.6h4.9c.7 0 1.2.5 1.2 1.2v5.6c0 .7-.5 1.2-1.2 1.2H3.1c-.7 0-1.2-.5-1.2-1.2z" />,
  key: <><circle cx="5" cy="7.4" r="2.6" /><path d="M7 8.6l5.6 3.2M11 10.5l-.7 1.6M12.9 11.6l-.8 1.5" /></>,
  laptop: <><rect x="3" y="3.5" width="10" height="7" rx="1" /><path d="M1.5 12.5h13" /></>,
  helpCircle: <><circle cx="8" cy="8" r="5.8" /><path d="M6.4 6.3a1.7 1.7 0 0 1 3.3.5c0 1.2-1.7 1.4-1.7 2.5" /><path d="M8 11.4h.01" /></>,
  clock: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.7V8l2.2 1.4" /></>,
  inbox: <><path d="M2 8.5h3l1 2h4l1-2h3" /><path d="M3.4 3.2h9.2l1.4 5.3v3.4c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1V8.5z" /></>,
  arrowRight: <path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" />,
  collapse: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6.5 2.5v11" /><path d="M11.5 6.2L9.7 8l1.8 1.8" /></>,
  dots: <><circle cx="8" cy="3.5" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="8" cy="12.5" r="1" /></>,
  logout: <><path d="M6 13.5H3.4c-.6 0-1.1-.5-1.1-1.1V3.6c0-.6.5-1.1 1.1-1.1H6" /><path d="M10.4 11L13.5 8l-3.1-3M13 8H6.2" /></>,
  shieldCheck: <><path d="M8 1.9l4.8 1.7v4c0 3-2 5.2-4.8 6.5C5.2 12.8 3.2 10.6 3.2 7.6v-4z" /><path d="M5.9 7.9l1.6 1.6 2.8-3" /></>,
  activity: <path d="M1.8 8h2.6l1.8-4.8L9 12.4l1.7-4.4h3.5" />,
  reports: <><path d="M3.5 13.5v-4.5M8 13.5v-11M12.5 13.5v-7.5" /><path d="M2 13.5h12" /></>,
  trail: <><path d="M13.2 8A5.2 5.2 0 1 1 11 3.9" /><path d="M13.5 2.2v2.6h-2.6" /><path d="M8 5.3V8l1.9 1.3" /></>,
};

export function Icon({ name, size = 16, className = '', strokeWidth = 1.5 }) {
  const shape = ICON_PATHS[name];
  if (!shape) return null;
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

/**
 * Shared open/close behaviour for the header menus: a pointer press outside
 * the anchor closes it, so does Escape, and focus returns to the trigger.
 * Spread `anchorProps` on the wrapping element.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button, [href]')?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return { open, setOpen, close, toggle, anchorProps: { ref, className: 'popover-anchor' } };
}

/* Badges ------------------------------------------------------------ */

export function StateBadge({ state }) {
  return <span className={`pill pill-state-${String(state).toLowerCase()}`}>{stateLabel(state)}</span>;
}

export function PriorityBadge({ priority }) {
  return (
    <span className={`pill pill-priority-${priority}`}>
      <span className="prio-dot" aria-hidden="true" />
      {priorityLabel(priority)}
    </span>
  );
}

const STATE_LABELS = { NEW: 'New', IN_PROGRESS: 'In Progress', RESOLVED: 'Resolved', CLOSED: 'Closed' };
const PRIORITY_LABELS = { low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' };

function stateLabel(v) { return STATE_LABELS[v] || v; }
function priorityLabel(v) { return PRIORITY_LABELS[v] || v; }

export function SlaBadge({ ticket }) {
  // The API's `sla` block is the source of truth: statuses and remaining
  // working time arrive precomputed — nothing SLA-related is derived here.
  const sla = slaOverview(ticket);
  if (sla) {
    const cls =
      sla.badge.tone === 'bad' ? 'pill-overdue' : sla.badge.tone === 'warn' ? 'pill-sla-warn' : 'pill-sla';
    const title = [
      `Response SLA — ${sla.response.text}`,
      `Resolution SLA — ${sla.resolution.text}`,
      sla.cycleEndedAt ? `Cycle ${sla.cycleNumber} (ended)` : `Cycle ${sla.cycleNumber} (active)`,
    ].join('\n');
    return (
      <span className={`pill ${cls}`} title={title}>
        ⏱ {sla.badge.text}
      </span>
    );
  }
  // Tickets without SLA cycles (created before the feature) keep their legacy
  // calendar-due countdown, word for word.
  const info = legacySlaInfo(ticket);
  if (!info) return null;
  return (
    <span className={`pill ${info.overdue ? 'pill-overdue' : 'pill-sla'}`} title={`Due ${fmtDateTime(ticket.dueAt)}`}>
      ⏱ {info.text}
    </span>
  );
}

function legacySlaInfo(ticket) {
  if (!ticket?.dueAt) return null;
  const open = OPEN_STATES.includes(ticket.state);
  const diffMs = new Date(ticket.dueAt).getTime() - Date.now();
  const overdue = diffMs < 0;
  if (!open) return null;
  const h = Math.abs(diffMs) / 3600000;
  let text;
  if (overdue) text = h >= 24 ? `Overdue ${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : `Overdue ${Math.max(1, Math.round(h))}h`;
  else if (h >= 24) text = `Due in ${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
  else if (h >= 1) text = `Due in ${Math.round(h)}h`;
  else text = `Due in ${Math.max(1, Math.round(diffMs / 60000))}m`;
  return { text, overdue };
}

/* Modal -------------------------------------------------------------- */

export function Modal({ title, onClose, children, width = 460 }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ maxWidth: width }} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} width={420}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy}
          autoFocus
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* Forms --------------------------------------------------------------- */

export function Field({ label, hint, children, required }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <em aria-hidden="true"> *</em>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  function show(message, kind = 'success') {
    setToast({ message, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }
  const node = toast ? (
    <div className={`toast toast-${toast.kind}`} role="status">{toast.message}</div>
  ) : null;
  return [show, node];
}
