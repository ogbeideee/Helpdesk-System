import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, EmptyState, Modal, ConfirmDialog, Field, useToast,
} from './ui.jsx';
import {
  PRIORITIES, SCOPES, EMPTY_FORM, ruleToForm, ruleRows, validateForm,
} from '../emailRulesView.js';

/**
 * Admin screen for the email parsing rules — the keyword rules the parser
 * evaluates on inbound mail. A rule influences ONLY the fields it sets
 * (category, priority, assignment group); everything else keeps flowing
 * through the normal classifier and defaults.
 */
export default function EmailRulesPage() {
  const [rules, setRules] = useState(null);
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | rule object
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const [r, g] = await Promise.all([api.emailRules(), api.teams()]);
      setRules(r.rules);
      setGroups(Array.isArray(g) ? g : []);
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
      return true;
    } catch (e) {
      showToast(e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openNew() {
    setForm(EMPTY_FORM);
    setFormErrors([]);
    setEditing('new');
  }

  function openEdit(rule) {
    setForm(ruleToForm(rule));
    setFormErrors([]);
    setEditing(rule);
  }

  async function save() {
    const { errors, payload } = validateForm(form, { groups });
    setFormErrors(errors);
    if (!payload) return;
    const isNew = editing === 'new';
    const ok = await run(
      () => (isNew ? api.createEmailRule(payload) : api.updateEmailRule(editing.id, payload)),
      isNew ? 'Rule created.' : 'Rule saved.'
    );
    if (ok) setEditing(null);
  }

  async function toggleEnabled(rule) {
    await run(() => api.updateEmailRule(rule.id, { enabled: !rule.enabled }));
  }

  const rows = rules ? ruleRows(rules) : null;

  return (
    <div className="page">
      {toastNode}
      <div className="page-actions">
        <button className="btn btn-primary" onClick={openNew}>New rule</button>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rules && <Spinner label="Loading email parsing rules…" />}

      {rows && (
        rows.length === 0 ? (
          <EmptyState
            icon="✉️"
            title="No email parsing rules"
            hint="Keyword rules match inbound email and can set the ticket's category, priority or assignment group. Without rules, the default classification applies."
            action={<button className="btn btn-primary btn-sm" onClick={openNew}>Create the first rule</button>}
          />
        ) : (
          <section className="card" style={{ paddingTop: 16, paddingBottom: 16 }}>
            <div className="card-head">
              <h2>Email parsing rules</h2>
              <span className="muted small">
                Evaluated in precedence order — the lowest number that matches wins for each field.
              </span>
            </div>
            <div className="rule-list">
              {rows.map((row) => (
                <article key={row.id} className={`rule-item${row.enabled ? '' : ' is-off'}`}>
                  <div className="rule-item-head">
                    <div>
                      <strong>{row.name}</strong>
                      <span className="muted small" style={{ marginLeft: 8 }}>
                        precedence {row.precedence} · {row.scopeLabel}
                      </span>
                    </div>
                    <div className="rule-item-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>Edit</button>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => toggleEnabled(row)}>
                        {row.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(row)}>Remove</button>
                    </div>
                  </div>
                  <div className="rule-keywords">
                    {row.keywords.map((kw) => <span key={kw} className="rule-keyword">{kw}</span>)}
                  </div>
                  <div className="muted small">
                    {row.sets.length
                      ? <>Sets: {row.sets.join(' · ')}</>
                      : 'Match only — sets no ticket fields.'}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? 'New email parsing rule' : `Edit rule: ${editing.name}`}
          onClose={() => setEditing(null)}
          width={560}
        >
          <div className="form-grid">
            <Field label="Name" required>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. VPN problems go to Network"
              />
            </Field>
            <Field
              label="Keywords or phrases"
              required
              hint="One per line (or comma-separated). Matched case-insensitively as whole words/phrases in the subject and/or body."
            >
              <textarea
                className="input"
                rows={4}
                value={form.keywordsText}
                onChange={(e) => setForm({ ...form, keywordsText: e.target.value })}
                placeholder={'vpn\nremote access\nconnection drops'}
              />
            </Field>
            <div className="form-row">
              <Field label="Match in">
                <select
                  className="input"
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                >
                  {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Precedence" hint="Lower wins when several rules match.">
                <input
                  className="input"
                  type="number"
                  min="0"
                  max="10000"
                  value={form.precedence}
                  onChange={(e) => setForm({ ...form, precedence: e.target.value })}
                />
              </Field>
            </div>
            <div className="muted small" style={{ margin: '4px 0 8px' }}>
              Leave a field empty to leave that ticket field untouched — a rule only changes what it sets.
            </div>
            <div className="form-row">
              <Field label="Category">
                <input
                  className="input"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="leave empty to keep the classified category"
                />
              </Field>
              <Field label="Priority">
                <select
                  className="input"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                >
                  <option value="">Leave unchanged</option>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Assignment group">
                <select
                  className="input"
                  value={form.teamKey}
                  onChange={(e) => setForm({ ...form, teamKey: e.target.value })}
                >
                  <option value="">Leave unchanged</option>
                  {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
                </select>
              </Field>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              <span>Enabled</span>
            </label>
          </div>

          {formErrors.length > 0 && (
            <div className="callout callout-error" role="alert">
              {formErrors.map((e) => <div key={e}>{e}</div>)}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>Save rule</button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove rule"
          message={`Delete the email parsing rule "${confirmDelete.name}"? Inbound email will no longer match it.`}
          confirmLabel="Delete rule"
          danger
          busy={busy}
          onConfirm={async () => {
            const ok = await run(() => api.deleteEmailRule(confirmDelete.id), 'Rule removed.');
            if (ok) setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
