const prisma = require('../lib/prisma');
const { separateQuotedContent } = require('../email/emailParser');
const { splitOutlookTrail } = require('../email/outlookTrail');
const audit = require('./auditService');

function displayMessage(body) {
  const rawBody = String(body || '');
  const parts = separateQuotedContent(rawBody);
  return { ...parts, quotedMessages: parts.quotedText ? splitOutlookTrail(parts.quotedText).map(block => ({
    headers: block.headers, ...separateQuotedContent(block.body),
  })) : [] };
}
function threadEvidence(comment) {
  let saved = null;
  try { saved = JSON.parse(comment.threadingMetadata || 'null'); } catch {}
  return { reason: saved?.reason || 'historical_unknown',
    matchedMessageId: saved?.matchedMessageId || null,
    correctedFromTicketId: saved?.correctedFromTicketId || null,
    messageId: comment.internetMessageId || comment.graphMessageId || null };
}
function messageType(comment, requesterEmail, staff) {
  if (comment.isInternal) return 'internal';
  if (comment.authorAgentId) return 'agent';
  const email = String(comment.authorEmail || '').trim().toLowerCase();
  if (email && email === String(requesterEmail || '').trim().toLowerCase()) return 'requester';
  return staff.has(email) ? 'agent' : 'participant';
}
async function describe(ticket, actor, snapshotAt = new Date(), client = prisma) {
  const [read, agents] = await Promise.all([
    client.ticketConversationRead.findUnique({ where: { ticketId_agentId: { ticketId: ticket.id, agentId: actor.id } } }),
    client.agent.findMany({ select: { email: true } }),
  ]);
  const staff = new Set(agents.map(agent => agent.email.trim().toLowerCase()));
  const comments = (ticket.comments || []).map(comment => {
    const type = messageType(comment, ticket.requesterEmail, staff);
    const unread = ['requester', 'participant'].includes(type) &&
      (!read || new Date(comment.linkedAt) > read.lastReadAt);
    const { threadingMetadata, ...safe } = comment;
    return { ...safe, messageType: type, unread, displayMessage: comment.viaEmail ? displayMessage(comment.body)
      : { cleanBody: comment.body, quotedText: null, signature: null },
      ...(actor.role === 'admin' && comment.viaEmail ? { threading: threadEvidence(comment), canMoveThread: true } : {}) };
  });
  const last = comments.filter(comment => !comment.isInternal).sort((a, b) => new Date(a.linkedAt) - new Date(b.linkedAt) || a.id - b.id).at(-1);
  const awaiting = ticket.state === 'CLOSED' ? 'closed' : ticket.state === 'RESOLVED' ? 'confirmation'
    : last?.messageType === 'agent' ? 'requester' : 'agent';
  return { originalMessage: displayMessage(ticket.body), comments,
    conversation: { awaiting, snapshotAt: snapshotAt.toISOString(),
      unreadIds: comments.filter(comment => comment.unread).map(comment => comment.id),
      lastReadAt: read?.lastReadAt?.toISOString() || null,
      ...(actor.role === 'admin' ? { originalThreading: {
        messageId: ticket.internetMessageId || ticket.graphMessageId || null,
        reason: 'original_ticket',
      } } : {}) } };
}
async function markRead(ticketId, agentId, through, client = prisma) {
  const at = new Date(through);
  if (!Number.isFinite(at.getTime()) || at > new Date()) {
    const error = new Error('A valid conversation snapshot time is required'); error.status = 400; throw error;
  }
  // A late request from another tab can never move the read cursor backwards.
  await client.$executeRaw`INSERT INTO "TicketConversationRead" ("ticketId", "agentId", "lastReadAt")
    VALUES (${ticketId}, ${agentId}, ${at}) ON CONFLICT ("ticketId", "agentId")
    DO UPDATE SET "lastReadAt" = GREATEST("TicketConversationRead"."lastReadAt", EXCLUDED."lastReadAt")`;
  return { ok: true };
}
async function moveReply({ ticketId, commentId, targetTicketNumber, note, actor }, client = prisma) {
  function reject(status, message) { const error = new Error(message); error.status = status; throw error; }
  if (actor?.role !== 'admin') reject(403, 'Only administrators can correct email threading');
  if (!String(note || '').trim() || String(note).length > 1000) reject(400, 'Explain the correction in 1–1000 characters');
  const target = await client.ticket.findUnique({ where: { ticketNumber: String(targetTicketNumber || '').trim() } });
  if (!target) reject(404, 'Destination ticket not found');
  if (target.id === ticketId) reject(400, 'Choose a different ticket');
  return client.$transaction(async tx => {
    const ids = [ticketId, target.id].sort((a, b) => a - b);
    await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" IN (${ids[0]}, ${ids[1]}) ORDER BY "id" FOR UPDATE`;
    const [source, destination, comment] = await Promise.all([
      tx.ticket.findUnique({ where: { id: ticketId } }),
      tx.ticket.findUnique({ where: { id: target.id } }),
      tx.comment.findUnique({ where: { id: commentId } }),
    ]);
    if (!source || !destination) reject(404, 'Ticket not found');
    if (!['NEW', 'IN_PROGRESS'].includes(destination.state)) reject(400, 'Destination must be an open ticket');
    if (!comment || comment.ticketId !== ticketId) reject(409, 'This reply has moved — refresh the ticket');
    if (!comment.viaEmail || comment.isInternal) reject(400, 'Only received email replies can be moved');
    const prior = threadEvidence(comment);
    const at = new Date();
    const moved = await tx.comment.updateMany({ where: { id: commentId, ticketId }, data: {
      ticketId: target.id, linkedAt: at,
      threadingMetadata: JSON.stringify({ ...prior, reason: 'manual_correction', correctedFromTicketId: ticketId }),
    } });
    if (!moved.count) reject(409, 'This reply changed — refresh and try again');
    await tx.attachment.updateMany({ where: { commentId, ticketId }, data: { ticketId: target.id } });
    for (const current of [source, destination]) {
      await tx.ticket.update({ where: { id: current.id }, data: { updatedAt: at } });
      const explanation = `Email reply ${commentId} moved from ${source.ticketNumber} to ${destination.ticketNumber}: ${note.trim()}`;
      await tx.ticketAuditLog.create({ data: { ticketId: current.id, fromState: current.state,
        toState: current.state, actor: `${actor.name} <${actor.email}>`, note: explanation } });
      await audit.record(tx, { action: 'ticket.thread_corrected', entityType: 'Ticket', entityId: current.id,
        entityLabel: current.ticketNumber, ticketId: current.id, actor, description: explanation,
        metadata: { commentId, sourceTicketId: ticketId, targetTicketId: target.id, note: note.trim() } });
    }
    return { ok: true, targetTicketId: target.id, targetTicketNumber: destination.ticketNumber };
  }, { timeout: 20000 });
}
module.exports = { displayMessage, messageType, threadEvidence, describe, markRead, moveReply };
