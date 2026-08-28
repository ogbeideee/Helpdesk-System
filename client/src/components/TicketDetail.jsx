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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteMode, setNoteMode] = useState('public'); // 'public' | 'internal'
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionText, setResolutionText] = useState('');
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [candidatesError, setCandidatesError] = useState('');
  const [assignPick, setAssignPick] = useState('');
  const [reassignReason, setReassignReason] = useState('');
  const [groupPick, setGroupPick] = useState('');
  const [handovers, setHandovers] = useState([]);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverPick, setHandoverPick] = useState('');
  const [handoverNote, setHandoverNote] = useState('');
  const [showToast, toastNode] = useToast();

  const load = useCallback(() => {
    setError('');
    return api
      .getTicket(id)
      .then((t) => {
        setTicket(t);
        setGroupPick(t.team?.key || '');
        return api.ticketHandovers(id).then((h) => setHandovers(h.handovers || [])).catch(() => {});
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!reassignOpen && !handoverOpen) return;
    setCandidates(null);
    setCandidatesError('');
    setAssignPick('');
    setReassignReason('');
    setHandoverPick('');
    setHandoverNote('');
    api
      .assignmentCandidates(id)
      .then(setCandidates)
      .catch((e) => setCandidatesError(e.message));
  }, [reassignOpen, handoverOpen, id]);

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

  const events = useMemo(
    () => (ticket ? buildTimeline(ticket) : []),
    [ticket]
  );

  if (error && !ticket) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;
  if (!ticket) return <div className="page"><Spinner label="Loading ticket…" /></div>;

  const open = ['NEW', 'IN_PROGRESS'].includes(ticket.state);
  const nextStates = STATE_TRANSITIONS[ticket.state] || [];
  const canStart = nextStates.includes('IN_PROGRESS');
  const canResolve = nextStates.includes('RESOLVED');
  const canClose = nextStates.includes('CLOSED');
  const activeHandover = handovers.find((h) => h.active) || null;

  return (
    <div className="page">
      <header className="page-head detail-head">
        <div>
          <button className="crumb" onClick={() => window.location.hash = '/tickets'}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
            Tickets
          </button>
          <h1 className="detail-title">
            <span className="cell-id">{ticket.ticketNumber}</span>
            {ticket.shortDescription}
          </h1>
          <div className="pill-row">
            <StateBadge state={ticket.state} />
            <PriorityBadge priority={ticket.priority} />
            <SlaBadge ticket={ticket} />
            {ticket.awaitingAssignment && <span className="chip chip-warn">awaiting assignment</span>}
            {ticket.source === 'email' && <span className="chip">via email</span>}
            {ticket.category && <span className="chip">{ticket.category}</span>}
          </div>
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <div className="detail-layout">
        <div className="stack">
          <Conversation
            ticket={ticket}
            events={events}
            handovers={handovers}
          />

          {open && (
            <Composer
              me={me}
              ticket={ticket}
              noteText={noteText}
              setNoteText={setNoteText}
              noteMode={noteMode}
              setNoteMode={setNoteMode}
              busy={busy}
              onSend={async () => {
                const isInternal = noteMode === 'internal';
                const ok = await run(async () => {
                  await api.addNote(id, noteText, isInternal);
                  setNoteText('');
                }, isInternal ? 'Internal note added' : 'Requester update added');
                return ok;
              }}
            />
          )}
        </div>

        <div className="stack side-panel">
          <PropertiesCard
            ticket={ticket}
            busy={busy}
            groupPick={groupPick}
            setGroupPick={setGroupPick}
            run={run}
            me={me}
          />
          <ActionsCard
            ticket={ticket}
            me={me}
            busy={busy}
            canStart={canStart}
            canResolve={canResolve}
            canClose={canClose}
            nextStates={nextStates}
            open={open}
            activeHandover={activeHandover}
            onStart={() => run(async () => api.startTicket(id), 'Work started')}
            onInProgress={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }), 'Status updated')}
            onResolve={() => setResolveOpen(true)}
            onClose={() => setCloseConfirm(true)}
            onReopen={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }), 'Ticket reopened')}
            onReassign={() => setReassignOpen(true)}
            onHandover={() => setHandoverOpen(true)}
            onCancelHandover={(hid) => run(async () => api.cancelHandover(hid), 'Handover cancelled')}
            onTake={() => run(async () => api.takeTicket(id), 'Ticket is now yours')}
          />
        </div>
      </div>

      {reassignOpen && (
        <Modal title={`Reassign ${ticket.ticketNumber}`} onClose={() => setReassignOpen(false)} width={560}>
          {candidatesError && <div className="callout callout-error">{candidatesError}</div>}
          {!candidates && !candidatesError && <Spinner label="Loading team…" />}
          {candidates && (
            <>
              <div className="reassign-current">
                <h4 className="action-label">Current assignment</h4>
                <div className="muted small">
                  {candidates.assignmentGroup ? candidates.assignmentGroup.name : 'No assignment group'}
                </div>
                <div style={{ marginTop: 4 }}>
                  {candidates.currentAssignee ? (
                    <>
                      <strong>{candidates.currentAssignee.name}</strong>{' '}
                      <span className="muted small">· {candidates.currentAssignee.openTickets} open</span>
                    </>
                  ) : (
                    <em className="muted">Unassigned</em>
                  )}
                </div>
              </div>
              <h4 className="action-label" style={{ marginTop: 14 }}>Reassign to</h4>
              {candidates.candidates.length === 0 && (
                <p className="muted small">No other agents in this assignment group.</p>
              )}
              <div className="reassign-list">
                {candidates.candidates.map((c) => (
                  <label
                    key={c.id}
                    className={`reassign-option ${c.selectable ? '' : 'is-disabled'} ${String(c.id) === assignPick ? 'is-selected' : ''}`}
                    title={c.selectable ? '' : c.reason || 'Not selectable'}
                  >
                    <input
                      type="radio" name="reassign-target" value={c.id}
                      disabled={!c.selectable}
                      checked={String(c.id) === assignPick}
                      onChange={() => setAssignPick(String(c.id))}
                    />
                    <span className="reassign-option-body">
                      <strong>{c.name}</strong>
                      <small className="muted">
                        {c.skillLabel} · {c.assignmentGroup || 'no group'} ·{' '}
                        <span className={c.available ? 'ok-text' : 'warn-text'}>
                          {c.available ? 'Available' : 'Unavailable'}
                        </span>{' '}
                        · {c.openTickets} open {c.openTickets === 1 ? 'ticket' : 'tickets'}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <label className="field" style={{ marginTop: 12 }}>
                <span className="field-label">Reason (optional)</span>
                <textarea
                  rows={2}
                  placeholder="e.g. Currently handling several critical requests."
                  value={reassignReason}
                  onChange={(e) => setReassignReason(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setReassignOpen(false)} disabled={busy}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={busy || !assignPick}
                  onClick={() => run(async () => {
                    await api.reassignTicket(id, { agentId: Number(assignPick), reason: reassignReason.trim() || undefined });
                    setReassignOpen(false);
                  }, 'Ticket reassigned')}
                >
                  Reassign
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {handoverOpen && (
        <Modal title={`Request a handover of ${ticket.ticketNumber}`} onClose={() => setHandoverOpen(false)} width={560}>
          <p className="modal-message">
            The ticket stays with {ticket.assignedAgent ? ticket.assignedAgent.name : 'its current owner'} until
            the teammate accepts. They can accept, decline, or suggest somebody else.
          </p>
          {candidatesError && <div className="callout callout-error">{candidatesError}</div>}
          {!candidates && !candidatesError && <Spinner label="Loading team…" />}
          {candidates && (
            <>
              {candidates.candidates.filter((c) => !c.isCurrentAssignee).length === 0 && (
                <p className="muted small">No other agents in this assignment group.</p>
              )}
              <div className="reassign-list">
                {candidates.candidates.filter((c) => !c.isCurrentAssignee).map((c) => (
                  <label
                    key={c.id}
                    className={`reassign-option ${c.selectable ? '' : 'is-disabled'} ${String(c.id) === handoverPick ? 'is-selected' : ''}`}
                    title={c.selectable ? '' : c.reason || 'Not selectable'}
                  >
                    <input
                      type="radio" name="handover-target" value={c.id}
                      disabled={!c.selectable}
                      checked={String(c.id) === handoverPick}
                      onChange={() => setHandoverPick(String(c.id))}
                    />
                    <span className="reassign-option-body">
                      <strong>{c.name}</strong>
                      <small className="muted">
                        {c.skillLabel} · {c.assignmentGroup || 'no group'} ·{' '}
                        <span className={c.available ? 'ok-text' : 'warn-text'}>
                          {c.available ? 'Available' : 'Unavailable'}
                        </span>{' '}
                        · {c.openTickets} open
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <label className="field" style={{ marginTop: 12 }}>
                <span className="field-label">Message (optional)</span>
                <textarea rows={2} value={handoverNote} onChange={(e) => setHandoverNote(e.target.value)}
                  placeholder="e.g. You dealt with this printer last week." />
              </label>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setHandoverOpen(false)} disabled={busy}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={busy || !handoverPick}
                  onClick={() => run(async () => {
                    await api.requestHandover(id, { agentId: Number(handoverPick), note: handoverNote.trim() || undefined });
                    setHandoverOpen(false);
                  }, 'Handover requested')}
                >
                  Send request
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

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
                if (ok) { setResolveOpen(false); setResolutionText(''); }
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

      {me.role === 'admin' && (
        <DeleteZone id={id} onDeleted={() => { window.location.hash = '/tickets'; }} />
      )}

      {toastNode}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation — the main workspace                                  */
/* ------------------------------------------------------------------ */

function Conversation({ ticket, events, handovers }) {
  return (
    <section className="card" style={{ padding: '20px 22px' }}>
      <div className="card-head">
        <h2>Conversation</h2>
        <span className="muted small">{events.length} event{events.length === 1 ? '' : 's'}</span>
      </div>
      <div className="conversation">
        <OriginalMessage ticket={ticket} />
        {events
          .filter((ev) => !['created'].includes(ev.kind))
          .map((ev, i) => <EventItem key={i} ev={ev} />)}
        {handovers.length > 0 && <HandoverChain handovers={handovers} />}
        {ticket.state === 'CLOSED' && (
          <div className="conv-item is-system">
            <Avatar name="system" size={28} />
            <div>
              <div className="conv-meta"><strong>Closed</strong> · no further status changes possible</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function OriginalMessage({ ticket }) {
  return (
    <div className="conv-item is-requester conv-original">
      <Avatar name={ticket.requesterName || ticket.requesterEmail} size={28} />
      <div>
        <div className="conv-meta">
          <strong>{ticket.requesterName || 'Requester'}</strong>
          {ticket.requesterEmail && <span className="muted mono-sm">{ticket.requesterEmail}</span>}
          <span className="muted">opened this ticket</span>
          <span className="muted small">{fmtDateTime(ticket.createdAt)}</span>
          {ticket.source === 'email' && <span className="chip" style={{ fontSize: 10 }}>via email</span>}
        </div>
        <div className="conv-bubble">{ticket.body || '(no message body)'}</div>
      </div>
    </div>
  );
}

function EventItem({ ev }) {
  const kind = ev.kind;
  const isInternal = kind === 'internal';
  const isUpdate = kind === 'update';
  const isResolution = kind === 'resolution';
  const isSystem = ['status', 'reassign', 'assignment', 'handover', 'group', 'closed', 'reopened', 'audit'].includes(kind);

  if (isSystem) {
    return (
      <div className="conv-item is-system">
        <Avatar name={ev.actor || 'system'} size={28} />
        <div>
          <div className="conv-meta">
            <strong>{ev.title}</strong>
            {ev.actor && <span className="muted">by {ev.actor}</span>}
            <span className="muted small">{fmtDateTime(ev.at)}</span>
          </div>
          {ev.detail && <div className="muted small" style={{ marginTop: 2 }}>{ev.detail}</div>}
        </div>
      </div>
    );
  }

  const variant = isInternal ? 'is-internal' : isUpdate ? 'is-update' : isResolution ? 'is-resolution' : '';
  return (
    <div className={`conv-item ${variant}`}>
      <Avatar name={ev.authorInitials ? ev.title : (ev.title || 'agent')} size={28} />
      <div>
        <div className="conv-meta">
          <strong>{ev.title}</strong>
          <span className="muted small">{fmtDateTime(ev.at)}</span>
          {isInternal && <span className="chip chip-warn" style={{ fontSize: 10 }}>Internal</span>}
          {isResolution && <span className="chip chip-ok" style={{ fontSize: 10 }}>Resolution</span>}
        </div>
        <div className={`conv-bubble ${isResolution ? 'resolution-text' : ''}`}>{ev.detail}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composer — chat-style reply box                                    */
/* ------------------------------------------------------------------ */

function Composer({ me, ticket, noteText, setNoteText, noteMode, setNoteMode, busy, onSend }) {
  const isPublic = noteMode === 'public';
  return (
    <section className="card" style={{ padding: 16 }}>
      <div className="card-head" style={{ marginBottom: 6 }}>
        <h2>{isPublic ? 'Reply to requester' : 'Add internal note'}</h2>
        <div className="composer-toggle" role="tablist">
          <button className={isPublic ? 'is-active' : ''} onClick={() => setNoteMode('public')}>Public</button>
          <button className={!isPublic ? 'is-active' : ''} onClick={() => setNoteMode('internal')}>Internal</button>
        </div>
      </div>
      <div className="composer">
        <textarea
          rows={3}
          placeholder={isPublic ? `Message ${ticket.requesterName || 'the requester'}…` : 'Note for the team — never sent to the requester.'}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
        />
        <div className="composer-toolbar">
          <div className="muted small">
            {isPublic
              ? ticket.requesterEmail ? `Will email ${ticket.requesterEmail}` : 'No requester email on file'
              : 'Internal — only visible to the team.'}
          </div>
          <div className="btn-row">
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy || !noteText.trim()}
              onClick={() => { setNoteText(''); }}
            >Discard</button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !noteText.trim()}
              onClick={onSend}
            >
              {isPublic ? 'Send to requester' : 'Add note'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Properties side panel                                              */
/* ------------------------------------------------------------------ */

function PropertiesCard({ ticket, busy, groupPick, setGroupPick, run, me }) {
  return (
    <section className="card">
      <div className="card-head"><h2>Properties</h2></div>
      <dl className="props">
        <div><dt>Requester</dt><dd>{ticket.requesterName || '—'}</dd></div>
        <div><dt>Email</dt><dd className="mono-sm" style={{ fontSize: 11.5 }}>{ticket.requesterEmail}</dd></div>
        <div>
          <dt>Category</dt>
          <dd>
            <select
              value={ticket.category}
              disabled={busy}
              onChange={(e) => run(async () => api.updateTicket(ticket.id, { category: e.target.value }))}
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
              onChange={(e) => run(async () => api.updateTicket(ticket.id, { priority: e.target.value }), 'Priority updated')}
            >
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </dd>
        </div>
        <div>
          <dt>Group</dt>
          <dd>
            <select
              value={groupPick}
              disabled={busy || me.role !== 'admin'}
              onChange={(e) => setGroupPick(e.target.value)}
            >
              <option value="">Triage</option>
              {/* options injected from page state — using groups from API */}
              <GroupsOptions current={groupPick} />
            </select>
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy || me.role !== 'admin' || groupPick === (ticket.team?.key || '')}
              onClick={() => run(
                async () => api.updateTicket(ticket.id, { assignmentGroup: groupPick || null }),
                'Assignment group changed'
              )}
            >Apply</button>
          </dd>
        </div>
        <div>
          <dt>Assignee</dt>
          <dd>
            {ticket.assignedAgent ? (
              <span className="cell-agent">
                <Avatar name={ticket.assignedAgent.name} size={22} />
                <strong>{ticket.assignedAgent.name}</strong>
              </span>
            ) : <span className="muted small">Unassigned</span>}
          </dd>
        </div>
        <div><dt>Created</dt><dd className="muted small">{fmtDateTime(ticket.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd className="muted small">{fmtDateTime(ticket.updatedAt)}</dd></div>
        {ticket.dueAt && <div><dt>SLA</dt><dd className="muted small">{fmtDateTime(ticket.dueAt)}</dd></div>}
        {ticket.resolution && (
          <div className="prop-resolution">
            <dt>Resolution</dt>
            <dd className="resolution-text" style={{ fontSize: 12.5, fontStyle: 'italic' }}>{ticket.resolution}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function GroupsOptions({ current }) {
  const [groups, setGroups] = useState([]);
  useEffect(() => {
    api.groups().then((g) => setGroups(g)).catch(() => {});
  }, []);
  return (
    <>
      {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Actions side panel                                                 */
/* ------------------------------------------------------------------ */

function ActionsCard({
  ticket, me, busy,
  canStart, canResolve, canClose, nextStates, open, activeHandover,
  onStart, onInProgress, onResolve, onClose, onReopen,
  onReassign, onHandover, onCancelHandover, onTake,
}) {
  return (
    <section className="card">
      <div className="card-head"><h2>Actions</h2></div>

      <div className="action-block">
        <h3 className="action-label">Workflow</h3>
        <div className="btn-row">
          {canStart && ticket.state === 'NEW' && (ticket.assignedAgentId === me.id || me.role === 'admin') && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onStart}>
              Start working
            </button>
          )}
          {canResolve && (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onResolve}>
              Resolve…
            </button>
          )}
          {canClose && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onClose}>
              Close ticket
            </button>
          )}
          {!open && nextStates.includes('IN_PROGRESS') && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onReopen}>
              Reopen
            </button>
          )}
          {!canStart && !canResolve && !canClose && ticket.state === 'CLOSED' && (
            <p className="muted small" style={{ margin: 0 }}>
              Closed. Reopens automatically if the requester replies.
            </p>
          )}
        </div>
      </div>

      {ticket.state !== 'CLOSED' && (
        <div className="action-block">
          <h3 className="action-label">Assignment</h3>
          <div className="btn-row">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onReassign}>
              {ticket.assignedAgent ? 'Reassign' : 'Assign'}
            </button>
            {ticket.assignedAgentId && ticket.state !== 'RESOLVED' && (ticket.assignedAgentId === me.id || me.role === 'admin') && (
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy || Boolean(activeHandover)}
                title={activeHandover ? `Awaiting ${activeHandover.targetAgent.name}'s answer` : 'Ask a teammate to take this ticket'}
                onClick={onHandover}
              >
                Request handover
              </button>
            )}
            {ticket.assignedAgentId !== me.id && (ticket.unattended || !ticket.assignedAgentId || me.role === 'admin') && (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={onTake}>
                Take ticket
              </button>
            )}
          </div>
          {activeHandover && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {activeHandover.status === 'QUEUED'
                ? `Queued for ${activeHandover.targetAgent.name}.`
                : `Awaiting ${activeHandover.targetAgent.name}'s answer.`}
              {(activeHandover.requestedById === me.id || me.role === 'admin') && (
                <>
                  {' '}
                  <button className="btn-link" disabled={busy} onClick={() => onCancelHandover(activeHandover.id)}>Cancel</button>
                </>
              )}
            </p>
          )}
          {ticket.assignedAgentId && ticket.assignedAgentId !== me.id
            && !ticket.unattended && ticket.state === 'NEW' && me.role !== 'admin' && (
            <p className="muted small" style={{ marginTop: 8 }}>
              Available to teammates in{' '}
              {ticket.hoursUntilClaimable >= 1
                ? `${ticket.hoursUntilClaimable.toFixed(1)} hours`
                : `${Math.ceil((ticket.hoursUntilClaimable || 0) * 60)} minutes`}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function DeleteZone({ id, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  return (
    <div style={{ marginTop: 18 }}>
      <div className="card-head" style={{ marginBottom: 6 }}>
        <h2 className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Administration</h2>
      </div>
      <p className="muted small" style={{ marginBottom: 8 }}>
        Deleting is permanent and removes the audit history. Prefer closing the ticket.
      </p>
      <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
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
                try { await api.deleteTicket(id); onDeleted(); } catch (e) { alert(e.message); }
              }}
            >
              Delete forever
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline (data model)                                              */
/* ------------------------------------------------------------------ */

function buildTimeline(ticket) {
  const events = [];
  for (const log of ticket.auditLogs || []) {
    if (!log.fromState && log.toState === 'NEW') continue;
    const { kind, title } = classifyAuditEvent(log);
    events.push({
      kind,
      at: log.createdAt,
      title,
      detail: (log.note && log.fromState !== log.toState) ? log.note : null,
      actor: prettyActor(log.actor),
    });
  }
  for (const c of ticket.comments || []) {
    events.push({
      kind: c.isInternal ? 'internal' : 'update',
      at: c.createdAt,
      title: c.isInternal
        ? `Internal note${c.authorName ? ' — ' + c.authorName : ''}`
        : c.isRequester
          ? `Requester reply${c.authorName ? ' — ' + c.authorName : c.authorEmail ? ' — ' + c.authorEmail : ''}`
          : `${c.authorName || 'Agent'} updated the requester`,
      detail: c.body,
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

function classifyAuditEvent(log) {
  const note = log.note || '';
  const changedState = log.fromState !== log.toState;
  if (changedState) {
    const reopened = log.toState === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(log.fromState);
    if (reopened) return { kind: 'reopened', title: `Reopened (${STATE_LABELS[log.fromState] || log.fromState} → In Progress)` };
    if (log.toState === 'CLOSED') return { kind: 'closed', title: 'Ticket closed' };
    if (log.toState === 'RESOLVED') return { kind: 'resolution', title: 'Marked resolved' };
    if (log.toState === 'IN_PROGRESS') return { kind: 'status', title: 'Started work' };
    return { kind: 'status', title: `Status: ${STATE_LABELS[log.fromState] || log.fromState} → ${STATE_LABELS[log.toState] || log.toState}` };
  }
  if (/^Handover/i.test(note)) return { kind: 'handover', title: note };
  if (/^Reassigned from/i.test(note)) return { kind: 'reassign', title: note };
  if (/assignment group changed/i.test(note)) return { kind: 'group', title: note };
  if (/assigned|claim/i.test(note)) return { kind: 'assignment', title: note };
  return { kind: 'audit', title: note || 'Updated' };
}

function prettyActor(actor) {
  if (!actor) return null;
  if (actor === 'system') return 'automation';
  const m = /^(.*?)\s*</.exec(actor);
  return m ? m[1] : actor;
}

const HANDOVER_META = {
  PENDING:   { label: 'awaiting answer', cls: 'chip-warn' },
  QUEUED:    { label: 'queued', cls: 'chip-off' },
  ACCEPTED:  { label: 'accepted', cls: 'chip-ok' },
  DECLINED:  { label: 'declined', cls: 'chip-warn' },
  CANCELLED: { label: 'cancelled', cls: 'chip-off' },
  EXPIRED:   { label: 'expired', cls: 'chip-off' },
};

function HandoverChain({ handovers }) {
  return (
    <div className="conv-item is-system">
      <Avatar name="chain" size={28} />
      <div style={{ width: '100%' }}>
        <div className="conv-meta"><strong>Handover chain</strong> <span className="muted small">{handovers.length} event{handovers.length === 1 ? '' : 's'}</span></div>
        <ol className="handover-chain" style={{ marginTop: 6 }}>
          {handovers.map((h) => {
            const meta = HANDOVER_META[h.status] || { label: h.status.toLowerCase(), cls: '' };
            return (
              <li key={h.id} className={`handover-chain-item is-${h.status.toLowerCase()}`}>
                <div className="handover-chain-line">
                  <strong>{h.requestedBy.name}</strong>
                  <span className="handover-arrow" aria-hidden="true">→</span>
                  <strong>{h.targetAgent.name}</strong>
                  <span className={`chip ${meta.cls}`}>{meta.label}</span>
                </div>
                <div className="muted small" style={{ marginTop: 3 }}>
                  {fmtDateTime(h.createdAt)}
                  {h.respondedAt && ` · answered ${fmtDateTime(h.respondedAt)}`}
                  {h.suggestedAgent && ` · suggested ${h.suggestedAgent.name} instead`}
                </div>
                {(h.note || h.responseNote) && (
                  <div className="handover-note">{h.responseNote || h.note}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
