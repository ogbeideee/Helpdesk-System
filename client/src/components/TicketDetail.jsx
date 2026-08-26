import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  STATES, PRIORITIES, CATEGORIES,
  STATE_TRANSITIONS,
} from '../constants.js';
import {
  Spinner, ErrorState, EmptyState, StateBadge, PriorityBadge, SlaBadge,
  Avatar, Modal, ConfirmDialog, useToast, fmtDateTime, initials,
} from './ui.jsx';

const STATE_LABELS = Object.fromEntries(STATES.map((s) => [s.value, s.label]));
const PRIORITY_LABELS = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label]));

export default function TicketDetail({ id, me, onChanged }) {
  const [ticket, setTicket] = useState(null);
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionText, setResolutionText] = useState('');
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [assignPick, setAssignPick] = useState('');
  const [groupPick, setGroupPick] = useState('');
  const [showToast, toastNode] = useToast();

  const load = useCallback(() => {
    setError('');
    return api
      .getTicket(id)
      .then((t) => {
        setTicket(t);
        setGroupPick(t.team?.key || '');
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
    api
      .dashboard()
      .then((d) => setAgents(d.ticketsPerAgent || []))
      .catch(() => {});
    api.groups().then(setGroups).catch(() => {});
  }, [load]);

  async function run(fn, successMessage) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChanged?.();
      if (successMessage) showToast(successMessage);
      return true;
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (error && !ticket) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!ticket) return <div className="page"><Spinner label="Loading ticket…" /></div>;

  const open = ['NEW', 'IN_PROGRESS'].includes(ticket.state);
  const nextStates = STATE_TRANSITIONS[ticket.state] || [];
  const canStart = nextStates.includes('IN_PROGRESS');
  const canResolve = nextStates.includes('RESOLVED');
  const canClose = nextStates.includes('CLOSED');

  return (
    <div className="page">
      <header className="page-head detail-head">
        <div>
          <button className="crumb" onClick={() => window.history.back()}>← Tickets</button>
          <h1 className="detail-title">
            <span className="mono ticket-no">{ticket.ticketNumber}</span>
            {ticket.shortDescription}
          </h1>
          <div className="pill-row">
            <StateBadge state={ticket.state} />
            <PriorityBadge priority={ticket.priority} />
            <SlaBadge ticket={ticket} />
            {ticket.awaitingAssignment && <span className="chip chip-warn">awaiting assignment</span>}
            {ticket.source === 'email' && <span className="chip">📧 via email</span>}
          </div>
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <div className="detail-layout">
        {/* ---------------- main column ---------------- */}
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Original Request</h2></div>
            <div className="request-body">{ticket.body || <span className="muted">(no content)</span>}</div>
          </section>

          {(open || ticket.state === 'IN_PROGRESS') && (
            <section className="card">
              <div className="card-head"><h2>Respond</h2></div>
              <textarea
                rows={4}
                placeholder="Write an update…"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <div className="composer-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || !noteText.trim()}
                  onClick={() => run(async () => {
                    await api.addNote(id, noteText, false);
                    setNoteText('');
                  }, 'Requester-facing update added')}
                  title={ticket.requesterEmail ? `Will be emailed to ${ticket.requesterEmail}` : 'No requester email on file'}
                >
                  Send requester update
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy || !noteText.trim()}
                  onClick={() => run(async () => {
                    await api.addNote(id, noteText, true);
                    setNoteText('');
                  }, 'Internal note added')}
                >
                  Add internal note
                </button>
                {!ticket.requesterEmail && <span className="muted small">Requester updates cannot be emailed (no address on file).</span>}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Activity Timeline</h2>
              <span className="muted small">{buildTimeline(ticket).length} events</span>
            </div>
            <Timeline ticket={ticket} />
          </section>
        </div>

        {/* ---------------- side column: properties + actions ---------------- */}
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Properties</h2></div>
            <dl className="props">
              <div><dt>Requester</dt><dd>{ticket.requesterName || '—'}</dd></div>
              <div><dt>Requester Email</dt><dd className="mono-sm">{ticket.requesterEmail}</dd></div>
              <div>
                <dt>Category</dt>
                <dd>
                  <select
                    value={ticket.category}
                    disabled={busy}
                    onChange={(e) => run(async () => api.updateTicket(id, { category: e.target.value }))}
                  >
                    {[...new Set([ticket.category, ...CATEGORIES])].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>
                  <select
                    value={ticket.priority}
                    disabled={busy}
                    onChange={(e) => run(async () => api.updateTicket(id, { priority: e.target.value }), 'Priority updated')}
                  >
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </dd>
              </div>
              <div>
                <dt>Assignment Group</dt>
                <dd>
                  <select value={groupPick} disabled={busy} onChange={(e) => setGroupPick(e.target.value)}>
                    <option value="">Triage (none)</option>
                    {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy || groupPick === (ticket.team?.key || '')}
                    onClick={() => run(
                      async () => api.updateTicket(id, { assignmentGroup: groupPick || null }),
                      'Assignment group changed'
                    )}
                  >
                    Apply
                  </button>
                </dd>
              </div>
              <div>
                <dt>Assigned Agent</dt>
                <dd>
                  {ticket.assignedAgent ? (
                    <span className="cell-agent"><Avatar name={ticket.assignedAgent.name} size={22} /> {ticket.assignedAgent.name}</span>
                  ) : <span className="muted">Unassigned</span>}
                </dd>
              </div>
              <div><dt>Created</dt><dd>{fmtDateTime(ticket.createdAt)}</dd></div>
              <div><dt>Updated</dt><dd>{fmtDateTime(ticket.updatedAt)}</dd></div>
              {ticket.dueAt && <div><dt>SLA Target</dt><dd>{fmtDateTime(ticket.dueAt)}</dd></div>}
              {ticket.resolution && (
                <div className="prop-resolution">
                  <dt>Resolution</dt>
                  <dd>{ticket.resolution}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="card">
            <div className="card-head"><h2>Actions</h2></div>

            {/* Workflow */}
            <div className="action-block">
              <h3 className="action-label">Workflow</h3>
              <div className="btn-row">
                {canStart && (
                  <button className="btn btn-primary" disabled={busy}
                    onClick={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }, ), 'Work started')}>
                    ▶ Start work
                  </button>
                )}
                {canResolve && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => setResolveOpen(true)}>
                    ✓ Resolve…
                  </button>
                )}
                {canClose && (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => setCloseConfirm(true)}>
                    ⏹ Close ticket
                  </button>
                )}
                {!open && nextStates.includes('IN_PROGRESS') && (
                  <button className="btn btn-ghost" disabled={busy}
                    onClick={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }), 'Ticket reopened')}>
                    ↺ Reopen
                  </button>
                )}
                {!canStart && !canResolve && !canClose && ticket.state === 'CLOSED' && (
                  <span className="muted small">Closed tickets can only be reopened.</span>
                )}
              </div>
            </div>

            {/* Assignment */}
            <div className="action-block">
              <h3 className="action-label">Assign / Reassign</h3>
              <div className="assign-controls">
                <select value={assignPick} onChange={(e) => setAssignPick(e.target.value)} aria-label="Select agent">
                  <option value="">Select agent…</option>
                  {agents.filter((a) => a.agentId !== ticket.assignedAgentId).map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.name} · {a.assignmentGroup || 'no group'} · L{a.skillLevel} · {a.openTickets} open
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || !assignPick}
                  onClick={() => run(async () => api.assignTicket(id, { agentId: Number(assignPick) }),
                    ticket.assignedAgent ? 'Ticket reassigned' : 'Ticket assigned')}
                >
                  {ticket.assignedAgent ? 'Reassign' : 'Assign'}
                </button>
              </div>
            </div>

            {me.role === 'admin' && (
              <div className="action-block">
                <h3 className="action-label">Administration</h3>
                <p className="muted small">Deleting is permanent and removes the audit history. Prefer closing the ticket.</p>
                <DeleteButton id={id} busy={busy} onDeleted={() => window.location.hash = '/tickets'} run={run} />
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Resolve modal — resolution note is mandatory (backend enforces too) */}
      {resolveOpen && (
        <Modal title={`Resolve ${ticket.ticketNumber}`} onClose={() => setResolveOpen(false)}>
          <p className="modal-message">
            A resolution note is required. It will be recorded in the audit history
            {ticket.requesterEmail ? ' and included in the notification to the requester.' : '.'}
          </p>
          <textarea
            rows={4}
            autoFocus
            placeholder="Describe how the issue was resolved…"
            value={resolutionText}
            onChange={(e) => setResolutionText(e.target.value)}
          />
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setResolveOpen(false)} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || !resolutionText.trim()}
              onClick={async () => {
                const ok = await run(async () => api.resolveTicket(id, { resolution: resolutionText }), 'Ticket resolved');
                if (ok) {
                  setResolveOpen(false);
                  setResolutionText('');
                }
              }}
            >
              Resolve ticket
            </button>
          </div>
        </Modal>
      )}

      {closeConfirm && (
        <ConfirmDialog
          title="Close this ticket?"
          message={`${ticket.ticketNumber} will be closed. Closed tickets can be reopened if the requester replies, but no further status changes to NEW are possible.`}
          confirmLabel="Close ticket"
          danger
          busy={busy}
          onCancel={() => setCloseConfirm(false)}
          onConfirm={async () => {
            const ok = await run(async () => api.closeTicket(id, {}), 'Ticket closed');
            if (ok) setCloseConfirm(false);
          }}
        />
      )}

      {toastNode}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

