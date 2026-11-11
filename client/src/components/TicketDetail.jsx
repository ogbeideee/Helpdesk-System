import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useReplyDraft } from '../useReplyDraft.js';
import { api, peekRead } from '../api.js';
import { usePageRefresh } from '../usePageRefresh.js';
import { usePageHeader } from '../pageHeader.js';
import { STATES, PRIORITIES, STATE_TRANSITIONS } from '../constants.js';
import { buildTimeline, activeHandover as findActiveHandover } from '../ticketTimelineView.js';
import { originalAttachments } from '../attachmentView.js';
import { Conversation } from './TicketConversation.jsx';
import { PropertiesCard, SlaCard, RemoteAccessCard, ActionsCard } from './TicketInspector.jsx';
import { ReassignModal, HandoverModal, ResolveModal, DeleteZone } from './TicketModals.jsx';
import {
  Spinner, ErrorState, StateBadge, PriorityBadge, ConfirmationChip, ReplyChip, Icon, timeAgo,
  ConfirmDialog, useToast,
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
  const [ticket, setTicket] = useState(() => peekRead(`/tickets/${id}?history=recent`));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { text: noteText, mode: noteMode, setText: setNoteText, setMode: setNoteMode, clearSent, saved: draftSaved } = useReplyDraft(me.id, id);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const allHistory = useRef(false);
  const dirtyGroup = useRef(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [candidatesError, setCandidatesError] = useState('');
  const [groupPick, setGroupPick] = useState(() => ticket?.team?.key || '');
  const [handovers, setHandovers] = useState(() => peekRead(`/tickets/${id}/handovers`)?.handovers || []);
  const [raSessions, setRaSessions] = useState(() => peekRead(`/remote-access/ticket/${id}`)?.sessions || null);
  const [secondaryError, setSecondaryError] = useState('');
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [showToast, toastNode] = useToast();

  const load = useCallback(async () => {
    setError('');
    try {
      const t = await api.getTicket(id, allHistory.current);
      setTicket(t);
      if (!dirtyGroup.current) setGroupPick(t.team?.key || '');
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  const refreshSecondaryData = useCallback(() => {
    setSecondaryError('');
    api
      .ticketHandovers(id)
      .then((data) => setHandovers(data.handovers || []))
      .catch(() => setSecondaryError('Handover information could not be refreshed.'));
    api
      .remoteAccessSessions(id)
      .then((data) => setRaSessions(data.sessions || []))
      .catch(() => setSecondaryError('Remote assistance information could not be refreshed.'));
  }, [id]);

  useEffect(() => {
    load();
    refreshSecondaryData();
  }, [load]);
  usePageRefresh(() => {
    if (!busy && !resolveOpen && !handoverOpen && !reassignOpen && groupPick === (ticket?.team?.key || '')) {
      load(); refreshSecondaryData();
    }
  }, [`/tickets/${id}`, `/remote-access/ticket/${id}`]);

  // The shared visible-page refresh also refreshes server-derived SLA values.

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
  async function run(fn, successMessage, { resetGroup = false } = {}) {
    setBusy(true);
    setError('');
    try {
      const updated = await fn();
      if (updated && typeof updated === 'object' && updated.ticketNumber) {
        // Mutation payloads may include raw/full comments. Only the detail
        // reader adds sender types, quote parsing, unread state and paging.
        // Keep the current enriched collections until that reader refreshes.
        const { comments: rawComments, attachments: rawAttachments, slaEvents: rawSlaEvents, ...fields } = updated;
        setTicket((current) => ({
          ...current,
          ...fields,
          auditLogs: updated.auditLogs
            ? [...new Map([...(current?.auditLogs || []), ...updated.auditLogs].map((log) => [log.id, log])).values()]
            : current?.auditLogs,
          comments: current?.comments,
          attachments: current?.attachments,
          slaEvents: current?.slaEvents,
        }));
        if (resetGroup) dirtyGroup.current = false;
        if (!dirtyGroup.current) setGroupPick(updated.team?.key || '');
        await load();
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
  const markRead = useCallback(async (through) => {
    await api.markConversationRead(id, through);
    setTicket(current => current ? { ...current,
      conversation: { ...current.conversation, unreadIds: [] },
      comments: current.comments?.map(comment => new Date(comment.linkedAt) <= new Date(through)
        ? { ...comment, unread: false } : comment),
    } : current);
  }, [id]);
  async function moveReply(commentId, data) {
    await api.moveThreadReply(id, commentId, data);
    await load();
    onChanged?.();
    showToast('Email reply and attachments moved. Both tickets have an audit record.');
  }

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
    <div className="page ticket-workspace">
      <button className="crumb" onClick={() => window.location.hash = '/tickets'}>
        <Icon name="chevronRight" className="ticket-back-icon" size={12} /> All tickets
      </button>

      {error && <ErrorState message={error} />}

      <div className="detail-layout">
        <div className="stack ticket-main">
          <Conversation
            key={ticket.id}
            ticket={ticket}
            events={events}
            handovers={handovers}
            originalAttachments={originalAttachments(ticket)}
            header={
              <header className="detail-head">
                <div className="ticket-subject-line">
                  <h2 className="detail-title">{ticket.shortDescription}</h2>
                  <StateBadge state={ticket.state} />
                  <PriorityBadge priority={ticket.priority} />
                </div>
                <div className="ticket-request-meta">
                  <span>{ticket.requesterName || 'Unknown requester'}</span>
                  <span>{ticket.source === 'email' ? 'Email' : 'Portal'}</span>
                  <span>Created {timeAgo(ticket.createdAt)}</span>
                </div>
                <div className="ticket-context">
                  <ConfirmationChip ticket={ticket} />
                  <ReplyChip ticket={ticket} />
                  {ticket.awaitingAssignment && <span className="chip chip-warn">awaiting assignment</span>}
                </div>
              </header>
            }
            onRead={markRead}
            onMove={moveReply}
            historyBusy={historyBusy}
            historyError={historyError}
            onLoadHistory={async () => {
              setHistoryBusy(true); setHistoryError('');
              try { const data = await api.getTicket(id, true); allHistory.current = true; setTicket(data); return true; }
              catch (error) { setHistoryError(error.message); return false; }
              finally { setHistoryBusy(false); }
            }}
          />

          {open && (
            <Composer
              ticket={ticket}
              noteText={noteText}
              setNoteText={setNoteText}
              noteMode={noteMode}
              setNoteMode={setNoteMode}
              busy={busy}
              draftSaved={draftSaved}
              onSend={async () => {
                const isInternal = noteMode === 'internal';
                await run(async () => {
                  await api.addNote(id, noteText, isInternal);
                  clearSent(noteMode, noteText);
                }, isInternal ? 'Internal note added' : 'Requester update added');
              }}
            />
          )}
        </div>

        <aside className={`inspector ${inspectorOpen ? 'is-expanded' : ''}`} aria-label="Ticket details">
          <div className="mobile-ticket-summary">
            <span><strong>{ticket.assignedAgent?.name || 'Unassigned'}</strong><span className="muted small">Ticket owner</span></span>
            <button className="btn btn-secondary btn-sm" aria-expanded={inspectorOpen} aria-controls="ticket-properties" onClick={() => setInspectorOpen(value => !value)}>{inspectorOpen ? 'Hide details' : 'Ticket details'}</button>
            {open && <button className="btn btn-ghost btn-sm" onClick={() => { const input = document.getElementById('ticket-reply'); input?.focus(); input?.scrollIntoView({ block: 'center' }); }}>Write reply</button>}
          </div>
          <SlaCard ticket={ticket} />
          <div className="ticket-properties-region" id="ticket-properties">
          <PropertiesCard
            ticket={ticket}
            busy={busy}
            groupPick={groupPick}
            setGroupPick={value => { dirtyGroup.current = value !== (ticket.team?.key || ''); setGroupPick(value); }}
            run={run}
            me={me}
          />
          </div>
          <section className="insp-section ticket-primary-actions">
            <h2 className="insp-title">Actions</h2>
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
          </section>
          {secondaryError && <div className="insp-section inline-load-error" role="status">{secondaryError} <button className="btn-link" onClick={refreshSecondaryData}>Retry</button></div>}
          <div className="ticket-secondary-region">
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
          </div>
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
          title={ticket.awaitingConfirmation ? 'Force close this ticket?' : 'Close this ticket?'}
          message={
            ticket.awaitingConfirmation
              ? `${ticket.ticketNumber} is awaiting the requester's confirmation. Force closing overrides it: the ticket closes now${ticket.confirmationAutoCloseAt ? ` (the auto-close was set for ${new Date(ticket.confirmationAutoCloseAt).toLocaleString()})` : ''}, the audit trail records the override, and only a reply from the requester can reopen it.`
              : `${ticket.ticketNumber} will be closed. Closed tickets can be reopened if the requester replies, but no further status changes to NEW are possible.`
          }
          confirmLabel={ticket.awaitingConfirmation ? 'Force close' : 'Close ticket'}
          danger
          busy={busy}
          onCancel={() => setCloseConfirm(false)}
          onConfirm={async () => {
            const ok = await run(
              async () => api.closeTicket(id, { note: ticket.awaitingConfirmation ? 'Force closed by an administrator — pending confirmation overridden' : undefined }),
              ticket.awaitingConfirmation ? 'Ticket force-closed' : 'Ticket closed'
            );
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

function Composer({ ticket, noteText, setNoteText, noteMode, setNoteMode, busy, onSend, draftSaved }) {
  const isPublic = noteMode === 'public';
  return (
    <section className={`card ticket-composer ${isPublic ? '' : 'is-internal'}`}>
      <div className="card-head">
        <h2>{isPublic ? 'Reply to requester' : 'Add internal note'}</h2>
        <div className="composer-toggle" role="group" aria-label="Note visibility">
          <button aria-pressed={isPublic} className={isPublic ? 'is-active' : ''} onClick={() => setNoteMode('public')}>Public</button>
          <button aria-pressed={!isPublic} className={!isPublic ? 'is-active' : ''} onClick={() => setNoteMode('internal')}>Internal</button>
        </div>
      </div>
      <div className="composer">
        <textarea
          id="ticket-reply"
          aria-label={isPublic ? 'Reply to requester' : 'Internal note'}
          rows={3}
          placeholder={isPublic ? `Message ${ticket.requesterName || 'the requester'}…` : 'Note for the team — never sent to the requester.'}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
        />
        <div className="composer-toolbar">
          <div className="muted small">
            {noteText && <span className={draftSaved ? 'draft-status' : 'draft-status warn-text'} role="status">{draftSaved ? 'Draft saved in this tab' : 'Draft could not be saved — keep this page open'}<br /></span>}
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
/* Inspector actions — one primary, chosen by lifecycle position       */
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
  // the eye is not asked to choose between five equal buttons. Closing a
  // ticket that is awaiting the requester's confirmation overrides that
  // confirmation, so the button names it.
  let primary = null;
  if (canStart && ticket.state === 'NEW' && (mine || isAdmin)) {
    primary = { label: 'Start working', onClick: onStart };
  } else if (canResolve) {
    primary = { label: 'Resolve…', onClick: onResolve };
  } else if (canClose) {
    primary = {
      label: ticket.awaitingConfirmation ? 'Force close…' : 'Close ticket',
      onClick: onClose,
    };
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
      {primary && (
        <button className="btn btn-primary" disabled={busy} onClick={primary.onClick}>
          {primary.label}
        </button>
      )}
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
          Offer handover
        </button>
      )}
    </div>
  );
}
