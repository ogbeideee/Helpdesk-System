import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import { ErrorState, Field } from './ui.jsx';

const EMPTY = {
  shortDescription: '',
  body: '',
  priority: 'moderate',
  category: '',
  requesterName: '',
  requesterEmail: '',
};

export default function TicketForm({ ticketId, onSaved, onCancel }) {
  const editing = Boolean(ticketId);
  const [form, setForm] = useState(EMPTY);
  const [loadedTicket, setLoadedTicket] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    api.getTicket(ticketId).then((t) => {
      setLoadedTicket(t);
      setForm({
        shortDescription: t.shortDescription,
        body: t.body,
        priority: t.priority,
        category: t.category,
        requesterName: t.requesterName || '',
        requesterEmail: t.requesterEmail || '',
      });
    }).catch((e) => setError(e.message));
  }, [ticketId, editing]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const saved = editing
        ? await api.updateTicket(ticketId, {
            shortDescription: form.shortDescription,
            body: form.body,
          })
        : await api.createTicket({
            ...form,
            category: form.category || undefined,
            autoAssign: true,
          });
      onSaved(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <div className="hero">
        <h1 className="hero-title">{editing ? `Edit ${loadedTicket?.ticketNumber || ''}` : 'New Ticket'}</h1>
        <p className="hero-sub">
          {editing
            ? 'Subject and description can be corrected; status and assignment are managed on the ticket.'
            : 'Log a walk-up or phone request. The assignment engine will route it automatically.'}
        </p>
      </div>

      {error && <ErrorState message={error} />}

      <form className="card form-card" onSubmit={handleSubmit}>
        <Field label="Subject" required hint="A short summary (max 160 characters)">
          <input value={form.shortDescription} onChange={set('shortDescription')} maxLength={160} required />
        </Field>

        {!editing && (
          <>
            <Field label="Requester name" required>
              <input value={form.requesterName} onChange={set('requesterName')} required placeholder="Jane Doe" />
            </Field>
            <Field label="Requester email" required hint="Status updates and the resolution are emailed here">
              <input type="email" value={form.requesterEmail} onChange={set('requesterEmail')} required placeholder="name@yourcompany.com" />
            </Field>
          </>
        )}

        <Field label="Description">
          <textarea rows={6} value={form.body} onChange={set('body')} placeholder="What happened? What did they expect?" />
        </Field>

        {!editing && (
          <div className="form-grid-2">
            <Field label="Category" hint="Leave on auto-detect to let the classifier decide">
              <select value={form.category} onChange={set('category')}>
                <option value="">Auto-detect</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </Field>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create ticket'}
          </button>
        </div>
      </form>
    </div>
  );
}
