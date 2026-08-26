import { useState } from 'react';
import { api } from '../api.js';
import { Field, StateBadge, PriorityBadge, ErrorState } from './ui.jsx';

/**
 * DEVELOPMENT-ONLY stand-in for the future Microsoft Graph ingestion.
 * Posts to /api/tickets/from-email, which runs the exact production
 * intake pipeline (dedupe → classify → route → assign → audit) without
 * a real mailbox. Hidden when VITE_ENABLE_EMAIL_SIMULATOR=false.
 */
export default function SimulateEmailPage({ onOpen }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
    messageId: '',
    conversationId: '',
  });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validationErrors, setValidationErrors] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setValidationErrors(null);
    setResult(null);
    try {
      const payload = {
        from: form.email,
        name: form.name || undefined,
        subject: form.subject,
        body: form.message,
        messageId: form.messageId.trim() || `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(form.conversationId.trim() ? { conversationId: form.conversationId.trim() } : {}),
      };
      const data = await api.simulateEmail(payload);
      setResult(data);
    } catch (err) {
      if (/required|valid email|must be/.test(err.message)) setValidationErrors([err.message]);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>
            Simulate Incoming Email <span className="chip chip-dev">DEVELOPMENT</span>
          </h1>
          <p className="muted">
            Stands in for the Microsoft 365 mailbox integration. Submission runs the
            production intake pipeline: dedupe → classify → route → assign → audit log.
            No real email is sent.
          </p>
        </div>
      </header>

      <form className="card form-card" onSubmit={handleSubmit}>
        <div className="form-grid-2">
          <Field label="Requester name">
            <input value={form.name} onChange={set('name')} placeholder="John Doe" />
          </Field>
          <Field label="Requester email" required>
            <input type="email" value={form.email} onChange={set('email')} required placeholder="john.doe@company.com" />
          </Field>
        </div>

        <Field label="Subject" required hint="Keywords drive classification — e.g. 'password', 'laptop', 'outlook'">
          <input value={form.subject} onChange={set('subject')} required placeholder="My laptop is not connecting to WiFi" />
        </Field>

        <Field label="Message">
          <textarea rows={5} value={form.message} onChange={set('message')}
            placeholder="I have been unable to connect since this morning…" />
        </Field>

        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '▾' : '▸'} Advanced delivery metadata
        </button>
        {advanced && (
          <div className="form-grid-2">
            <Field label="Message ID" hint="Unique per email. Re-submitting the same ID returns the existing ticket (dedupe).">
              <input value={form.messageId} onChange={set('messageId')} placeholder="(auto-generated)" />
            </Field>
            <Field label="Conversation ID" hint="Replies sharing this ID attach to the original ticket instead of creating a new one.">
              <input value={form.conversationId} onChange={set('conversationId')} placeholder="(optional)" />
            </Field>
          </div>
        )}

        <div className="modal-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Delivering…' : '📨 Deliver email'}
          </button>
        </div>
      </form>

      {validationErrors && (
        <div className="callout callout-error" role="alert">
          <strong>The message was rejected:</strong>
          <ul className="error-list">
            {validationErrors.map((e2, i) => <li key={i}>{e2}</li>)}
          </ul>
        </div>
      )}
      {error && <ErrorState message={error} />}

      {result && result.status === 'duplicate' && (
        <div className="card result-card">
          <h2>↩ Duplicate delivery</h2>
          <p className="muted">
            Message <code className="mono-sm">{form.messageId || '(id)'}</code> was already processed.
            No new ticket was created — idempotency worked as designed.
          </p>
          <button className="btn btn-primary" onClick={() => onOpen(result.ticket.id)}>
            Open existing ticket {result.ticket.ticketNumber}
          </button>
        </div>
      )}

      {result && (result.status === 'created') && (
        <div className="card result-card">
          <div className="result-head">
            <span className="mono ticket-no">{result.ticket.ticketNumber}</span>
            <StateBadge state={result.ticket.state} />
            <PriorityBadge priority={result.ticket.priority} />
          </div>
          <dl className="props props-inline">
            <div><dt>Category</dt><dd>{result.ticket.category}</dd></div>
            <div><dt>Assignment group</dt><dd>{result.assignment.groupName}</dd></div>
            <div>
              <dt>Assigned agent</dt>
              <dd>
                {result.assignment.assignedAgentId
                  ? result.ticket.assignedAgent?.name
                  : <span className="muted">awaiting assignment</span>}
              </dd>
            </div>
            <div><dt>Reasoning</dt><dd className="muted">{result.assignment.reason}</dd></div>
          </dl>
          <button className="btn btn-primary" onClick={() => onOpen(result.ticket.id)}>
            Open ticket {result.ticket.ticketNumber}
          </button>
        </div>
      )}

      {result && (result.status === 'comment_added' || result.status === 'reopened') && (
        <div className="card result-card">
          <h2>{result.status === 'reopened' ? '↺ Ticket reopened' : '💬 Reply attached'}</h2>
          <p className="muted">
            The conversation ID matched an existing ticket — the message was added as a
            requester reply{result.status === 'reopened' ? ' and the ticket was reopened.' : '.'}
          </p>
          <button className="btn btn-primary" onClick={() => onOpen(result.ticket.id)}>
            Open ticket {result.ticket.ticketNumber}
          </button>
        </div>
      )}
    </div>
  );
}
