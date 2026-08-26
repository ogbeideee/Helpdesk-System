import { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from '../api.js';
import { STATES, PRIORITIES, CATEGORIES, OPEN_STATES } from '../constants.js';
import {
  Spinner, ErrorState, EmptyState, StateBadge, PriorityBadge,
  SlaBadge, Avatar, fmtDateTime,
} from './ui.jsx';

const PAGE_SIZE = 25;

const EMPTY_FILTERS = { q: '', status: '', priority: '', category: '', group: '', agentId: '' };

export default function TicketsPage({ onOpen }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [tickets, setTickets] = useState(null);
  const [groups, setGroups] = useState([]);
  const [agentOptions, setAgentOptions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Debounce the free-text search so we do not hammer the API.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  useEffect(() => {
    api.groups().then(setGroups).catch(() => {});
    // Agent options for the filter: any authenticated user can read the
    // dashboard aggregate (the /agents admin listing is admin-only).
    api.dashboard().then((d) => setAgentOptions(d.ticketsPerAgent || [])).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api
      .listTickets({
        q: debouncedQ || undefined,
        status: filters.status || undefined,
        priority: filters.priority || undefined,
        category: filters.category || undefined,
        group: filters.group || undefined,
        agentId: filters.agentId || undefined,
        limit: 200,
      })
      .then((list) => {
        setTickets(list);
        setPage(1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [debouncedQ, filters.status, filters.priority, filters.category, filters.group, filters.agentId]);

  useEffect(() => {
    load();
  }, [load]);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const sorted = useMemo(() => tickets || [], [tickets]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Tickets</h1>
          <p className="muted">
            {tickets === null ? 'Loading…' : `${sorted.length} ticket${sorted.length === 1 ? '' : 's'} match`}
            {activeFilterCount > 0 && ' · filters active'}
          </p>
        </div>
      </header>

      <div className="filter-bar card">
        <input
          className="filter-search"
          placeholder="Search subject, body, requester or ticket #…"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          aria-label="Search tickets"
        />
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>
          {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)} aria-label="Priority filter">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filters.group} onChange={(e) => setFilter('group', e.target.value)} aria-label="Assignment group filter">
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
        </select>
        <select value={filters.agentId} onChange={(e) => setFilter('agentId', e.target.value)} aria-label="Assigned agent filter">
          <option value="">All agents</option>
          {agentOptions.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </select>
        {activeFilterCount > 0 && (
          <button className="btn btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
        )}
      </div>

      {error && <ErrorState message={error} onRetry={load} />}

      {!error && loading && tickets === null && <Spinner label="Loading tickets…" />}

      {!error && tickets !== null && tickets.length === 0 && (
        <EmptyState
          icon="🔍"
          title="No tickets match"
          hint={activeFilterCount ? 'Try adjusting or clearing the filters.' : 'Submit a simulated email or create a ticket manually.'}
        />
      )}

      {!error && tickets !== null && tickets.length > 0 && (
        <>
          <div className="table-wrap card">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Ticket #</th>
                  <th>Subject</th>
                  <th>Requester</th>
                  <th>Requester Email</th>
                  <th>Category</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Group</th>
                  <th>Assigned Agent</th>
                  <th>SLA</th>
                  <th>Created</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => onOpen(t.id)}>
                    <td className="mono nowrap">{t.ticketNumber}</td>
                    <td className="cell-subject" title={t.shortDescription}>
                      {t.awaitingAssignment && <span className="chip chip-warn">awaiting</span>}
                      {t.shortDescription}
                    </td>
                    <td className="nowrap">{t.requesterName || <span className="muted">—</span>}</td>
                    <td className="muted">{t.requesterEmail}</td>
                    <td><span className="chip">{t.category}</span></td>
                    <td><PriorityBadge priority={t.priority} /></td>
                    <td><StateBadge state={t.state} /></td>
                    <td>{t.team?.name || <span className="muted">Triage</span>}</td>
                    <td>
                      {t.assignedAgent ? (
                        <span className="cell-agent"><Avatar name={t.assignedAgent.name} size={22} /> {t.assignedAgent.name}</span>
                      ) : (
                        <span className="muted">Unassigned</span>
                      )}
                    </td>
                    <td><SlaBadge ticket={t} /></td>
                    <td className="muted nowrap">{fmtDateTime(t.createdAt)}</td>
                    <td className="muted nowrap">{fmtDateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <span className="muted">
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
            </span>
            <div className="pagination-controls">
              <button className="btn btn-ghost" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
              <span>Page {safePage} / {pageCount}</span>
              <button className="btn btn-ghost" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>Next →</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
