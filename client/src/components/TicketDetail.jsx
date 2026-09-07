import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api.js';
import { usePageHeader } from '../pageHeader.js';
import { slaOverview, cycleSummary } from '../slaView.js';
import {
  statusMeta as raStatusMeta, summaryLine as raSummary, minutesLeft as raMinutesLeft,
  canRequest as raCanRequest, allowedActions as raAllowedActions,
  durationLabel as raDuration, liveSession as raLive, historyRows as raHistoryRows,
} from '../remoteAccessView.js';
import {
  STATES, PRIORITIES, CATEGORIES,
  STATE_TRANSITIONS,
} from '../constants.js';
import {
  Spinner, ErrorState, EmptyState, StateBadge, PriorityBadge, SlaBadge,
  Avatar, Modal, ConfirmDialog, useToast, fmtDateTime, timeAgo, initials,
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
  const [raSessions, setRaSessions] = useState(null);
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
      .then(() => api.remoteAccessSessions(id).then((r) => setRaSessions(r.sessions || [])).catch(() => setRaSessions([])))
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the SLA block live the only compliant way: re-read it from the API.
  // There is no client-side clock math — remainingMs and the breached /
  // approaching flags always come from the server, so a quiet refresh every
  // minute (while the tab is visible and the ticket is open) is what makes
  // the countdown move. Actions still refresh immediately via run().
  useEffect(() => {
    if (!ticket || !['NEW', 'IN_PROGRESS'].includes(ticket.state)) return undefined;
    const iv = setInterval(() => {
      if (!document.hidden) load();
    }, 60_000);
    return () => clearInterval(iv);
  }, [ticket?.id, ticket?.state, load]);

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

  usePageHeader(
    ticket?.ticketNumber || 'Ticket',
    ticket
      ? `${ticket.category} · ${STATE_LABELS[ticket.state] || ticket.state} · ${PRIORITY_LABELS[ticket.priority] || ticket.priority} priority`
      : 'Loading…'
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
      <header className="detail-head">
        <button className="crumb" onClick={() => window.location.hash = '/tickets'}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          All tickets
        </button>
        <div className="detail-head-main">
          <div className="detail-head-text">
            <h1 className="detail-title">{ticket.shortDescription}</h1>
            <div className="pill-row">
              <span className="cell-id">{ticket.ticketNumber}</span>
              <StateBadge state={ticket.state} />
              <PriorityBadge priority={ticket.priority} />
              <SlaBadge ticket={ticket} />
              {ticket.awaitingAssignment && <span className="chip chip-warn">awaiting assignment</span>}
              {ticket.source === 'email' && <span className="chip">via email</span>}
              {ticket.category && <span className="chip">{ticket.category}</span>}
            </div>
          </div>
          {/* One primary action, chosen by where the ticket is in its
              lifecycle. Everything else is secondary, in the inspector. */}
          <PrimaryActions
            ticket={ticket}
            me={me}
            busy={busy}
            canStart={canStart}
            canResolve={canResolve}
            canClose={canClose}
            activeHandover={activeHandover}
            onStart={() => run(async () => api.startTicket(id), 'Work started')}
            onResolve={() => setResolveOpen(true)}
            onClose={() => setCloseConfirm(true)}
            onTake={() => run(async () => api.takeTicket(id), 'Ticket is now yours')}
            onReassign={() => setReassignOpen(true)}
            onHandover={() => setHandoverOpen(true)}
          />
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

        <aside className="inspector" aria-label="Ticket details">
          <PropertiesCard
            ticket={ticket}
            busy={busy}
            groupPick={groupPick}
            setGroupPick={setGroupPick}
            run={run}
            me={me}
          />
          <SlaCard ticket={ticket} />
          {raSessions !== null && (
            <RemoteAccessCard
              ticket={ticket}
              me={me}
              sessions={raSessions}
              busy={busy}
              run={run}
            />
          )}
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
        </aside>
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
    <section className="card activity-card">
      <div className="card-head">
        <h2>Activity</h2>
        <span className="muted small">{events.length} event{events.length === 1 ? '' : 's'}</span>
      </div>
      <div className="activity-rail">
        <OriginalMessage ticket={ticket} />
        {events
          .filter((ev) => !['created'].includes(ev.kind))
          .map((ev, i) => <EventItem key={i} ev={ev} />)}
        {handovers.length > 0 && <HandoverChain handovers={handovers} />}
        {ticket.state === 'CLOSED' && (
          <div className="ev ev-closed is-marker">
            <span className="ev-mark" aria-hidden="true"><EvGlyph name="stop" /></span>
            <div className="ev-body">
              <div className="ev-line"><span className="ev-title">Closed</span></div>
              <div className="ev-detail">No further status changes. Reopens if the requester replies.</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function OriginalMessage({ ticket }) {
  return (
    <div className="ev ev-requester is-message is-original">
      <span className="ev-mark" aria-hidden="true"><EvGlyph name="message" /></span>
      <div className="ev-body">
        <div className="ev-line">
          <span className="ev-title">{ticket.requesterName || 'Requester'}</span>
          <span className="muted small">opened this ticket</span>
          {ticket.source === 'email' && <span className="chip ev-tag">via email</span>}
          <time className="ev-time" dateTime={ticket.createdAt} title={fmtDateTime(ticket.createdAt)}>
            {timeAgo(ticket.createdAt)}
          </time>
        </div>
        {ticket.requesterEmail && <div className="ev-detail mono-sm">{ticket.requesterEmail}</div>}
        <div className="ev-bubble">{ticket.body || '(no message body)'}</div>
        {ticket.attachments?.some((a) => !a.commentId) && (
          <AttachmentChips ticketId={ticket.id} items={ticket.attachments.filter((a) => !a.commentId)} />
        )}
      </div>
    </div>
  );
}

/* Each activity kind gets its own marker, so requester messages, agent
   replies, internal notes, assignment moves, handovers, status changes and
   system events are told apart at a glance rather than by reading. */
const EVENT_META = {
  requester:  { cls: 'ev-requester',  glyph: 'message', label: 'Requester' },
  update:     { cls: 'ev-update',     glyph: 'message', label: 'Agent reply' },
  internal:   { cls: 'ev-internal',   glyph: 'lock',    label: 'Internal note' },
  status:     { cls: 'ev-status',     glyph: 'arrow',   label: 'Status' },
  assignment: { cls: 'ev-assign',     glyph: 'person',  label: 'Assignment' },
  reassign:   { cls: 'ev-assign',     glyph: 'person',  label: 'Assignment' },
  handover:   { cls: 'ev-handover',   glyph: 'swap',    label: 'Handover' },
  group:      { cls: 'ev-assign',     glyph: 'grid',    label: 'Group' },
  resolution: { cls: 'ev-resolution', glyph: 'check',   label: 'Resolution' },
  closed:     { cls: 'ev-closed',     glyph: 'stop',    label: 'Closed' },
  reopened:   { cls: 'ev-status',     glyph: 'undo',    label: 'Reopened' },
  audit:      { cls: 'ev-system',     glyph: 'dot',     label: 'System' },
  sla:        { cls: 'ev-system',     glyph: 'clock',   label: 'SLA' },
  'sla-warn': { cls: 'ev-sla-warn',   glyph: 'clock',   label: 'SLA' },
  'sla-breach': { cls: 'ev-sla-breach', glyph: 'clock', label: 'SLA' },
};

function EvGlyph({ name }) {
  const p = { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (name) {
    case 'message': return <svg {...p}><path d="M13.5 8.5a4.5 4.5 0 0 1-4.5 4.5H5l-2.5 2V6.5A3.5 3.5 0 0 1 6 3h4a3.5 3.5 0 0 1 3.5 3.5z"/></svg>;
    case 'lock':    return <svg {...p}><rect x="3.5" y="7" width="9" height="6" rx="1.2"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/></svg>;
    case 'arrow':   return <svg {...p}><path d="M2.5 8h11M10 4.5L13.5 8 10 11.5"/></svg>;
    case 'person':  return <svg {...p}><circle cx="8" cy="5.5" r="2.3"/><path d="M3.5 13c.6-2.4 2.3-3.5 4.5-3.5s3.9 1.1 4.5 3.5"/></svg>;
    case 'swap':    return <svg {...p}><path d="M3 5.5h9L9.5 3M13 10.5H4l2.5 2.5"/></svg>;
    case 'grid':    return <svg {...p}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>;
    case 'check':   return <svg {...p}><path d="M3 8.5l3.2 3.2L13 5"/></svg>;
    case 'stop':    return <svg {...p}><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>;
    case 'undo':    return <svg {...p}><path d="M3 8a5 5 0 1 0 1.6-3.7M3 3.5V7h3.5"/></svg>;
    case 'clock':   return <svg {...p}><circle cx="8" cy="8" r="5.8"/><path d="M8 4.7V8l2.2 1.4"/></svg>;
    default:        return <svg {...p}><circle cx="8" cy="8" r="2"/></svg>;
  }
}

function EventItem({ ev }) {
  const kind = ev.kind;
  const isMessage = ['internal', 'update', 'resolution', 'requester'].includes(kind);
  const meta = EVENT_META[kind] || EVENT_META.audit;

  // System-ish events are one compact line on the rail: they are context,
  // not conversation, and should never out-shout an actual message.
  if (!isMessage) {
    return (
      <div className={`ev ${meta.cls} is-marker`}>
        <span className="ev-mark" aria-hidden="true"><EvGlyph name={meta.glyph} /></span>
        <div className="ev-body">
          <div className="ev-line">
            <span className="ev-title">{ev.title}</span>
            <time className="ev-time" dateTime={ev.at} title={fmtDateTime(ev.at)}>{timeAgo(ev.at)}</time>
          </div>
          {ev.detail && <div className="ev-detail">{ev.detail}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={`ev ${meta.cls} is-message`}>
      <span className="ev-mark" aria-hidden="true"><EvGlyph name={meta.glyph} /></span>
      <div className="ev-body">
        <div className="ev-line">
          <span className="ev-title">{ev.title}</span>
          {kind === 'internal' && <span className="chip chip-warn ev-tag">Internal</span>}
          {kind === 'resolution' && <span className="chip chip-ok ev-tag">Resolution</span>}
          <time className="ev-time" dateTime={ev.at} title={fmtDateTime(ev.at)}>{timeAgo(ev.at)}</time>
        </div>
        {ev.detail && (
          <div className={`ev-bubble ${kind === 'resolution' ? 'is-resolution' : ''}`}>{ev.detail}</div>
        )}
        {ev.attachments?.length > 0 && <AttachmentChips ticketId={ev.ticketId} items={ev.attachments} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attachments — metadata chips with an authorized download action.    */
/* Visually secondary: a quiet row under the message they arrived with. */
/* ------------------------------------------------------------------ */

function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChips({ ticketId, items }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  async function download(att) {
    setBusyId(att.id);
    setError('');
    try {
      const res = await fetch(`/api/tickets/${ticketId}/attachments/${att.id}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Download failed (${res.status})`);
      }
      // Always saved to disk, never rendered: the backend sends an inert
      // octet-stream with an attachment disposition, and the blob keeps that
      // inertness on the client side too.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="attachment-row">
      {items.map((att) => (
        <span key={att.id} className="attachment-chip" title={`${att.mimeType || 'file'} · ${formatBytes(att.size)}`}>
          <span className="attachment-name">{att.filename}</span>
          <span className="muted small">{att.mimeType ? att.mimeType.split(';')[0] : 'file'}</span>
          <span className="muted small">{formatBytes(att.size)}</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busyId === att.id}
            onClick={() => download(att)}
          >
            {busyId === att.id ? '…' : 'Download'}
          </button>
        </span>
      ))}
      {error && <span className="muted small" role="alert">{error}</span>}
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

/* ------------------------------------------------------------------ */
/* Inspector — one panel of labelled rows, not a stack of cards        */
/* ------------------------------------------------------------------ */

function Row({ label, children, stack }) {
  return (
    <div className={`insp-row ${stack ? 'is-stacked' : ''}`}>
      <span className="insp-label">{label}</span>
      <span className="insp-value">{children}</span>
    </div>
  );
}

const SKILL_LABEL = { 1: 'L1 \u00b7 Junior', 2: 'L2 \u00b7 Standard', 3: 'L3 \u00b7 Senior' };

function PropertiesCard({ ticket, busy, groupPick, setGroupPick, run, me }) {
  const [groups, setGroups] = useState([]);
  useEffect(() => { api.groups().then(setGroups).catch(() => {}); }, []);

  const isAdmin = me.role === 'admin';
  const group = groups.find((g) => g.key === (ticket.team?.key || ''));
  // Real figure from /api/assignment-groups — the minimum skill the routing
  // rules require for this group. Never invented.
  const requiredSkill = group ? group.minSkillLevel : null;

  return (
    <section className="insp-section">
      <h2 className="insp-title">Details</h2>

      <Row label="Requester">
        <span className="insp-strong">{ticket.requesterName || 'Unknown'}</span>
        {ticket.requesterEmail && <span className="insp-sub mono-sm">{ticket.requesterEmail}</span>}
      </Row>

      <Row label="Status"><StateBadge state={ticket.state} /></Row>

      <Row label="Priority">
        <select
          className="insp-select"
          value={ticket.priority}
          disabled={busy}
          onChange={(e) => run(async () => api.updateTicket(ticket.id, { priority: e.target.value }), 'Priority updated')}
        >
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Row>

      <Row label="Category">
        <select
          className="insp-select"
          value={ticket.category}
          disabled={busy}
          onChange={(e) => run(async () => api.updateTicket(ticket.id, { category: e.target.value }), 'Category updated')}
        >
          {[...new Set([ticket.category, ...CATEGORIES])].map((c) => <option key={c}>{c}</option>)}
        </select>
      </Row>

      <Row label="Group" stack>
        <span className="insp-inline">
          <select
            className="insp-select"
            value={groupPick}
            disabled={busy || !isAdmin}
            title={isAdmin ? '' : 'Only an administrator can change the assignment group'}
            onChange={(e) => setGroupPick(e.target.value)}
          >
            <option value="">Triage</option>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select>
          {isAdmin && groupPick !== (ticket.team?.key || '') && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => run(
                async () => api.updateTicket(ticket.id, { assignmentGroup: groupPick || null }),
                'Assignment group changed'
              )}
            >Apply</button>
          )}
        </span>
      </Row>

      <Row label="Assigned to">
        {ticket.assignedAgent ? (
          <>
            <span className="cell-agent">
              <Avatar name={ticket.assignedAgent.name} size={22} />
              <span className="insp-strong">{ticket.assignedAgent.name}</span>
            </span>
            {ticket.assignedAgent.skillLevel && (
              <span className="insp-sub">{SKILL_LABEL[ticket.assignedAgent.skillLevel] || `L${ticket.assignedAgent.skillLevel}`}</span>
            )}
          </>
        ) : <span className="unassigned-tag">Unassigned</span>}
      </Row>

      {requiredSkill != null && (
        <Row label="Skill required">
          <span>{SKILL_LABEL[requiredSkill] || `L${requiredSkill}`}</span>
          {ticket.assignedAgent && ticket.assignedAgent.skillLevel < requiredSkill && (
            <span className="insp-sub warn-text">Assignee is below the required level</span>
          )}
        </Row>
      )}

      <div className="insp-divider" />

      <Row label="Created">
        <span title={fmtDateTime(ticket.createdAt)}>{timeAgo(ticket.createdAt)}</span>
        <span className="insp-sub">{fmtDateTime(ticket.createdAt)}</span>
      </Row>
      <Row label="Updated">
        <span title={fmtDateTime(ticket.updatedAt)}>{timeAgo(ticket.updatedAt)}</span>
      </Row>
      {ticket.dueAt && !ticket.sla && (
        <Row label="SLA target">
          <span className={ticket.overdue ? 'warn-text' : ''}>{fmtDateTime(ticket.dueAt)}</span>
        </Row>
      )}

      {ticket.resolution && (
        <>
          <div className="insp-divider" />
          <Row label="Resolution" stack>
            <span className="insp-resolution">{ticket.resolution}</span>
          </Row>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* SLA — the current cycle at a glance, previous cycles underneath     */
/* ------------------------------------------------------------------ */

/* Every value here is the API's word: statuses, remainingMs and cycle rows
   arrive from the server precomputed. This card formats; it never derives. */
function SlaCard({ ticket }) {
  const sla = slaOverview(ticket);
  // Tickets without SLA cycles keep the legacy "SLA target" row in Details.
  if (!sla) return null;
  const cycles = ticket.sla?.cycles || [];
  const previous = cycles.slice(0, -1).reverse();

  return (
    <section className="insp-section">
      <h2 className="insp-title">SLA</h2>

      <Row label="Cycle">
        <span>
          {sla.cycleNumber}
          <span className="insp-sub">{sla.cycleEndedAt ? 'ended' : 'active'}</span>
        </span>
      </Row>

      <Row label="Started" stack>
        <span title={fmtDateTime(sla.cycleStartedAt)}>{timeAgo(sla.cycleStartedAt)}</span>
        <span className="insp-sub">{fmtDateTime(sla.cycleStartedAt)}</span>
      </Row>

      <SlaClockRow label="Response" block={ticket.sla?.response} view={sla.response} />
      <SlaClockRow label="Resolution" block={ticket.sla?.resolution} view={sla.resolution} />

      {previous.length > 0 && (
        <>
          <div className="insp-divider" />
          <div className="sla-history">
            <span className="insp-label">Previous cycles</span>
            {previous.map((c) => {
              const s = cycleSummary(c);
              return (
                <div key={c.cycleNumber} className="sla-history-row">
                  <span className="sla-history-cycle">Cycle {c.cycleNumber}</span>
                  <span className="sla-history-outcome">
                    R: {s.response} · Res: {s.resolution}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

const TONE_PILL = { bad: 'pill-overdue', warn: 'pill-sla-warn', ok: 'pill-sla', muted: 'pill-state-closed' };

function SlaClockRow({ label, block, view }) {
  return (
    <Row label={label} stack>
      {/* The view's text already carries the remaining working time where it
          runs; a separate line here would say it twice. */}
      <span className={`pill ${TONE_PILL[view.tone] || 'pill-sla'}`}>{view.text}</span>
      {block?.dueAt && (
        <span className="insp-sub">Due {fmtDateTime(block.dueAt)}</span>
      )}
      {block?.firstResponseAt && (
        <span className="insp-sub">First response {fmtDateTime(block.firstResponseAt)}</span>
      )}
    </Row>
  );
}

/* ------------------------------------------------------------------ */
/* Remote access — the application-side session bookkeeping. The      */
/* backend owns every rule; this card only mirrors what it decided.   */
/* ------------------------------------------------------------------ */

function RemoteAccessCard({ ticket, me, sessions, busy, run }) {
  const live = raLive(sessions);
  const actions = raAllowedActions(live, me);
  const mayRequest = raCanRequest(ticket, me);
  const history = raHistoryRows(sessions);

  return (
    <section className="insp-section">
      <h2 className="insp-title">Remote access</h2>

      {live ? (
        <div className={`insp-note ra-live-note ${live.status === 'active' ? 'is-active' : ''}`}>
          <span className={`pill ${raStatusMeta(live.status).pill}`}>{raStatusMeta(live.status).label}</span>
          <span className="muted small">
            {live.agent ? live.agent.name : 'An agent'} — {raStatusMeta(live.status).hint.toLowerCase()}
          </span>
          {live.status === 'requested' && (
            <span className="muted small">
              Requested {timeAgo(live.requestedAt)}
              {live.expiresAt ? ` · expires in ${raMinutesLeft(live)} min` : ''}
            </span>
          )}
          {live.status === 'active' && (
            <span className="muted small">
              Started {timeAgo(live.startedAt)} · running {raDuration(live)}
            </span>
          )}
          {live.note && <span className="muted small">“{live.note}”</span>}
        </div>
      ) : (
        <p className="muted small">{raSummary(sessions)}</p>
      )}

      {(mayRequest || actions.canStart || actions.canEnd || actions.canCancel) && (
        <div className="insp-actions">
          {actions.canStart && (
            <button
              className="btn btn-secondary btn-sm btn-block" disabled={busy}
              onClick={() => run(async () => api.startRemoteAccess(live.id), 'Remote session started')}
            >
              Start session
            </button>
          )}
          {actions.canEnd && (
            <button
              className="btn btn-secondary btn-sm btn-block" disabled={busy}
              onClick={() => run(async () => api.endRemoteAccess(live.id), 'Remote session ended')}
            >
              End session
            </button>
          )}
          {actions.canCancel && (
            <button
              className="btn btn-ghost btn-sm btn-block" disabled={busy}
              onClick={() => run(async () => api.cancelRemoteAccess(live.id), 'Remote session cancelled')}
            >
              Cancel session
            </button>
          )}
          {!live && mayRequest && (
            <button
              className="btn btn-secondary btn-sm btn-block" disabled={busy}
              onClick={() => run(async () => api.requestRemoteAccess({ ticketId: ticket.id }), 'Remote session requested')}
            >
              Request remote session
            </button>
          )}
        </div>
      )}

      {history.length > 0 && (
        <>
          <div className="insp-divider" />
          <div className="ra-history">
            <span className="insp-label">Session history</span>
            {history.map((row) => (
              <div key={row.id} className="ra-history-row">
                <span className={`pill ${row.pill}`}>{row.statusLabel}</span>
                <span className="ra-who" title={row.endReason || undefined}>{row.agentName}</span>
                <span className="ra-when" title={row.endedAt ? fmtDateTime(row.endedAt) : undefined}>
                  {row.startedAt
                    ? raDuration(row)
                    : `requested ${timeAgo(row.requestedAt) || fmtDateTime(row.requestedAt)}`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Header actions — exactly one primary, chosen by lifecycle position  */
/* ------------------------------------------------------------------ */

function PrimaryActions({
  ticket, me, busy, canStart, canResolve, canClose, activeHandover,
  onStart, onResolve, onClose, onTake, onReassign, onHandover,
}) {
  const mine = ticket.assignedAgentId === me.id;
  const isAdmin = me.role === 'admin';
  const canTake = ticket.assignedAgentId !== me.id
    && (ticket.unattended || !ticket.assignedAgentId || isAdmin)
    && !['RESOLVED', 'CLOSED'].includes(ticket.state);

  // The single most likely next step. Everything else drops to secondary so
  // the eye is not asked to choose between five equal buttons.
  let primary = null;
  if (canStart && ticket.state === 'NEW' && (mine || isAdmin)) {
    primary = { label: 'Start working', onClick: onStart };
  } else if (canResolve) {
    primary = { label: 'Resolve…', onClick: onResolve };
  } else if (canClose) {
    primary = { label: 'Close ticket', onClick: onClose };
  } else if (canTake) {
    primary = { label: 'Take ticket', onClick: onTake };
  }

  const showHandover = ticket.assignedAgentId
    && ticket.state !== 'RESOLVED' && ticket.state !== 'CLOSED'
    && (mine || isAdmin);

  if (!primary && !showHandover && ticket.state === 'CLOSED') {
    return <div className="detail-actions"><span className="muted small">Closed — reopens if the requester replies.</span></div>;
  }

  return (
    <div className="detail-actions">
      {canTake && primary && primary.label !== 'Take ticket' && (
        <button className="btn btn-secondary" disabled={busy} onClick={onTake}>Take</button>
      )}
      {ticket.state !== 'CLOSED' && (
        <button className="btn btn-secondary" disabled={busy} onClick={onReassign}>
          {ticket.assignedAgent ? 'Reassign' : 'Assign'}
        </button>
      )}
      {showHandover && (
        <button
          className="btn btn-secondary"
          disabled={busy || Boolean(activeHandover)}
          title={activeHandover ? `Awaiting ${activeHandover.targetAgent.name}'s answer` : 'Ask a teammate to take this ticket'}
          onClick={onHandover}
        >
          Handover
        </button>
      )}
      {primary && (
        <button className="btn btn-primary" disabled={busy} onClick={primary.onClick}>
          {primary.label}
        </button>
      )}
    </div>
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
  const mine = ticket.assignedAgentId === me.id;
  const isAdmin = me.role === 'admin';

  // Secondary moves only: the likely next step already sits in the header.
  const secondary = [];
  if (canResolve && canStart) secondary.push({ label: 'Start working', onClick: onStart });
  if (canClose && canResolve) secondary.push({ label: 'Close ticket', onClick: onClose });
  if (!open && nextStates.includes('IN_PROGRESS')) secondary.push({ label: 'Reopen', onClick: onReopen });
  if (open && ticket.state !== 'NEW' && nextStates.includes('IN_PROGRESS')) {
    secondary.push({ label: 'Back to in progress', onClick: onInProgress });
  }

  const waiting = ticket.assignedAgentId && !mine && !ticket.unattended
    && ticket.state === 'NEW' && !isAdmin;

  if (!secondary.length && !activeHandover && !waiting) return null;

  return (
    <section className="insp-section">
      <h2 className="insp-title">More actions</h2>

      {activeHandover && (
        <div className="insp-note">
          <strong>
            {activeHandover.status === 'QUEUED'
              ? `Queued for ${activeHandover.targetAgent.name}`
              : `Awaiting ${activeHandover.targetAgent.name}`}
          </strong>
          <span className="muted small">
            The ticket stays with its current owner until they accept.
          </span>
          {(activeHandover.requestedById === me.id || isAdmin) && (
            <button className="btn-link" disabled={busy} onClick={() => onCancelHandover(activeHandover.id)}>
              Cancel handover
            </button>
          )}
        </div>
      )}

      {waiting && (
        <div className="insp-note">
          <span className="muted small">
            Available to teammates in{' '}
            {ticket.hoursUntilClaimable >= 1
              ? `${ticket.hoursUntilClaimable.toFixed(1)} hours`
              : `${Math.ceil((ticket.hoursUntilClaimable || 0) * 60)} minutes`}.
          </span>
        </div>
      )}

      {secondary.length > 0 && (
        <div className="insp-actions">
          {secondary.map((a) => (
            <button key={a.label} className="btn btn-secondary btn-sm btn-block" disabled={busy} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Destructive action, deliberately the quietest thing on the page. */
function DeleteZone({ id, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  return (
    <div className="danger-zone">
      <div className="danger-zone-text">
        <strong>Delete this ticket</strong>
        <span className="muted small">
          Permanent, and it removes the audit history. Prefer closing the ticket.
        </span>
      </div>
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
      ticketId: ticket.id,
      attachments: (ticket.attachments || []).filter((a) => a.commentId === c.id),
    });
  }
  for (const ev of ticket.slaEvents || []) {
    const e = slaTimelineEvent(ev);
    if (e) events.push(e);
  }
  // The RESOLVED transition already produced an audit event. Carry the
  // resolution text onto it rather than appending a second, near-identical
  // entry — which is what left an empty bubble under "Resolved".
  if (ticket.resolvedAt && ticket.resolution) {
    const existing = events.find((e) => e.kind === 'resolution');
    if (existing) {
      if (!existing.detail) existing.detail = ticket.resolution;
    } else {
      events.push({
        kind: 'resolution',
        at: ticket.resolvedAt,
        title: 'Resolved',
        detail: ticket.resolution,
      });
    }
  }
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/* SLA timeline entries map 1:1 onto the API's slaEvents array (the
   append-only TicketSlaEvent log). `at` is the historical instant, so a
   breach marker lands where the clock actually ran out rather than when the
   sweeper happened to record it. Unknown future types are skipped rather
   than guessed at. */
const SLA_EVENT_TITLES = {
  target_created: () => 'SLA targets set',
  target_changed: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA target changed` : 'SLA target changed'),
  response_recorded: () => 'First response recorded',
  approaching_breach: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA approaching breach` : 'SLA approaching breach'),
  breach: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA breached` : 'SLA breached'),
  cycle_restarted: () => 'SLA cycle restarted',
};

function clockLabel(clock) {
  return clock === 'response' ? 'Response' : clock === 'resolution' ? 'Resolution' : null;
}

function slaTimelineEvent(ev) {
  const title = SLA_EVENT_TITLES[ev.type];
  if (!title) return null;
  return {
    kind: ev.type === 'breach' ? 'sla-breach' : ev.type === 'approaching_breach' ? 'sla-warn' : 'sla',
    at: ev.at,
    title: title(ev),
    detail: ev.detail || null,
  };
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
