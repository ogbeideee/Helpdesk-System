import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, EmptyState, Modal, ConfirmDialog, Field, useToast, timeAgo,
} from './ui.jsx';

const SKILL_OPTIONS = [
  { value: '', label: 'Any skill' },
  { value: 'JUNIOR', label: 'Junior' },
  { value: 'MID', label: 'Mid' },
  { value: 'SENIOR', label: 'Senior' },
];

export default function RoutingPage() {
  const [rules, setRules] = useState(null);
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [previewText, setPreviewText] = useState('');
  const [preview, setPreview] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const [r, g, a] = await Promise.all([
        api.routingRules(),
        api.routingGroups(),
        api.agents(),
      ]);
      setRules(r.rules);
      setGroups(g.groups);
      setAgents(a.agents);
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
  if (!rules) return <div className="page"><Spinner label="Loading routing rules…" /></div>;

  return (
    <div className="page">
      <div className="hero" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <h1 className="hero-title">Routing Rules</h1>
          <p className="hero-sub">
            Rules are evaluated in order — the lowest priority number that matches wins. Unmatched tickets go to the default group.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ New rule</button>
      </div>

      <section className="card" style={{ paddingTop: 16, paddingBottom: 16 }}>
        <div className="card-head">
          <h2>Test a description</h2>
        </div>
        <div className="assign-controls">
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder='e.g. "Cannot connect to WiFi in the annexe"'
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runPreview()}
          />
          <button className="btn btn-primary btn-sm" disabled={busy || !previewText.trim()} onClick={runPreview}>
            Preview
          </button>
        </div>
        {preview && (
          <div className="preview-box">
            <span className="muted small">Category</span>
            <strong>{preview.category}</strong>
            <span className="preview-arrow">→</span>
            <span className="muted small">Rule</span>
            <strong>{preview.matchedRule ? preview.matchedRule.name : <em className="muted">no rule matched</em>}</strong>
            <span className="preview-arrow">→</span>
            <span className="muted small">Group</span>
            <strong>{preview.assignmentGroup ? preview.assignmentGroup.name : '—'}</strong>
            <span className="muted small" style={{ marginLeft: 'auto' }}>Min skill</span>
            <strong>{preview.minimumSkillName}</strong>
            {preview.matchedKeywords.length > 0 && (
              <div style={{ width: '100%', marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted small">matched</span>
                {preview.matchedKeywords.map((kw) => (
                  <span key={kw} className="rule-keyword">{kw}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {rules.length === 0 ? (
        <EmptyState icon="◇" title="No routing rules" hint="Create one to start routing tickets automatically." />
      ) : (
        <div className="rule-list">
          {rules.map((r) => (
            <div key={r.id} className={`rule-card ${r.isActive ? '' : 'is-inactive'}`}>
              <div className="rule-priority">{r.priority}</div>
              <div className="rule-main">
                <div className="rule-name">{r.name}</div>
                <div className="rule-meta">
                  {r.category
                    ? <span className="chip">{r.category}</span>
                    : <span className="muted small">Any category</span>}
                  {r.assignmentGroup && <span className="chip chip-ok">{r.assignmentGroup.name}</span>}
                  {r.preferredAgent && <span className="chip">→ {r.preferredAgent.name}</span>}
                  {r.minimumSkillName && <span className="chip chip-skill-3">min {r.minimumSkillName}</span>}
                  {!r.isActive && <span className="chip chip-off">inactive</span>}
                </div>
                {r.keywords.length > 0 && (
                  <div className="rule-keywords">
                    {r.keywords.slice(0, 12).map((kw) => (
                      <span key={kw} className="rule-keyword">{kw}</span>
                    ))}
                    {r.keywords.length > 12 && (
                      <span className="muted small">+{r.keywords.length - 12} more</span>
                    )}
                  </div>
                )}
              </div>
              <div className="rule-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => run(() => api.updateRoutingRule(r.id, { isActive: !r.isActive }),
                    r.isActive ? 'Rule deactivated' : 'Rule activated')}
                >
                  {r.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(r)}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(r)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head"><h2>Assignment Groups</h2></div>
        {groups.map((g) => (
          <div key={g.id} className="kv-row">
            <span>
              <strong>{g.name}</strong>
              {g.isDefault && <span className="chip chip-you" style={{ marginLeft: 6 }}>default</span>}
              {!g.isActive && <span className="chip chip-off" style={{ marginLeft: 6 }}>inactive</span>}
              {g.description && <span className="muted small" style={{ marginLeft: 6 }}>— {g.description}</span>}
            </span>
            <span className="muted small tnum">{g.agentCount} agents · {g.ruleCount} rules</span>
          </div>
        ))}
      </section>

      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          categories={rules ? rules.flatMap((r) => r.category ? [r.category] : []).filter((v, i, a) => a.indexOf(v) === i) : []}
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
          <Field label="Priority" hint="Lower number wins.">
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
