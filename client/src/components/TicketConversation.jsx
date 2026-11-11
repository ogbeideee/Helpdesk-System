// The conversation rail — the ticket's activity, oldest first.
//
// Presentation only. The event list itself is built by
// `src/ticketTimelineView.js` (pure, unit-checked) and the attachment chips
// read from `src/attachmentView.js`, so this file only decides how a kind
// looks: a chat bubble for conversation, a compact one-line marker for
// everything else, so a status change never out-shouts an actual message.

import { useEffect, useState, useRef } from 'react';
import { conversationSections, conversationUnreadIds, conversationDate, conversationRows, conversationReferences, quotedTrail, messageText, mailHeaderRows, MESSAGE_LABELS, AWAITING_LABELS, THREAD_REASONS } from '../conversationView.js';
import { fmtDateTime, timeAgo, Avatar, Modal } from './ui.jsx';
import {
  eventMeta, isMessageKind, handoverMeta,
} from '../ticketTimelineView.js';
import {
  attachmentTitle, attachmentType, formatBytes, downloadAttachment,
  canPreviewInline, fetchAttachmentObjectUrl,
} from '../attachmentView.js';

export function Conversation({ ticket, events, handovers, originalAttachments, onRead, onMove, header, onLoadHistory, historyBusy, historyError }) {
  const [tab, setTab] = useState('conversation');
  const [expanded, setExpanded] = useState(false);
  const [seenUnread, setSeenUnread] = useState(() => ticket.conversation?.unreadIds || []);
  const [readError, setReadError] = useState('');
  const [moving, setMoving] = useState(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [jumpTarget, setJumpTarget] = useState(null);
  const readSnapshots = useRef(new Set());
  const unreadIds = conversationUnreadIds(ticket, seenUnread);
  const sections = conversationSections(events, expanded, unreadIds);
  const references = conversationReferences(ticket, events);
  const rows = conversationRows(ticket, events, sections.messages);
  const messageId = key => `conversation-${ticket.id}-${key}`;
  function revealMessage(key) { setExpanded(true); setJumpTarget(key); }
  async function loadFullHistory() { if (await onLoadHistory?.()) setExpanded(true); }
  useEffect(() => {
    if (!jumpTarget) return;
    const target = document.getElementById(`conversation-${ticket.id}-${jumpTarget}`);
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' }); }
    setJumpTarget(null);
  }, [jumpTarget, expanded, ticket.id]);
  useEffect(() => {
    if (tab !== 'conversation' || ticket.history?.olderReplyCount || !ticket.conversation?.unreadIds?.length) return;
    const through = ticket.conversation.snapshotAt;
    if (readSnapshots.current.has(through)) return;
    readSnapshots.current.add(through);
    setSeenUnread(ids => [...new Set([...ids, ...ticket.conversation.unreadIds])]);
    onRead(through).catch(error => { setReadError(error.message); readSnapshots.current.delete(through); });
  }, [ticket.conversation, tab, onRead]);
  async function dismissUnread() {
    try { await onRead(ticket.conversation.snapshotAt, true); setSeenUnread([]); setReadError(''); }
    catch (error) { setReadError(error.message); }
  }
  async function move(data) {
    setMoveBusy(true);
    try { await onMove(moving.commentId, data); setMoving(null); }
    finally { setMoveBusy(false); }
  }
  return (
    <section className="card activity-card">
      {header || <div className="card-head">
        <h2>{tab === 'conversation' ? 'Conversation' : 'Activity'}</h2>
        <span className="chip">{AWAITING_LABELS[ticket.conversation?.awaiting] || 'Conversation'}</span>
      </div>}
      <div className="conversation-tools">
        <div className="segmented" role="group" aria-label="Ticket history view">
          <button aria-pressed={tab === 'conversation'} className={`segment ${tab === 'conversation' ? 'is-active' : ''}`} onClick={() => setTab('conversation')}>Conversation</button>
          <button aria-pressed={tab === 'activity'} className={`segment ${tab === 'activity' ? 'is-active' : ''}`} onClick={() => setTab('activity')}>Activity ({sections.activity.length})</button>
        </div>
        {unreadIds.length > 0 && (ticket.history?.olderReplyCount
          ? <button className="btn btn-ghost btn-sm" disabled={historyBusy} onClick={loadFullHistory}>Load earlier replies before marking read</button>
          : <button className="btn btn-ghost btn-sm" onClick={dismissUnread}>Mark {unreadIds.length} new repl{unreadIds.length === 1 ? 'y' : 'ies'} read</button>)}
      </div>
      {readError && <div className="conversation-tools" role="alert">Read status could not be saved: {readError}</div>}
      <div className="activity-rail">
        {tab === 'conversation' ? <>
        <p className="conversation-caption">{sections.totalMessages + 1 + (ticket.history?.olderReplyCount || 0)} messages · Oldest first · Times recorded by helpdesk</p>
        <div className="conversation-date">{conversationDate(ticket.createdAt).label}</div>
        <OriginalMessage ticket={ticket} attachments={originalAttachments} messageId={messageId('original')}
          references={references} onReveal={revealMessage} />
        {ticket.history?.olderReplyCount > 0 && <button className="conversation-gap btn btn-secondary btn-sm" disabled={historyBusy} onClick={loadFullHistory}>{historyBusy ? 'Loading history…' : `Load ${ticket.history.olderReplyCount} earlier replies`}</button>}
        {historyError && <p className="inline-load-error" role="alert">{historyError} <button className="btn-link" onClick={onLoadHistory}>Retry</button></p>}
        {sections.hiddenCount > 0 && <p className="conversation-caption">Showing {sections.messages.length} of {sections.totalMessages} replies · Original request always shown</p>}
        {expanded && sections.totalMessages > 5 && <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(false)}>Collapse older messages</button>}
        {rows.map(({ event: ev, number, gapBefore, dateLabel }) => <div key={references.find(reference => reference.number === number).key}>
          {gapBefore > 0 && <button className="conversation-gap btn btn-ghost btn-sm" onClick={() => setExpanded(true)}>{gapBefore} earlier {gapBefore === 1 ? 'message hidden' : 'messages hidden'} · Show all</button>}
          {dateLabel && <div className="conversation-date">{dateLabel}</div>}
          {ev === sections.firstUnread && <div className="conversation-unread" role="separator" aria-label="New since your last visit">New since your last visit</div>}
          <EventItem ev={ev} number={number} messageId={messageId(references.find(reference => reference.number === number).key)} currentKey={references.find(reference => reference.number === number).key}
            references={references} onReveal={revealMessage} unread={unreadIds.includes(ev.commentId)} onMove={() => setMoving(ev)} />
        </div>)}
        </> : <>
        {ticket.history?.activityLimited && <button className="btn btn-secondary btn-sm" disabled={historyBusy} onClick={onLoadHistory}>{historyBusy ? 'Loading history…' : 'Load complete activity history'}</button>}
        {historyError && <p role="alert">{historyError}</p>}
        {sections.activity.map((ev, i) => <EventItem key={`${ev.at}-${i}`} ev={ev} />)}
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
        </>}
      </div>
      {moving && <ThreadCorrectionModal event={moving} busy={moveBusy} onClose={() => { if (!moveBusy) setMoving(null); }} onMove={move} />}
    </section>
  );
}

