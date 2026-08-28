import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import {
  Spinner, ErrorState, EmptyState, StateBadge, PriorityBadge,
  Avatar, Skeleton, timeAgo,
} from './ui.jsx';

function StatStripCell({ label, value, sub, tone = 'default' }) {
  return (
    <div className="stat-strip-cell">
      <div className="stat-strip-label">
        <span className={`stat-strip-dot ${tone === 'default' ? '' : `is-${tone}`}`} />
        {label}
      </div>
      <div className="stat-strip-value tnum">{value ?? '—'}</div>
      {sub && <div className="stat-strip-sub">{sub}</div>}
    </div>
  );
}

function BarRow({ label, value, max, toneClass = '' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span className={`bar-label ${toneClass}`}>{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bar-value tnum">{value}</span>
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
        <div className="hero">
          <h1 className="hero-title">Service Desk Overview</h1>
          <p className="hero-sub">Loading live queue…</p>
        </div>
        <div className="stat-strip">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="stat-strip-cell">
              <Skeleton width={80} height={10} />
              <div style={{ marginTop: 8 }}><Skeleton width={60} height={22} /></div>
            </div>
          ))}
        </div>
        <Spinner label="Loading dashboard…" />
      </div>
    );
  }

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
      <div className="hero">
        <h1 className="hero-title">Service Desk Overview</h1>
        <p className="hero-sub">
          Live operations view of the IT helpdesk · updated {timeAgo(data.generatedAt)}
        </p>
      </div>

      <div className="stat-strip" aria-label="Key figures">
        <StatStripCell label="Total Open" value={data.totalOpen} sub="Active queue" tone="primary" />
        <StatStripCell label="New" value={counts.new} sub="Awaiting triage" tone="primary" />
        <StatStripCell label="In Progress" value={counts.inProgress} sub="Being worked" tone="warn" />
        <StatStripCell label="Unassigned" value={data.unassigned} sub="No owner yet" tone={data.unassigned ? 'warn' : 'default'} />
        <StatStripCell label="Critical" value={data.critical} sub="Open · p1" tone={data.critical ? 'danger' : 'default'} />
      </div>

      {/* Recent Tickets leads the page at full width: it is the thing an
          agent actually acts on. The breakdowns are context, and follow. */}
      <section className="queue-lead">
        <div className="section-head">
          <h2>Recent Tickets</h2>
          <button
            type="button"
            className="section-link"
            onClick={() => { window.location.hash = '/tickets'; }}
          >
            View all tickets →
          </button>
        </div>
        <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {recentlyCreated.length === 0 ? (
            <EmptyState
              icon="✦"
              title="No tickets yet"
              hint="New tickets created from email or the portal will appear here."
            />
          ) : (
            <div className="queue">
              {recentlyCreated.slice(0, 8).map((t) => (
                <div key={t.id} className="queue-row" onClick={() => onOpen(t.id)}>
                  <span className="queue-id">{t.ticketNumber}</span>
                  <div>
                    <div className="queue-subject">
                      {t.shortDescription}
                    </div>
                    <div className="queue-subject-meta">
                      {t.requesterName || t.requesterEmail}
                    </div>
                  </div>
                  <span><PriorityBadge priority={t.priority} /></span>
                  <span><StateBadge state={t.state} /></span>
                  <span className="queue-time tnum">{timeAgo(t.createdAt)}</span>
                  <span className="muted small">→</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="dash-breakdowns">
        <section className="card" style={{ paddingTop: 14 }}>
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

        <section className="card" style={{ paddingTop: 14 }}>
          <div className="card-head"><h2>Open by Category</h2></div>
          {categoryRows.every((r) => r.count === 0) ? (
            <p className="muted small">No open tickets.</p>
          ) : (
            categoryRows.map((r) => (
              <div key={r.name} className="kv-row">
                <span>{r.name}</span>
                <strong className="tnum">{r.count}</strong>
              </div>
            ))
          )}
        </section>

        <section className="card" style={{ paddingTop: 14 }}>
          <div className="card-head"><h2>Open by Group</h2></div>
          {Object.entries(ticketsPerGroup).length === 0 ? (
            <p className="muted small">No active groups.</p>
          ) : (
            Object.entries(ticketsPerGroup).map(([name, count]) => (
              <BarRow key={name} label={name} value={count} max={groupMax} />
            ))
          )}
        </section>

      </div>

      <div style={{ marginTop: 16 }}>
        <section className="card" style={{ paddingTop: 14 }}>
          <div className="card-head">
            <h2>Agent Workload</h2>
            <span className="muted small">Open · NEW + In Progress</span>
          </div>
          {ticketsPerAgent.length === 0 ? (
            <EmptyState icon="◇" title="No active agents" hint="Add agents under Administration." />
          ) : (
            <div className="agent-list">
              {ticketsPerAgent.map((a) => (
                <div key={a.agentId} className="agent-row">
                  <Avatar name={a.name} size={28} />
                  <div className="agent-name">
                    <strong>{a.name}</strong>
                    <small className="muted">{a.assignmentGroup || 'No group'} · L{a.skillLevel}{a.isAvailable ? '' : ' · Unavailable'}</small>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
                    <div className="bar-track bar-thin" style={{ width: 60 }} title={`${a.openTickets} open`}>
                      <div className="bar-fill" style={{ width: `${(a.openTickets / agentMax) * 100}%` }} />
                    </div>
                    <span className={`workload-pill ${a.openTickets > 10 ? 'hot' : ''}`}>{a.openTickets}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
