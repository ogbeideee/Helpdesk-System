# Ticket conversations

Browser detail reads now opt into `?history=recent`: latest 20 comments,
bounded activity, original attachments and attachments belonging to loaded
comments. `history.olderReplyCount` preserves absolute message numbering and
offers an explicit full-history load. The unqualified detail endpoint keeps its
full-history contract. Partial history is not automatically marked entirely read.
Mutation payloads are followed by a detail read so raw comments cannot overwrite
sender/quote/unread annotations. See `security-and-ux-2026-10-18.md` for the related
draft, mobile and emailed-response SLA changes.

Ticket detail separates **Conversation** (received emails, agent replies,
internal notes and resolution text) from **Activity** (status, assignment, SLA
and handover history). The **Original request** is always visible. Five recent
replies are expanded by default, with older unread replies also visible. Stable
message numbers, local calendar-date dividers, exact clock times and explicit
hidden-message gaps preserve continuity. Times are labelled as helpdesk-recorded
times, not the original email's sent time. Attachments remain beside the message
that supplied them.

`conversationService.js` reuses the deterministic email parser to derive the
sender's new text, quoted history and signature. Stored bodies are untouched.
The **View complete email** disclosure displays the complete stored text, not raw
MIME. Internal notes and replies composed in the app stay verbatim. React
renders all content as text; it does not render inbound HTML.

**Quoted email history** opens directly beneath the message, separately from
technical Message details. Parsed quoted blocks sort oldest first only when
every quoted date is readable; otherwise their source order is retained and
labelled. A unique earlier message with the same sender address and exact text
(normalizing whitespace, at least 32 characters) gets a compact cross-reference.
It says **Same sender and text**, not that the two emails share an identity.
The full quoted copy, headers and signature remain expandable. Ambiguous,
short, internal, unknown-sender and later-message matches remain quoted in full;
standalone emails are never deduplicated. A reference reveals a hidden target,
scrolls to it and moves keyboard focus without changing the hash route.

The backend classifies message authors and derives who should respond next.
Closed tickets and resolution confirmation have distinct labels. Internal
notes never count as a reply to the requester.

## Unread replies

`TicketConversationRead` holds one monotonic timestamp per ticket and staff
account. Visiting Conversation saves the server's loaded snapshot time; replies
arriving afterwards remain unread. The divider stays visible for that visit
until dismissed with **Mark new replies read**. Activity alone does not mark the
conversation read. Cursor writes from older tabs cannot move the timestamp
backwards. Reading messages does not change ticket timestamps or write domain
audit events. The queue's per-account unread count shares its latest-reply
query, preserving the existing read-performance budget.

`Comment.linkedAt` records when a reply joined its current ticket. Moving an
older reply therefore makes it unread at its destination without changing its
historical message time or body. Internal and staff-authored messages do not
increment incoming unread counts. Existing replies initially have their
original creation time as `linkedAt`; no historical read receipt is invented.

## Inspecting and correcting threading

Assignment notifications sent to agents make the ticket number a hyperlink to
the authenticated ticket page. A plain-text alternative includes the same URL.
`PORTAL_BASE_URL` supplies the public origin/subpath; no credentials or signed
access tokens are embedded. Signed-out agents sign in and retain the selected
ticket route. Existing ticket permissions apply. Missing or invalid portal
configuration leaves an unlinked notice; already delivered emails are unchanged.

Expanded quoted history uses Outlook-style dividers with From, Sent/Date, To,
Cc and Subject labels. A complete header run is recognised even without an
"Original Message" line and with blank lines or wrapped recipient lists. Each
historical message keeps its own signature collapsed. Incomplete header-like
prose stays in the message. The original stored text remains available.
The parser also distinguishes plain-text angle-bracket email addresses from
HTML tags, preserving addresses in new incoming trails. Existing stored text
is rendered again on read, with no database rewrite or mailbox change.

Administrators can expand **Threading details** beneath received emails. New
intake persists the matching reason (ticket number, original-message reference,
earlier-reply reference, or conversation/requester match). Historical messages
say the reason was not recorded. Message IDs are evidence, never credentials.

**Correct linked ticket…** moves a received email reply and its attachments to
another open ticket. The administrator must enter the exact destination number
and a reason. A transaction locks both tickets in stable order, compares the
reply's existing ticket, moves the reply and attachment metadata, and writes
domain and unified audit entries on both tickets. The message identity and
original text remain unchanged. Ownership, lifecycle state, existing SLA
history and previously sent notifications are not rewritten. This action sends
no email. Original ticket-opening messages and internal notes cannot be moved
through this action.

Correction changes the selected reply's current ticket. Future incoming email
continues to follow its explicit ticket references and reply headers; an email
explicitly naming the old ticket can still join it. This avoids silently
overriding the sender's explicit ticket choice.

Implementation is split between the backend service, the intake pipeline,
`ticketTimelineView.js` / `conversationView.js`, and `TicketConversation.jsx`.
`test-conversation` and `conversation-check.mjs` pin the rules. Database changes
ship in `20261009000000_conversation_threads`.
