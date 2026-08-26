import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import {
  Spinner, ErrorState, EmptyState, StateBadge, PriorityBadge,
  Avatar, Skeleton, timeAgo,
} from './ui.jsx';

function StatCard({ label, value, tone = '', icon }) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}
      </div>
      <div className="stat-value">{value ?? '—'}</div>
    </div>
  );
}

function BarRow({ label, value, max, toneClass = '' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span className={`bar-label ${toneClass}`}>{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export default function Dashboard({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api
      .dashboard()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('td:changed', onChange);
    return () => window.removeEventListener('td:changed', onChange);
  }, [load]);

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!data) {
    return (
      <div className="page">
        <SkeletonHeader />
        <div className="stat-grid">
          {Array.from({ length: 5 }).map((_, i) => <StatCard key={i} label={<Skeleton width={80} />} value='' />)}
        </div>
        <Spinner label="Loading dashboard…" />
      </div>
    );
  }

  // The payload is treated as untrusted: a partial response must degrade to
  // empty sections, never throw and blank the page.
  const counts = data.counts || {};
  const recentlyCreated = Array.isArray(data.recentlyCreated) ? data.recentlyCreated : [];
  const ticketsPerAgent = Array.isArray(data.ticketsPerAgent) ? data.ticketsPerAgent : [];
  const ticketsPerGroup = data.ticketsPerGroup && typeof data.ticketsPerGroup === 'object'
    ? data.ticketsPerGroup
    : {};

  const priorityMax = Math.max(1, ...Object.values(data.byPriority || {}).map(Number));
  const categoryRows = CATEGORIES.map((c) => ({ name: c, count: data.byCategory?.[c] || 0 }));
  const groupMax = Math.max(1, ...Object.values(ticketsPerGroup).map(Number));
  const agentMax = Math.max(1, ...ticketsPerAgent.map((a) => a.openTickets || 0));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Service Desk Overview</h1>
          <p className="muted">Live view of the IT helpdesk queue · updated {timeAgo(data.generatedAt)}</p>
        </div>
        <button className="btn btn-primary" onClick={load}>↻ Refresh</button>
      </header>

      <section className="stat-grid" aria-label="Key figures">
        <StatCard label="Total Open" value={data.totalOpen} tone="open" icon="▤" />
        <StatCard label="New" value={counts.new} tone="new" icon="✦" />
        <StatCard label="In Progress" value={counts.inProgress} tone="progress" icon="◐" />
        <StatCard label="Unassigned" value={data.unassigned} tone={data.unassigned ? 'warn' : 'muted'} icon="◌" />
        <StatCard label="Critical" value={data.critical} tone={data.critical ? 'critical' : 'muted'} icon="▲" />
      </section>

      <div className="dash-grid">
        <section className="card card-span-2">
          <div className="card-head">
            <h2>Recently Created</h2>
          </div>
          {recentlyCreated.length === 0 ? (
            <EmptyState
              icon="📭"
              title="No tickets yet"
              hint="New tickets created from email or the portal will appear here."
            />
          ) : (
            <table className="table table-clickable">
              <thead>
                <tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Priority</th><th>Created</th></tr>
              </thead>
              <tbody>
                {recentlyCreated.map((t) => (
                  <tr key={t.id} onClick={() => onOpen(t.id)}>
                    <td className="mono">{t.ticketNumber}</td>
                    <td className="cell-subject">{t.shortDescription}</td>
                    <td><StateBadge state={t.state} /></td>
                    <td><PriorityBadge priority={t.priority} /></td>
                    <td className="muted nowrap">{timeAgo(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Open by Priority</h2></div>
            {PRIORITIES.map((p) => (
              <BarRow
                key={p.value}
                label={p.label}
                toneClass={`prio-text-${p.value}`}
                value={data.byPriority?.[p.value] || 0}
                max={priorityMax}
              />
            ))}
          </section>

          <section className="card">
            <div className="card-head"><h2>Open by Category</h2></div>
            {categoryRows.every((r) => r.count === 0) ? (
              <p className="muted">No open tickets.</p>
            ) : (
              categoryRows.map((r) => (
                <div key={r.name} className="kv-row">
                  <span>{r.name}</span>
                  <strong>{r.count}</strong>
                </div>
              ))
            )}
          </section>
        </div>

        <section className="card">
          <div className="card-head"><h2>Open by Assignment Group</h2></div>
          {Object.entries(ticketsPerGroup).map(([name, count]) => (
            <BarRow key={name} label={name} value={count} max={groupMax} />
          ))}
        </section>

        <section className="card">
          <div className="card-head"><h2>Agent Workload (open)</h2></div>
          {ticketsPerAgent.length === 0 ? (
            <EmptyState icon="👤" title="No active agents" hint="Add agents under Administration." />
          ) : (
            ticketsPerAgent.map((a) => (
              <div key={a.agentId} className="agent-row">
                <Avatar name={a.name} />
                <span className="agent-name">
                  <strong>{a.name}</strong>
                  <small className="muted">{a.assignmentGroup || 'No group'} · L{a.skillLevel}</small>
                </span>
                <span className={`workload ${a.openTickets === 0 ? 'muted' : ''}`}>{a.openTickets}</span>
                <div className="bar-track bar-thin" title={`${a.openTickets} open (max ${agentMax})`}>
                  <div className="bar-fill" style={{ width: `${(a.openTickets / agentMax) * 100}%` }} />
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function SkeletonHeader() {
  return (
    <header className="page-head">
      <div>
        <h1>Service Desk Overview</h1>
        <p className="muted">Loading live queue…</p>
      </div>
    </header>
  );
}
