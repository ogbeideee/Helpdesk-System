import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Spinner, ErrorState, useToast } from './ui.jsx';
import { outcomeLabel, deliveryLabel, operationTime, decisionExplanation } from '../operationsView.js';

export default function OperationsSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [greeting, setGreeting] = useState('Dear Bash,');
  const [preview, setPreview] = useState(null);
  const [toast, toastNode] = useToast();
  async function load() {
    try { const next = await api.operations(); setData(next); setForm(current => current || next.settings); setError(''); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function run(action) {
    setBusy(true);
    try { await action(); } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data || !form) return <Spinner label="Loading email operations…" />;
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  return <>
    {toastNode}
    <section className="card">
      <div className="card-head"><h2>Email intake and name aliases</h2><button className="btn" disabled={busy} onClick={() => run(load)}>Refresh</button></div>
      <div className="card-body">
        <Field label="Assign by opening greeting"><select value={form.intakeAddressedRouting} onChange={e => set('intakeAddressedRouting', e.target.value)}><option value="1">Enabled</option><option value="0">Disabled</option></select></Field>
        <Field label="Name aliases" hint="One nickname = saved agent name per line. Each nickname must identify one account."><textarea rows={5} value={form.intakeAddressedAliases || ''} onChange={e => set('intakeAddressedAliases', e.target.value)} placeholder={'bash = Bashir Oladipo\nyemi = Ibiyemi Aboyewa'} /></Field>
        <Field label="Helpdesk and department DL addresses" hint="Comma separated. Include the addresses that deliver mail to the helpdesk."><textarea rows={2} value={form.intakeMailboxAddresses || ''} onChange={e => set('intakeMailboxAddresses', e.target.value)} /></Field>
        <Field label="Ignore copied mail from our accounts"><select value={form.intakeInternalCopies} onChange={e => set('intakeInternalCopies', e.target.value)}><option value="1">Enabled</option><option value="0">Disabled</option></select></Field>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { const next = await api.updateIntakeSettings(form); setData(next); setForm(next.settings); setPreview(null); toast('Intake settings saved'); })}>Save intake settings</button>
        <Field label="Test an opening greeting" hint="Tests saved settings. The assignment engine still checks availability, skill, group and workload."><input value={greeting} maxLength={300} onChange={e => { setGreeting(e.target.value); setPreview(null); }} /></Field>
        <button className="btn" disabled={busy} onClick={() => run(async () => setPreview(await api.previewGreeting(greeting)))}>Test greeting</button>
        {preview && <p role="status">{preview.enabled ? `${preview.match.agentName || 'No unique agent'}: ${preview.match.reason}` : 'Greeting routing is disabled.'}</p>}
      </div>
    </section>
    <section className="card">
      <div className="card-head"><h2>Email delivery</h2><span className="muted small">Latest 100 deliveries · automatic retry up to five attempts</span></div>
      <div className="table-wrap table-stack"><table className="table"><thead><tr><th>Created</th><th>Alert</th><th>Status</th><th>Attempts</th><th>Next attempt</th><th>Action</th></tr></thead><tbody>
        {data.deliveries.map(row => <tr key={row.id}><td data-label="Created">{operationTime(row.createdAt)}</td><td data-label="Alert">{row.title}</td><td data-label="Status">{deliveryLabel(row.emailStatus)}{row.emailError && <div className="muted small">{row.emailError}</div>}</td><td data-label="Attempts">{row.emailAttempts}</td><td data-label="Next attempt">{operationTime(row.emailNextAttemptAt)}</td><td data-label="Action">{row.emailStatus === 'failed' && <button className="btn" disabled={busy} onClick={() => run(async () => { await api.retryDelivery(row.id); await load(); toast('Delivery queued for retry'); })}>Retry</button>}</td></tr>)}
        {!data.deliveries.length && <tr><td colSpan={6}>No delivery records yet.</td></tr>}
      </tbody></table></div>
    </section>
    <section className="card">
      <div className="card-head"><h2>Intake decisions</h2><span className="muted small">Latest 100 outcomes · recorded from this release onward</span></div>
      <div className="table-wrap table-stack"><table className="table"><thead><tr><th>Time</th><th>Ticket</th><th>Outcome</th><th>Explanation</th></tr></thead><tbody>
        {data.decisions.map(row => <tr key={row.id}><td data-label="Time">{operationTime(row.createdAt)}</td><td data-label="Ticket">{row.entityLabel}</td><td data-label="Outcome">{outcomeLabel(row.metadata?.outcome)}</td><td data-label="Explanation">{decisionExplanation(row)}</td></tr>)}
        {!data.decisions.length && <tr><td colSpan={4}>No intake decisions recorded yet.</td></tr>}
      </tbody></table></div>
    </section>
  </>;
}
