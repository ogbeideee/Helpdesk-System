// The ticket inspector — the right-hand column.
//
// One panel of labelled rows rather than a stack of cards: `Row` is the only
// primitive, and every card below is a section of it. Nothing in this file
// decides what is allowed — the server has already answered (SLA states and
// remaining time arrive precomputed, remote-access actions arrive as a
// decision), so each card formats and reflects.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PRIORITIES, CATEGORIES } from '../constants.js';
import { slaOverview, cycleSummary } from '../slaView.js';
import {
  statusMeta as raStatusMeta, summaryLine as raSummary, minutesLeft as raMinutesLeft,
  canRequest as raCanRequest, allowedActions as raAllowedActions,
  durationLabel as raDuration, liveSession as raLive, historyRows as raHistoryRows,
} from '../remoteAccessView.js';
import { StateBadge, Avatar, fmtDateTime, timeAgo } from './ui.jsx';

export function Row({ label, children, stack }) {
  return (
    <div className={`insp-row ${stack ? 'is-stacked' : ''}`}>
      <span className="insp-label">{label}</span>
      <span className="insp-value">{children}</span>
    </div>
  );
}

export const SKILL_LABEL = { 1: 'L1 \u00b7 Junior', 2: 'L2 \u00b7 Standard', 3: 'L3 \u00b7 Senior' };

/* ------------------------------------------------------------------ */
/* Details — the editable facts                                        */
/* ------------------------------------------------------------------ */

export function PropertiesCard({ ticket, busy, groupPick, setGroupPick, run, me }) {
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
export function SlaCard({ ticket }) {
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
