// Outbound email assembly — the application-generated email layer.
//
// Inbound and outbound email meet in this package but never mix:
//   - Inbound:  graph/* -> emailParser -> emailIngestion -> ticketIntake
//   - Outbound: THIS MODULE assembles, src/mailer.js sends
//
// This module owns WHAT application-generated emails say and WHO may receive
// them. It never sends and never touches a transport: every builder is a pure
// function from ticket/requester/agent data to the mailer's mail shape
// ({ subject, body, toRecipients }), so tests can assert on exact content
// with no transport at all. src/mailer.js stays the only place that talks to
// Graph (or the console fallback), wrapping these builders in sendMailSafe.
//
// Recipient classes, explicit per builder:
//   - REQUESTER mails (ticketAcknowledgementMail, statusUpdateMail,
//     agentReplyMail) go ONLY to ticket.requesterEmail and return null when
//     the ticket has none — a requester mail without a requester is never
//     assembled. They are built from ticket fields and, at most, an agent's
//     NAME: never internal notes, audit metadata, credentials or any other
//     helpdesk-internal context.
//   - INTERNAL mails (newTicketBroadcastMail, assignmentMail, replyAlertMail)
//     go to agents and the team distribution list, never to the requester.
// SLA alerts (slaNotifier.js) and scheduled reports (reportScheduler.js)
// assemble their own wording but reuse the shared formatting here and send
// through the same mailer; both are internal-only.
const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Shared formatting — the single source of the email conventions      */
/* ------------------------------------------------------------------ */

/** `[TK-123] text` — the one place the ticket-subject convention lives. */
function ticketSubject(ticket, text) {
  return `[${ticket.ticketNumber}] ${text}`;
}

function toRecipient(address) {
  return { emailAddress: { address } };
}

function recipientsOf(mail) {
  const addrs = [];
  for (const key of ['toRecipients', 'ccRecipients']) {
    for (const r of mail[key] || []) {
      if (r.emailAddress && r.emailAddress.address) addrs.push(r.emailAddress.address);
    }
  }
  return addrs.join(', ') || '(none)';
}

function portalLink(ticket) {
  return PORTAL_BASE_URL ? `${PORTAL_BASE_URL}/tickets/${ticket.id}` : null;
}

