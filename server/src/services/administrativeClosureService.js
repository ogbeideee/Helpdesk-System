const prisma = require('../lib/prisma');
const auditService = require('./auditService');
const slaService = require('../slaService');
const handoverService = require('./handoverService');
const notifications = require('../mailer');
const { OPEN_STATES } = require('../states');

// Explicit administrator override for unfinished work. Normal lifecycle
// transitions and requester confirmation keep their existing rules.
async function closeOpenTicket(ticket, { agent, note, include }) {
  if (agent?.role !== 'admin') {
    return { status: 403, error: 'Only an administrator can close an unresolved ticket' };
  }
  if (!OPEN_STATES.includes(ticket.state)) {
    return { status: 400, error: 'Administrative closure requires a New or In Progress ticket' };
  }
  const text = String(note || '').trim();
  if (!text) return { status: 400, error: 'A note is required for administrative closure' };
  const actor = `${agent.name} <${agent.email}>`;
  const at = new Date();
  const policy = await slaService.loadSlaPolicy();
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.ticket.updateMany({
      where: { id: ticket.id, state: ticket.state, assignedAgentId: ticket.assignedAgentId },
      data: { state: 'CLOSED', closedAt: at },
    });
    if (!changed.count) return null;
    await tx.ticketAuditLog.create({ data: {
      ticketId: ticket.id, fromState: ticket.state, toState: 'CLOSED', actor, note: text,
    } });
    await auditService.record(tx, {
      action: 'ticket.closed', entityType: 'Ticket', entityId: ticket.id,
      entityLabel: ticket.ticketNumber, ticketId: ticket.id, actor: agent,
      from: { state: ticket.state }, to: { state: 'CLOSED' },
      description: `${ticket.ticketNumber} administratively closed without resolution by ${agent.name}`,
      metadata: { via: 'administrative_close', note: text },
    });
    await slaService.finalizeOpenCycle(ticket, { at, actor, client: tx, policy });
    return tx.ticket.findUnique({ where: { id: ticket.id }, include });
  }, { timeout: 20000 });
  if (!updated) return { status: 409, error: 'Ticket changed while closing — refresh and try again' };
  await handoverService.cancelForTicket(ticket.id, actor, 'Ticket was administratively closed');
  notifications.notifyStatusChanged(updated, { previousState: ticket.state }).catch(() => {});
  return { status: 200, ticket: updated };
}

module.exports = { closeOpenTicket };
