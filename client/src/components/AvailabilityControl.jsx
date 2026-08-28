import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, useToast } from './ui.jsx';

/**
 * Sidebar availability switch plus the in-app notification feed.
 *
 * The backend decides whether going unavailable is allowed; this component
 * only renders the answer. Two refusals are expected and handled:
 *   409 blocked              — IN_PROGRESS work must be dealt with first
 *   409 confirmationRequired — NEW tickets will be handed over
 */
export default function AvailabilityControl({ me, onChanged }) {
  const [available, setAvailable] = useState(Boolean(me.isAvailable));
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [feed, setFeed] = useState({ unread: 0, notifications: [] });
  const [feedOpen, setFeedOpen] = useState(false);
  const [showToast, toastNode] = useToast();

  const loadFeed = useCallback(() => {
    api.notifications().then(setFeed).catch(() => {});
  }, []);

  useEffect(() => {
    loadFeed();
    const t = setInterval(loadFeed, 60000);
    return () => clearInterval(t);
  }, [loadFeed]);

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
      loadFeed();
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

  return (
    <>
      <div className="availability-bar">
        <label className="switch" title={available ? 'Accepting new tickets' : 'Not accepting new tickets'}>
          <input
            type="checkbox"
            checked={available}
            disabled={busy}
            onChange={(e) => apply(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          <span className={`switch-text ${available ? '' : 'muted'}`}>
            {available ? 'Available' : 'Unavailable'}
          </span>
        </label>

        <button
          className="btn btn-ghost btn-sm notif-button"
          onClick={() => { setFeedOpen(true); loadFeed(); }}
          aria-label="Notifications"
        >
          🔔{feed.unread > 0 && <span className="notif-badge">{feed.unread}</span>}
        </button>
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

      {feedOpen && (
        <Modal title="Notifications" onClose={() => setFeedOpen(false)} width={560}>
          {feed.notifications.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul className="plain-list notif-list">
              {feed.notifications.map((n) => (
                <li key={n.id} className={n.readAt ? 'muted' : ''}>
                  <strong>{n.title}</strong>
                  {n.body && <div className="small">{n.body}</div>}
                  {n.ticket && (
                    <a href={`#/tickets/${n.ticket.id}`} onClick={() => setFeedOpen(false)} className="small">
                      Open {n.ticket.ticketNumber}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button
              className="btn btn-ghost"
              onClick={async () => { await api.markNotificationsRead(); loadFeed(); }}
            >
              Mark all read
            </button>
            <button className="btn btn-primary" onClick={() => setFeedOpen(false)}>Close</button>
          </div>
        </Modal>
      )}
      {toastNode}
    </>
  );
}
