import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { usePageHeader } from '../pageHeader.js';
import { STATES, PRIORITIES, STATE_TRANSITIONS } from '../constants.js';
import { buildTimeline, activeHandover as findActiveHandover } from '../ticketTimelineView.js';
import { originalAttachments } from '../attachmentView.js';
import { Conversation } from './TicketConversation.jsx';
import { PropertiesCard, SlaCard, RemoteAccessCard, ActionsCard } from './TicketInspector.jsx';
import { ReassignModal, HandoverModal, ResolveModal, DeleteZone } from './TicketModals.jsx';
import {
  Spinner, ErrorState, StateBadge, PriorityBadge, SlaBadge, ConfirmDialog, useToast,
} from './ui.jsx';

const STATE_LABELS = Object.fromEntries(STATES.map((s) => [s.value, s.label]));
const PRIORITY_LABELS = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label]));

/**
 * The ticket detail page — layout and wiring only.
 *
 * The three regions below it are their own components: the conversation rail
 * (`TicketConversation.jsx`), the inspector (`TicketInspector.jsx`) and the
 * modals (`TicketModals.jsx`). The data those regions read is built by
 * `ticketTimelineView.js` / `attachmentView.js`, which are pure and unit
 * checked. What stays here is the one thing none of them can own: loading the
 * ticket, and running a mutation and folding the result back in.
 */
export default function TicketDetail({ id, me, onChanged }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteMode, setNoteMode] = useState('public'); // 'public' | 'internal'
  const [resolveOpen, setResolveOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [candidatesError, setCandidatesError] = useState('');
  const [groupPick, setGroupPick] = useState('');
  const [handovers, setHandovers] = useState([]);
  const [raSessions, setRaSessions] = useState(null);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const [t, h, r] = await Promise.all([
        api.getTicket(id),
        api.ticketHandovers(id).then((data) => data.handovers || []).catch(() => []),
        api.remoteAccessSessions(id).then((data) => data.sessions || []).catch(() => []),
      ]);
      setTicket(t);
      setGroupPick(t.team?.key || '');
      setHandovers(h);
      setRaSessions(r);
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  const refreshSecondaryData = useCallback(() => {
    api
      .ticketHandovers(id)
      .then((data) => setHandovers(data.handovers || []))
      .catch(() => {});
    api
      .remoteAccessSessions(id)
      .then((data) => setRaSessions(data.sessions || []))
      .catch(() => setRaSessions([]));
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

  // Both people-modals read the same candidate payload, so it is fetched once
  // per open and thrown away on close.
  useEffect(() => {
    if (!reassignOpen && !handoverOpen) return;
    setCandidates(null);
    setCandidatesError('');
    api
      .assignmentCandidates(id)
      .then(setCandidates)
      .catch((e) => setCandidatesError(e.message));
  }, [reassignOpen, handoverOpen, id]);

  /**
   * Run a mutation, then fold its result into the loaded ticket.
   *
   * The lifecycle endpoints answer with the updated ticket *without* the
   * conversation, so each collection is merged only when the response actually
   * carried one — an omitted array means "unchanged", never "emptied".
   */
  async function run(fn, successMessage) {
    setBusy(true);
    setError('');
    try {
      const updated = await fn();
      if (updated && typeof updated === 'object' && updated.ticketNumber) {
        setTicket((current) => ({
          ...current,
          ...updated,
          auditLogs: updated.auditLogs
            ? [...new Map([...(current?.auditLogs || []), ...updated.auditLogs].map((log) => [log.id, log])).values()]
            : current?.auditLogs,
          comments: updated.comments ?? current?.comments,
          attachments: updated.attachments ?? current?.attachments,
          slaEvents: updated.slaEvents ?? current?.slaEvents,
        }));
        setGroupPick(updated.team?.key || '');
        refreshSecondaryData();
      } else {
        await load();
      }
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

  const events = useMemo(() => buildTimeline(ticket), [ticket]);

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
  const activeHandover = findActiveHandover(handovers);

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
            nextStates={nextStates}
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
            originalAttachments={originalAttachments(ticket)}
          />

          {open && (
            <Composer
              ticket={ticket}
              noteText={noteText}
              setNoteText={setNoteText}
              noteMode={noteMode}
              setNoteMode={setNoteMode}
              busy={busy}
              onSend={async () => {
                const isInternal = noteMode === 'internal';
                await run(async () => {
                  await api.addNote(id, noteText, isInternal);
                  setNoteText('');
                }, isInternal ? 'Internal note added' : 'Requester update added');
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
            nextStates={nextStates}
            open={open}
            activeHandover={activeHandover}
            onStart={() => run(async () => api.startTicket(id), 'Work started')}
            onInProgress={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }), 'Status updated')}
            onResolve={() => setResolveOpen(true)}
            onClose={() => setCloseConfirm(true)}
            onReopen={() => run(async () => api.setStatus(id, { state: 'IN_PROGRESS' }), 'Ticket reopened')}
            onCancelHandover={(hid) => run(async () => api.cancelHandover(hid), 'Handover cancelled')}
          />
        </aside>
      </div>

      {reassignOpen && (
        <ReassignModal
          ticket={ticket}
          candidates={candidates}
          candidatesError={candidatesError}
          busy={busy}
          run={run}
          onClose={() => setReassignOpen(false)}
        />
      )}

      {handoverOpen && (
        <HandoverModal
          ticket={ticket}
          candidates={candidates}
          candidatesError={candidatesError}
          busy={busy}
          run={run}
          onClose={() => setHandoverOpen(false)}
        />
      )}

      {resolveOpen && (
        <ResolveModal
          ticket={ticket}
          busy={busy}
          run={run}
          onClose={() => setResolveOpen(false)}
        />
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
/* Composer — chat-style reply box                                    */
/* ------------------------------------------------------------------ */

function Composer({ ticket, noteText, setNoteText, noteMode, setNoteMode, busy, onSend }) {
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
/* Header actions — exactly one primary, chosen by lifecycle position  */
/* ------------------------------------------------------------------ */

function PrimaryActions({
  ticket, me, busy, nextStates, activeHandover,
  onStart, onResolve, onClose, onTake, onReassign, onHandover,
}) {
  const mine = ticket.assignedAgentId === me.id;
  const isAdmin = me.role === 'admin';
  const canStart = nextStates.includes('IN_PROGRESS');
  const canResolve = nextStates.includes('RESOLVED');
  const canClose = nextStates.includes('CLOSED');
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
