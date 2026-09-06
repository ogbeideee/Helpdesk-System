import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState, EmptyState, useToast } from './ui.jsx';
import { KpiCard } from './Dashboard.jsx';
import {
  reportKpiCards, bucketRows, overTimeRows, sourceRows, hasReportData,
  buildReportQuery, rangeLabel,
} from '../slaReportView.js';

// One bucket table: the report's byPriority / byGroup / byAgent arrays share
// the exact same shape, so a single renderer keeps them consistent.
function BucketTable({ title, rows, emptyHint }) {
  return (
    <section className="card" style={{ paddingTop: 16 }}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="muted small">completed cycles</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="◻" title="Nothing attributed yet" hint={emptyHint} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{title.replace(/^By /, '')}</th>
                <th className="tnum">Completed</th>
                <th className="tnum">Met</th>
                <th className="tnum">Compliance</th>
                <th className="tnum">Resp. breaches</th>
                <th className="tnum">Avg first response</th>
                <th className="tnum">Res. breaches</th>
                <th className="tnum">Avg resolution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key ?? r.name}>
                  <td><strong>{r.name ?? '—'}</strong></td>
                  <td className="tnum">{r.total}</td>
                  <td className="tnum">{r.met}</td>
                  <td className="tnum">{r.rate}</td>
                  <td className="tnum">{r.responseBreached}</td>
                  <td className="tnum">{r.avgResponse ?? '—'}</td>
                  <td className="tnum">{r.resolutionBreached}</td>
                  <td className="tnum">{r.avgResolution ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Volume & outcomes over time: a pure-CSS bar chart in the app's visual
// language — met time in the success tone, breached in the danger tone,
// started volume as a thin track behind them.
function OverTimeChart({ rows }) {
  return (
    <div className="overtime-chart">
      <div className="overtime-head">
        <span className="muted small">Day</span>
        <span className="muted small">Started</span>
        <span className="muted small">Outcomes (met / breached)</span>
        <span className="muted small tnum">Met</span>
        <span className="muted small tnum">Breached</span>
      </div>
      {rows.map((r) => (
        <div key={r.day} className="overtime-row">
          <span className="overtime-day">{r.day}</span>
          <span className="tnum overtime-started" title={`${r.started} cycle(s) started`}>{r.started}</span>
          <span className="overtime-bar" role="presentation">
            <span className="overtime-track" style={{ width: `${r.startedPct}%` }} />
            <span className="overtime-seg seg-met" style={{ width: `${r.metPct}%` }} title={`${r.met} met`} />
            <span className="overtime-seg seg-breached" style={{ width: `${r.breachedPct}%` }} title={`${r.breached} breached`} />
          </span>
          <span className="tnum">{r.met}</span>
          <span className="tnum">{r.breached}</span>
        </div>
      ))}
    </div>
  );
}

export default function SlaReportsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({});
  const [showToast, toastNode] = useToast();

  const load = useCallback(async (params = {}) => {
    setError('');
    try {
      setData(await api.slaReport(params));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load({}); }, [load]);

  async function applyRange(e) {
    e.preventDefault();
    const verdict = buildReportQuery(draft);
    if (!verdict.ok) {
      showToast(verdict.error, 'error');
      return;
    }
    setBusy(true);
    try {
      const qs = Object.fromEntries(new URLSearchParams(verdict.query));
      await load(qs);
      setApplied(qs);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clearRange() {
    setDraft({ from: '', to: '' });
    setBusy(true);
    try {
      await load({});
      setApplied({});
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page"><ErrorState message={error} onRetry={() => load(applied)} /></div>;
  if (!data) return <div className="page"><Spinner label="Loading SLA report…" /></div>;

  const { historical, live } = reportKpiCards(data);
  const priorityRows = bucketRows(data.byPriority, 'priority');
  const groupRows = bucketRows(data.byGroup, 'group');
  const agentRows = bucketRows(data.byAgent, 'agent');
  const chartRows = overTimeRows(data);
  const sources = sourceRows(data.totals.sources);

  return (
    <div className="page">
      <form className="page-actions report-controls" onSubmit={applyRange}>
        <label className="report-date">
          <span>From</span>
          <input type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
        </label>
        <label className="report-date">
          <span>To</span>
          <input type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Apply range</button>
        {(applied.from || applied.to) && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={clearRange}>
            All time
          </button>
        )}
        <span className="muted small report-showing">
          Showing: {rangeLabel(data.range)}
        </span>
      </form>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Completed-cycle performance</h2>
          <span className="muted small">historical · range-filtered by the API</span>
        </div>
        {!data.totals.total ? (
          <EmptyState
            icon="📊"
            title="No completed SLA cycles in this range"
            hint="Widen the date range, or run the SLA backfill for tickets that predate the SLA feature."
          />
        ) : (
          <div className="kpi-row kpi-row-sla" aria-label="Completed SLA performance">
            {historical.map((c) => <KpiCard key={c.label} {...c} />)}
          </div>
        )}
        {sources.length > 0 && (
          <div className="source-split">
            {sources.map((s) => (
              <span key={s.key} className="source-split-item">
                <strong>{s.label}</strong>
                <span className="muted small">{s.total} completed · {s.met} met · {s.rate}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Live right now</h2>
          <span className="chip chip-dev">current</span>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          The current state of open cycles — separate from the completed-cycle figures above and unaffected by the date range.
        </p>
        <div className="kpi-row kpi-row-sla" aria-label="Live SLA state">
          {live.map((c) => <KpiCard key={c.label} {...c} />)}
        </div>
      </section>

      <BucketTable
        title="By priority"
        rows={priorityRows}
        emptyHint="Completed cycles appear here once tickets with SLA cycles resolve."
      />
      <BucketTable
        title="By assignment group"
        rows={groupRows}
        emptyHint="Cycles are attributed to the group the ticket ended with."
      />
      <BucketTable
        title="By agent"
        rows={agentRows}
        emptyHint="Cycles are attributed to the agent who owned the ticket when it resolved or was answered."
      />

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Volume &amp; outcomes over time</h2>
          <span className="muted small">
            per calendar day{data.range.from ? '' : ' · all time'}
          </span>
        </div>
        {chartRows.length === 0 ? (
          <EmptyState icon="📈" title="No SLA cycle activity in this range" hint="Days appear once cycles start or complete." />
        ) : (
          <OverTimeChart rows={chartRows} />
        )}
      </section>

      {toastNode}
    </div>
  );
}
