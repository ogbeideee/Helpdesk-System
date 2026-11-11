// The ticket inspector — the right-hand column.
//
// One panel of labelled rows rather than a stack of cards: `Row` is the only
// primitive, and every card below is a section of it. Nothing in this file
// decides what is allowed — the server has already answered (SLA states and
// remaining time arrive precomputed, remote-access actions arrive as a
// decision), so each card formats and reflects.

import { useEffect, useState, useRef } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import { slaOverview, cycleSummary } from '../slaView.js';
import {
  statusMeta as raStatusMeta, summaryLine as raSummary, minutesLeft as raMinutesLeft,
  canRequest as raCanRequest, allowedActions as raAllowedActions,
  durationLabel as raDuration, liveSession as raLive, historyRows as raHistoryRows,
} from '../remoteAccessView.js';
import { StateBadge, ConfirmationChip, Avatar, fmtDateTime, timeAgo } from './ui.jsx';
import { requiredSkillOf, skillLabel, assigneeBelowRequired } from '../ticketSkillView.js';
import { ticketPropertyChanges } from '../ticketPropertiesView.js';

export function Row({ label, children, stack }) {
  return (
    <div className={`insp-row ${stack ? 'is-stacked' : ''}`}>
      <span className="insp-label">{label}</span>
      <span className="insp-value">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Details — the editable facts                                        */
/* ------------------------------------------------------------------ */

export function PropertiesCard({ ticket, busy, groupPick, setGroupPick, run, me }) {
  const [groups, setGroups] = useState([]);
  const [groupsError, setGroupsError] = useState('');
  const [priorityPick, setPriorityPick] = useState(ticket.priority);
  const [categoryPick, setCategoryPick] = useState(ticket.category);
  const prior = useRef({ priority: ticket.priority, category: ticket.category });
  useEffect(() => {
    const previous = prior.current;
    setPriorityPick(value => value === previous.priority ? ticket.priority : value);
    setCategoryPick(value => value === previous.category ? ticket.category : value);
    prior.current = { priority: ticket.priority, category: ticket.category };
  }, [ticket.priority, ticket.category]);
  function loadGroups() { setGroupsError(''); api.groups().then(setGroups).catch(() => setGroupsError('Assignment groups are unavailable.')); }
  useEffect(loadGroups, []);

  const isAdmin = me.role === 'admin';
  const changes = ticketPropertyChanges(ticket, { priority: priorityPick, category: categoryPick, group: groupPick }, isAdmin);
  const changed = Object.keys(changes).length > 0;
  const group = groups.find((g) => g.key === (ticket.team?.key || ''));
  // The engine's own answer for THIS ticket — the bar of the routing rule that
  // governs it in this group, plus the priority boost. The group's bar is only
  // a fallback for payloads that predate the field (ticketSkillView.js).
  const requiredSkill = requiredSkillOf(ticket, group);

  return (
    <section className="insp-section">
      <h2 className="insp-title">Details</h2>

      <Row label="Status">
        <span className="insp-inline">
          <StateBadge state={ticket.state} />
          <ConfirmationChip ticket={ticket} />
        </span>
      </Row>
      {ticket.state === 'RESOLVED' && ticket.confirmationAutoCloseAt && (
        <Row label="Auto-close">
          <span title={fmtDateTime(ticket.confirmationAutoCloseAt)}>
            {fmtDateTime(ticket.confirmationAutoCloseAt)}
          </span>
          <span className="insp-sub">if the requester does not confirm</span>
        </Row>
      )}

      <Row label="Priority">
        <select
          className="insp-select"
          aria-label="Priority"
          value={priorityPick}
          disabled={busy}
          onChange={e => setPriorityPick(e.target.value)}
        >
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Row>

      <Row label="Category">
        <select
          className="insp-select"
          aria-label="Category"
          value={categoryPick}
          disabled={busy}
          onChange={e => setCategoryPick(e.target.value)}
        >
          {[...new Set([ticket.category, ...CATEGORIES])].map((c) => <option key={c}>{c}</option>)}
        </select>
      </Row>

      <Row label="Group">
        <span className="insp-inline">
          <select
            className="insp-select"
            aria-label="Assignment group"
            value={groupPick}
            disabled={busy || !isAdmin || Boolean(groupsError)}
            title={isAdmin ? '' : 'Only an administrator can change the assignment group'}
            onChange={(e) => setGroupPick(e.target.value)}
          >
            <option value="">Triage</option>
            {ticket.team && !groups.some(group => group.key === ticket.team.key) && <option value={ticket.team.key}>{ticket.team.name}</option>}
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
          </select>
        </span>
      </Row>

      {groupsError && <p className="inline-load-error" role="status">{groupsError} <button className="btn-link" onClick={loadGroups}>Retry</button></p>}
      {changed && <div className="property-save-bar" role="status">
        <span className="muted small">Unsaved changes</span>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => {
          const ok = await run(() => api.updateTicket(ticket.id, changes), 'Ticket details saved', { resetGroup: true });
          if (ok) { setPriorityPick(priorityPick); setCategoryPick(categoryPick); }
        }}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPriorityPick(ticket.priority); setCategoryPick(ticket.category); setGroupPick(ticket.team?.key || ''); }}>Cancel</button>
      </div>}

      <Row label="Assigned to">
        {ticket.assignedAgent ? (
          <>
            <span className="cell-agent">
              <Avatar name={ticket.assignedAgent.name} size={22} />
              <span className="insp-strong">{ticket.assignedAgent.name}</span>
            </span>
          </>
        ) : <span className="unassigned-tag">Unassigned</span>}
      </Row>

      {requiredSkill && (
        <Row label="Skill required">
          <span>{skillLabel(requiredSkill.level)}</span>
          {assigneeBelowRequired(ticket, requiredSkill) && (
            <span className="insp-sub warn-text">Assignee is below the required level</span>
          )}
        </Row>
      )}

      <details className="ticket-additional-details">
        <summary>More details</summary>
        <Row label="Requester">
          <span className="insp-strong">{ticket.requesterName || 'Unknown'}</span>
          {ticket.requesterEmail && <span className="insp-sub mono-sm">{ticket.requesterEmail}</span>}
        </Row>
        {ticket.assignedAgent?.skillLevel && <Row label="Agent skill">{skillLabel(ticket.assignedAgent.skillLevel)}</Row>}
        {requiredSkill?.ruleName && <Row label="Skill rule">{requiredSkill.ruleName}</Row>}
      <Row label="Created">
        <span title={fmtDateTime(ticket.createdAt)}>{timeAgo(ticket.createdAt)}</span>
        <span className="insp-sub">{fmtDateTime(ticket.createdAt)}</span>
      </Row>
      <Row label="Updated">
        <span title={fmtDateTime(ticket.updatedAt)}>{timeAgo(ticket.updatedAt)}</span>
      </Row>
      </details>
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
export function SlaCard({ ticket }) {
  const sla = slaOverview(ticket);
  // Tickets without SLA cycles keep the legacy "SLA target" row in Details.
  if (!sla) return null;
  const cycles = ticket.sla?.cycles || [];
  const previous = cycles.slice(0, -1).reverse();

  return (
    <section className="insp-section">
      <h2 className="insp-title ticket-sla-heading">SLA <span className="ticket-sla-caption">Working time</span></h2>

      <SlaClockRow label="Response" block={ticket.sla?.response} view={sla.response} />
      <SlaClockRow label="Resolution" block={ticket.sla?.resolution} view={sla.resolution} />

      <details className="ticket-additional-details">
        <summary>Cycle {sla.cycleNumber} · {sla.cycleEndedAt ? 'ended' : 'active'}</summary>
        <Row label="Started" stack>
          <span>{fmtDateTime(sla.cycleStartedAt)}</span>
        </Row>
        {ticket.sla?.response?.dueAt && <Row label="Response due" stack>{fmtDateTime(ticket.sla.response.dueAt)}</Row>}
        {ticket.sla?.resolution?.dueAt && <Row label="Resolution due" stack>{fmtDateTime(ticket.sla.resolution.dueAt)}</Row>}
        {ticket.sla?.response?.firstResponseAt && <Row label="First response" stack>{fmtDateTime(ticket.sla.response.firstResponseAt)}</Row>}
        {previous.length > 0 && <>
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
        </>}
      </details>
    </section>
  );
}

function SlaClockRow({ label, block, view }) {
  return (
    <div className={`ticket-sla-clock is-${view.tone}`}>
      {/* The view's text already carries the remaining working time where it
          runs; a separate line here would say it twice. */}
      <div className="ticket-sla-line" title={block?.dueAt ? `Due ${fmtDateTime(block.dueAt)}` : undefined}>
        <span>{label}</span>
        <strong title={view.text}>{view.short === '—' ? view.text : view.short}</strong>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Remote access — the application-side session bookkeeping. The      */
/* backend owns every rule; this card only mirrors what it decided.   */
/* ------------------------------------------------------------------ */

export function RemoteAccessCard({ ticket, me, sessions, busy, run }) {
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
/* More actions — everything the header deliberately left out          */
/* ------------------------------------------------------------------ */

export function ActionsCard({
  ticket, me, busy,
  canStart, canResolve, canClose, nextStates, open, activeHandover,
  onStart, onInProgress, onResolve, onClose, onReopen,
  onCancelHandover,
}) {
  const mine = ticket.assignedAgentId === me.id;
  const isAdmin = me.role === 'admin';

  // Secondary moves only: the likely next step is in the inspector's Actions section.
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
