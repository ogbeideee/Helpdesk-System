// Who the ball is with, as the queue and the ticket header show it.
//
// One rule, one place: the server's replyActivityService reads the newest
// non-internal message on the ticket and decides which side wrote it and
// whether a reply is owed; this module only NAMES that answer. The client never
// recomputes either — a queue row carries no comments to read, and a second
// copy of the rule would be a second answer.
//
// Why the marker exists at all: a threaded reply creates no ticket, so the only
// visible trace of "somebody wrote in" on a ticket that is already in the queue
// is this. Without it a freshly forwarded request looks exactly like a mail
// nobody parsed.
const AWAITING_LABEL = { requester: 'Reply received', other: 'Message received' };

/**
 * The chip a ticket should carry, or null when it should carry none.
 *
 * Null is the answer for a ticket nobody has written on (`lastReply` absent),
 * for closed work (history, not a queue signal) and for a RESOLVED ticket —
 * which already shows the confirmation chip for the one reply it waits on.
 *
 * @param {object} ticket a serialized ticket
 * @returns {{tone: 'waiting'|'other'|'answered', label: string, detail: string}|null}
 */
export function replyMarker(ticket) {
  const reply = ticket?.lastReply;
  if (!reply || !reply.at) return null;
  if (ticket.state === 'RESOLVED' || ticket.state === 'CLOSED') return null;
  if (reply.unreadCount > 0) return {
    tone: 'waiting', label: `${reply.unreadCount} new repl${reply.unreadCount === 1 ? 'y' : 'ies'}`,
    detail: 'New email replies since your last conversation visit',
  };
  const who = reply.authorName || reply.authorEmail || 'the sender';
  if (!reply.awaitingResponse) {
    return {
      tone: 'answered',
      label: 'Awaiting requester',
      detail: `We replied last — ${who}`,
    };
  }
  return {
    tone: reply.from === 'requester' ? 'waiting' : 'other',
    label: AWAITING_LABEL[reply.from] || 'Message received',
    detail: `${who} wrote in`,
  };
}

/**
 * The quiet line under the queue's status badge: whose turn it is.
 *
 * This exists because the queue used to print "Awaiting requester" as a chip
 * BESIDE the lifecycle badge, so a row read "New · Awaiting requester" — two
 * statuses arguing about the same ticket. The badge answers "where is this in
 * its life"; this answers "whose move is it", and the queue now stacks them as
 * a primary and a secondary rather than as peers.
 *
 * Renders nothing when there is nothing to say: no conversation yet, a closed
 * ticket (history, not a queue signal), or a RESOLVED one — which already
 * carries the confirmation chip for the single reply it is waiting on.
 *
 * @param {object} ticket a serialized ticket
 * @returns {{tone: 'owed'|'waiting'|'attention', text: string, detail: string}|null}
 */
export function nextResponse(ticket) {
  const reply = ticket?.lastReply;
  if (!reply || !reply.at) return null;
  if (ticket.state === 'RESOLVED' || ticket.state === 'CLOSED') return null;
  const who = reply.authorName || reply.authorEmail || 'the sender';
  // Unread mail is the one case that outranks "whose turn is it": it is new
  // information nobody has looked at yet.
  if (reply.unreadCount > 0) {
    const n = reply.unreadCount;
    return { tone: 'attention', text: `${n} unread repl${n === 1 ? 'y' : 'ies'}`, detail: `${who} wrote in` };
  }
  return reply.awaitingResponse
    ? { tone: 'owed', text: 'Next response: us', detail: `${who} wrote in` }
    : { tone: 'waiting', text: 'Next response: requester', detail: `We replied last — ${who}` };
}
