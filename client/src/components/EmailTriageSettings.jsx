import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorState, Field, Spinner, useToast } from './ui.jsx';

const MODES = [
  { value: 'disabled', label: 'Disabled — no model calls' },
  { value: 'shadow', label: 'Shadow — record only, always ticket' },
  { value: 'auto_skip', label: 'Auto-skip — conservative suppression' },
];

function formFrom(data) {
  return {
    mode: data.settings.mode,
    threshold: String(data.settings.threshold),
    requireApprovedSender: data.settings.requireApprovedSender ? '1' : '0',
    approvedSenders: (data.settings.approvedSenders || []).join(', '),
    skipReasonCodes: (data.settings.skipReasonCodes || []).join(', '),
  };
}

function sameForm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function metric(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  return `${value}${suffix}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function EmailTriageSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const next = await api.emailTriageManagement();
      setData(next);
      setForm((current) => current || formFrom(next));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data || !form) return <Spinner label="Loading email triage controls…" />;

  const dirty = !sameForm(form, formFrom(data));
  const hardStopped = data.runtime.hardKillSwitch;
  const autoSkipActive = data.settings.mode === 'auto_skip' && !hardStopped;
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      const next = await api.updateEmailTriageSettings({
        intakeRelevanceMode: form.mode,
        intakeRelevanceSkipThreshold: Number(form.threshold),
        intakeRelevanceRequireApprovedSender: Number(form.requireApprovedSender),
        intakeRelevanceApprovedSenders: form.approvedSenders,
        intakeRelevanceSkipReasonCodes: form.skipReasonCodes,
      });
      setData(next);
      setForm(formFrom(next));
      showToast('Email triage settings saved');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function disableAutoSkip() {
    setBusy(true);
    try {
      const next = await api.disableEmailTriageAutoSkip();
      setData(next);
      setForm(formFrom(next));
      showToast('Auto-skip disabled — new mail will follow normal intake');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function testProvider() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testEmailTriageProvider();
      setTestResult(result);
      showToast(result.ok ? 'Groq provider check passed' : `Provider check failed (${result.errorCode})`, result.ok ? undefined : 'error');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="card triage-settings-card">
      <div className="card-head">
        <div>
          <h2>Email relevance triage</h2>
          <span className="muted small">Groq policy, monitoring and emergency controls</span>
        </div>
        <span className={`chip ${autoSkipActive ? 'chip-role-admin' : 'chip-dev'}`}>
          {hardStopped ? 'ENVIRONMENT STOP' : data.settings.mode.replace('_', ' ').toUpperCase()}
        </span>
      </div>

      {hardStopped && (
        <div className="callout callout-error" role="alert">
          <strong>Environment kill switch is engaged.</strong>
          <div className="muted">
            No Groq request can leave this server while INTAKE_TRIAGE_KILL_SWITCH is true. Clear it
            through the server/Fly environment before enabling the feature.
          </div>
        </div>
      )}
      {data.runtime.circuit?.open && (
        <div className="callout callout-warning" role="alert">
          <strong>Provider circuit is open.</strong>
          <div className="muted">
            Consecutive provider failures have paused new Groq calls briefly. Messages continue
            through normal ticket creation until the circuit closes.
          </div>
        </div>
      )}
      {!data.runtime.keyConfigured && (
        <div className="callout callout-warning" role="status">
          <strong>Groq API key is not configured.</strong>
          <div className="muted">Add GROQ_API_KEY as a server secret, then use Provider check.</div>
        </div>
      )}
      {autoSkipActive && (
        <div className="callout callout-warning" role="status">
          <strong>Auto-skip is active for approved policy classes.</strong>
          <div className="muted">
            Any uncertainty, provider error, malformed response, unapproved sender or action signal
            creates a ticket. Use Disable auto-skip below for an immediate stop.
          </div>
        </div>
      )}
      {autoSkipActive && data.settings.requireApprovedSender && data.settings.approvedSenders.length === 0 && (
        <div className="callout callout-warning" role="status">
          <strong>No approved senders are configured.</strong>
          <div className="muted">Auto-skip will currently create tickets for every message.</div>
        </div>
      )}

      <div className="triage-metrics" aria-label="Email triage monitoring">
        <div className="triage-metric"><span>Decisions</span><strong>{metric(data.metrics.total)}</strong><small>all recorded</small></div>
        <div className="triage-metric"><span>Last 24h</span><strong>{metric(data.metrics.last24h)}</strong><small>provider decisions</small></div>
        <div className="triage-metric"><span>Skipped</span><strong>{metric(data.metrics.skipped)}</strong><small>{metric(data.metrics.skipRate, '%')}</small></div>
        <div className="triage-metric"><span>Ticket candidates</span><strong>{metric(data.metrics.ticketCandidates)}</strong><small>provider errors included</small></div>
        <div className="triage-metric"><span>p95 latency</span><strong>{metric(data.metrics.p95LatencyMs, ' ms')}</strong><small>provider round trip</small></div>
        <div className="triage-metric"><span>Errors</span><strong className={data.metrics.errors ? 'warn-text' : ''}>{metric(data.metrics.errors)}</strong><small>{metric(data.metrics.errorRate, '%')} of decisions</small></div>
      </div>

      <div className="callout callout-warning" role="status">
        <strong>Cloud privacy checkpoint</strong>
        <div className="muted">
          Real subject/body text leaves this server when the model is enabled. Confirm your Groq
          Zero Data Retention and organizational privacy approval before selecting Auto-skip.
        </div>
      </div>

      <div className="settings-group-label">Runtime policy</div>
      <div className="settings-grid">
        <Field label="Mode" hint="Disabled is the safe default. Shadow never suppresses a ticket.">
          <select value={form.mode} onChange={(e) => set('mode', e.target.value)} disabled={busy || hardStopped}>
            {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </Field>
        <Field label="Minimum auto-skip confidence (%)" hint="The local policy also blocks action signals and unapproved senders.">
          <input type="number" min="95" max="100" value={form.threshold} onChange={(e) => set('threshold', e.target.value)} disabled={busy} />
        </Field>
      </div>

      <div className="field triage-checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={form.requireApprovedSender === '1'}
            onChange={(e) => set('requireApprovedSender', e.target.checked ? '1' : '0')}
            disabled={busy}
          />
          <span>Only auto-skip messages from approved senders</span>
        </label>
        <span className="field-hint">Keep this enabled for the first production rollout.</span>
      </div>

      <Field
        label="Approved senders"
        hint="Comma-separated local-part prefixes, exact addresses, or @domains. Leave empty to allow no sender while the requirement is enabled."
      >
        <textarea
          rows={2}
          value={form.approvedSenders}
          onChange={(e) => set('approvedSenders', e.target.value)}
          placeholder="hr-announcements@example.com,@updates.example.com"
          disabled={busy}
        />
      </Field>
      <Field
        label="Allowed reason codes"
        hint="Remove codes to make the policy narrower. Unknown codes are rejected by the server."
      >
        <textarea
          rows={2}
          value={form.skipReasonCodes}
          onChange={(e) => set('skipReasonCodes', e.target.value)}
          disabled={busy}
        />
      </Field>

      <div className="btn-row triage-actions">
        <button className="btn btn-primary btn-sm" disabled={busy || !dirty || hardStopped} onClick={save}>
          {busy ? 'Saving…' : 'Save triage policy'}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy || !dirty} onClick={() => setForm(formFrom(data))}>
          Reset
        </button>
        <button className="btn btn-ghost btn-sm" disabled={testing || hardStopped} onClick={testProvider}>
          {testing ? 'Checking Groq…' : hardStopped ? 'Provider check stopped' : 'Check Groq provider'}
        </button>
        <button className="btn btn-danger btn-sm" disabled={busy || data.settings.mode === 'disabled'} onClick={disableAutoSkip}>
          Disable auto-skip now
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={load}>Refresh metrics</button>
      </div>
      <span className="settings-note">
        Model: {data.runtime.model} · prompt: {data.runtime.promptVersion} · timeout: {data.runtime.timeoutMs} ms · key: {data.runtime.keyConfigured ? 'configured' : 'missing'} · circuit: {data.runtime.circuit?.open ? 'open' : 'closed'}
      </span>

      {testResult && (
        <div className={`callout ${testResult.ok ? 'callout-success' : 'callout-error'}`} role="status">
          {testResult.ok
            ? `Provider check passed in ${testResult.latencyMs} ms (${testResult.disposition}, ${Math.round(testResult.confidence * 100)}% confidence).`
            : `Provider check failed: ${testResult.errorCode}.`}
        </div>
      )}

      <div className="settings-group-label">Recent sanitized decisions</div>
      {data.recentDecisions.length === 0 ? (
        <p className="muted small">No provider decisions recorded yet.</p>
      ) : (
        <div className="table-wrap triage-recent-wrap">
          <table className="table triage-recent">
            <thead>
              <tr><th>When</th><th>Action</th><th>Model says</th><th>Reason</th><th>Latency</th><th>Error</th></tr>
            </thead>
            <tbody>
              {data.recentDecisions.map((decision) => (
                <tr key={decision.messageKey}>
                  <td>{formatDate(decision.createdAt)}</td>
                  <td><span className={`pill ${decision.action === 'skipped_non_ticket' ? 'pill-sla' : 'pill-neutral'}`}>{decision.action.replace(/_/g, ' ')}</span></td>
                  <td>{decision.disposition || '—'}</td>
                  <td>{decision.reasonCode || decision.policyCode || '—'}</td>
                  <td>{decision.latencyMs == null ? '—' : `${decision.latencyMs} ms`}</td>
                  <td>{decision.errorCode || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toastNode}
    </section>
  );
}
