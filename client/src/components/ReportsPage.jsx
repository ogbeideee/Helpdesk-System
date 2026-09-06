import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState, EmptyState, useToast } from './ui.jsx';
import { KpiCard } from './Dashboard.jsx';
import { buildReportQuery, rangeLabel } from '../slaReportView.js';
import {
  reportKpiCards, volumeRows, distributionRows, groupRows, agentRows,
  currentCards, slaSummary, hasRangeData,
} from '../reportsView.js';

// Created-vs-resolved per day: the same pure-CSS bar language as the SLA
// report's over-time chart, with one bar per series side by side.
function VolumeChart({ rows }) {
  return (
    <div className="volume-chart">
      <div className="volume-head">
        <span className="muted small">Day</span>
        <span className="muted small">Created</span>
        <span className="muted small">Resolved</span>
      </div>
      {rows.map((r) => (
        <div key={r.day} className="volume-row">
          <span className="overtime-day">{r.day}</span>
          <span className="volume-cell">
            <span className="tnum">{r.created}</span>
            <span className="overtime-bar" role="presentation">
              <span className="overtime-seg seg-created" style={{ width: `${r.createdPct}%` }} title={`${r.created} created`} />
            </span>
          </span>
          <span className="volume-cell">
            <span className="tnum">{r.resolved}</span>
            <span className="overtime-bar" role="presentation">
              <span className="overtime-seg seg-resolved" style={{ width: `${r.resolvedPct}%` }} title={`${r.resolved} resolved`} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// One distribution table (status / priority): count plus a share bar.
function DistributionTable({ title, rows, labelFor }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="tnum">Tickets</th>
            <th className="tnum">Share</th>
            <th aria-label="Share bar" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.state ?? r.priority}>
              <td><strong>{labelFor(r)}</strong></td>
              <td className="tnum">{r.count}</td>
              <td className="tnum">{r.share ? `${r.share}%` : '—'}</td>
              <td className="share-cell">
                {r.share > 0 && (
                  <span className="overtime-bar share-bar" role="presentation">
                    <span className="overtime-seg seg-created" style={{ width: `${r.share}%` }} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttributionTable({ title, rows, emptyHint }) {
  return (
    <div className="table-wrap">
      {rows.length === 0 ? (
        <EmptyState icon="◻" title="Nothing attributed yet" hint={emptyHint} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{title}</th>
              <th className="tnum">Tickets</th>
              <th className="tnum">Still open</th>
              <th className="tnum">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id ?? r.name}>
                <td><strong>{r.name}</strong></td>
                <td className="tnum">{r.count}</td>
                <td className="tnum">{r.open}</td>
                <td className="tnum">{r.share ? `${r.share}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({});
  const [showToast, toastNode] = useToast();

  const load = useCallback(async (params = {}) => {
    setError('');
    try {
      setData(await api.reports(params));
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
  if (!data) return <div className="page"><Spinner label="Loading reports…" /></div>;

  const cards = reportKpiCards(data);
  const volume = volumeRows(data.volume);
  const status = distributionRows(data.byStatus);
  const priority = distributionRows(data.byPriority);
  const groups = groupRows(data.byGroup);
  const agents = agentRows(data.byAgent);
  const snapshot = currentCards(data.current);
  const sla = slaSummary(data.sla);
  const inRange = hasRangeData(data);

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
          <h2>Tickets in range</h2>
          <span className="muted small">volume · resolution · first response</span>
        </div>
        {!inRange ? (
          <EmptyState
            icon="📊"
            title="No ticket activity in this range"
            hint="Widen the date range — the current queue snapshot below is live regardless of the range."
          />
        ) : (
          <div className="kpi-row kpi-row-sla" aria-label="Range metrics">
            {cards.map((c) => <KpiCard key={c.label} {...c} />)}
          </div>
        )}
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Ticket volume over time</h2>
          <span className="muted small">created vs resolved · per day{data.range.from ? '' : ' · all time'}</span>
        </div>
        {volume.length === 0 ? (
          <EmptyState icon="📈" title="No volume in this range" hint="Days appear once tickets are created or resolved in the range." />
        ) : (
          <VolumeChart rows={volume} />
        )}
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>By status</h2>
          <span className="muted small">created tickets in range, by current state</span>
        </div>
        <DistributionTable title="Status" rows={status} labelFor={(r) => r.state} />
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>By priority</h2>
          <span className="muted small">created tickets in range</span>
        </div>
        <DistributionTable title="Priority" rows={priority} labelFor={(r) => r.priority} />
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>By assignment group</h2>
          <span className="muted small">created tickets in range, by current group</span>
        </div>
        <AttributionTable title="Group" rows={groups} emptyHint="No tickets were created in this range." />
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>By agent</h2>
          <span className="muted small">created tickets in range, by current owner</span>
        </div>
        <AttributionTable title="Agent" rows={agents} emptyHint="No tickets were created in this range." />
      </section>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>SLA performance</h2>
          <a className="btn btn-ghost btn-sm" href="#/sla-reports">Open SLA Reports</a>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Computed by the SLA reporting service — working-time compliance, breaches and averages.
          This is the operational summary; the dedicated SLA Reports page has the full breakdown.
        </p>
        {sla.total === 0 && sla.liveOpen === 0 ? (
          <EmptyState icon="⏱" title="No SLA cycles yet" hint="Cycles appear once tickets run under the SLA engine." />
        ) : (
          <div className="source-split">
            <span className="source-split-item">
              <strong>Compliance {sla.compliance ?? '—'}</strong>
              <span className="muted small">{sla.met} of {sla.total} completed cycles met</span>
            </span>
            <span className="source-split-item">
              <strong>Breaches</strong>
              <span className="muted small">response {sla.responseBreached} · resolution {sla.resolutionBreached} (completed)</span>
            </span>
            <span className="source-split-item">
              <strong>Avg first response {sla.avgResponse ?? '—'}</strong>
              <span className="muted small">working time</span>
            </span>
            <span className="source-split-item">
              <strong>Avg resolution {sla.avgResolution ?? '—'}</strong>
              <span className="muted small">working time</span>
            </span>
            <span className="source-split-item">
              <strong>Live now</strong>
              <span className="muted small">{sla.liveOpen} open · {sla.liveBreaches} breaching · {sla.liveApproaching} approaching</span>
            </span>
            {sla.sources.map((s) => (
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
          <h2>Current queue snapshot</h2>
          <span className="chip chip-dev">right now</span>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          The live state of the queue — separate from the range metrics above and unaffected by the date range.
        </p>
        <div className="kpi-row kpi-row-sla" aria-label="Current queue">
          {snapshot.map((c) => <KpiCard key={c.label} {...c} />)}
        </div>
      </section>

      {toastNode}
    </div>
  );
}
