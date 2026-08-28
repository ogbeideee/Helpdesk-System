import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const agent = await api.login(email.trim(), password);
      onLogin(agent);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-split">
      <aside className="login-hero">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg">IT</span>
          <div>
            <h1>Helpdesk</h1>
            <p className="muted">Service Console</p>
          </div>
        </div>
        <div>
          <h2>Internal IT service-desk operations.</h2>
          <p>
            Route, work, and resolve tickets across the helpdesk. Triage, assignments,
            handovers, and routing rules live in one place — built for the team, not
            for a quarterly demo.
          </p>
        </div>
        <div className="hero-foot">
          <span><strong>Operations</strong> · tickets · handovers</span>
          <span><strong>Administration</strong> · agents · routing</span>
        </div>
      </aside>
      <main className="login-pane">
        <form onSubmit={handleSubmit} className="login-card">
          <div className="card-head" style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Sign in</h2>
          </div>
          {error && <div className="callout callout-error" role="alert">{error}</div>}
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourcompany.com"
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="btn btn-primary btn-block" disabled={busy} style={{ marginTop: 10, padding: '9px 13px' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="login-hint muted">Access is restricted to IT staff accounts.</p>
        </form>
      </main>
    </div>
  );
}
