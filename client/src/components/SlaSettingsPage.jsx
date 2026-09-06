import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, ErrorState, Field, ConfirmDialog, useToast,
} from './ui.jsx';
import {
  WEEKDAYS, timezoneOptions, buildForm, validateForm, formPayload, formDirty,
  normalizeHolidays,
} from '../slaSettingsView.js';

// The backend definition list carries the help lines; keep the page free of
// duplicated rule text.
function hintFor(definitions, key, fallback) {
  const def = definitions?.find((d) => d.key === key);
  const parts = [];
  if (def?.help) parts.push(def.help);
  if (def && def.default != null) parts.push(`Default ${def.default}.`);
  return parts.join(' ') || fallback;
}

function holidayLabel(h) {
  return h.name ? `${h.date} — ${h.name}` : h.date;
}

export default function SlaSettingsPage() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showToast, toastNode] = useToast();
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const next = await api.slaSettings();
      setData(next);
      setForm(buildForm(next));
      setIssues([]);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!form) return <div className="page"><Spinner label="Loading SLA settings…" /></div>;

  const dirty = formDirty(form, data);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleDay = (day) =>
    setForm((f) => ({
      ...f,
      workingDays: f.workingDays.includes(day)
        ? f.workingDays.filter((d) => d !== day)
        : [...f.workingDays, day],
    }));

  async function run(fn, message) {
    setBusy(true);
    try {
      await fn();
      if (message) showToast(message);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const found = validateForm(form);
    setIssues(found);
    if (found.length) return;
    run(async () => {
      const next = await api.updateSlaSettings(formPayload(form));
      setData(next);
      setForm(buildForm(next));
    }, 'SLA settings saved — new cycles will use them');
  }

  function addHoliday() {
    if (!newHoliday.date) {
      showToast('Pick a date for the holiday', 'error');
      return;
    }
    run(async () => {
      const next = await api.addSlaHoliday({
        date: newHoliday.date,
        name: newHoliday.name.trim() || null,
      });
      setData((d) => ({ ...d, holidays: next.holidays }));
      setForm((f) => ({ ...f, holidays: normalizeHolidays(next.holidays) }));
      setNewHoliday({ date: '', name: '' });
      showToast(next.updated ? `Holiday updated — ${next.holiday.date} was already recorded` : 'Holiday added');
    });
  }

  function removeHoliday(h) {
    setConfirmDelete(null);
    run(async () => {
      const next = await api.deleteSlaHoliday(h.id);
      setData((d) => ({ ...d, holidays: next.holidays }));
      setForm((f) => ({ ...f, holidays: normalizeHolidays(next.holidays) }));
    }, 'Holiday removed');
  }

  return (
    <div className="page">
      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>SLA targets &amp; working calendar</h2>
          <span className="chip chip-dev">admin</span>
        </div>

        <div className="settings-group-label">Response target</div>
        <div className="settings-grid">
          <Field label="Response SLA target (working minutes)" hint={hintFor(data.definitions, 'slaResponseTargetMinutes')}>
            <input type="number" min="1" value={form.slaResponseTargetMinutes} onChange={set('slaResponseTargetMinutes')} />
          </Field>
        </div>

        <div className="settings-group-label">Resolution targets by priority</div>
        <div className="settings-grid">
          {['slaResolutionHoursCritical', 'slaResolutionHoursHigh', 'slaResolutionHoursModerate', 'slaResolutionHoursLow'].map((key) => (
            <Field
              key={key}
              label={data.definitions?.find((d) => d.key === key)?.label || key}
              hint={hintFor(data.definitions, key)}
            >
              <input type="number" min="1" value={form[key]} onChange={set(key)} />
            </Field>
          ))}
        </div>

        <div className="settings-group-label">Working calendar</div>
        <div className="field">
          <span className="field-label">Working days</span>
          <div className="day-toggles">
            {WEEKDAYS.map(({ day, label }) => (
              <button
                key={day}
                type="button"
                className={`day-toggle ${form.workingDays.includes(day) ? 'is-on' : ''}`}
                aria-pressed={form.workingDays.includes(day)}
                disabled={busy}
                onClick={() => toggleDay(day)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field-hint">{hintFor(data.definitions, 'slaWorkingDays')}</span>
        </div>
        <div className="settings-grid">
          <Field label="Working day starts (hour)" hint={hintFor(data.definitions, 'slaWorkdayStartHour')}>
            <select value={form.slaWorkdayStartHour} onChange={set('slaWorkdayStartHour')}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
          </Field>
          <Field label="Working day ends (hour)" hint={hintFor(data.definitions, 'slaWorkdayEndHour')}>
            <select value={form.slaWorkdayEndHour} onChange={set('slaWorkdayEndHour')}>
              {Array.from({ length: 24 }, (_, i) => {
                const h = i + 1;
                return <option key={h} value={h}>{h === 24 ? '24:00 (midnight)' : `${String(h).padStart(2, '0')}:00`}</option>;
              })}
            </select>
          </Field>
          <Field label="Timezone" hint={hintFor(data.definitions, 'slaTimezone')}>
            <input
              list="sla-timezone-options"
              value={form.slaTimezone}
              onChange={set('slaTimezone')}
              placeholder="Africa/Lagos"
            />
            <datalist id="sla-timezone-options">
              {timezoneOptions().map((tz) => <option key={tz} value={tz} />)}
            </datalist>
          </Field>
        </div>

        {issues.length > 0 && (
          <div className="callout callout-error" role="alert">
            <div>
              <strong>Please fix the following before saving.</strong>
              <ul className="settings-errors">
                {issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            </div>
          </div>
        )}

        <div className="btn-row">
          <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>
            Save settings
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy || !dirty}
            onClick={() => { setForm(buildForm(data)); setIssues([]); }}
          >
            Reset
          </button>
        </div>
        <span className="settings-note">
          Saving applies to SLA cycles started afterwards — existing cycles keep the targets they were created with.
        </span>
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Public holidays</h2>
          <span className="muted small">{form.holidays.length} recorded</span>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          No working time accrues on these dates. Holidays take effect for SLA cycles started from now on;
          adding or removing one never rewrites an existing cycle's targets.
        </p>

        <div className="field">
          <span className="field-label">Add a holiday</span>
          <div className="assign-controls">
            <input
              type="date"
              value={newHoliday.date}
              onChange={(e) => setNewHoliday((n) => ({ ...n, date: e.target.value }))}
              style={{ flex: '0 0 160px' }}
              aria-label="Holiday date"
            />
            <input
              type="text"
              value={newHoliday.name}
              placeholder="Name (optional) — e.g. Independence Day"
              onChange={(e) => setNewHoliday((n) => ({ ...n, name: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addHoliday()}
              style={{ flex: 1 }}
              aria-label="Holiday name (optional)"
            />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={addHoliday}>
              Add
            </button>
          </div>
        </div>

        {form.holidays.length === 0 ? (
          <p className="muted small">No holidays recorded — every non-weekend day counts as a working day.</p>
        ) : (
          form.holidays.map((h) => (
            <div key={h.id} className="kv-row">
              <span>{holidayLabel(h)}</span>
              <button
                className="btn btn-ghost btn-sm btn-danger-quiet"
                disabled={busy}
                onClick={() => setConfirmDelete(h)}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </section>

      {confirmDelete && (
        <ConfirmDialog
          title={`Remove ${holidayLabel(confirmDelete)}?`}
          message="The date stops pausing SLA time. Cycles that already started keep their frozen targets."
          confirmLabel="Remove holiday"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => removeHoliday(confirmDelete)}
        />
      )}
      {toastNode}
    </div>
  );
}
