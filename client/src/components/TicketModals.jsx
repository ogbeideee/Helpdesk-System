// The ticket detail modals — reassign, request a handover, resolve, delete.
//
// Each one owns its own transient form state, so the page shell does not carry
// a dozen `useState` calls. The candidate list is shared because reassignment
// and handovers read the same `/api/tickets/:id/assignment-candidates` payload
// and the same `selectable` decision the backend already made — this file never
// recomputes whether somebody may be picked.

import { useState } from 'react';
import { api } from '../api.js';
import { Spinner, Modal } from './ui.jsx';

/* ------------------------------------------------------------------ */
/* Candidate list — one radio row per teammate                          */
/* ------------------------------------------------------------------ */

function CandidateList({ candidates, pick, onPick, name }) {
  return (
    <div className="reassign-list">
      {candidates.map((c) => (
        <label
          key={c.id}
          className={`reassign-option ${c.selectable ? '' : 'is-disabled'} ${String(c.id) === pick ? 'is-selected' : ''}`}
          title={c.selectable ? '' : c.reason || 'Not selectable'}
        >
          <input
            type="radio" name={name} value={c.id}
            disabled={!c.selectable}
            checked={String(c.id) === pick}
            onChange={() => onPick(String(c.id))}
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
  );
}

export function ReassignModal({ ticket, candidates, candidatesError, busy, run, onClose }) {
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');

  return (
    <Modal title={`Reassign ${ticket.ticketNumber}`} onClose={onClose} width={560}>
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
          <CandidateList candidates={candidates.candidates} pick={pick} onPick={setPick} name="reassign-target" />
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">Reason (optional)</span>
            <textarea
              rows={2}
              placeholder="e.g. Currently handling several critical requests."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || !pick}
              onClick={() => run(async () => {
                await api.reassignTicket(ticket.id, { agentId: Number(pick), reason: reason.trim() || undefined });
                onClose();
              }, 'Ticket reassigned')}
            >
              Reassign
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function HandoverModal({ ticket, candidates, candidatesError, busy, run, onClose }) {
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  // You cannot hand a ticket to the person who already owns it.
  const targets = (candidates?.candidates || []).filter((c) => !c.isCurrentAssignee);

  return (
    <Modal title={`Request a handover of ${ticket.ticketNumber}`} onClose={onClose} width={560}>
      <p className="modal-message">
        The ticket stays with {ticket.assignedAgent ? ticket.assignedAgent.name : 'its current owner'} until
        the teammate accepts. They can accept, decline, or suggest somebody else.
      </p>
      {candidatesError && <div className="callout callout-error">{candidatesError}</div>}
      {!candidates && !candidatesError && <Spinner label="Loading team…" />}
      {candidates && (
        <>
          {targets.length === 0 && (
            <p className="muted small">No other agents in this assignment group.</p>
          )}
          <CandidateList candidates={targets} pick={pick} onPick={setPick} name="handover-target" />
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">Message (optional)</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. You dealt with this printer last week." />
          </label>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || !pick}
              onClick={() => run(async () => {
                await api.requestHandover(ticket.id, { agentId: Number(pick), note: note.trim() || undefined });
                onClose();
              }, 'Handover requested')}
            >
              Send request
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ResolveModal({ ticket, busy, run, onClose }) {
  const [resolution, setResolution] = useState('');

  return (
    <Modal title={`Resolve ${ticket.ticketNumber}`} onClose={onClose}>
      <p className="modal-message">
        A resolution note is required. It will be recorded in the audit history
        {ticket.requesterEmail ? ' and included in the notification to the requester.' : '.'}
      </p>
      <textarea
        rows={4}
        autoFocus
        placeholder="Describe how the issue was resolved…"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      />
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || !resolution.trim()}
          onClick={async () => {
            const ok = await run(async () => api.resolveTicket(ticket.id, { resolution }), 'Ticket resolved');
            if (ok) onClose();
          }}
        >
          Resolve ticket
        </button>
      </div>
    </Modal>
  );
}

/** Destructive action, deliberately the quietest thing on the page. */
export function DeleteZone({ id, onDeleted }) {
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
