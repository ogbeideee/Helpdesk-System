import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import { usePageHeader } from '../pageHeader.js';
import { slaKpiCards } from '../slaKpis.js';
import {
  ErrorState, EmptyState, StateBadge, PriorityBadge,
  Avatar, Icon, timeAgo, fmtDateTime,
} from './ui.jsx';

const EMAIL_SIMULATOR_ENABLED = import.meta.env.VITE_ENABLE_EMAIL_SIMULATOR !== 'false';

const CATEGORY_ICONS = {
  'Password Reset': 'key',
  'Inquiry / Help': 'helpCircle',
  Software: 'laptop',
  Hardware: 'monitor',
};

/* ------------------------------------------------------------------ */
/* KPI cards                                                           */
/* ------------------------------------------------------------------ */

/**
 * The reference design puts a trend line in each figure. This system stores no
 * history — there is nothing to plot — so the same slot carries something the
 * data does support: how much of the open queue this figure accounts for.
 * A real proportion, not a decorative one.
 *
 * Exported for the SSR checks, which render the SLA KPI cards directly (the
 * Dashboard's own data state is fetch-fed and unreachable in server render).
 */
export function KpiCard({ tone, label, value, sub, segments, note }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <article className={`kpi-card kpi-${tone}`}>
      <div className="kpi-head">
        <span className="kpi-dot" aria-hidden="true" />
        {label}
      </div>
      <div className="kpi-value tnum">{value ?? '—'}</div>
      <div className="kpi-sub">{sub}</div>
      <div className="kpi-meter" role="presentation">
        {total > 0 ? (
          segments.map((s) => (
            <span
              key={s.key}
              className={`kpi-seg kpi-seg-${s.key}`}
              style={{ width: `${s.pct}%` }}
              title={s.title}
            />
          ))
        ) : (
          <span className="kpi-seg is-empty" style={{ width: '100%' }} />
        )}
      </div>
      <div className="kpi-note">{note}</div>
    </article>
  );
}

