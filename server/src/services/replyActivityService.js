// Who the ball is with, on every ticket a screen is about to render.
//
// A threaded requester reply is the easiest event in this system to miss. It
// creates no new ticket — RFC threading appends it to the conversation it
// belongs to — so it never enters the queue as a row of its own, and the ticket
// it lands on can be days old, already breached, and nobody's current task. The
// mail alert sent to the owner is the only other trace, which is why "this
// email did not get parsed" is the natural conclusion of reading the queue.
//
// This module answers that with one fact per ticket: the newest non-internal
// message on it, and which side wrote it. It is DERIVED on read, deliberately
// never stored — the Comment table already holds every message, and a stored
// copy would have to be maintained by every write path that touches a
// conversation (intake replies, agent replies, notes, reopen, sweeps).
//
// The side is decided by the AUTHOR's address, not by `Comment.isRequester`:
// a thread carries several people (the requester, colleagues, vendors, an agent
// answering from their own mailbox), and the flag records only that the message
// arrived from outside the app. An address that is the ticket's requester is
// the requester; an address on a staff account is us; anybody else is a third
// party who is also waiting on a reply.
const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');

/** The sides a conversation can end on. */
const SIDES = { REQUESTER: 'requester', AGENT: 'agent', OTHER: 'other' };

/* The "is the last word theirs?" rule, as SQL, so a queue FILTER can ask the
   same question the queue CHIP answers. lastReplies() decides the side in
   JavaScript; this is the same CASE over the same newest non-internal message.
   Two copies would be two answers — a ticket could carry "Reply received" and
   still be missing from a "Needs response" view — so the derivation lives in
   one place and both readers use it.

   Binds to the `t` alias: it reads t."id" and t."requesterEmail". */
const AWAITING_RESPONSE_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM (
    SELECT CASE
        WHEN c."authorAgentId" IS NOT NULL THEN 'agent'
        WHEN lower(trim(c."authorEmail")) = lower(trim(t."requesterEmail")) THEN 'requester'
        WHEN EXISTS (SELECT 1 FROM "Agent" a WHERE lower(trim(a."email")) = lower(trim(c."authorEmail"))) THEN 'agent'
        ELSE 'other' END AS side
      FROM "Comment" c
     WHERE c."ticketId" = t."id" AND c."isInternal" = false
     ORDER BY c."id" DESC
     LIMIT 1
  ) m WHERE m.side <> 'agent'
)`;

/**
 * The last non-internal message per ticket.
 *
 * @param {number[]|number} ids ticket ids to describe
 * @param {object} [client] an optional Prisma client / transaction
 * @returns {Promise<Map<number, {at: Date, from: string, awaitingResponse: boolean,
 *   authorName: string|null, authorEmail: string|null}>>}
 *   one entry per ticket that has a conversation; absent = nothing said yet.
 */
async function lastReplies(ids, client = prisma, actor = null) {
  const ticketIds = [...new Set((Array.isArray(ids) ? ids : [ids])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ticketIds.length) return new Map();

  try {
    if (actor) return await actorReplies(ticketIds, actor, client);
    const [tickets, latest, agents] = await Promise.all([
      client.ticket.findMany({
        where: { id: { in: ticketIds } },
        select: { id: true, requesterEmail: true },
      }),
      // Internal notes are not messages to the requester and must never make a
      // ticket read as "answered". One newest row per ticket: the whole
      // derivation stays bounded by the page, never by the traffic on it.
      client.comment.findMany({
        where: { ticketId: { in: ticketIds }, isInternal: false },
        orderBy: [{ ticketId: 'asc' }, { id: 'desc' }],
        distinct: ['ticketId'],
        select: {
          ticketId: true, createdAt: true, authorEmail: true, authorName: true,
          authorAgentId: true,
        },
      }),
      client.agent.findMany({ select: { email: true } }),
    ]);

    const requesterOf = new Map(
      tickets.map((t) => [t.id, String(t.requesterEmail || '').trim().toLowerCase()]),
    );
    const staff = new Set(
      agents.map((a) => String(a.email || '').trim().toLowerCase()).filter(Boolean),
    );

    const out = new Map();
    for (const row of latest) {
      const author = String(row.authorEmail || '').trim().toLowerCase();
      const requester = requesterOf.get(row.ticketId) || '';
      let from = SIDES.OTHER;
      if (row.authorAgentId) from = SIDES.AGENT;
      else if (requester && author === requester) from = SIDES.REQUESTER;
      else if (author && staff.has(author)) from = SIDES.AGENT;
      out.set(row.ticketId, {
        at: row.createdAt,
        from,
        // The queue's whole question: is the last word theirs, or ours?
        awaitingResponse: from !== SIDES.AGENT,
        authorName: row.authorName || null,
        authorEmail: row.authorEmail || null,
        ...(actor ? { unreadCount: Number(row.unreadCount || 0) } : {}),
      });
    }
    return out;
  } catch {
    // A derived hint is never a reason to lose the screen: the queue renders
    // without the marker rather than failing whole.
    return new Map();
  }
}

module.exports = { SIDES, lastReplies, AWAITING_RESPONSE_SQL };

async function actorReplies(ticketIds, actor, client) {
  const rows = await client.$queryRaw`WITH messages AS (
    SELECT c.*, r."lastReadAt",
      CASE WHEN c."authorAgentId" IS NOT NULL THEN 'agent'
        WHEN lower(trim(c."authorEmail")) = lower(trim(t."requesterEmail")) THEN 'requester'
        WHEN EXISTS (SELECT 1 FROM "Agent" a WHERE lower(trim(a."email")) = lower(trim(c."authorEmail"))) THEN 'agent'
        ELSE 'other' END AS side
    FROM "Comment" c JOIN "Ticket" t ON t."id" = c."ticketId"
    LEFT JOIN "TicketConversationRead" r ON r."ticketId" = c."ticketId" AND r."agentId" = ${actor.id}
    WHERE c."ticketId" IN (${Prisma.join(ticketIds)}) AND c."isInternal" = false
  ) SELECT DISTINCT ON ("ticketId") "ticketId", "createdAt", "authorEmail", "authorName", side,
      COUNT(*) FILTER (WHERE side <> 'agent' AND ("lastReadAt" IS NULL OR "linkedAt" > "lastReadAt"))
        OVER (PARTITION BY "ticketId") AS "unreadCount"
    FROM messages ORDER BY "ticketId", "linkedAt" DESC, "id" DESC`;
  return new Map(rows.map(row => [row.ticketId, { at: row.createdAt, from: row.side,
    awaitingResponse: row.side !== SIDES.AGENT, authorName: row.authorName || null,
    authorEmail: row.authorEmail || null, unreadCount: Number(row.unreadCount) }]));
}
