import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorState, EmptyState, useToast, Icon, fmtDateTime } from './ui.jsx';
import {
  ENTITY_TYPES,
  buildAuditQuery,
  eventRows,
  changePairs,
  metadataPairs,
  entityTypeLabel,
  isFiltered,
  resultRange,
} from '../auditView.js';

const PAGE_SIZE = 50;
const EMPTY_DRAFT = { action: '', entityType: '', actor: '', from: '', to: '' };

// The expandable detail of one event: what changed (from → to) and the
// structured metadata, both rendered as escaped key/value pairs — the trail
// stores no credentials and the renderer treats every value as text.
function EventDetail({ row }) {
  const changes = changePairs(row);
  const meta = metadataPairs(row);
  return (
    <div className="audit-detail">
      <div className="audit-detail-grid">
        <div className="audit-kv-key">Event</div>
        <div className="audit-kv-value">
          <code className="audit-action">{row.action}</code>
          <span className="muted small" style={{ marginLeft: 8 }}>#{row.id}</span>
        </div>

        <div className="audit-kv-key">Entity</div>
        <div className="audit-kv-value">
          {entityTypeLabel(row.entityType)}
          {row.entityLabel ? <span className="muted"> · {row.entityLabel}</span> : null}
          {row.entityId != null ? <span className="muted small"> (id {row.entityId})</span> : null}
          {row.entityType && !row.entityLabel && row.entityId == null ? (
            <span className="muted small"> — the record itself is no longer referenced</span>
          ) : null}
          {row.ticketId != null ? (
            <span className="muted small" style={{ marginLeft: 8 }}>linked ticket #{row.ticketId}</span>
          ) : null}
        </div>

        {changes.length > 0 && (
          <>
            <div className="audit-kv-key">Changes</div>
            <div className="audit-kv-value">
              {changes.map((c) => (
                <div key={c.key} className="audit-diff-row">
                  <span className="audit-diff-key">{c.key}</span>
                  <span className="audit-diff-from">{c.from === null ? '—' : c.from}</span>
                  <span className="muted" aria-hidden="true">→</span>
                  <span className="audit-diff-to">{c.to === null ? '—' : c.to}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {meta.length > 0 && (
          <>
            <div className="audit-kv-key">Metadata</div>
            <div className="audit-kv-value">
              {meta.map((m) => (
                <div key={m.key} className="audit-diff-row">
                  <span className="audit-diff-key">{m.key}</span>
                  <span className="audit-kv-text">{m.value}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <details className="audit-raw">
        <summary className="muted small">Raw structured record</summary>
        <pre>{JSON.stringify(
          {
            id: row.id,
            action: row.action,
            actor: row.actor,
            entityType: row.entityType,
            entityId: row.entityId,
            entityLabel: row.entityLabel,
            ticketId: row.ticketId,
            from: row.from,
            to: row.to,
            metadata: row.metadata,
          },
          null,
          2
        )}</pre>
      </details>
    </div>
  );
}

export default function AuditTrailPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [applied, setApplied] = useState({});
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async (query, pageNo = 1) => {
    setError('');
    try {
      const d = await api.auditEvents({ ...query, page: pageNo });
      setData(d);
      setPage(d.page);
      return d;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, []);

  useEffect(() => { load({}); }, [load]);

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function applyFilters(e) {
    e.preventDefault();
    const verdict = buildAuditQuery(draft);
    if (!verdict.ok) {
      showToast(verdict.error, 'error');
      return;
    }
    run(async () => {
      await load(verdict.query, 1);
      setApplied(verdict.query);
      setExpandedId(null);
    });
  }

  function clearFilters() {
    setDraft(EMPTY_DRAFT);
    run(async () => {
      await load({}, 1);
      setApplied({});
      setExpandedId(null);
    });
  }

  function gotoPage(p) {
    run(async () => {
      await load(applied, p);
      setExpandedId(null);
    });
  }

  if (error) {
    return (
      <div className="page">
        <ErrorState message={error} onRetry={() => run(() => load(applied, page))} />
      </div>
    );
  }
  if (!data) return <div className="page"><Spinner label="Loading audit trail…" /></div>;

  const rows = eventRows(data.events);
  const filtered = isFiltered(applied);
  const entityOptions = Array.isArray(data.entityTypes) && data.entityTypes.length
    ? data.entityTypes
    : ENTITY_TYPES;
  const range = resultRange(data);
  const totalPages = Math.max(data.totalPages, data.total ? 1 : 0);

  return (
    <div className="page">
      <form className="filter-bar audit-controls" onSubmit={applyFilters}>
        <input
          type="search"
          className="filter-search"
          placeholder="Search by action — e.g. ticket. or setting.updated"
          aria-label="Search by action"
          value={draft.action}
          onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
        />
        <select
          aria-label="Entity type"
          value={draft.entityType}
          onChange={(e) => setDraft((d) => ({ ...d, entityType: e.target.value }))}
        >
          <option value="">All entity types</option>
          {entityOptions.map((t) => (
            <option key={t} value={t}>{entityTypeLabel(t)}</option>
          ))}
        </select>
        <input
          type="search"
          className="filter-search"
          placeholder="Actor — name, email, or system"
          aria-label="Filter by actor"
          value={draft.actor}
          onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))}
        />
        <label className="report-date">
          <span>From</span>
          <input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
        </label>
        <label className="report-date">
          <span>To</span>
          <input
            type="date"
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Apply filters
        </button>
        {filtered && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={clearFilters}>
            Clear
          </button>
        )}
      </form>

      <section className="card" style={{ paddingTop: 16 }}>
        <div className="card-head">
          <h2>Audit trail</h2>
          <span className="muted small">
            {range ? `${range} events` : 'no events'}
            {filtered ? ' · filtered' : ' · most recent first'}
          </span>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon="🧾"
            title={filtered ? 'No audit events match these filters' : 'The audit trail is empty'}
            hint={
              filtered
                ? 'Widen the date range or clear the filters to see recent activity.'
                : 'Actions such as ticket changes, assignments, handovers and settings updates will appear here as they happen.'
            }
            action={filtered ? (
              <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear filters</button>
            ) : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="table audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Summary</th>
                  <th aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = expandedId === row.id;
                  return (
                    <FragmentRow
                      key={row.id}
                      row={row}
                      open={open}
                      onToggle={() => setExpandedId(open ? null : row.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data.total > 0 && (
          <div className="pagination">
            <span className="muted small">
              {range} · filtering and paging happen on the server
            </span>
            <div className="pagination-controls">
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy || page <= 1}
                onClick={() => gotoPage(page - 1)}
              >
                Previous
              </button>
              <span className="muted small tnum">Page {page} of {totalPages}</span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy || page >= totalPages}
                onClick={() => gotoPage(page + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {toastNode}
    </div>
  );
}

function FragmentRow({ row, open, onToggle }) {
  return (
    <>
      <tr
        className={`audit-row ${open ? 'is-open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="audit-when tnum" title={row.createdAt}>
          {fmtDateTime(row.createdAt)}
        </td>
        <td className="audit-actor">
          {row.actor}
          {row.actorId != null ? <span className="muted small"> #{row.actorId}</span> : null}
        </td>
        <td><code className="audit-action">{row.action}</code></td>
        <td className="audit-entity">{row.entity}</td>
        <td className="audit-summary">{row.description}</td>
        <td className="audit-chevron">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </td>
      </tr>
      {open && (
        <tr className="audit-detail-tr">
          <td colSpan={6}>
            <EventDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
