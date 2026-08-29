import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, EmptyState, Avatar, Modal, ConfirmDialog,
  Field, useToast, fmtDateTime, timeAgo,
} from './ui.jsx';

const SKILL_LABELS = { 1: 'Junior', 2: 'Standard', 3: 'Senior' };
const SKILL_SHORT  = { 1: 'L1', 2: 'L2', 3: 'L3' };

export default function AgentsPage({ me }) {
  const [agents, setAgents] = useState(null);
  const [teams, setTeams] = useState([]);
  const [workload, setWorkload] = useState({}); // agentId -> {new, inProgress}
  const [error, setError] = useState('');
  const [editorAgent, setEditorAgent] = useState(null);
  const [confirmToggle, setConfirmToggle] = useState(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const [a, d] = await Promise.all([api.agents(), api.dashboard()]);
      setAgents(a.agents);
      setTeams(a.teams);
      // Aggregate the dashboard's recent tickets and queue into a per-agent
      // NEW vs IN_PROGRESS breakdown. The dashboard already counts per agent.
      const perAgent = {};
      (d.ticketsPerAgent || []).forEach((row) => {
        perAgent[row.agentId] = {
          total: row.openTickets,
          // dashboard doesn't break out states — show 0/0 as a fallback; load
          // the workload API for richer data below if available.
          new: 0,
          inProgress: 0,
        };
      });
      setWorkload(perAgent);
      // Try to enrich with NEW/IN_PROGRESS using the workload API.
      try {
        const w = await api.workload();
        const next = { ...perAgent };
        (w.agents || []).forEach((row) => {
          next[row.agentId] = {
            total: row.openTickets,
            new: row.newTickets ?? 0,
            inProgress: row.inProgressTickets ?? 0,
          };
        });
        setWorkload(next);
      } catch { /* not admin / unavailable — keep totals only */ }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleAvailability(agent, nextAvailable) {
    if (!nextAvailable) { setConfirmToggle(agent); return; }
    try {
      await api.updateAgent(agent.id, { isAvailable: true });
      showToast(`${agent.name} is now available`);
      await load();
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function setActive(agent, nextActive) {
    if (!nextActive) { setConfirmDeactivate(agent); return; }
    try {
      await api.updateAgent(agent.id, { isActive: true });
      showToast(`${agent.name} activated`);
      await load();
    } catch (e) { showToast(e.message, 'error'); }
  }

  async function changeRole(agent, nextRole) {
    try {
      await api.updateAgent(agent.id, { role: nextRole });
      showToast(`${agent.name} is now ${nextRole.toUpperCase()}`);
      await load();
    } catch (e) { showToast(e.message, 'error'); }
  }

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!agents) return <div className="page"><Spinner label="Loading agents…" /></div>;

  const teamName = (id) => teams.find((t) => t.id === id)?.name || 'No group';

  // Aggregate stats
  const total = agents.length;
  const active = agents.filter((a) => a.isActive).length;
  const available = agents.filter((a) => a.isActive && a.isAvailable).length;
  const totalOpen = Object.values(workload).reduce((s, w) => s + (w.total || 0), 0);

  return (
    <div className="page">
      <div className="page-actions">
        <button className="btn btn-primary" onClick={() => setEditorAgent('new')}>New agent</button>
      </div>

      <div className="stat-strip" style={{ marginBottom: 18 }}>
        <div className="stat-strip-cell">
          <div className="stat-strip-label"><span className="stat-strip-dot is-primary" />Accounts</div>
          <div className="stat-strip-value tnum">{active}<span className="muted small" style={{ marginLeft: 6 }}>/ {total}</span></div>
          <div className="stat-strip-sub">Active</div>
        </div>
        <div className="stat-strip-cell">
          <div className="stat-strip-label"><span className="stat-strip-dot is-success" />Available</div>
          <div className="stat-strip-value tnum">{available}</div>
          <div className="stat-strip-sub">Accepting new work</div>
        </div>
        <div className="stat-strip-cell">
          <div className="stat-strip-label"><span className="stat-strip-dot is-warn" />Open workload</div>
          <div className="stat-strip-value tnum">{totalOpen}</div>
          <div className="stat-strip-sub">Across team</div>
        </div>
      </div>

      {agents.length === 0 ? (
        <EmptyState
          icon="◇"
          title="No agents yet"
          hint="Create the first agent to start routing tickets."
          action={<button className="btn btn-primary" onClick={() => setEditorAgent('new')}>New agent</button>}
        />
      ) : (
        <div className="table-wrap agents-table">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th>Team</th>
                <th>Skill</th>
                <th>Availability</th>
                <th>Workload</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const w = workload[a.id] || { total: a.openWorkload || 0, new: 0, inProgress: 0 };
                const hasSplit = w.new || w.inProgress;
                return (
                  <tr key={a.id} className={a.isActive ? '' : 'row-inactive'}>
                    <td>
                      <span className="cell-agent">
                        <Avatar name={a.name} size={26} />
                        <span style={{ minWidth: 0 }}>
                          <strong>{a.name}</strong>
                          <div className="muted small mono-sm" style={{ marginTop: 1, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.email}</div>
                        </span>
                        {me && a.id === me.id && <span className="chip chip-you" style={{ marginLeft: 6 }}>you</span>}
                      </span>
                    </td>
                    <td><span className={`chip chip-role-${a.role}`}>{String(a.role || '').toUpperCase()}</span></td>
                    <td>
                      {a.assignmentGroup
                        ? <span className="chip">{a.assignmentGroup}</span>
                        : <span className="muted small">Triage</span>}
                    </td>
                    <td><span className={`chip chip-skill-${a.skillLevel}`}>{SKILL_SHORT[a.skillLevel]} · {SKILL_LABELS[a.skillLevel]}</span></td>
                    <td>
                      <label className="switch" title={a.isAvailable ? 'Accepting new work' : 'Not accepting new work'}>
                        <input
                          type="checkbox"
                          checked={Boolean(a.isAvailable)}
                          disabled={!a.isActive}
                          onChange={(e) => toggleAvailability(a, e.target.checked)}
                        />
                        <span className="switch-track" aria-hidden="true" />
                        <span className={`switch-text ${a.isAvailable ? '' : 'muted'}`}>
                          {a.isAvailable ? 'Available' : 'Unavailable'}
                        </span>
                      </label>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      {a.isActive ? (
                        hasSplit ? (
                          <WorkloadSplit newCount={w.new} inProgressCount={w.inProgress} total={w.total} />
                        ) : (
                          <span className="cell-agent" style={{ gap: 8 }}>
                            <span className={`workload-pill ${w.total > 10 ? 'hot' : ''}`}>{w.total}</span>
                            <span className="muted small">open</span>
                          </span>
                        )
                      ) : (
                        <span className="chip chip-off">Inactive</span>
                      )}
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditorAgent(a)}>Edit</button>
                      {me && a.id !== me.id && (
                        <>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => changeRole(a, a.role === 'admin' ? 'agent' : 'admin')}
                          >
                            {a.role === 'admin' ? 'Demote' : 'Promote'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setActive(a, !a.isActive)}
                          >
                            {a.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(editorAgent === 'new' || editorAgent) && editorAgent !== null && (
        <AgentEditor
          agent={editorAgent === 'new' ? null : editorAgent}
          teams={teams}
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
              await api.updateAgent(confirmToggle.id, { isAvailable: false });
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

      {confirmDeactivate && (
        <ConfirmDialog
          title={`Deactivate ${confirmDeactivate.name}?`}
          message="Their open tickets will be reassigned. The account cannot sign in."
          confirmLabel="Deactivate"
          danger
          onCancel={() => setConfirmDeactivate(null)}
          onConfirm={async () => {
            try {
              await api.updateAgent(confirmDeactivate.id, { isActive: false });
              setConfirmDeactivate(null);
              showToast(`${confirmDeactivate.name} deactivated`);
              await load();
            } catch (e) {
              setConfirmDeactivate(null);
              showToast(e.message, 'error');
            }
          }}
        />
      )}

      {toastNode}
    </div>
  );
}

function WorkloadSplit({ newCount, inProgressCount, total }) {
  const newPct = total > 0 ? (newCount / total) * 100 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
        <span><span style={{ color: 'var(--primary-2)' }}>●</span> NEW {newCount}</span>
        <span><span style={{ color: 'var(--warning)' }}>●</span> IN PROGRESS {inProgressCount}</span>
      </div>
      <div className="bar-track" style={{ height: 4 }}>
        <div className="bar-fill" style={{ width: `${newPct}%`, background: 'var(--primary)' }} />
      </div>
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
  // Changing an existing agent's password is a separate, deliberate act. The
  // field is not rendered until it is requested, so there is nothing for the
  // browser's password manager to fill while an admin edits a name or a group.
  const [changingPassword, setChangingPassword] = useState(false);
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
        // Gated on the admin having opened the password control, not merely on
        // the field holding a value: autofill puts a value there without anyone
        // typing, and that used to be enough to overwrite the real password.
        if (changingPassword && form.password) patchBody.password = form.password;
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
    <Modal title={editing ? `Edit ${agent.name}` : 'New agent'} onClose={onClose} width={480}>
      <form onSubmit={handleSubmit} autoComplete="off">
        {error && <div className="callout callout-error">{error}</div>}
        <Field label="Full name" required>
          <input name="agent-name" autoComplete="off" value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        {!editing && (
          <>
            <Field label="Email" required hint="Used to sign in to this portal">
              <input type="email" name="agent-email" autoComplete="off" value={form.email} onChange={set('email')} required placeholder="name@yourcompany.com" />
            </Field>
            <Field label="Initial password" required hint="Minimum 8 characters — they can change it later">
              <input type="password" name="agent-initial-password" autoComplete="new-password" value={form.password} onChange={set('password')} minLength={8} required />
            </Field>
          </>
        )}
        {editing && (
          changingPassword ? (
            <Field label="New password" required hint="Minimum 8 characters. They can change it again after signing in.">
              <input
                type="password"
                name="agent-new-password"
                autoComplete="new-password"
                value={form.password}
                onChange={set('password')}
                minLength={8}
                required
                autoFocus
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 6 }}
                onClick={() => { setChangingPassword(false); setForm((f) => ({ ...f, password: '' })); }}
              >
                Keep the current password
              </button>
            </Field>
          ) : (
            <Field label="Password" hint="Unchanged unless you set a new one.">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChangingPassword(true)}>
                Set a new password
              </button>
            </Field>
          )
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
              <option value="1">L1 · {SKILL_LABELS[1]}</option>
              <option value="2">L2 · {SKILL_LABELS[2]}</option>
              <option value="3">L3 · {SKILL_LABELS[3]}</option>
            </select>
          </Field>
        </div>
        <Field label="Role" hint="USER cannot be assigned tickets. ADMIN can manage users.">
          <select value={form.role} onChange={set('role')}>
            <option value="user">User</option>
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