function OriginalMessage({ ticket, attachments = [], messageId, references, onReveal }) {
  return (
    <div className="ev ev-requester is-message is-original" id={messageId} tabIndex={-1}>
      <Avatar name={ticket.requesterName || 'Requester'} size={32} />
      <div className="ev-body">
        <div className="ev-line">
          <span className="ev-title">{ticket.requesterName || 'Requester'}</span>
          <span className="chip ev-tag original-request-tag">Original request</span>
          <span className="message-ordinal">Message 1</span>
          <time className="ev-time" dateTime={ticket.createdAt} title={`Recorded ${fmtDateTime(ticket.createdAt)}`}>
            {conversationDate(ticket.createdAt).time}
          </time>
        </div>
        <MessageBody display={ticket.originalMessage} fallback={ticket.body} />
        {attachments.length > 0 && <AttachmentChips ticketId={ticket.id} items={attachments} />}
        <QuotedHistory display={ticket.originalMessage} references={references} currentKey="original" onReveal={onReveal} />
        <details className="message-details">
          <summary>Message details</summary>
          {ticket.requesterEmail && <div className="ev-detail mono-sm">{ticket.requesterEmail}</div>}
          <MessageDetails display={ticket.originalMessage} fallback={ticket.body} />
          {ticket.conversation?.originalThreading && <ThreadDetails evidence={ticket.conversation.originalThreading} />}
        </details>
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

function EventItem({ ev, unread, onMove, number, messageId, currentKey, references, onReveal }) {
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
    <div className={`ev ${meta.cls} is-message`} id={messageId} tabIndex={-1}>
      <Avatar name={ev.senderName || ev.actor || 'Team'} size={32} />
      <div className="ev-body">
        <div className="ev-line">
          <span className="ev-title">{ev.senderName || ev.title}</span>
          <span className={`chip ev-tag ${ev.kind === 'internal' ? 'chip-warn' : ''}`}>{MESSAGE_LABELS[ev.kind]}</span>
          {number && <span className="message-ordinal">Message {number}</span>}
          {unread && <span className="chip chip-warn ev-tag">New reply</span>}
          <time className="ev-time" dateTime={ev.at} title={`Recorded ${fmtDateTime(ev.at)}`}>{conversationDate(ev.at).time}</time>
        </div>
        {ev.detail && (
          <MessageBody display={ev.displayMessage} fallback={ev.detail} />
        )}
        {ev.attachments?.length > 0 && <AttachmentChips ticketId={ev.ticketId} items={ev.attachments} />}
        <QuotedHistory display={ev.displayMessage} references={references} currentKey={currentKey} onReveal={onReveal} />
        {(ev.displayMessage || ev.threading || ev.canMoveThread) && <details className="message-details">
          <summary>Message details</summary>
          <MessageDetails display={ev.displayMessage} fallback={ev.detail} />
          {ev.threading && <ThreadDetails evidence={ev.threading} />}
          {ev.canMoveThread && <button className="btn btn-ghost btn-sm" onClick={onMove}>Correct linked ticket…</button>}
        </details>}
      </div>
    </div>
  );
}

function MessageBody({ display, fallback }) {
  return <div className="ev-bubble">{messageText(display, fallback)}</div>;
}

function QuotedHistory({ display, references, currentKey, onReveal }) {
  if (!display?.quotedText) return null;
  const trail = quotedTrail(display, references, currentKey);
  return <details className="quoted-history">
    <summary>Quoted email history{trail.rows.length > 0 ? ` (${trail.rows.length})` : ''}</summary>
    <p className="conversation-caption">Earlier emails included with this message · {trail.order}</p>
    {trail.rows.length ? trail.rows.map(({ message, sourceIndex, match }, index) => <section className="mail-trail-message" key={sourceIndex} aria-label={`Quoted email ${index + 1}`}>
      {match ? <>
        <div className="quoted-reference">
          <span>Same sender and text as message {match.number}</span>
          <button className="btn-link" onClick={() => onReveal(match.key)}>View message {match.number} · {match.name}</button>
        </div>
        <details className="conversation-history"><summary>View quoted copy and headers</summary><QuotedMessage message={message} /></details>
      </> : <QuotedMessage message={message} />}
    </section>) : <pre>{display.quotedText}</pre>}
  </details>;
}

function QuotedMessage({ message }) {
  return <>
    <div className="quoted-message-heading">{message.headers?.from || 'Quoted email'}{(message.headers?.sent || message.headers?.date) && <span>{message.headers.sent || message.headers.date}</span>}</div>
    {message.cleanBody && <div className="mail-trail-text">{message.cleanBody}</div>}
    {message.quotedText && <pre>{message.quotedText}</pre>}
    <details className="conversation-history"><summary>Email headers and signature</summary>
      {message.headers && <dl className="mail-trail-header">{mailHeaderRows(message.headers).map(row => <div key={row.label}><dt>{row.label}:</dt><dd>{row.value}</dd></div>)}</dl>}
      {message.signature && <pre>{message.signature}</pre>}
    </details>
  </>;
}

function MessageDetails({ display, fallback }) {
  return <>
    {display?.signature && <details className="conversation-history"><summary>Show signature</summary><pre>{display.signature}</pre></details>}
    {display && <details className="conversation-history"><summary>View complete email</summary><pre>{fallback}</pre></details>}
  </>;
}
function ThreadDetails({ evidence }) {
  return <details className="conversation-history"><summary>Threading details</summary>
    <p>{THREAD_REASONS[evidence.reason] || THREAD_REASONS.historical_unknown}</p>
    {evidence.messageId && <p>Message ID: <code>{evidence.messageId}</code></p>}
    {evidence.matchedMessageId && <p>Matched message: <code>{evidence.matchedMessageId}</code></p>}
    {evidence.correctedFromTicketId && <p>Moved from ticket ID {evidence.correctedFromTicketId}</p>}
  </details>;
}
function ThreadCorrectionModal({ event, busy, onClose, onMove }) {
  const [targetTicketNumber, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setError('');
    try { await onMove({ targetTicketNumber, note }); } catch (e) { setError(e.message); }
  }
  return <Modal title="Correct linked ticket" onClose={onClose}>
    <form onSubmit={submit}>
      <p>Move this received email and its attachments to another open ticket. Both tickets keep an audit record. Status, assignment and original message text stay unchanged. No email is sent by this correction.</p>
      <label className="field">Destination ticket number<input required value={targetTicketNumber} onChange={e => setTarget(e.target.value)} placeholder="INC-000123" disabled={busy} /></label>
      <label className="field">Reason<textarea required maxLength={1000} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
      <p className="muted small">Future mail continues to follow its ticket references and reply headers.</p>
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Moving…' : 'Move email reply'}</button></div>
    </form>
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Attachments — metadata chips, with the actions the server allows.    */
/* Images the server marked previewable open in place; everything else   */
/* is a download. Visually secondary: a quiet row under the message.     */
/* ------------------------------------------------------------------ */

export function AttachmentChips({ ticketId, items }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  // { att, url } while a preview is open. The URL is an authorized blob, never
  // a direct link to the endpoint, so the session token is still required.
  const [preview, setPreview] = useState(null);

  // One owner for the object URL: revoking when the preview closes AND on
  // unmount keeps a ticket switch from leaking blobs.
  useEffect(() => {
    if (!preview) return undefined;
    const { url } = preview;
    return () => URL.revokeObjectURL(url);
  }, [preview]);

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

  async function openPreview(att) {
    setBusyId(att.id);
    setError('');
    try {
      setPreview({ att, url: await fetchAttachmentObjectUrl(ticketId, att) });
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
          {canPreviewInline(att) && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={busyId === att.id}
              onClick={() => openPreview(att)}
            >
              {busyId === att.id ? '…' : 'Preview'}
            </button>
          )}
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
      {preview && (
        <Modal title={preview.att.filename} onClose={() => setPreview(null)} width={760}>
          <div className="attachment-preview">
            <img src={preview.url} alt={preview.att.filename} />
          </div>
          <div className="modal-actions">
            <span className="muted small">
              {attachmentType(preview.att)} · {formatBytes(preview.att.size)}
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={busyId === preview.att.id}
              onClick={() => download(preview.att)}
            >
              {busyId === preview.att.id ? '…' : 'Download'}
            </button>
          </div>
        </Modal>
      )}
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
