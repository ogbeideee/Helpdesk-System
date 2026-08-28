import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import { STATES, PRIORITIES, CATEGORIES } from '../constants.js';
import {
  ErrorState, EmptyState, StateBadge, PriorityBadge,
  Avatar, timeAgo, fmtDateTime,
} from './ui.jsx';

const PAGE_SIZE = 25;
const EMPTY_FILTERS = { q: '', status: '', priority: '', category: '', group: '', agentId: '' };

/* Sorting is client-side over the loaded page, so it never changes which
   tickets the backend returned — only the order they are read in. */
const PRIORITY_RANK = { critical: 0, high: 1, moderate: 2, low: 3 };
const STATE_RANK = { NEW: 0, IN_PROGRESS: 1, RESOLVED: 2, CLOSED: 3 };
const SORTS = {
  updated: { label: 'Updated', get: (t) => -new Date(t.updatedAt).getTime() },
  age: { label: 'Age', get: (t) => new Date(t.createdAt).getTime() },
  priority: { label: 'Priority', get: (t) => PRIORITY_RANK[t.priority] ?? 9 },
  status: { label: 'Status', get: (t) => STATE_RANK[t.state] ?? 9 },
  ticket: { label: 'Ticket number', get: (t) => String(t.ticketNumber) },
};

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />
    </svg>
  );
}

function SortArrow({ dir }) {
  return (
    <svg className="sort-arrow" width="10" height="10" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'asc' ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
    </svg>
  );
}

/** Column header that also acts as the sort control. */
function Th({ id, children, sort, setSort, align, width }) {
  if (!id) return <th style={{ width, textAlign: align }}>{children}</th>;
  const active = sort.key === id;
  return (
    <th style={{ width, textAlign: align }} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`th-sort ${active ? 'is-active' : ''}`}
        onClick={() => setSort((s) => ({ key: id, dir: s.key === id && s.dir === 'asc' ? 'desc' : 'asc' }))}
      >
        {children}
        {active && <SortArrow dir={sort.dir} />}
      </button>
    </th>
  );
}

function SkeletonRows({ rows = 6 }) {
  return (
    <tbody className="is-loading" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="skeleton-row">
          <td><span className="sk" style={{ width: 74 }} /></td>
          <td>
            <span className="sk" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
            <span className="sk sk-sm" style={{ width: '38%' }} />
          </td>
          <td><span className="sk" style={{ width: 70 }} /></td>
          <td><span className="sk" style={{ width: 64 }} /></td>
          <td><span className="sk" style={{ width: 88 }} /></td>
          <td><span className="sk" style={{ width: 96 }} /></td>
          <td><span className="sk" style={{ width: 48 }} /></td>
          <td />
        </tr>
      ))}
    </tbody>
  );
}

