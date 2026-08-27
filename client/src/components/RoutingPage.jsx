import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, EmptyState, Modal, ConfirmDialog, Field, useToast, timeAgo,
} from './ui.jsx';

const SKILL_OPTIONS = [
  { value: '', label: 'Any skill level' },
  { value: 'JUNIOR', label: 'JUNIOR' },
  { value: 'MID', label: 'MID' },
  { value: 'SENIOR', label: 'SENIOR' },
];

/**
 * Routing rules administration.
 *
 * The backend owns matching and precedence; this screen only edits the rows
 * and shows the order they will be evaluated in.
 */
export default function RoutingPage() {
  const [data, setData] = useState(null);
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // rule object | 'new' | null
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [previewText, setPreviewText] = useState('');
  const [preview, setPreview] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const [rules, grp, ag] = await Promise.all([
        api.routingRules(),
        api.routingGroups(),
        api.agents(),
      ]);
      setData(rules);
      setGroups(grp.groups);
      setAgents(ag.agents);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(fn, message) {
    setBusy(true);
    try {
      await fn();
      if (message) showToast(message);
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!previewText.trim()) return;
    setBusy(true);
    try {
      setPreview(await api.previewRouting({ text: previewText }));
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!data) return <div className="page"><Spinner label="Loading routing rules…" /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Routing Rules</h1>
          <p className="muted">
            Rules are evaluated in order — the lowest priority number that matches wins.
            Unmatched tickets go to the default assignment group.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ New Rule</button>
      </header>

      {/* Try a description against the live rule set. Creates nothing. */}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Test a ticket description</h2></div>
        <div className="assign-controls">
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder="e.g. Cannot connect to WiFi in the annexe"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runPreview()}
          />
          <button className="btn btn-secondary btn-sm" disabled={busy || !previewText.trim()} onClick={runPreview}>
            Preview
          </button>
        </div>
        {preview && (
          <div className="kv-row" style={{ marginTop: 10 }}>
            <span>
              <strong>{preview.category}</strong>
              {' → '}
              {preview.matchedRule ? preview.matchedRule.name : <em className="muted">no rule matched</em>}
              {' → '}
              <strong>{preview.assignmentGroup ? preview.assignmentGroup.name : '—'}</strong>
              {' · min '}{preview.minimumSkillName}
            </span>
            {preview.matchedKeywords.length > 0 && (
              <small className="muted">matched: {preview.matchedKeywords.join(', ')}</small>
            )}
          </div>
        )}
      </section>

      {data.rules.length === 0 ? (
        <EmptyState icon="⛁" title="No routing rules" hint="Create one to start routing tickets automatically." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Name</th>
                <th>Category</th>
                <th>Keywords</th>
                <th>Assignment Group</th>
                <th>Preferred Agent</th>
                <th>Min Skill</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'row-inactive'}>
                  <td className="mono">{r.priority}</td>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category || <span className="muted">Any</span>}</td>
                  <td className="cell-subject">
                    {r.keywords.length ? (
                      <span className="muted small">{r.keywords.slice(0, 6).join(', ')}{r.keywords.length > 6 ? ` +${r.keywords.length - 6}` : ''}</span>
                    ) : (
                      <span className="muted small">category only</span>
                    )}
                  </td>
                  <td>{r.assignmentGroup ? r.assignmentGroup.name : '—'}</td>
                  <td>{r.preferredAgent ? r.preferredAgent.name : <span className="muted">—</span>}</td>
                  <td>{r.minimumSkillName || <span className="muted">Any</span>}</td>
                  <td>
                    <span className={`chip ${r.isActive ? 'chip-ok' : 'chip-off'}`}>
                      {r.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="nowrap">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>Edit</button>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => run(() => api.updateRoutingRule(r.id, { isActive: !r.isActive }),
                        r.isActive ? 'Rule deactivated' : 'Rule activated')}
                    >
                      {r.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card" style={{ marginTop: 18 }}>
        <div className="card-head"><h2>Assignment Groups</h2></div>
        {groups.map((g) => (
          <div key={g.id} className="kv-row">
            <span>
              <strong>{g.name}</strong>
              {g.isDefault && <span className="chip chip-you">default</span>}
              {!g.isActive && <span className="chip chip-off">inactive</span>}
              {g.description && <small className="muted"> — {g.description}</small>}
            </span>
            <small className="muted">{g.agentCount} agents · {g.ruleCount} rules</small>
          </div>
        ))}
      </section>

      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          categories={data.categories}
          groups={groups}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
          showToast={showToast}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          message="The rule is removed, but its history stays in the routing audit trail."
          confirmLabel="Delete rule"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const r = confirmDelete;
            setConfirmDelete(null);
            await run(() => api.deleteRoutingRule(r.id), 'Rule deleted');
          }}
        />
      )}
      {toastNode}
    </div>
  );
}

function RuleEditor({ rule, categories, groups, agents, onClose, onSaved, showToast }) {
  const editingExisting = Boolean(rule);
  const [form, setForm] = useState({
    name: rule?.name || '',
    keywords: (rule?.keywords || []).join(', '),
    category: rule?.category || '',
    assignmentGroupId: rule?.assignmentGroupId || (groups[0] && groups[0].id) || '',
    preferredAgentId: rule?.preferredAgentId || '',
    minimumSkillLevel: rule?.minimumSkillName || '',
    priority: rule?.priority ?? 100,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Only agents in the chosen group can sensibly be the preferred agent.
  const groupAgents = agents.filter((a) => a.teamId === Number(form.assignmentGroupId));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        keywords: form.keywords,
        category: form.category || null,
        assignmentGroupId: Number(form.assignmentGroupId),
        preferredAgentId: form.preferredAgentId ? Number(form.preferredAgentId) : null,
        minimumSkillLevel: form.minimumSkillLevel || null,
        priority: Number(form.priority),
      };
      if (editingExisting) await api.updateRoutingRule(rule.id, payload);
      else await api.createRoutingRule(payload);
      showToast(editingExisting ? 'Rule updated' : 'Rule created');
      await onSaved();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editingExisting ? `Edit ${rule.name}` : 'New routing rule'} onClose={onClose} width={560}>
      <form onSubmit={submit}>
        <Field label="Rule name" required>
          <input value={form.name} onChange={set('name')} required autoFocus placeholder="e.g. Network Issues" />
        </Field>
        <Field
          label="Keywords"
          hint="Comma separated. Matching ignores case and punctuation, so “wifi” also matches “Wi-Fi”. Leave empty to match on category alone."
        >
          <textarea rows={3} value={form.keywords} onChange={set('keywords')} placeholder="wifi, wi-fi, internet, network, vpn, router" />
        </Field>
        <div className="form-grid">
          <Field label="Category" hint="Leave as Any to match every category.">
            <select value={form.category} onChange={set('category')}>
              <option value="">Any category</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Priority" hint="Lower number is evaluated first and wins.">
            <input type="number" min="0" value={form.priority} onChange={set('priority')} />
          </Field>
        </div>
        <Field label="Assignment group" required>
          <select value={form.assignmentGroupId} onChange={set('assignmentGroupId')} required>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}{g.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Preferred agent" hint="Used when they are available and skilled enough.">
            <select value={form.preferredAgentId} onChange={set('preferredAgentId')}>
              <option value="">No preference</option>
              {groupAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} (L{a.skillLevel})</option>
              ))}
            </select>
          </Field>
          <Field label="Minimum skill">
            <select value={form.minimumSkillLevel} onChange={set('minimumSkillLevel')}>
              {SKILL_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : editingExisting ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
