import { isMessageKind } from './ticketTimelineView.js';
export const MESSAGE_LABELS = {
  requester: 'Requester email', participant: 'Participant email', update: 'Agent reply',
  internal: 'Internal note · staff only', resolution: 'Resolution',
};
export const AWAITING_LABELS = {
  agent: 'Awaiting agent', requester: 'Awaiting requester',
  confirmation: 'Awaiting resolution confirmation', closed: 'Conversation closed',
};
export const THREAD_REASONS = {
  original_ticket: 'This email opened the ticket',
  ticket_number: 'The email referenced this ticket number',
  message_reference: 'Reply headers referenced the original email',
  reply_reference: 'Reply headers referenced an earlier reply',
  conversation_requester: 'Conversation identity and requester matched',
  manual_correction: 'An administrator corrected the linked ticket',
  historical_unknown: 'The original matching reason was not recorded',
};
export function mailHeaderRows(headers) {
  if (!headers) return [];
  return [['from', 'From'], ['sent', 'Sent'], ['date', 'Date'], ['to', 'To'], ['cc', 'Cc'], ['subject', 'Subject']]
    .filter(([key]) => headers[key]).map(([key, label]) => ({ label, value: headers[key] }));
}
export function conversationSections(events, expanded, unreadIds = []) {
  const messages = events.filter(event => isMessageKind(event.kind));
  const activity = events.filter(event => !isMessageKind(event.kind));
  const unread = new Set(unreadIds);
  const keep = new Set(messages.slice(-5));
  const visible = expanded ? messages : messages.filter(event => keep.has(event) || unread.has(event.commentId));
  return { messages: visible, activity, hiddenCount: messages.length - visible.length, totalMessages: messages.length,
    firstUnread: visible.find(event => unread.has(event.commentId)) };
}
export function conversationUnreadIds(ticket, remembered = []) {
  const available = new Set((ticket.comments || []).map(comment => comment.id));
  return [...new Set([...remembered, ...(ticket.conversation?.unreadIds || [])])].filter(id => available.has(id));
}
export function messageText(display, fallback) {
  return display?.cleanBody || (display?.quotedText || display?.signature
    ? '(No new text outside the quoted history or signature)' : fallback || '(no message body)');
}

// Conversation dates describe the helpdesk's recorded time, never an invented
// email-sent time. Calendar boundaries follow the viewer's display timezone.
export function conversationDate(value, timeZone) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return { key: 'unknown', label: 'Date unavailable', time: '—' };
  const options = timeZone ? { timeZone } : {};
  return {
    key: new Intl.DateTimeFormat('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
    label: new Intl.DateTimeFormat('en-GB', { ...options, day: 'numeric', month: 'long', year: 'numeric' }).format(date),
    time: new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit', hour12: false }).format(date),
  };
}

export function conversationRows(ticket, events, visible) {
  const messages = events.filter(event => isMessageKind(event.kind));
  const keep = new Set(visible);
  let previousDay = conversationDate(ticket.createdAt).key;
  let gap = 0;
  return messages.flatMap((event, index) => {
    if (!keep.has(event)) { gap++; return []; }
    const day = conversationDate(event.at);
    const row = { event, number: index + 2 + (ticket.history?.olderReplyCount || 0), gapBefore: gap, dateLabel: day.key !== previousDay ? day.label : null };
    previousDay = day.key;
    gap = 0;
    return [row];
  });
}

export function conversationReferences(ticket, events) {
  return [{ key: 'original', number: 1, name: ticket.requesterName || 'Requester', email: ticket.requesterEmail,
    text: messageText(ticket.originalMessage, ticket.body) },
  ...events.filter(event => isMessageKind(event.kind)).map((event, index) => ({
    key: event.commentId ? `reply-${event.commentId}` : `event-${index}`,
    number: index + 2 + (ticket.history?.olderReplyCount || 0), name: event.senderName || event.title, email: event.senderEmail,
    text: messageText(event.displayMessage, event.detail),
    internal: event.kind === 'internal',
  }))];
}

const normalizedText = text => String(text || '').replace(/\s+/g, ' ').trim();
function senderAddress(from) {
  const text = String(from || '').trim();
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = bracketed?.[1] || (/^[^\s<>]+@[^\s<>]+$/.test(text) ? text : '');
  return address.toLowerCase();
}

export function quotedTrail(display, references = [], currentKey) {
  const currentIndex = references.findIndex(reference => reference.key === currentKey);
  const prior = currentIndex >= 0 ? references.slice(0, currentIndex) : [];
  const rows = (display?.quotedMessages || []).map((message, index) => {
    const text = normalizedText(message.cleanBody);
    const email = senderAddress(message.headers?.from);
    // This is a text cross-reference, not identity deduplication. Ambiguous,
    // short, unknown-sender and internal matches remain full quoted entries.
    const matches = text.length >= 32 && email ? prior.filter(reference => !reference.internal &&
      String(reference.email || '').trim().toLowerCase() === email && normalizedText(reference.text) === text) : [];
    return { message, sourceIndex: index, match: matches.length === 1 ? matches[0] : null,
      sent: Date.parse(message.headers?.sent || message.headers?.date || '') };
  });
  const chronological = rows.length > 0 && rows.every(row => Number.isFinite(row.sent));
  return { rows: chronological ? rows.slice().sort((a, b) => a.sent - b.sent || a.sourceIndex - b.sourceIndex) : rows,
    order: chronological ? 'Oldest first' : 'As quoted in the email' };
}
