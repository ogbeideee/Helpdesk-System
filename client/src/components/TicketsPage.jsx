import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api, peekRead } from '../api.js';
import { usePageRefresh } from '../usePageRefresh.js';
import { PAGE_SIZE, EMPTY_FILTERS, SORTS, QUICK_VIEWS, activeQuickView, queueCounts, queueColumns, readDensity, writeDensity, readShowActivity, writeShowActivity, fromQuery, queuePath } from '../ticketQueueView.js';
import { filterChips } from '../filterChipsView.js';
import { STATES, PRIORITIES, CATEGORIES } from '../constants.js';
import { usePageHeader } from '../pageHeader.js';
import { slaOverview } from '../slaView.js';
import {
  ErrorState, EmptyState, StateBadge, PriorityBadge, ConfirmationChip, NextResponseLine,
  Avatar, Icon, timeAgo, fmtDateTime, useToast, usePopover, ConfirmDialog,
} from './ui.jsx';

/* One aligned pair per clock, named in full: "Response" / "Resolution" against what
   that clock is actually doing — "Due in 45m", "Overdue · 2h", "Answered".
   Every value and status comes from the API's sla block via slaView; the queue
   derives nothing. The clock name is real content, not decoration, so it is
   announced rather than hidden. */
function SlaCell({ ticket }) {
  const sla = slaOverview(ticket);
  if (!sla) {
    // Ticket created before SLA cycles existed: keep the legacy overdue
    // signal rather than showing a misleading dash.
    return ticket.overdue
      ? <span className="sla-mini is-bad" title="Past its SLA target (legacy)">Overdue</span>
      : <span className="muted small">—</span>;
  }
  return (
    <span className="sla-cell">
      {[sla.response, sla.resolution].map((c) => (
        <span key={c.key} className={`sla-mini is-${c.tone}`} title={`${c.label} — ${c.text}`}>
          <span className="sla-mini-key">{c.word}</span>
          <span className="sla-mini-val">{c.short}</span>
        </span>
      ))}
    </span>
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

/* The column headers are the desktop sort control, and they disappear when the
   queue folds into cards. This is the same sort for a screen that has no
   headers: a field picker plus a direction toggle. */
function SortControl({ sort, setSort }) {
  const setKey = (key) => setSort((s) => ({
    key,
    dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : 'asc',
  }));
  return (
    <div className="queue-sort">
      <label className="queue-sort-field">
        <span className="mini-label">Sort</span>
        <select
          value={sort.key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="Sort tickets by"
        >
          {Object.entries(SORTS).map(([key, s]) => (
            <option key={key} value={key}>{s.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn-ghost btn-sm queue-sort-dir"
        onClick={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
        aria-label={sort.dir === 'asc' ? 'Sort descending' : 'Sort ascending'}
        title={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
      >
        <SortArrow dir={sort.dir} />
      </button>
    </div>
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

function SkeletonRows({ rows = 6, columns }) {
  return (
    <tbody className="is-loading" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="skeleton-row">
          <td className="select-cell" />
          <td><span className="sk" style={{ width: 74 }} /></td>
          <td>
            <span className="sk" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
            <span className="sk sk-sm" style={{ width: '38%' }} />
          </td>
          <td><span className="sk" style={{ width: 70 }} /></td>
          <td><span className="sk" style={{ width: 64 }} /></td>
          <td><span className="sk" style={{ width: 56 }} /></td>
          {/* The placeholders track the real column set, so switching density
              does not shift every cell one column to the left while loading. */}
          {columns.group && <td><span className="sk" style={{ width: 88 }} /></td>}
          {columns.agent && <td><span className="sk" style={{ width: 96 }} /></td>}
          {columns.age && <td><span className="sk" style={{ width: 48 }} /></td>}
          {columns.activity && <td><span className="sk" style={{ width: 62 }} /></td>}
          <td />
        </tr>
      ))}

    </tbody>
  );
}

export default function TicketsPage({ onOpen, initialFilters, agent }) {
  const [filters, setFilters] = useState(() => fromQuery(initialFilters));
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'updated', dir: SORTS.updated.dir });
  const query = useMemo(() => ({ ...filters, page, sort: sort.key, direction: sort.dir }), [filters, page, sort]);
  const queryKey = queuePath(query);
  const [tickets, setTickets] = useState(() => peekRead(queryKey)?.tickets ?? null);
  const [total, setTotal] = useState(() => peekRead(queryKey)?.total ?? 0);
  const [rawCounts, setRawCounts] = useState(() => peekRead(queryKey)?.counts ?? null);
  const [groups, setGroups] = useState(() => peekRead('/assignment-groups') || []);
  const [agentOptions, setAgentOptions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [density, setDensity] = useState(readDensity);
  const [showActivity, setShowActivity] = useState(readShowActivity);
  const rowMenu = usePopover();
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkPriority, setBulkPriority] = useState('');
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [showToast, toastNode] = useToast();

  useEffect(() => {
    api.groups().then(setGroups).catch(() => {});
    api.people().then((people) => setAgentOptions(people.map(person => ({ agentId: person.id, name: person.name })))).catch(() => {});
  }, []);

  const loadVersion = useRef(0);
  const load = useCallback(() => {
    const version = ++loadVersion.current;
    const cached = peekRead(queryKey);
    if (cached) { setTickets(cached.tickets); setTotal(cached.total); setRawCounts(cached.counts ?? null); }
    setLoading(true);
    setError('');
    return api.ticketQueue(query).then((result) => {
      if (version !== loadVersion.current) return;
      setTickets(result.tickets);
      setTotal(result.total);
      setRawCounts(result.counts ?? null);
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (page > lastPage) setPage(lastPage);
    }).catch((e) => {
      if (version === loadVersion.current) setError(e.message);
    }).finally(() => {
      if (version === loadVersion.current) setLoading(false);
    });
  }, [queryKey, query, page]);
  usePageRefresh(load, ['/tickets']);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setSelectedIds(new Set());
    setPage(1);
  }, [filters.view, filters.status, filters.priority, filters.category, filters.group, filters.agentId]);
  useEffect(() => {
  }, [load]);

  function setFilter(key, value) {
    setPage(1);
    // A quick view already answers the status and the owner question, so
    // setting either one REPLACES the view rather than intersecting with it —
    // "My open tickets" plus "assigned to someone else" is a silently empty
    // list, which is exactly the kind of puzzle the views exist to remove.
    // Priority, category and group narrow the view instead, which is useful.
    const replacesView = key === 'status' || key === 'agentId';
    setFilters((f) => ({ ...f, [key]: value, ...(replacesView ? { view: '' } : {}) }));
  }

  /* A quick view is a complete question, so it replaces the filter set rather
     than joining it. Pressing the active one again returns to the whole queue.
     Its meaning lives on the server — this only sends the name. */
  function applyQuickView(key) {
    setPage(1);
    setFilters((f) => (f.view === key ? EMPTY_FILTERS : { ...EMPTY_FILTERS, view: key }));
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePageSelection() {
    const ids = rows.map((ticket) => ticket.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function toggleDensity() {
    setDensity((current) => {
      const next = current === 'compact' ? 'comfortable' : 'compact';
      writeDensity(next);
      return next;
    });
  }

  function toggleActivity() {
    setShowActivity((current) => {
      const next = !current;
      writeShowActivity(next);
      return next;
    });
  }

  async function applyBulkChanges() {
    const updates = {};
    if (bulkPriority) updates.priority = bulkPriority;
    if (bulkCategory) updates.category = bulkCategory;
    if (bulkGroup) updates.assignmentGroup = bulkGroup;
    const ids = [...selectedIds];
    if (!ids.length || !Object.keys(updates).length) {
      showToast('Select at least one ticket and one change.', 'error');
      return;
    }

    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.updateTicket(id, updates)));
      const failedIds = results.flatMap((result, index) => result.status === 'rejected' ? [ids[index]] : []);
      const updatedCount = results.length - failedIds.length;
      setSelectedIds(new Set(failedIds));
      if (failedIds.length) {
        showToast(`${updatedCount} updated; ${failedIds.length} could not be updated.`, 'error');
      } else {
        showToast(`${updatedCount} ticket${updatedCount === 1 ? '' : 's'} updated.`);
      }
      setBulkPriority('');
      setBulkCategory('');
      setBulkGroup('');
      load();
    } finally {
      setBulkBusy(false);
    }
  }

  async function closeSelectedTickets() {
    const ids = [...selectedIds];
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const failed = [];
      // The server authorizes the explicit override; ordinary agents retain
      // the resolved-ticket workflow.
      for (const id of ids) {
        try {
          if (tickets?.find(ticket => ticket.id === id)?.state === 'CLOSED') continue;
          await api.closeTicket(id, {
            force: agent?.role === 'admin',
            note: agent?.role === 'admin'
              ? 'Closed from the ticket queue selection by administrator decision'
              : 'Closed from the ticket queue selection',
          });
        } catch (error) {
          failed.push({ id, message: error.message });
        }
      }
      setSelectedIds(new Set(failed.map((result) => result.id)));
      const count = ids.length - failed.length;
      showToast(failed.length
        ? `${count} closed; ${failed.length} could not be closed. ${failed[0].message}`
        : `${count} ticket${count === 1 ? '' : 's'} closed.`, failed.length ? 'error' : undefined);
      setCloseConfirm(false);
      window.dispatchEvent(new Event('td:changed'));
    } finally {
      setBulkBusy(false);
    }
  }

  const sorted = tickets || [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = sorted;
  function changeSort(next) {
    setPage(1);
    setSort(next);
  }
  const pageIds = rows.map((ticket) => ticket.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  const anyFilter = Object.values(filters).some(Boolean);
  const quickView = activeQuickView(filters);
  const counts = queueCounts(rawCounts);
  // Chips arrive with the rows, so they are absent on the very first paint.
  // A tab reading "New (0)" while the request is still out would be a lie.
  const showCounts = rawCounts !== null;
  // The chips are also the active-filter count: the badge on the Filters
  // button and the chips below it are the same fact, so they cannot disagree.
  const chips = filterChips(filters, { groups, agents: agentOptions });
  // Compact density hands the secondary columns' width to the subject.
  const columns = queueColumns(density, showActivity);

  /* The header says what the number counts. "86 tickets" is ambiguous — all of
     them, or the ones the filters left? A filtered queue therefore reads as
     "12 of 240 tickets", which cannot be misread either way. */
  usePageHeader(
    null,
    tickets === null
      ? 'Loading the queue…'
      : anyFilter && counts.everything > 0
        ? `${total} of ${counts.everything} tickets · ${quickView ? quickView.label : 'filtered'}`
        : `${total} ticket${total === 1 ? '' : 's'} in the queue`
  );

  return (
    <div className="page">
      {/* The quick views are the front door: four questions an agent asks
          every day, each one click and each one a complete filter of its own.
          They sit above the control strip because they are a shortcut past it,
          not another control inside it. */}
      <div className="quick-views" role="group" aria-label="Quick views">
        {QUICK_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`quick-view ${filters.view === v.key ? 'is-active' : ''}`}
            aria-pressed={filters.view === v.key}
            onClick={() => applyQuickView(v.key)}
          >
            {v.label}
            {showCounts && <span className="quick-view-count tnum">{counts.views[v.key]}</span>}
          </button>
        ))}
      </div>

      {/* Status segments, sort and filters read as one control strip, not a
          form. Search is not here: the header's search is the product's, it
          is on every screen, and a second field doing the same job in one
          screen is the kind of duplication people stop trusting. */}
      <div className="queue-controls">
        <div className="segmented" role="group" aria-label="Filter by status">
          <button
            type="button"
            className={`segment ${filters.status === '' && !quickView ? 'is-active' : ''}`}
            aria-pressed={filters.status === '' && !quickView}
            onClick={() => setFilter('status', '')}
          >
            All
            {showCounts && <span className="segment-count tnum">{counts.matching}</span>}
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
              {showCounts && <span className="segment-count tnum">{counts.byStatus[s.value]}</span>}
            </button>
          ))}
        </div>

        <SortControl sort={sort} setSort={changeSort} />

        {/* Row display — density and the optional Last activity column. Both
            are preferences about how much of a row to read, not filters, so
            they share one control instead of adding two more buttons to a
            strip that already carries four. */}
        <div {...rowMenu.anchorProps}>
          <button
            type="button"
            className={`btn btn-ghost btn-sm density-toggle ${density === 'compact' || showActivity ? 'is-on' : ''}`}
            aria-haspopup="menu"
            aria-expanded={rowMenu.open}
            onClick={rowMenu.toggle}
            title="Rows — density and which columns to show"
          >
            <Icon name="rows" size={15} />
            <span className="sr-only">Row display</span>
          </button>
          {rowMenu.open && (
            <div className="menu menu-right" role="menu" aria-label="Row display">
              <div className="menu-label">Rows</div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={density === 'compact'}
                className={`menu-item ${density === 'compact' ? 'is-selected' : ''}`}
                onClick={toggleDensity}
              >
                <Icon name="rows" size={15} className="menu-item-icon" />
                <span>Compact rows</span>
                {density === 'compact' && <Icon name="check" size={14} className="menu-check" />}
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showActivity}
                className={`menu-item ${showActivity ? 'is-selected' : ''}`}
                onClick={toggleActivity}
              >
                <Icon name="clock" size={15} className="menu-item-icon" />
                <span>Last activity column</span>
                {showActivity && <Icon name="check" size={14} className="menu-check" />}
              </button>
              <div className="menu-foot">
                The subject column takes whatever the other columns leave.
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`btn btn-secondary btn-sm filter-more ${moreOpen || chips.length ? 'is-on' : ''}`}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          Filters
          {chips.length > 0 && <span className="count-dot">{chips.length}</span>}
        </button>

        <button
          className="btn btn-primary btn-sm queue-new"
          onClick={() => { window.location.hash = '/tickets/new'; }}
        >
          <Icon name="plus" size={14} />
          New ticket
        </button>
      </div>

      {/* Collapsed by default: the first ticket should not have to queue behind
          a form. An active filter stays on screen as a chip instead, so
          closing the panel never hides the reason the queue looks short. The
          chips step aside while the panel is open — the same values are in the
          selects right there, and two copies of one setting is how people
          start trusting neither. */}
      {chips.length > 0 && !moreOpen && (
        <div className="filter-chips">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              className="filter-chip"
              aria-label={`Remove filter: ${c.label} ${c.text}`}
              onClick={() => setFilter(c.key, '')}
            >
              <span className="filter-chip-label">{c.label}</span>
              <span className="filter-chip-value">{c.text}</span>
              <span className="filter-chip-x" aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" className="btn-link" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear all
          </button>
        </div>
      )}

      {moreOpen && (
        <div className="filter-row">
          <label className="mini-field">
            <span>Sort by</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <select
                value={sort.key}
                onChange={(e) => changeSort({ key: e.target.value, dir: SORTS[e.target.value].dir || sort.dir })}
                style={{ flex: 1 }}
              >
                {Object.entries(SORTS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
              </select>
              <button
                type="button"
                className="btn btn-icon btn-sm"
                style={{ padding: '2px 6px', fontSize: 13, whiteSpace: 'nowrap' }}
                onClick={() => changeSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
                title={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
              >
                {sort.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
              </button>
            </div>
          </label>
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
              <option value="unassigned">Unassigned</option>
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

      {selectedIds.size > 0 && (
        <div className="bulk-bar">
          <strong>{selectedIds.size} selected</strong>
          <div className="bulk-fields">
            <label className="mini-field">
              <span>Priority</span>
              <select value={bulkPriority} onChange={(e) => setBulkPriority(e.target.value)} disabled={bulkBusy}>
                <option value="">No change</option>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="mini-field">
              <span>Category</span>
              <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} disabled={bulkBusy}>
                <option value="">No change</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="mini-field">
              <span>Group</span>
              <select value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)} disabled={bulkBusy}>
                <option value="">No change</option>
                {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
              </select>
            </label>
          </div>
          <div className="bulk-actions">
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setCloseConfirm(true)} disabled={bulkBusy}>
              Close selected…
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={applyBulkChanges} disabled={bulkBusy}>
              {bulkBusy ? 'Updating…' : 'Apply changes'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy}>
              Clear
            </button>
          </div>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {!error && (
        <div className="queue-table-wrap queue-cards">
          <table className={`queue-table ${density === 'compact' ? 'is-compact' : ''}`}>
            <thead>
              <tr>
                <th className="select-cell" aria-label="Select tickets">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={togglePageSelection}
                    disabled={!pageIds.length || bulkBusy || loading}
                    aria-label="Select all tickets on this page"
                  />
                </th>
                {/* Every column here is fixed-width, so the subject column —
                    the main clue for deciding what to open — is whatever they
                    leave behind. These widths are therefore a budget: trim one
                    and the subject gets the difference. */}
                <Th id="ticket" sort={sort} setSort={changeSort} width={100}>Ticket</Th>
                <Th id={null}>Subject &amp; requester</Th>
                <Th id="status" sort={sort} setSort={changeSort} width={112}>Status</Th>
                <Th id="priority" sort={sort} setSort={changeSort} width={104}>Priority</Th>
                <Th id={null} width={248}>SLA</Th>
                {columns.group && <Th id={null} width={132}>Group</Th>}
                {columns.agent && <Th id={null} width={142}>Assigned to</Th>}
                {columns.age && <Th id="created" sort={sort} setSort={changeSort} width={72} align="right">Created</Th>}
                {columns.activity && <Th id="updated" sort={sort} setSort={changeSort} width={92} align="right">Last activity</Th>}
                <th style={{ width: 30 }} aria-label="Open" />
              </tr>
            </thead>

            {loading && tickets === null ? (
              <SkeletonRows columns={columns} />
            ) : (
              <tbody className={loading ? 'is-refreshing' : ''}>
                {rows.map((t) => (
                  <tr
                    key={t.id}
                    tabIndex={0}
                    role="link"
                    aria-label={`${t.ticketNumber} — ${t.shortDescription}`}
                    onClick={() => onOpen(t.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); }
                    }}
                  >
                    {/* The whole cell selects, not just the 13px box inside it.
                        The checkbox stops propagation on its own click, so the
                        two handlers never both fire — clicking the box toggles
                        once, clicking the cell around it toggles once. */}
                    <td
                      className="select-cell"
                      data-label="Select"
                      onClick={(e) => { e.stopPropagation(); toggleSelected(t.id); }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(t.id)}
                        onChange={() => toggleSelected(t.id)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={bulkBusy || loading}
                        aria-label={`Select ${t.ticketNumber}`}
                      />
                    </td>
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
                    <td data-label="Status">
                      <span className="status-cell">
                        <span className="status-primary">
                          <StateBadge state={t.state} />
                          <ConfirmationChip ticket={t} />
                        </span>
                        {/* Who owes the next message. Deliberately a line under
                            the status rather than another badge beside it: a
                            threaded reply adds no row of its own, so this is
                            how it shows up in the queue at all. */}
                        <NextResponseLine ticket={t} />
                      </span>
                    </td>
                    <td data-label="Priority"><PriorityBadge priority={t.priority} /></td>
                    <td data-label="SLA"><SlaCell ticket={t} /></td>
                    {columns.group && (
                      <td data-label="Group">
                        {t.team?.name
                          ? <span className="group-tag" title={t.team.name}>{t.team.name}</span>
                          : <span className="muted small">Triage</span>}
                      </td>
                    )}
                    {columns.agent && (
                      <td data-label="Assigned to">
                        {t.assignedAgent ? (
                          <span className="cell-agent">
                            <Avatar name={t.assignedAgent.name} size={22} />
                            <span className="cell-agent-name" title={t.assignedAgent.name}>{t.assignedAgent.name}</span>
                          </span>
                        ) : (
                          <span className="unassigned-tag">Unassigned</span>
                        )}
                      </td>
                    )}
                    {columns.age && (
                      <td data-label="Created" className="cell-age" title={fmtDateTime(t.createdAt)}>
                        {timeAgo(t.createdAt)}
                      </td>
                    )}
                    {columns.activity && (
                      <td data-label="Last activity" className="cell-age" title={fmtDateTime(t.updatedAt)}>
                        {timeAgo(t.updatedAt)}
                      </td>
                    )}
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
              title={quickView
                ? `${quickView.label} — nothing here`
                : anyFilter ? 'No tickets match these filters' : 'The queue is empty'}
              hint={quickView
                ? quickView.empty
                : anyFilter
                  ? 'Clear the filters to see everything, or search from the bar above.'
                  : 'Tickets arrive by email, or you can raise one manually.'}
              action={
                quickView ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Show the whole queue
                  </button>
                ) : anyFilter ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => { window.location.hash = '/tickets/new'; }}>New ticket</button>
                )
              }
            />
          )}
        </div>
      )}

      {!error && total > PAGE_SIZE && (
        <div className="pagination">
          <span className="muted small">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, total)} of {total}
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
      {closeConfirm && (
        <ConfirmDialog
          title={`Close ${selectedIds.size} selected tickets?`}
          message={agent?.role === 'admin'
            ? "New, In Progress and Resolved tickets will be closed by administrator decision. Unresolved tickets will not be marked as resolved. Closing overrides any pending requester confirmation. Already closed tickets are skipped. Only a requester reply can reopen a closed ticket."
            : "Only resolved tickets you have permission to close will be closed. Other tickets stay selected, with an explanation. Only a requester reply can reopen a closed ticket."}
          confirmLabel="Close selected tickets"
          danger
          busy={bulkBusy}
          onConfirm={closeSelectedTickets}
          onCancel={() => { if (!bulkBusy) setCloseConfirm(false); }}
        />
      )}
      {toastNode}
    </div>
  );
}
