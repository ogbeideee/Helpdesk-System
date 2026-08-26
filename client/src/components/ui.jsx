import { useEffect, useRef, useState } from 'react';
import { OPEN_STATES } from '../constants.js';

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
      style={{
        width: size, height: size, fontSize: size * 0.38,
        background: `hsl(${hue} 45% 26%)`, color: `hsl(${hue} 90% 78%)`,
      }}
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
  const info = slaInfo(ticket);
  if (!info) return null;
  return (
    <span className={`pill ${info.overdue ? 'pill-overdue' : 'pill-sla'}`} title={`Due ${fmtDateTime(ticket.dueAt)}`}>
      ⏱ {info.text}
    </span>
  );
}

function slaInfo(ticket) {
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
