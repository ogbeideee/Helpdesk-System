// The ticket activity timeline — the data model behind the conversation rail.
//
// Pure, no React and no API: one ticket payload in, an ordered list of timeline
// events out. It merges the three independent histories the API returns
// (audit logs, comments, SLA events), attaches each comment's own
// attachments, and carries the resolution text onto the event that already
// records the RESOLVED transition rather than appending a duplicate.
//
// Every title is derived from data the server sent. Nothing here invents a
// state, a time or a label.

import { stateLabel } from './constants.js';
import { attachmentsForComment } from './attachmentView.js';

/* ------------------------------------------------------------------ */
/* Marker vocabulary — the CSS class and glyph each kind is drawn with  */
/* ------------------------------------------------------------------ */

export const EVENT_META = {
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

/** The conversation bubble kinds, as opposed to the one-line system markers. */
const MESSAGE_KINDS = ['internal', 'update', 'resolution', 'requester'];

export function isMessageKind(kind) {
  return MESSAGE_KINDS.includes(kind);
}

export function eventMeta(kind) {
  return EVENT_META[kind] || EVENT_META.audit;
}

/* ------------------------------------------------------------------ */
/* The timeline itself                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {object} ticket  a ticket as `GET /api/tickets/:id` returns it
 * @returns {Array<{kind,at,title,detail,actor?,ticketId?,attachments?}>}
 *          oldest first
 */
export function buildTimeline(ticket) {
  if (!ticket) return [];
  const events = [];

  for (const log of ticket.auditLogs || []) {
    // The creation row is drawn as the original message instead, so the rail
    // does not open with a "created" marker immediately above it.
    if (!log.fromState && log.toState === 'NEW') continue;
    const { kind, title } = classifyAuditEvent(log);
    events.push({
      kind,
      at: log.createdAt,
      title,
      // For a state change the title is a fixed phrase, so the note is worth
      // carrying as the second line. For anything else the note IS the title,
      // and repeating it would print the same sentence twice.
      detail: log.note && log.fromState !== log.toState ? log.note : null,
      actor: prettyActor(log.actor),
    });
  }

  for (const c of ticket.comments || []) {
    events.push({
      kind: c.isInternal ? 'internal' : 'update',
      at: c.createdAt,
      title: commentTitle(c),
      detail: c.body,
      ticketId: ticket.id,
      attachments: attachmentsForComment(ticket, c.id),
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

/* ------------------------------------------------------------------ */
/* Comment titles                                                      */
/* ------------------------------------------------------------------ */

function commentTitle(c) {
  if (c.isInternal) {
    return `Internal note${c.authorName ? ' — ' + c.authorName : ''}`;
  }
  if (c.isRequester) {
    return `Requester reply${c.authorName || c.authorEmail ? ' — ' + (c.authorName || c.authorEmail) : ''}`;
  }
  return `${c.authorName || 'Agent'} updated the requester`;
}

/* ------------------------------------------------------------------ */
/* Audit-log classification                                            */
/* ------------------------------------------------------------------ */

/**
 * A state change is always classified by the transition itself; anything else
 * is read off the human note the audit trail wrote. Unknown shapes fall
 * through to a generic entry rather than being dropped.
 */
export function classifyAuditEvent(log) {
  const note = log.note || '';
  if (log.fromState !== log.toState) {
    const reopened = log.toState === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(log.fromState);
    if (reopened) {
      return { kind: 'reopened', title: `Reopened (${stateLabel(log.fromState)} → In Progress)` };
    }
    if (log.toState === 'CLOSED') return { kind: 'closed', title: 'Ticket closed' };
    if (log.toState === 'RESOLVED') return { kind: 'resolution', title: 'Marked resolved' };
    if (log.toState === 'IN_PROGRESS') return { kind: 'status', title: 'Started work' };
    return {
      kind: 'status',
      title: `Status: ${stateLabel(log.fromState)} → ${stateLabel(log.toState)}`,
    };
  }
  if (/^Handover/i.test(note)) return { kind: 'handover', title: note };
  if (/^Reassigned from/i.test(note)) return { kind: 'reassign', title: note };
  if (/assignment group changed/i.test(note)) return { kind: 'group', title: note };
  if (/assigned|claim/i.test(note)) return { kind: 'assignment', title: note };
  return { kind: 'audit', title: note || 'Updated' };
}

/** `system` reads as `automation`; "Ada Lovelace <ada@…" loses the address. */
export function prettyActor(actor) {
  if (!actor) return null;
  if (actor === 'system') return 'automation';
  const m = /^(.*?)\s*</.exec(actor);
  return m ? m[1] : actor;
}

/* ------------------------------------------------------------------ */
/* SLA events                                                          */
/* ------------------------------------------------------------------ */

/* SLA timeline entries map 1:1 onto the API's slaEvents array (the
   append-only TicketSlaEvent log). `at` is the historical instant, so a breach
   marker lands where the clock actually ran out rather than when the sweeper
   happened to record it. Unknown future types are skipped rather than
   guessed at. */
export const SLA_EVENT_TITLES = {
  target_created: () => 'SLA targets set',
  target_changed: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA target changed` : 'SLA target changed'),
  response_recorded: () => 'First response recorded',
  approaching_breach: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA approaching breach` : 'SLA approaching breach'),
  breach: (e) => (clockLabel(e.clock) ? `${clockLabel(e.clock)} SLA breached` : 'SLA breached'),
  cycle_restarted: () => 'SLA cycle restarted',
};

export function clockLabel(clock) {
  return clock === 'response' ? 'Response' : clock === 'resolution' ? 'Resolution' : null;
}

export function slaTimelineEvent(ev) {
  const title = SLA_EVENT_TITLES[ev.type];
  if (!title) return null;
  return {
    kind: ev.type === 'breach' ? 'sla-breach' : ev.type === 'approaching_breach' ? 'sla-warn' : 'sla',
    at: ev.at,
    title: title(ev),
    detail: ev.detail || null,
  };
}

/* ------------------------------------------------------------------ */
/* Handovers                                                           */
/* ------------------------------------------------------------------ */

export const HANDOVER_META = {
  PENDING:   { label: 'awaiting answer', cls: 'chip-warn' },
  QUEUED:    { label: 'queued', cls: 'chip-off' },
  ACCEPTED:  { label: 'accepted', cls: 'chip-ok' },
  DECLINED:  { label: 'declined', cls: 'chip-warn' },
  CANCELLED: { label: 'cancelled', cls: 'chip-off' },
  EXPIRED:   { label: 'expired', cls: 'chip-off' },
};

export function handoverMeta(status) {
  return HANDOVER_META[status] || { label: String(status || '').toLowerCase(), cls: '' };
}

/** The one handover that is live, i.e. the one the UI talks about. */
export function activeHandover(handovers) {
  return (handovers || []).find((h) => h.active) || null;
}
