import { useState } from 'react';
import { api } from '../api.js';
import { Avatar, Field, useToast } from './ui.jsx';
import EmailTriageSettings from './EmailTriageSettings.jsx';

/**
 * Self-service account settings, reached from the account menu in the header.
 * Everything here is the signed-in user's own record — administrative fields
 * (role, group, skill, activation) stay on the Agents screen for admins. The
 * admin-only email triage control below manages the shared intake policy.
 *
 * Preferences that act on the whole product (appearance, availability) are NOT
 * duplicated here: appearance lives in the header theme toggle, availability
 * in the navigation rail — the page says so instead of rebuilding them.
 */
export default function SettingsPage({ me, onUpdated }) {
  const [name, setName] = useState(me.name || '');
  const [nameBusy, setNameBusy] = useState(false);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [showToast, toastNode] = useToast();

  const nameDirty = name.trim() !== (me.name || '');
  const setPwField = (key) => (e) => setPw((f) => ({ ...f, [key]: e.target.value }));

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Display name is required', 'error');
      return;
    }
    setNameBusy(true);
    try {
      const updated = await api.updateProfile({ name: trimmed });
      onUpdated?.(updated);
      setName(updated.name || '');
      showToast('Display name updated');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setNameBusy(false);
    }
  }

  async function savePassword() {
    if (!pw.currentPassword || !pw.newPassword) {
      showToast('Enter your current password and a new password', 'error');
      return;
    }
    if (pw.newPassword.length < 8) {
      showToast('New password must be at least 8 characters', 'error');
      return;
    }
    if (pw.newPassword !== pw.confirm) {
      showToast('New passwords do not match', 'error');
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword({ currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      showToast('Password changed — use it the next time you sign in');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="page settings-page">
      <section className="card">
        <div className="card-head">
          <h2>Profile</h2>
          <span className="muted small">How you appear across the console</span>
        </div>

        <div className="settings-identity">
          <Avatar name={name.trim() || me.email} size={44} />
          <div className="settings-identity-text">
            <strong>{me.email}</strong>
            <span className="muted small">
              {me.role === 'admin' ? 'Administrator' : me.role === 'agent' ? 'Agent' : 'User'}
              {me.team?.name ? ` · ${me.team.name}` : ''} — your sign-in address and role are
              changed by an administrator.
            </span>
          </div>
        </div>

        <Field
          label="Display name"
          hint="Shown on tickets, comments, assignment and notifications — anywhere the console names you."
        >
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && nameDirty && !nameBusy && saveName()}
          />
        </Field>
        <div className="btn-row">
          <button className="btn btn-primary btn-sm" disabled={nameBusy || !nameDirty} onClick={saveName}>
            {nameBusy ? 'Saving…' : 'Save profile'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={nameBusy || !nameDirty}
            onClick={() => setName(me.name || '')}
          >
            Reset
          </button>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Security</h2>
          <span className="muted small">Change your password</span>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Your current password is required so a momentarily unattended, signed-in session
          cannot be used to lock you out. After changing it, this session stays signed in
          until it expires; your next sign-in uses the new password.
        </p>

        <Field label="Current password" required>
          <input
            type="password"
            value={pw.currentPassword}
            autoComplete="current-password"
            onChange={setPwField('currentPassword')}
          />
        </Field>
        <Field label="New password" hint="At least 8 characters." required>
          <input
            type="password"
            value={pw.newPassword}
            autoComplete="new-password"
            onChange={setPwField('newPassword')}
          />
        </Field>
        <Field label="Confirm new password" required>
          <input
            type="password"
            value={pw.confirm}
            autoComplete="new-password"
            onChange={setPwField('confirm')}
            onKeyDown={(e) => e.key === 'Enter' && !pwBusy && savePassword()}
          />
        </Field>
        <div className="btn-row">
          <button className="btn btn-primary btn-sm" disabled={pwBusy} onClick={savePassword}>
            {pwBusy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Preferences</h2>
        </div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 8 }}>
          Some preferences live where they act, so there is only one place to look:
        </p>
        <ul className="settings-prefs muted small">
          <li>
            <strong>Appearance</strong> — the light/dark toggle in the header, next to search.
            It follows your operating system until you choose explicitly.
          </li>
          <li>
            <strong>Availability</strong> — the control in the navigation rail. It tells the
            assignment engine whether you can take new work.
          </li>
          <li>
            <strong>Notifications</strong> — the bell in the header lists everything addressed
            to you; email copies are sent by the system automatically.
          </li>
        </ul>
      </section>

      {me.role === 'admin' && <EmailTriageSettings />}

      {toastNode}
    </div>
  );
}
