import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState, EmptyState, Modal, useToast } from './ui.jsx';

/**
 * The recipient's Pending Handovers screen, plus the requests they have sent.
 *
 * Every rule (who may answer, whether a request is still live, how long is
 * left) is decided by the backend; this screen renders the answer and posts
 * the three replies: Accept, Decline, Suggest Another.
 */
export default function HandoversPage({ me, onCountChange }) {
  const [inbox, setInbox] = useState(null);
  const [outbox, setOutbox] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestFor, setSuggestFor] = useState(null);
  const [settings, setSettings] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(() => {
    setError('');
    return Promise.all([api.handoverInbox(), api.handoverOutbox()])
      .then(([i, o]) => {
        setInbox(i);
        setOutbox(o.requests || []);
        onCountChange?.(i.pending.length);
      })
      .catch((e) => setError(e.message));
  }, [onCountChange]);

  useEffect(() => {
    load();
    api.handoverSettings().then(setSettings).catch(() => {});
    // Requests expire and queued ones activate on their own, so refresh.
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  async function run(fn, message) {
    setBusy(true);
    try {
      await fn();
      await load();
      if (message) showToast(message);
      return true;
    } catch (e) {
      showToast(e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (error && !inbox) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!inbox) return <div className="page"><Spinner label="Loading handovers…" /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Handovers</h1>
          <p className="muted">
            A handover is an offer: a ticket only changes owner when you accept it.
          </p>
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <section className="card">
        <div className="card-head">
          <h2>Pending Handovers</h2>
          <span className="muted small">
            {inbox.pending.length} of {inbox.limit} active
          </span>
        </div>
        {inbox.pending.length === 0 ? (
          <EmptyState icon="🤝" title="Nothing waiting for you" hint="Requests from teammates appear here." />
        ) : (
          <ul className="handover-list">
            {inbox.pending.map((h) => (
              <li key={h.id} className="handover-item">
                <div className="handover-main">
                  <a className="handover-ticket" href={`#/tickets/${h.ticket.id}`}>
                    <strong className="mono">{h.ticket.ticketNumber}</strong> {h.ticket.shortDescription}
                  </a>
                  <div className="muted small">
                    From <strong>{h.requestedBy.name}</strong> · {timeRemaining(h)}
                  </div>
                  {h.note && <div className="handover-note">“{h.note}”</div>}
                </div>
                <div className="btn-row">
                  <button className="btn btn-primary btn-sm" disabled={busy}
                    onClick={() => run(() => api.acceptHandover(h.id), `${h.ticket.ticketNumber} is now yours`)}>
                    ✓ Accept
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={busy}
                    onClick={() => run(() => api.declineHandover(h.id), 'Handover declined')}>
                    ✕ Decline
                  </button>
                  <button className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => setSuggestFor(h)}>
                    ↗ Suggest Another
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {inbox.queued.length > 0 && (
          <>
            <h3 className="action-label" style={{ marginTop: 18 }}>
              Queued — activated automatically as slots free up
            </h3>
            <ul className="handover-list">
              {inbox.queued.map((h) => (
                <li key={h.id} className="handover-item is-queued">
                  <div className="handover-main">
                    <a className="handover-ticket" href={`#/tickets/${h.ticket.id}`}>
                      <strong className="mono">{h.ticket.ticketNumber}</strong> {h.ticket.shortDescription}
                    </a>
                    <div className="muted small">
                      From <strong>{h.requestedBy.name}</strong> · queue position {h.queuePosition}
                    </div>
                  </div>
                  <span className="chip">queued</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Requests you have sent</h2>
        </div>
        {outbox.length === 0 ? (
          <p className="muted">You have no handovers waiting for an answer.</p>
        ) : (
          <ul className="handover-list">
            {outbox.map((h) => (
              <li key={h.id} className="handover-item">
                <div className="handover-main">
                  <a className="handover-ticket" href={`#/tickets/${h.ticket.id}`}>
                    <strong className="mono">{h.ticket.ticketNumber}</strong> {h.ticket.shortDescription}
                  </a>
                  <div className="muted small">
                    Waiting on <strong>{h.targetAgent.name}</strong> ·{' '}
                    {h.status === 'QUEUED' ? 'queued behind their other requests' : timeRemaining(h)}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" disabled={busy}
                  onClick={() => run(() => api.cancelHandover(h.id), 'Handover cancelled')}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {me.role === 'admin' && settings && (
        <AdminSettings
          settings={settings}
          onSaved={(next) => { setSettings(next); showToast('Handover settings updated'); load(); }}
          onError={(m) => showToast(m, 'error')}
        />
      )}

      {suggestFor && (
        <SuggestDialog
          handover={suggestFor}
          onClose={() => setSuggestFor(null)}
          onSubmit={async (agentId, note) => {
            const ok = await run(
              () => api.suggestHandover(suggestFor.id, { agentId, note }),
              'Suggestion sent — the original agent decides whether to ask them'
            );
            if (ok) setSuggestFor(null);
          }}
          busy={busy}
        />
      )}
      {toastNode}
    </div>
  );
}

/** Time left before the request expires, or why the clock is stopped. */
function timeRemaining(h) {
  if (h.paused) return 'timer paused while the recipient is unavailable';
  if (h.remainingMinutes === null || h.remainingMinutes === undefined) return 'no expiry';
  if (h.remainingMinutes <= 0) return 'expiring now';
  if (h.remainingMinutes < 60) return `${h.remainingMinutes} min left`;
  const hours = h.remainingMinutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours left`;
  return `${Math.round(hours / 24)} days left`;
}

/**
 * Suggest a teammate instead. Deliberately worded so it is clear this only
 * proposes somebody — no request is sent on their behalf.
 */
function SuggestDialog({ handover, onClose, onSubmit, busy }) {
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    api
      .assignmentCandidates(handover.ticket.id)
      .then(setCandidates)
      .catch((e) => setError(e.message));
  }, [handover.ticket.id]);

  const options = (candidates?.candidates || []).filter(
    (c) => c.id !== handover.targetAgentId && c.id !== handover.requestedById
  );

  return (
    <Modal title={`Suggest someone for ${handover.ticket.ticketNumber}`} onClose={onClose} width={560}>
      <p className="modal-message">
        This declines the request and shows your suggestion to {handover.requestedBy.name}.
        No request is sent to the person you name — it stays their decision.
      </p>
      {error && <div className="callout callout-error">{error}</div>}
      {!candidates && !error && <Spinner label="Loading team…" />}
      {candidates && options.length === 0 && <p className="muted">Nobody else is available in this group.</p>}
      <div className="reassign-list">
        {options.map((c) => (
          <label key={c.id} className={`reassign-option ${String(c.id) === pick ? 'is-selected' : ''}`}>
            <input
              type="radio"
              name="suggest-target"
              value={c.id}
              checked={String(c.id) === pick}
              onChange={() => setPick(String(c.id))}
            />
            <span className="reassign-option-body">
              <strong>{c.name}</strong>
              <small className="muted">
                {c.skillLabel} · {c.assignmentGroup || 'no group'} ·{' '}
                <span className={c.available ? 'ok-text' : 'warn-text'}>
                  {c.available ? 'Available' : 'Unavailable'}
                </span>{' '}
                · {c.openTickets} open
              </small>
            </span>
          </label>
        ))}
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Why them? (optional)</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || !pick}
          onClick={() => onSubmit(Number(pick), note.trim() || undefined)}
        >
          Decline and suggest
        </button>
      </div>
    </Modal>
  );
}

/** Administrator controls for the pending limit and the expiry window. */
function AdminSettings({ settings, onSaved, onError }) {
  const [draft, setDraft] = useState(settings.settings);
  const [busy, setBusy] = useState(false);
  const dirty = Object.keys(draft).some((k) => draft[k] !== settings.settings[k]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Handover settings</h2>
        <span className="chip chip-dev">admin</span>
      </div>
      <div className="settings-grid">
        {settings.definitions.map((def) => (
          <label key={def.key} className="field">
            <span className="field-label">{def.label}</span>
            <input
              type="number"
              min={def.min}
              max={def.max}
              value={draft[def.key]}
              onChange={(e) => setDraft({ ...draft, [def.key]: Number(e.target.value) })}
            />
            <small className="muted">{def.help} Default {def.default}.</small>
          </label>
        ))}
      </div>
      <div className="btn-row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            try {
              onSaved(await api.updateHandoverSettings(draft));
            } catch (e) {
              onError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save settings
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy || !dirty}
          onClick={() => setDraft(settings.settings)}>
          Reset
        </button>
      </div>
    </section>
  );
}
