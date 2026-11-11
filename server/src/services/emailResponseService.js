// Only a non-empty received reply from a currently active staff account can
// stop an open ticket's response clock. Requester identity takes precedence.
const { separateQuotedContent } = require('../email/emailParser');
async function recordEmailResponse(ticket, message, comment, client) {
  const email = String(message.requesterEmail || '').trim().toLowerCase();
  if (require('./intakeScreening').screenHeaders(message)) return;
  if (!['NEW', 'IN_PROGRESS'].includes(ticket.state) || !email ||
    email === String(ticket.requesterEmail || '').trim().toLowerCase() ||
    !separateQuotedContent(message.body || '').cleanBody?.trim()) return;
  const staff = await client.agent.findFirst({ where: { email: { equals: email, mode: 'insensitive' },
    isActive: true, role: { in: ['agent', 'admin'] } }, select: { id: true, name: true } });
  if (!staff) return;
  await require('../slaService').recordFirstResponse(ticket, { client, at: comment.createdAt,
    responderId: staff.id, actor: `email:${staff.id}` });
}
module.exports = { recordEmailResponse };