function stateLabel(state) {
  return String(state || '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function greeting(name) {
  return `Hi ${name || 'there'},`;
}

function requesterDisplay(ticket) {
  return ticket.requesterName
    ? `${ticket.requesterName} <${ticket.requesterEmail}>`
    : ticket.requesterEmail;
}

function excerpt(text, max = 600) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function slaLine(ticket) {
  if (!ticket.dueAt) return '';
  const due = new Date(ticket.dueAt);
  return `\r\nTarget resolution: ${due.toUTCString()} (${ticket.priority} priority)`;
}

function ticketFooter(ticket) {
  const lines = ['', '--', 'IT Helpdesk — TicketDesk', `Ticket: ${ticket.ticketNumber}`];
  const link = portalLink(ticket);
  if (link) lines.push(`View in portal: ${link}`);
  lines.push('Reply directly to this email to add information to the ticket.');
  return lines.join('\r\n');
}

/* ------------------------------------------------------------------ */
/* Message builders — one per notification type, pure, no sending      */
/* ------------------------------------------------------------------ */

/**
 * INTERNAL — new-ticket alert to the IT team distribution list. The mailer
 * decides whether a broadcast target exists and sends via sendBroadcastMail;
 * this only assembles the wording.
 */
function newTicketBroadcastMail(ticket) {
  return {
    subject: ticketSubject(ticket, `${ticket.category}: ${ticket.shortDescription}`),
    body: [
      'New ticket received.',
      '',
      `Ticket:     ${ticket.ticketNumber}`,
      `Requester:  ${requesterDisplay(ticket)}`,
      `Category:   ${ticket.category}`,
      `Priority:   ${ticket.priority}`,
      `Team:       ${ticket.team ? ticket.team.name : 'Unassigned (triage)'}`,
      `Assigned:   ${ticket.assignedAgent ? `${ticket.assignedAgent.name} <${ticket.assignedAgent.email}>` : 'pending'}`,
      slaLine(ticket),
      '',
      `Subject: ${ticket.shortDescription}`,
      'Excerpt:',
      `> ${excerpt(ticket.body, 240)}`,
      '',
      ticket.assignedAgent
        ? 'Assigned automatically — please pick it up in TicketDesk.'
        : 'Assignment is pending — please claim this ticket in TicketDesk.',
      ticketFooter(ticket),
    ].join('\r\n'),
  };
}

/**
 * REQUESTER — confirmation when their ticket is created. Returns null when
 * the ticket has no requester email (nothing to send to).
 */
function ticketAcknowledgementMail(ticket) {
  if (!ticket.requesterEmail) return null;
  return {
    subject: ticketSubject(ticket, 'We received your request'),
    body: [
      greeting(ticket.requesterName),
      '',
      'Your request has been logged with the IT Helpdesk.',
      '',
      `Ticket:    ${ticket.ticketNumber}`,
      `Subject:   ${ticket.shortDescription}`,
      `Priority:  ${ticket.priority}`,
      slaLine(ticket),
      '',
      'You will receive updates as we work on it. To add information,',
      'simply reply to this email — your message is attached to the ticket.',
      ticketFooter(ticket),
    ].join('\r\n'),
    toRecipients: [toRecipient(ticket.requesterEmail)],
  };
}

/**
 * INTERNAL — assignment notice to the assigned agent. Returns null when
 * there is no agent or the agent has no email address.
 */
function assignmentMail(ticket, agent) {
  if (!agent || !agent.email) return null;
  return {
    subject: ticketSubject(ticket, `Assigned to you: ${ticket.shortDescription}`),
    body: [
      greeting(agent.name),
      '',
      `Ticket ${ticket.ticketNumber} has been routed to your team (${ticket.team ? ticket.team.name : 'n/a'}) and assigned to you.`,
      '',
      `Requester:  ${requesterDisplay(ticket)}`,
      `Category:   ${ticket.category}`,
      `Priority:   ${ticket.priority}`,
      slaLine(ticket),
      '',
      `Subject: ${ticket.shortDescription}`,
      'Excerpt:',
      `> ${excerpt(ticket.body, 240)}`,
      ticketFooter(ticket),
    ].join('\r\n'),
    toRecipients: [toRecipient(agent.email)],
  };
}

/**
 * REQUESTER — status-change update (carries the resolution note on RESOLVED).
 * Returns null when the ticket has no requester email.
 */
function statusUpdateMail(ticket, context = {}) {
  if (!ticket.requesterEmail) return null;
  const previousState = context.previousState;
  const resolved = ticket.state === 'RESOLVED';
  const subject = resolved
    ? ticketSubject(ticket, `Resolved: ${ticket.shortDescription}`)
    : ticketSubject(ticket, `Status update: ${stateLabel(ticket.state)}`);
  const body = [
    greeting(ticket.requesterName),
    '',
    `Your ticket ${ticket.ticketNumber} ("${ticket.shortDescription}") status changed:`,
    `${previousState ? `${stateLabel(previousState)} -> ` : ''}${stateLabel(ticket.state)}.`,
  ];
  if (resolved && ticket.resolution) {
    body.push('', 'Resolution:', `> ${ticket.resolution}`);
  }
  if (resolved) {
    body.push(
      '',
      'If this resolves your issue, no action is needed — the ticket',
      'will be closed after confirmation. If you still need help,',
      'reply to this email and the ticket will reopen.'
    );
  }
  body.push(ticketFooter(ticket));
  return {
    subject,
    body: body.join('\r\n'),
    toRecipients: [toRecipient(ticket.requesterEmail)],
  };
}

/**
 * REQUESTER — a public agent reply on the ticket, quoted for the requester.
 * Internal notes never reach this builder: it is only wired to the public
 * path in the notes route. Returns null when there is no requester email.
 */
function agentReplyMail({ ticket, agentName, body }) {
  if (!ticket.requesterEmail) return null;
  const subject = ['RESOLVED', 'CLOSED'].includes(ticket.state)
    ? ticketSubject(ticket, 'Update on your request')
    : ticketSubject(ticket, 'New message about your request');
  return {
    subject,
    body: [
      greeting(ticket.requesterName),
      '',
      `${agentName} from the IT Helpdesk wrote:`,
      '',
      ...String(body || '').split('\n').map((l) => `> ${l}`),
      '',
      '--',
      `IT Helpdesk — Ticket ${ticket.ticketNumber}`,
    ].join('\r\n'),
    toRecipients: [toRecipient(ticket.requesterEmail)],
  };
}

/**
 * INTERNAL — alert to the assigned agent (or the DL fallback, chosen by the
 * mailer) when a requester replies or reopens. Returns only subject and body:
 * the recipient policy (assignee first, DL fallback) is the mailer's, because
 * it depends on the transport configuration.
 */
function replyAlertMail(ticket, context = {}) {
  const reopened = Boolean(context.reopened);
  return {
    subject: ticketSubject(ticket, `${reopened ? 'Reopened' : 'New reply'}: ${ticket.shortDescription}`),
    body: [
      reopened
        ? 'The requester replied on a resolved/closed ticket — it has been reopened.'
        : 'The requester added a reply to this ticket.',
      '',
      `Ticket:    ${ticket.ticketNumber}`,
      `From:      ${context.fromName || ticket.requesterEmail}`,
      `State:     ${stateLabel(ticket.state)}${reopened ? ' (reopened)' : ''}`,
      '',
      'See the portal conversation view for the full thread.',
      ticketFooter(ticket),
    ].join('\r\n'),
  };
}

module.exports = {
  // shared formatting
  ticketSubject,
  toRecipient,
  recipientsOf,
  portalLink,
  stateLabel,
  greeting,
  requesterDisplay,
  excerpt,
  slaLine,
  ticketFooter,
  // message builders
  newTicketBroadcastMail,
  ticketAcknowledgementMail,
  assignmentMail,
  statusUpdateMail,
  agentReplyMail,
  replyAlertMail,
};
