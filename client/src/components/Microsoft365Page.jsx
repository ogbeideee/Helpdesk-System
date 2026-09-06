import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState, fmtDateTime } from './ui.jsx';
import {
  checklistRows, configRows, subscriptionRows, runtimeRows,
  stateView, verifyAvailability, verifyResultView,
} from '../m365View.js';

/**
 * Administrator screen for the Microsoft 365 (Microsoft Graph) email
 * integration. The integration is environment-configured, so this page is a
 * read-only view: what is configured, whether it is on, the required-value
 * checklist for connecting a real tenant, and an explicit credential check.
 *
 * The client secret and access tokens are never sent by the API and are never
 * displayed here — the checklist reports them as "set (hidden)".
 */
export default function Microsoft365Page() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.m365();
      setData(d);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    // The integration runs in the background — poll so the runtime picture
    // (last poll, last error) stays current without a manual refresh.
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function runVerify() {
    setVerifying(true);
    setVerifyNote('');
    try {
      await api.verifyM365();
      await load();
    } catch (e) {
      setVerifyNote(e.message);
    } finally {
      setVerifying(false);
    }
  }

  if (error) {
    return (
      <div className="page">
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return <div className="page"><Spinner /></div>;
  }

  const view = stateView(data);
  const checkRows = checklistRows(data);
  const missing = checkRows.filter((r) => !r.present).length;
  const verify = verifyAvailability(data);
  const verifyResult = verifyResultView(data.connection);

  return (
    <div className="page">
      <div className={`callout ${view.tone === 'warn' ? 'callout-error' : ''}`} role="status">
        <div>
          <strong>{view.title}</strong>{' '}
          <span className={`chip ${data.state === 'enabled' ? 'chip-ok' : data.state === 'disabled' ? 'chip-warn' : ''}`}>
            {data.state === 'enabled' ? 'Enabled' : data.state === 'disabled' ? 'Disabled' : 'Not configured'}
          </span>
          <div className="muted">{view.body}</div>
          {view.tone === 'warn' && data.runtime?.lastError && (
            <div className="small" style={{ marginTop: 4 }}>
              {data.runtime.lastError.message} — {fmtDateTime(data.runtime.lastError.at)}
            </div>
          )}
        </div>
      </div>

      {missing > 0 && (
        <div className="callout">
          <strong>{missing} required value{missing === 1 ? '' : 's'} missing.</strong>{' '}
          <span className="muted">
            Microsoft 365 stays inactive until they are set in the server environment. The application
            starts normally without them, and IMAP ingestion is unaffected.
          </span>
        </div>
      )}

      <section className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="card-head">
          <h2>Required configuration</h2>
          <span className="muted small">Set in the server environment — restart the server after changing them</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Environment variable</th>
              <th>What it is</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {checkRows.map((row) => (
              <tr key={row.variable}>
                <td className="mono-sm">{row.variable}</td>
                <td>
                  {row.label}
                  {row.problem && <div className="small" style={{ color: 'var(--danger)' }}>{row.problem}</div>}
                </td>
                <td>
                  <span className={`chip ${row.present ? 'chip-ok' : 'chip-warn'}`}>
                    {row.present ? (row.secret ? 'set (hidden)' : 'set') : 'missing'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <section className="card" style={{ padding: 16 }}>
          <div className="card-head"><h2>Effective configuration</h2></div>
          {configRows(data).map((row) => (
            <div className="kv-row" key={row.label}>
              <span className="muted">{row.label}</span>
              <strong style={{ textAlign: 'right' }}>{row.value}</strong>
            </div>
          ))}
        </section>

        <section className="card" style={{ padding: 16 }}>
          <div className="card-head"><h2>Change-notification subscription</h2></div>
          {subscriptionRows(data).map((row) => (
            <div className="kv-row" key={row.label}>
              <span className="muted">{row.label}</span>
              <strong style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{row.value}</strong>
            </div>
          ))}
          <div className="muted small" style={{ marginTop: 8 }}>
            Without a subscription the poller alone fetches new mail — both paths feed the same pipeline.
          </div>
        </section>

        <section className="card" style={{ padding: 16 }}>
          <div className="card-head"><h2>Runtime</h2></div>
          {runtimeRows(data).map((row) => (
            <div className="kv-row" key={row.label}>
              <span className="muted">{row.label}</span>
              <strong style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{row.value}</strong>
            </div>
          ))}
        </section>
      </div>

      <section className="card" style={{ padding: 16 }}>
        <div className="card-head">
          <h2>Credential check</h2>
          <span className="muted small">Acquires a token and reads the shared mailbox profile — read-only, sends nothing</span>
        </div>
        {verifyResult && (
          <div className={`callout ${verifyResult.ok ? '' : 'callout-error'}`} style={{ marginBottom: 12 }}>
            {verifyResult.text}
          </div>
        )}
        {verifyNote && <div className="callout callout-error" style={{ marginBottom: 12 }}>{verifyNote}</div>}
        <button className="btn" onClick={runVerify} disabled={!verify.enabled || verifying}>
          {verifying ? 'Validating…' : 'Validate connection'}
        </button>
        {!verify.enabled && <div className="muted small" style={{ marginTop: 8 }}>{verify.reason}</div>}
        <div className="muted small" style={{ marginTop: 8 }}>
          The client secret and access tokens are never displayed, stored by this console, or returned by the API.
        </div>
      </section>
    </div>
  );
}