function share(part, whole) {
  if (!whole) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

function KpiSkeleton() {
  return (
    <article className="kpi-card is-loading" aria-hidden="true">
      <span className="sk" style={{ width: 72 }} />
      <span className="sk" style={{ width: 44, height: 24, marginTop: 10 }} />
      <span className="sk sk-sm" style={{ width: 62 }} />
      <span className="sk" style={{ width: '100%', height: 4, marginTop: 14 }} />
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Breakdown rows                                                      */
/* ------------------------------------------------------------------ */

function MeterRow({ label, value, max, tone, icon }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className={`meter-row ${tone ? `is-${tone}` : ''}`}>
      <span className="meter-label">
        {icon
          ? <Icon name={icon} size={14} className="meter-icon" />
          : <span className="meter-dot" aria-hidden="true" />}
        <span className="meter-name">{label}</span>
      </span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-value tnum">{value}</span>
    </div>
  );
}

function Panel({ title, icon, action, children, className = '' }) {
  return (
    <section className={`panel ${className}`.trim()}>
      <header className="panel-head">
        <h2>
          {icon && <Icon name={icon} size={15} className="panel-icon" />}
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export default function Dashboard({ onOpen, me, handoverCount = 0 }) {
  const [data, setData] = useState(null);
  const [recent, setRecent] = useState(null);
  const [mine, setMine] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api.dashboard().then(setData).catch((e) => setError(e.message));
    // The dashboard endpoint returns the newest five tickets without their
    // owner; the queue endpoint carries the assignment, which the operational
    // table needs. Same data, one extra field.
    api.listTickets({ limit: 8 }).then(setRecent).catch(() => setRecent([]));
    api.myWorkload().then(setMine).catch(() => setMine(null));
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('td:changed', onChange);
    return () => window.removeEventListener('td:changed', onChange);
  }, [load]);

  usePageHeader(
    null,
    data
      ? `Live operations view of the IT helpdesk · updated ${timeAgo(data.generatedAt)}`
      : 'Live operations view of the IT helpdesk'
  );

  const counts = data?.counts || {};
  const totalOpen = data?.totalOpen ?? 0;

  const ticketsPerGroup = data?.ticketsPerGroup && typeof data.ticketsPerGroup === 'object'
    ? data.ticketsPerGroup
    : {};
  const ticketsPerAgent = Array.isArray(data?.ticketsPerAgent) ? data.ticketsPerAgent : [];

  const priorityMax = Math.max(1, ...Object.values(data?.byPriority || {}).map(Number));
  const categoryRows = CATEGORIES.map((c) => ({ name: c, count: data?.byCategory?.[c] || 0 }));
  const categoryMax = Math.max(1, ...categoryRows.map((r) => r.count));
  const groupEntries = Object.entries(ticketsPerGroup);
  const groupMax = Math.max(1, ...groupEntries.map(([, v]) => Number(v)));
  const agentMax = Math.max(1, ...ticketsPerAgent.map((a) => a.openTickets || 0));

  const kpis = useMemo(() => [
    {
      tone: 'primary',
      label: 'Total Open',
      value: totalOpen,
      sub: 'Active queue',
      segments: [
        { key: 'new', value: counts.new || 0, pct: share(counts.new || 0, totalOpen), title: `${counts.new || 0} new` },
        { key: 'progress', value: counts.inProgress || 0, pct: share(counts.inProgress || 0, totalOpen), title: `${counts.inProgress || 0} in progress` },
      ],
      note: totalOpen ? `${counts.new || 0} new · ${counts.inProgress || 0} in progress` : 'Nothing open',
    },
    {
      tone: 'new',
      label: 'New',
      value: counts.new,
      sub: 'Awaiting triage',
      segments: [{ key: 'new', value: counts.new || 0, pct: share(counts.new || 0, totalOpen), title: 'Share of open' }],
      note: totalOpen ? `${share(counts.new || 0, totalOpen)}% of open` : '—',
    },
    {
      tone: 'progress',
      label: 'In Progress',
      value: counts.inProgress,
      sub: 'Being worked',
      segments: [{ key: 'progress', value: counts.inProgress || 0, pct: share(counts.inProgress || 0, totalOpen), title: 'Share of open' }],
      note: totalOpen ? `${share(counts.inProgress || 0, totalOpen)}% of open` : '—',
    },
    {
      tone: 'unassigned',
      label: 'Unassigned',
      value: data?.unassigned,
      sub: 'No owner yet',
      segments: [{ key: 'unassigned', value: data?.unassigned || 0, pct: share(data?.unassigned || 0, totalOpen), title: 'Share of open' }],
      note: totalOpen ? `${share(data?.unassigned || 0, totalOpen)}% of open` : '—',
    },
    {
      tone: 'critical',
      label: 'Critical',
      value: data?.critical,
      sub: 'Open · p1',
      segments: [{ key: 'critical', value: data?.critical || 0, pct: share(data?.critical || 0, totalOpen), title: 'Share of open' }],
      note: totalOpen ? `${share(data?.critical || 0, totalOpen)}% of open` : '—',
    },
  ], [counts.new, counts.inProgress, data?.unassigned, data?.critical, totalOpen]);

  // The SLA figures ride on the same dashboard payload; no second fetch.
  const slaCards = useMemo(() => slaKpiCards(data?.sla, totalOpen), [data?.sla, totalOpen]);

  if (error) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;

  const loading = !data;
  const rows = (recent || []).slice(0, 7);

  return (
    <div className="page dashboard">
      <div className="dash-layout">
        <div className="dash-main">
          <div className="kpi-row" aria-label="Key figures">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <KpiSkeleton key={i} />)
              : kpis.map((k) => <KpiCard key={k.label} {...k} />)}
          </div>

          {(loading || slaCards.length > 0) && (
            <div className="kpi-row kpi-row-sla" aria-label="SLA key figures">
              {loading
                ? Array.from({ length: 6 }).map((_, i) => <KpiSkeleton key={i} />)
                : slaCards.map((k) => <KpiCard key={k.label} {...k} />)}
            </div>
          )}

          <Panel
            title="Recent Tickets"
            icon="tickets"
            className="panel-queue"
            action={
              <button
                type="button"
                className="panel-link"
                onClick={() => { window.location.hash = '/tickets'; }}
              >
                View all <Icon name="arrowRight" size={13} />
              </button>
            }
          >
            <div className="panel-body is-flush">
              {recent === null ? (
                <table className="queue-table">
                  <tbody aria-hidden="true">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="skeleton-row">
                        <td><span className="sk" style={{ width: 76 }} /></td>
                        <td><span className="sk" style={{ width: `${50 + ((i * 11) % 30)}%` }} /></td>
                        <td><span className="sk" style={{ width: 120 }} /></td>
                        <td><span className="sk" style={{ width: 60 }} /></td>
                        <td><span className="sk" style={{ width: 68 }} /></td>
                        <td><span className="sk" style={{ width: 90 }} /></td>
                        <td><span className="sk" style={{ width: 44 }} /></td>
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : rows.length === 0 ? (
                <EmptyState
                  icon="◌"
                  title="No tickets yet"
                  hint="Tickets raised by email or from the portal appear here."
                />
              ) : (
                <table className="queue-table">
                  <thead>
                    <tr>
                      <th style={{ width: 108 }}>ID</th>
                      <th>Subject</th>
                      <th style={{ width: 190 }}>Requester</th>
                      <th style={{ width: 104 }}>Status</th>
                      <th style={{ width: 112 }}>Priority</th>
                      <th style={{ width: 158 }}>Assigned to</th>
                      <th style={{ width: 82, textAlign: 'right' }}>Age</th>
                      <th style={{ width: 32 }} aria-label="Open" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr
                        key={t.id}
                        tabIndex={0}
                        role="link"
                        aria-label={`${t.ticketNumber} — ${t.shortDescription}`}
                        onClick={() => onOpen(t.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); } }}
                      >
                        <td data-label="ID"><span className="cell-id">{t.ticketNumber}</span></td>
                        <td data-label="Subject" className="cell-main">
                          <span className="cell-subject">{t.shortDescription}</span>
                        </td>
                        <td data-label="Requester">
                          <span className="cell-requester-inline">{t.requesterName || t.requesterEmail}</span>
                        </td>
                        <td data-label="Status"><StateBadge state={t.state} /></td>
                        <td data-label="Priority"><PriorityBadge priority={t.priority} /></td>
                        <td data-label="Assigned to">
                          {t.assignedAgent ? (
                            <span className="cell-agent">
                              <Avatar name={t.assignedAgent.name} size={20} />
                              <span className="cell-agent-name">{t.assignedAgent.name}</span>
                            </span>
                          ) : (
                            <span className="cell-agent unassigned-tag">
                              <Icon name="agents" size={14} />
                              Unassigned
                            </span>
                          )}
                        </td>
                        <td data-label="Age" className="cell-age" title={fmtDateTime(t.createdAt)}>
                          {timeAgo(t.createdAt)}
                          {t.overdue && <span className="overdue-dot" title="Past its SLA target" />}
                        </td>
                        <td className="cell-chevron" aria-hidden="true">
                          <Icon name="chevronRight" size={13} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>

          <div className="dash-breakdowns">
            <Panel title="Open by Priority" icon="activity">
              <div className="panel-body">
                {PRIORITIES.map((p) => (
                  <MeterRow
                    key={p.value}
                    label={p.label}
                    tone={`prio-${p.value}`}
                    value={data?.byPriority?.[p.value] || 0}
                    max={priorityMax}
                  />
                ))}
              </div>
            </Panel>

            <Panel title="Open by Category" icon="folder">
              <div className="panel-body">
                {categoryRows.map((r) => (
                  <MeterRow
                    key={r.name}
                    label={r.name}
                    icon={CATEGORY_ICONS[r.name]}
                    value={r.count}
                    max={categoryMax}
                  />
                ))}
              </div>
            </Panel>
          </div>

          <Panel title="Open by Group" icon="groups">
            <div className="panel-body">
              {groupEntries.length === 0 ? (
                <p className="muted small">No active groups.</p>
              ) : (
                <div className="meter-scroll">
                  {groupEntries.map(([name, count]) => (
                    <MeterRow key={name} label={name} value={Number(count)} max={groupMax} />
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel
            title="Agent Workload"
            icon="agents"
            action={<span className="panel-note">Open · new + in progress</span>}
          >
            <div className="panel-body is-flush">
              {ticketsPerAgent.length === 0 ? (
                <EmptyState icon="◇" title="No active agents" hint="Add agents under Administration." />
              ) : (
                <div className="agent-list">
                  {ticketsPerAgent.map((a) => (
                    <div key={a.agentId} className="agent-row">
                      <Avatar name={a.name} size={28} />
                      <div className="agent-name">
                        <strong>{a.name}</strong>
                        <small className="muted">
                          {a.assignmentGroup || 'No group'} · L{a.skillLevel}
                          {a.isAvailable === false ? ' · Unavailable' : ''}
                        </small>
                      </div>
                      <div className="agent-load">
                        <span className="meter-track" style={{ width: 64 }} title={`${a.openTickets} open`}>
                          <span className="meter-fill" style={{ width: `${(a.openTickets / agentMax) * 100}%` }} />
                        </span>
                        <span className={`workload-pill ${a.openTickets > 10 ? 'hot' : ''}`}>{a.openTickets}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>
        </div>

        <aside className="dash-rail">
          <Panel title="Quick Actions" icon="zap">
            <div className="panel-body is-tight">
              <button className="rail-action" onClick={() => { window.location.hash = '/tickets/new'; }}>
                <span>New Ticket</span>
                <Icon name="plus" size={15} />
              </button>
              <button className="rail-action" onClick={() => { window.location.hash = '/tickets?agentId=unassigned'; }}>
                <span>Assign Ticket</span>
                <Icon name="userPlus" size={15} />
              </button>
              <button className="rail-action" onClick={() => { window.location.hash = '/handovers'; }}>
                <span>View Handovers</span>
                <Icon name="handovers" size={15} />
              </button>
              {EMAIL_SIMULATOR_ENABLED && (
                <button className="rail-action" onClick={() => { window.location.hash = '/simulate-email'; }}>
                  <span>Simulate Email</span>
                  <span className="chip-dev">DEV</span>
                </button>
              )}
            </div>
          </Panel>

          <Panel title="System Status" icon="shieldCheck">
            <div className="panel-body">
              <div className={`status-line ${data ? 'is-ok' : 'is-warn'}`}>
                <Icon name={data ? 'check' : 'clock'} size={15} />
                <span>{data ? 'Service desk API responding' : 'Waiting for the API…'}</span>
              </div>
              <div className="rail-row">
                <span>Data refreshed</span>
                <strong>{data ? timeAgo(data.generatedAt) : '—'}</strong>
              </div>
              <div className="rail-row">
                <span>Email intake</span>
                <strong>{EMAIL_SIMULATOR_ENABLED ? 'Simulator' : 'Microsoft 365'}</strong>
              </div>
              <div className="rail-row">
                <span>Assignment groups</span>
                <strong className="tnum">{groupEntries.length}</strong>
              </div>
            </div>
          </Panel>

          <Panel title="My Stats" icon="dashboard">
            <div className="panel-body">
              <div className="rail-stat">
                <Icon name="tickets" size={15} className="rail-stat-icon" />
                <span>Open tickets</span>
                <strong className="tnum">{mine ? mine.openTickets : '—'}</strong>
              </div>
              <div className="rail-stat">
                <Icon name="inbox" size={15} className="rail-stat-icon is-new" />
                <span>Awaiting my triage</span>
                <strong className="tnum">{mine ? mine.newTickets : '—'}</strong>
              </div>
              <div className="rail-stat">
                <Icon name="clock" size={15} className="rail-stat-icon is-progress" />
                <span>In progress</span>
                <strong className="tnum">{mine ? mine.inProgressTickets : '—'}</strong>
              </div>
              <div className="rail-stat">
                <Icon name="handovers" size={15} className="rail-stat-icon is-handover" />
                <span>Handovers pending</span>
                <strong className="tnum">{handoverCount}</strong>
              </div>
              <button
                className="btn btn-secondary btn-block rail-cta"
                onClick={() => { window.location.hash = `/tickets?agentId=${me?.id ?? ''}`; }}
                disabled={!me?.id}
              >
                View my tickets <Icon name="arrowRight" size={13} />
              </button>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