export default function TicketsPage({ onOpen }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [tickets, setTickets] = useState(null);
  const [groups, setGroups] = useState([]);
  const [agentOptions, setAgentOptions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'updated', dir: 'asc' });
  const [moreOpen, setMoreOpen] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 250);
    return () => clearTimeout(t);
  }, [filters.q]);

  useEffect(() => {
    api.groups().then(setGroups).catch(() => {});
    api.dashboard().then((d) => setAgentOptions(d.ticketsPerAgent || [])).catch(() => {});
  }, []);

  // Ctrl/Cmd-K focuses search, matching the shortcut shown in the field.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onChange = () => load();
    window.addEventListener('td:changed', onChange);
    return () => window.removeEventListener('td:changed', onChange);
  }, [load]);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const sorted = useMemo(() => {
    const list = [...(tickets || [])];
    const get = SORTS[sort.key].get;
    list.sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [tickets, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const secondaryFilters = ['priority', 'category', 'group', 'agentId'];
  const secondaryCount = secondaryFilters.filter((k) => filters[k]).length;
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <div className="page">
      <header className="page-bar">
        <div>
          <h1 className="hero-title">Tickets</h1>
          <p className="hero-sub">
            {tickets === null
              ? 'Loading the queue…'
              : `${sorted.length} ticket${sorted.length === 1 ? '' : 's'}${anyFilter ? ' matching your filters' : ' in the queue'}`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { window.location.hash = '/tickets/new'; }}>
          New ticket
        </button>
      </header>

      {/* Search + status segments read as one control strip, not a form. */}
      <div className="queue-controls">
        <div className="search-field">
          <span className="search-icon"><SearchIcon /></span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search tickets, subjects, requesters…"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            aria-label="Search tickets"
          />
          <kbd className="kbd-hint" aria-hidden="true">Ctrl K</kbd>
        </div>

        <div className="segmented" role="group" aria-label="Filter by status">
          <button
            type="button"
            className={`segment ${filters.status === '' ? 'is-active' : ''}`}
            aria-pressed={filters.status === ''}
            onClick={() => setFilter('status', '')}
          >
            All
          </button>
          {STATES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`segment segment-${s.value.toLowerCase()} ${filters.status === s.value ? 'is-active' : ''}`}
              aria-pressed={filters.status === s.value}
              onClick={() => setFilter('status', filters.status === s.value ? '' : s.value)}
            >
              <span className="segment-dot" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`btn btn-secondary btn-sm filter-more ${moreOpen || secondaryCount ? 'is-on' : ''}`}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          Filters
          {secondaryCount > 0 && <span className="count-dot">{secondaryCount}</span>}
        </button>
      </div>

      {(moreOpen || secondaryCount > 0) && (
        <div className="filter-row">
          <label className="mini-field">
            <span>Priority</span>
            <select value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
              <option value="">Any</option>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label className="mini-field">
            <span>Category</span>
            <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
              <option value="">Any</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="mini-field">
            <span>Group</span>
            <select value={filters.group} onChange={(e) => setFilter('group', e.target.value)}>
              <option value="">Any</option>
              {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
            </select>
          </label>
          <label className="mini-field">
            <span>Assigned to</span>
            <select value={filters.agentId} onChange={(e) => setFilter('agentId', e.target.value)}>
              <option value="">Anyone</option>
              {agentOptions.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
            </select>
          </label>
          {anyFilter && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setFilters(EMPTY_FILTERS); setMoreOpen(false); }}>
              Clear all
            </button>
          )}
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {!error && (
        <div className="queue-table-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <Th id="ticket" sort={sort} setSort={setSort} width={112}>Ticket</Th>
                <Th id={null}>Subject &amp; requester</Th>
                <Th id="status" sort={sort} setSort={setSort} width={112}>Status</Th>
                <Th id="priority" sort={sort} setSort={setSort} width={116}>Priority</Th>
                <Th id={null} width={150}>Group</Th>
                <Th id={null} width={160}>Assigned to</Th>
                <Th id="age" sort={sort} setSort={setSort} width={84} align="right">Age</Th>
                <th style={{ width: 34 }} aria-label="Open" />
              </tr>
            </thead>

            {loading && tickets === null ? (
              <SkeletonRows />
            ) : (
              <tbody className={loading ? 'is-refreshing' : ''}>
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    tabIndex={0}
                    role="link"
                    aria-label={`${t.ticketNumber} — ${t.shortDescription}`}
                    onClick={() => onOpen(t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); } }}
                  >
                    <td data-label="Ticket">
                      <span className="cell-id">{t.ticketNumber}</span>
                    </td>
                    <td data-label="Subject" className="cell-main">
                      <span className="cell-subject">{t.shortDescription}</span>
                      <span className="cell-requester">
                        {t.requesterName || t.requesterEmail}
                        {t.requesterName && <span className="muted"> · {t.requesterEmail}</span>}
                      </span>
                    </td>
                    <td data-label="Status"><StateBadge state={t.state} /></td>
                    <td data-label="Priority"><PriorityBadge priority={t.priority} /></td>
                    <td data-label="Group">
                      {t.team?.name
                        ? <span className="group-tag">{t.team.name}</span>
                        : <span className="muted small">Triage</span>}
                    </td>
                    <td data-label="Assigned to">
                      {t.assignedAgent ? (
                        <span className="cell-agent">
                          <Avatar name={t.assignedAgent.name} size={22} />
                          <span className="cell-agent-name">{t.assignedAgent.name}</span>
                        </span>
                      ) : (
                        <span className="unassigned-tag">Unassigned</span>
                      )}
                    </td>
                    <td data-label="Age" className="cell-age" title={fmtDateTime(t.createdAt)}>
                      {timeAgo(t.createdAt)}
                      {t.overdue && <span className="overdue-dot" title="Past its SLA target" />}
                    </td>
                    <td className="cell-chevron" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3l5 5-5 5" /></svg>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>

          {!loading && tickets !== null && rows.length === 0 && (
            <EmptyState
              icon="◌"
              title={anyFilter ? 'No tickets match these filters' : 'The queue is empty'}
              hint={
                anyFilter
                  ? 'Try widening the search, or clear the filters to see everything.'
                  : 'Tickets arrive by email, or you can raise one manually.'
              }
              action={
                anyFilter
                  ? <button className="btn btn-secondary btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
                  : <button className="btn btn-primary btn-sm" onClick={() => { window.location.hash = '/tickets/new'; }}>New ticket</button>
              }
            />
          )}
        </div>
      )}

      {!error && sorted.length > PAGE_SIZE && (
        <div className="pagination">
          <span className="muted small">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
            {' · sorted by '}{SORTS[sort.key].label.toLowerCase()}
          </span>
          <div className="pagination-controls">
            <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
              Previous
            </button>
            <span className="muted small tnum">Page {safePage} of {pageCount}</span>
            <button className="btn btn-ghost btn-sm" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
