// The conversation rail — the ticket's activity, oldest first.
//
// Presentation only. The event list itself is built by
// `src/ticketTimelineView.js` (pure, unit-checked) and the attachment chips
// read from `src/attachmentView.js`, so this file only decides how a kind
// looks: a chat bubble for conversation, a compact one-line marker for
// everything else, so a status change never out-shouts an actual message.

import { useState } from 'react';
import { fmtDateTime, timeAgo, Avatar } from './ui.jsx';
import {
  eventMeta, isMessageKind, handoverMeta,
} from '../ticketTimelineView.js';
import {
  attachmentTitle, attachmentType, formatBytes, downloadAttachment,
} from '../attachmentView.js';

export function Conversation({ ticket, events, handovers, originalAttachments }) {
  return (
    <section className="card activity-card">
      <div className="card-head">
        <h2>Activity</h2>
        <span className="muted small">{events.length} event{events.length === 1 ? '' : 's'}</span>
      </div>
      <div className="activity-rail">
        <OriginalMessage ticket={ticket} attachments={originalAttachments} />
        {events.map((ev, i) => <EventItem key={`${ev.at}-${i}`} ev={ev} />)}
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

function OriginalMessage({ ticket, attachments = [] }) {
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
        {attachments.length > 0 && <AttachmentChips ticketId={ticket.id} items={attachments} />}
      </div>
    </div>
  );
}

export function EvGlyph({ name }) {
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
  const meta = eventMeta(ev.kind);

  // System-ish events are one compact line on the rail: they are context,
  // not conversation, and should never out-shout an actual message.
  if (!isMessageKind(ev.kind)) {
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
          {ev.kind === 'internal' && <span className="chip chip-warn ev-tag">Internal</span>}
          {ev.kind === 'resolution' && <span className="chip chip-ok ev-tag">Resolution</span>}
          <time className="ev-time" dateTime={ev.at} title={fmtDateTime(ev.at)}>{timeAgo(ev.at)}</time>
        </div>
        {ev.detail && (
          <div className={`ev-bubble ${ev.kind === 'resolution' ? 'is-resolution' : ''}`}>{ev.detail}</div>
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

export function AttachmentChips({ ticketId, items }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  async function download(att) {
    setBusyId(att.id);
    setError('');
    try {
      await downloadAttachment(ticketId, att);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="attachment-row">
      {items.map((att) => (
        <span key={att.id} className="attachment-chip" title={attachmentTitle(att)}>
          <span className="attachment-name">{att.filename}</span>
          <span className="muted small">{attachmentType(att)}</span>
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
/* Handover chain — who passed what to whom, and what came back         */
/* ------------------------------------------------------------------ */

function HandoverChain({ handovers }) {
  return (
    <div className="conv-item is-system">
      <Avatar name="chain" size={28} />
      <div style={{ width: '100%' }}>
        <div className="conv-meta"><strong>Handover chain</strong> <span className="muted small">{handovers.length} event{handovers.length === 1 ? '' : 's'}</span></div>
        <ol className="handover-chain" style={{ marginTop: 6 }}>
          {handovers.map((h) => {
            const meta = handoverMeta(h.status);
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
