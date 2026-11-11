import assert from 'node:assert/strict';
import { replyMarker, nextResponse } from './src/replyView.js';

const at = '2026-10-08T16:19:26.000Z';

// A ticket nobody has written on carries no marker — an empty chip on every row
// would say nothing.
assert.equal(replyMarker({ state: 'NEW' }), null);
assert.equal(replyMarker({ state: 'NEW', lastReply: null }), null);
assert.equal(replyMarker({ state: 'NEW', lastReply: { from: 'requester' } }), null);

// The case the marker exists for: a threaded reply, so the ticket reads as
// work rather than as a mail nobody parsed.
const waiting = replyMarker({
  state: 'NEW',
  lastReply: { at, from: 'requester', awaitingResponse: true, authorName: 'Luca Beccarelli' },
});
assert.equal(waiting.tone, 'waiting');
assert.equal(waiting.label, 'Reply received');
assert.match(waiting.detail, /Luca Beccarelli/);

// A third party on the thread (neither the requester nor one of our accounts)
// is also waiting on an answer, and must not read as our own reply.
const other = replyMarker({
  state: 'IN_PROGRESS',
  lastReply: { at, from: 'other', awaitingResponse: true, authorEmail: 'vendor@example.com' },
});
assert.equal(other.tone, 'other');
assert.equal(other.label, 'Message received');
assert.match(other.detail, /vendor@example\.com/);

// We replied last: one quiet tone, and the wording says what is being waited on.
const answered = replyMarker({
  state: 'IN_PROGRESS',
  lastReply: { at, from: 'agent', awaitingResponse: false, authorName: 'Bashir Oladipo' },
});
assert.equal(answered.tone, 'answered');
assert.equal(answered.label, 'Awaiting requester');

// The server's flag is authoritative. The client never re-derives the side from
// `from` (or from who the author looks like) — it renders what it was told.
const flagWins = replyMarker({
  state: 'NEW',
  lastReply: { at, from: 'agent', awaitingResponse: true, authorName: 'Someone' },
});
assert.equal(flagWins.tone, 'other');
assert.equal(flagWins.label, 'Message received');

// Closed work is history; a RESOLVED ticket already shows the confirmation chip
// for the one reply it is waiting on.
assert.equal(replyMarker({
  state: 'RESOLVED',
  lastReply: { at, from: 'agent', awaitingResponse: false },
}), null);
assert.equal(replyMarker({
  state: 'CLOSED',
  lastReply: { at, from: 'requester', awaitingResponse: true },
}), null);

// ---------------------------------------------------------------------------
// nextResponse — the quiet line UNDER the queue's status badge. It answers a
// different question from the badge ("whose move is it" vs "where is this in
// its life"), which is why it is a second line and not a second status.
// ---------------------------------------------------------------------------

// Nothing said, or nothing to say: no line at all.
assert.equal(nextResponse({ state: 'NEW' }), null);
assert.equal(nextResponse({ state: 'NEW', lastReply: null }), null);
assert.equal(nextResponse({ state: 'NEW', lastReply: { from: 'requester' } }), null);

// We replied last — the case that used to print "Awaiting requester" beside
// the status and make a row look self-contradictory.
const theirs = nextResponse({
  state: 'NEW',
  lastReply: { at, from: 'agent', awaitingResponse: false, authorName: 'Bashir Oladipo' },
});
assert.equal(theirs.tone, 'waiting');
assert.equal(theirs.text, 'Next response: requester');
assert.match(theirs.detail, /Bashir Oladipo/);

// The ball is with us: same rule, the other way round.
const ours = nextResponse({
  state: 'IN_PROGRESS',
  lastReply: { at, from: 'requester', awaitingResponse: true, authorName: 'Luca Beccarelli' },
});
assert.equal(ours.tone, 'owed');
assert.equal(ours.text, 'Next response: us');
assert.match(ours.detail, /Luca Beccarelli/);

// Unread mail outranks "whose turn is it": it is news nobody has read.
const unread = nextResponse({
  state: 'NEW',
  lastReply: { at, from: 'requester', awaitingResponse: true, unreadCount: 3, authorName: 'Luca' },
});
assert.equal(unread.tone, 'attention');
assert.equal(unread.text, '3 unread replies');

const oneUnread = nextResponse({
  state: 'NEW',
  lastReply: { at, from: 'requester', awaitingResponse: true, unreadCount: 1 },
});
assert.equal(oneUnread.text, '1 unread reply');

// The server's flag is authoritative here too — never re-derived from `from`.
const flagWinsLine = nextResponse({
  state: 'NEW',
  lastReply: { at, from: 'agent', awaitingResponse: true, authorName: 'Someone' },
});
assert.equal(flagWinsLine.text, 'Next response: us');

// A third party wrote in: they are waiting on an answer like anyone else.
assert.equal(nextResponse({
  state: 'NEW',
  lastReply: { at, from: 'other', awaitingResponse: true, authorEmail: 'vendor@example.com' },
}).tone, 'owed');

// No line where the confirmation chip already says it, and none on history.
assert.equal(nextResponse({
  state: 'RESOLVED',
  lastReply: { at, from: 'agent', awaitingResponse: false },
}), null);
assert.equal(nextResponse({
  state: 'CLOSED',
  lastReply: { at, from: 'requester', awaitingResponse: true },
}), null);

console.log('Reply view checks passed');