function buildTimeline(ticket) {
  const events = [];

  events.push({
    kind: 'created',
    at: ticket.createdAt,
    title: 'Ticket created',
    detail: `Received from ${ticket.requesterName || ticket.requesterEmail}${ticket.source === 'email' ? ' via email' : ' via portal'}`,
  });

  for (const log of ticket.auditLogs || []) {
    if (!log.fromState && log.toState === 'NEW') continue; // covered by created event
    const assignmentChange =
      log.note && /assigned|claim/i.test(log.note) && log.fromState === log.toState;
    events.push({
      kind: log.fromState !== log.toState ? 'status' : assignmentChange ? 'assignment' : 'audit',
      at: log.createdAt,
      title:
        log.fromState && log.fromState !== log.toState
          ? `Status: ${STATE_LABELS[log.fromState] || log.fromState} → ${STATE_LABELS[log.toState] || log.toState}`
          : log.note || 'Updated',
      detail: [
        ...(log.note && log.fromState !== log.toState ? [log.note] : []),
        `by ${prettyActor(log.actor)}`,
      ].filter(Boolean).join(' · '),
      actor: prettyActor(log.actor),
    });
  }

  for (const c of ticket.comments || []) {
    events.push({
      kind: c.isInternal ? 'internal' : 'update',
      at: c.createdAt,
      title: c.isInternal
        ? `Internal note — ${c.authorName}`
        : c.isRequester
          ? `Requester reply — ${c.authorName || c.authorEmail}`
          : `Requester-facing update — ${c.authorName}`,
      detail: c.body,
      authorInitials: initials(c.authorName || c.authorEmail),
    });
  }

  if (ticket.resolvedAt && ticket.resolution) {
    events.push({
      kind: 'resolution',
      at: ticket.resolvedAt,
      title: 'Resolved',
      detail: ticket.resolution,
    });
  }

  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

function prettyActor(actor) {
  if (!actor) return 'system';
  if (actor === 'system') return 'automation';
  const m = /^(.*?)\s*</.exec(actor);
  return m ? m[1] : actor;
}

const KIND_META = {
  created:     { icon: '✦', cls: 'tl-created', },
  status:      { icon: '⇄', cls: 'tl-status' },
  assignment:  { icon: '👤', cls: 'tl-assign' },
  internal:    { icon: '🔒', cls: 'tl-internal' },
  update:      { icon: '💬', cls: 'tl-update' },
  resolution:  { icon: '✓', cls: 'tl-resolution' },
  audit:       { icon: '•', cls: 'tl-audit' },
};

function Timeline({ ticket }) {
  const events = useMemo(() => buildTimeline(ticket), [ticket]);
  if (!events.length) return <EmptyState icon="🕰️" title="No activity yet" />;
  return (
    <ol className="timeline">
      {events.map((ev, i) => {
        const meta = KIND_META[ev.kind] || KIND_META.audit;
        return (
          <li key={i} className={`timeline-item ${meta.cls}`}>
            <span className="timeline-icon" aria-hidden="true">{meta.icon}</span>
            <div className="timeline-body">
              <div className="timeline-title">{ev.title}</div>
              {ev.detail && <div className={`timeline-detail ${ev.kind === 'resolution' ? 'resolution-text' : ''}`}>{ev.detail}</div>}
              <time className="muted small">{fmtDateTime(ev.at)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DeleteButton({ id, busy, onDeleted, run }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  return (
    <>
      <button className="btn btn-danger btn-sm" onClick={() => setConfirming(true)} disabled={busy}>
        Delete ticket…
      </button>
      {confirming && (
        <Modal title="Delete ticket permanently?" onClose={() => setConfirming(false)} width={420}>
          <p className="modal-message">
            This destroys the ticket, its notes and its entire audit history.
            Type <strong>DELETE</strong> to confirm.
          </p>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" />
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={confirmText !== 'DELETE'}
              onClick={async () => {
                try {
                  await api.deleteTicket(id);
                  onDeleted();
                } catch (e) {
                  alert(e.message);
                }
              }}
            >
              Delete forever
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
