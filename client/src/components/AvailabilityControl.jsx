import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon, Modal, usePopover, useToast } from './ui.jsx';

/**
 * Sidebar availability control.
 *
 * The backend decides whether going unavailable is allowed; this component
 * only renders the answer. Two refusals are expected and handled:
 *   409 blocked              — IN_PROGRESS work must be dealt with first
 *   409 confirmationRequired — NEW tickets will be handed over
 *
 * The notification feed used to live here too. It now sits in the header,
 * where an inbox belongs — see NotificationBell.
 */
export default function AvailabilityControl({ me, onChanged }) {
  const [available, setAvailable] = useState(Boolean(me.isAvailable));
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [showToast, toastNode] = useToast();
  const { open, toggle, close, anchorProps } = usePopover();

  useEffect(() => setAvailable(Boolean(me.isAvailable)), [me.isAvailable]);

  async function apply(next, confirmReassign = false) {
    setBusy(true);
    try {
      const result = await api.setAvailability({ available: next, confirmReassign });
      setAvailable(result.isAvailable);
      setBlocked(null);
      setConfirm(null);
      if (onChanged) onChanged({ ...me, isAvailable: result.isAvailable });
      const moved = result.reassigned;
      showToast(
        result.isAvailable
          ? 'You are available again'
          : moved && moved.considered
            ? `You are unavailable — ${moved.moved} ticket(s) reassigned, ${moved.unassigned} sent to triage`
            : 'You are now unavailable'
      );
    } catch (err) {
      // The API returns structured detail for the two expected refusals; the
      // shared request helper only surfaces the message, so re-fetch detail.
      try {
        const preview = await api.availabilityPreview();
        if (preview.blocked) setBlocked(preview);
        else if (preview.requiresConfirmation) setConfirm(preview);
        else showToast(err.message, 'error');
      } catch {
        showToast(err.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  function choose(next) {
    close();
    if (next !== available) apply(next);
  }

  return (
    <>
      <div {...anchorProps}>
        <button
          type="button"
          className={`availability-btn ${available ? 'is-on' : 'is-off'}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={toggle}
          title={available ? 'Accepting new tickets' : 'Not accepting new tickets'}
        >
          <span className="availability-dot" aria-hidden="true" />
          <span className="availability-text">
            <strong>{available ? 'Available' : 'Unavailable'}</strong>
            <small>{available ? "You're set to receive tickets" : 'New tickets route elsewhere'}</small>
          </span>
          <Icon name="chevronDown" size={14} className="availability-caret" />
        </button>

        {open && (
          <div className="menu menu-up" role="menu" aria-label="Availability">
            <div className="menu-label">Availability</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={available}
              className={`menu-item ${available ? 'is-selected' : ''}`}
              onClick={() => choose(true)}
            >
              <span className="availability-dot is-on" aria-hidden="true" />
              <span>Available</span>
              {available && <Icon name="check" size={14} className="menu-check" />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!available}
              className={`menu-item ${!available ? 'is-selected' : ''}`}
              onClick={() => choose(false)}
            >
              <span className="availability-dot is-off" aria-hidden="true" />
              <span>Unavailable</span>
              {!available && <Icon name="check" size={14} className="menu-check" />}
            </button>
            <div className="menu-foot">
              Going unavailable hands your new tickets to the group; work already
              in progress has to be resolved or handed over first.
            </div>
          </div>
        )}
      </div>

      {blocked && (
        <Modal title="You still have work in progress" onClose={() => setBlocked(null)} width={520}>
          <p className="modal-message">
            You cannot go unavailable while {blocked.inProgress.length} ticket(s) are in progress.
            Resolve them, or hand them to a teammate first.
          </p>
          <ul className="plain-list">
            {blocked.inProgress.map((t) => (
              <li key={t.id}>
                <a href={`#/tickets/${t.id}`} onClick={() => setBlocked(null)}>
                  <strong className="mono">{t.ticketNumber}</strong> — {t.shortDescription}
                </a>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setBlocked(null)}>Close</button>
            <button
              className="btn btn-primary"
              onClick={() => { setBlocked(null); window.location.hash = '/tickets'; }}
            >
              Go to my tickets
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal title="Hand over your new tickets?" onClose={() => setConfirm(null)} width={520}>
          <p className="modal-message">
            These {confirm.newTickets.length} NEW ticket(s) will be reassigned to your team.
            Anything without a suitable owner goes back to triage.
          </p>
          <ul className="plain-list">
            {confirm.newTickets.map((t) => (
              <li key={t.id}>
                <strong className="mono">{t.ticketNumber}</strong> — {t.shortDescription}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => apply(false, true)}>
              Go unavailable
            </button>
          </div>
        </Modal>
      )}
      {toastNode}
    </>
  );
}
