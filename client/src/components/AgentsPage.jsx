import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, EmptyState, Avatar, Modal, ConfirmDialog,
  Field, useToast, fmtDateTime, timeAgo,
} from './ui.jsx';

const SKILL_LABELS = { 1: 'L1 · Junior', 2: 'L2 · Standard', 3: 'L3 · Senior' };

export default function AgentsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editorAgent, setEditorAgent] = useState(null); // null | 'new' | agent object
  const [confirmToggle, setConfirmToggle] = useState(null); // agent being deactivated
  const [showToast, toastNode] = useToast();

  const load = useCallback(() => {
    setError('');
    return api.agents().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleAvailability(agent, nextActive) {
    if (!nextActive) {
      setConfirmToggle(agent);
      return;
    }
    try {
      await api.updateAgent(agent.id, { isActive: true });
      showToast(`${agent.name} is now available`);
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!data) return <div className="page"><Spinner label="Loading agents…" /></div>;

  const teamName = (id) => data.teams.find((t) => t.id === id)?.name || 'No group';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">Availability and skill levels feed the assignment engine.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditorAgent('new')}>+ New Agent</button>
      </header>

      {data.agents.length === 0 ? (
        <EmptyState icon="👤" title="No agents yet" hint="Create the first agent to start routing tickets."
          action={<button className="btn btn-primary" onClick={() => setEditorAgent('new')}>+ New Agent</button>} />
      ) : (
        <div className="table-wrap card">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Email</th>
                <th>Skill Level</th>
                <th>Assignment Group</th>
                <th>Availability</th>
                <th>Open Workload</th>
                <th>Last Assigned</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.id} className={a.isActive ? '' : 'row-inactive'}>
                  <td>
                    <span className="cell-agent">
                      <Avatar name={a.name} />
                      <span><strong>{a.name}</strong>{a.role === 'admin' && <span className="chip chip-role">admin</span>}</span>
                    </span>
                  </td>
                  <td className="mono-sm muted">{a.email}</td>
                  <td><span className={`chip chip-skill-${a.skillLevel}`}>{SKILL_LABELS[a.skillLevel] || `L${a.skillLevel}`}</span></td>
                  <td>{teamName(a.teamId)}</td>
                  <td>
                    <label className="switch" title={a.isActive ? 'Available' : 'Unavailable'}>
                      <input
                        type="checkbox"
                        checked={a.isActive}
                        onChange={(e) => toggleAvailability(a, e.target.checked)}
                      />
                      <span className="switch-track" aria-hidden="true" />
                      <span className={`switch-text ${a.isActive ? '' : 'muted'}`}>{a.isActive ? 'Available' : 'Off'}</span>
                    </label>
                  </td>
                  <td><span className={`workload-pill ${a.openWorkload > 10 ? 'hot' : ''}`}>{a.openWorkload ?? 0}</span></td>
                  <td className="muted nowrap">{a.lastAssignedAt ? timeAgo(a.lastAssignedAt) : 'never'}</td>
                  <td className="nowrap">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditorAgent(a)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editorAgent === 'new' || editorAgent) && editorAgent !== null && (
        <AgentEditor
          agent={editorAgent === 'new' ? null : editorAgent}
          teams={data.teams}
          onClose={() => setEditorAgent(null)}
          onSaved={async (msg) => {
            setEditorAgent(null);
            showToast(msg);
            await load();
          }}
        />
      )}

      {confirmToggle && (
        <ConfirmDialog
          title={`Mark ${confirmToggle.name} unavailable?`}
          message="Their open tickets will be released back to the unassigned queue for reassignment."
          confirmLabel="Mark unavailable"
          danger
          onCancel={() => setConfirmToggle(null)}
          onConfirm={async () => {
            try {
              await api.updateAgent(confirmToggle.id, { isActive: false });
              setConfirmToggle(null);
              showToast(`${confirmToggle.name} marked unavailable`);
              await load();
            } catch (e) {
              setConfirmToggle(null);
              showToast(e.message, 'error');
            }
          }}
        />
      )}

      {toastNode}
    </div>
  );
}

function AgentEditor({ agent, teams, onClose, onSaved }) {
  const editing = Boolean(agent);
  const [form, setForm] = useState({
    name: agent?.name || '',
    email: agent?.email || '',
    password: '',
    teamKey: teams.find((t) => t.id === agent?.teamId)?.key || '',
    skillLevel: agent?.skillLevel || 2,
    role: agent?.role || 'agent',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (editing) {
        const patchBody = {
          name: form.name,
          teamKey: form.teamKey || null,
          skillLevel: Number(form.skillLevel),
          role: form.role,
        };
        if (form.password) patchBody.password = form.password;
        await api.updateAgent(agent.id, patchBody);
        onSaved(`${form.name} updated`);
      } else {
        await api.createAgent({
          name: form.name,
          email: form.email,
          password: form.password,
          teamKey: form.teamKey || null,
          skillLevel: Number(form.skillLevel),
          role: form.role,
        });
        onSaved(`${form.name} added to the desk`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Edit ${agent.name}` : 'New Agent'} onClose={onClose} width={480}>
      <form onSubmit={handleSubmit}>
        {error && <div className="callout callout-error">{error}</div>}
        <Field label="Full name" required>
          <input value={form.name} onChange={set('name')} required />
        </Field>
 {!editing && (
          <>
            <Field label="Email" required hint="Used to sign in to this portal">
              <input type="email" value={form.email} onChange={set('email')} required placeholder="name@noctincan.com" />
            </Field>
            <Field label="Initial password" required hint="Minimum 8 characters — they can change it later">
              <input type="password" value={form.password} onChange={set('password')} minLength={8} required />
            </Field>
          </>
        )}
        {editing && (
          <Field label="Reset password" hint="Leave blank to keep the current password">
            <input type="password" value={form.password} onChange={set('password')} minLength={8}
              placeholder="(unchanged)" />
          </Field>
        )}
        <div className="form-grid-2">
          <Field label="Assignment group">
            <select value={form.teamKey} onChange={set('teamKey')}>
              <option value="">Triage (no group)</option>
              {teams.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Skill level" hint="Drives eligibility in the assignment engine">
            <select value={form.skillLevel} onChange={set('skillLevel')}>
              <option value="1">{SKILL_LABELS[1]}</option>
              <option value="2">{SKILL_LABELS[2]}</option>
              <option value="3">{SKILL_LABELS[3]}</option>
            </select>
          </Field>
        </div>
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>
            <option value="agent">Agent</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create agent'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
