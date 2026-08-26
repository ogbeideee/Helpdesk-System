// Email notifications. Uses Microsoft Graph when configured, otherwise logs
// to the console so the system runs end-to-end without Azure credentials.
// All builders go through a small factory so callers (and tests) can inject
// an alternative transport.
const { graphConfig } = require('./graph/config');

const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '');

function consoleTransport(logger = console) {
  return {
    // Development mode always renders the DL alert so the flow is observable
    // without Azure credentials — nothing is actually sent.
    hasBroadcastTarget: () => true,
    async markAsRead() {},
    async sendBroadcastMail(mail) {
      logger.log(
        renderDevNotification({
          kind: 'NEW TICKET NOTIFICATION',
          to: graphConfig.broadcastDl || 'IT Helpdesk DL (GRAPH_BROADCAST_DL not set)',
          mail,
        })
      );
    },
    async sendMail(mail) {
      logger.log(
        renderDevNotification({
          kind: 'EMAIL NOTIFICATION',
          to: recipientsOf(mail),
          mail,
        })
      );
    },
  };
}

// Development-mode rendering of a notification that WOULD have been sent.
// Microsoft Graph replaces this transport later — nothing else changes.
function renderDevNotification({ kind, to, mail }) {
  const lines = [
    '='.repeat(60),
    kind,
    `To: ${to}`,
    '',
    'Subject:',
    mail.subject,
    '',
    ...String(mail.body || '').split('\r\n'),
    '='.repeat(60),
  ];
  return lines.join('\n');
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

function getDefaultTransport() {
  if (!graphConfig.enabled) return consoleTransport();
  // Lazy require so the Graph SDK/MSAL never loads when integration is off.
  const { graphOps } = require('./graph/graphClient');
  return graphOps;
}

function toRecipient(address) {
  return { emailAddress: { address } };
}

function excerpt(text, max = 600) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function stateLabel(state) {
  return String(state || '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function requesterDisplay(ticket) {
  return ticket.requesterName
    ? `${ticket.requesterName} <${ticket.requesterEmail}>`
    : ticket.requesterEmail;
}

function ticketLink(ticket) {
  return PORTAL_BASE_URL ? `${PORTAL_BASE_URL}/tickets/${ticket.id}` : null;
}

function footer(ticket) {
  const lines = ['', '--', 'IT Helpdesk — TicketDesk', `Ticket: ${ticket.ticketNumber}`];
  const link = ticketLink(ticket);
  if (link) lines.push(`View in portal: ${link}`);
  lines.push('Reply directly to this email to add information to the ticket.');
  return lines.join('\r\n');
}

function slaLine(ticket) {
  if (!ticket.dueAt) return '';
  const due = new Date(ticket.dueAt);
  return `\r\nTarget resolution: ${due.toUTCString()} (${ticket.priority} priority)`;
}

/**
 * Create a mailer bound to a specific transport + broadcast-target policy.
 * Called with no arguments it resolves Graph-or-console automatically.
 */
function createMailer(options = {}) {
  const logger = options.logger || console;
  const transport = options.transport || getDefaultTransport();

  async function sendMailSafe(mail) {
    try {
      await transport.sendMail(mail);
      return true;
    } catch (err) {
      logger.error(`[mailer] send failed ("${mail.subject}"): ${err.message}`);
      return false;
    }
  }

  /** New-ticket broadcast to the IT team distribution list. */
  async function notifyNewTicketToDl(ticket) {
    const wantsBroadcast =
      typeof transport.hasBroadcastTarget === 'function'
        ? transport.hasBroadcastTarget()
        : Boolean(graphConfig.broadcastDl);
    if (!wantsBroadcast) {
      logger.log('[mailer] no broadcast target (GRAPH_BROADCAST_DL unset) — skipping team alert');
      return false;
    }
    try {
      await transport.sendBroadcastMail({
        subject: `[${ticket.ticketNumber}] ${ticket.category}: ${ticket.shortDescription}`,
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
          footer(ticket),
        ].join('\r\n'),
      });
      return true;
    } catch (err) {
      logger.error(`[mailer] broadcast failed for ${ticket.ticketNumber}: ${err.message}`);
      return false;
    }
  }

  /** Confirmation to the requester when their ticket is created. */
  async function notifyRequesterAck(ticket) {
    if (!ticket.requesterEmail) return false;
    return sendMailSafe({
      subject: `[${ticket.ticketNumber}] We received your request`,
      body: [
        `Hi ${ticket.requesterName || 'there'},`,
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
        footer(ticket),
      ].join('\r\n'),
      toRecipients: [toRecipient(ticket.requesterEmail)],
    });
  }

  /** Assignment notice to the assigned agent. */
  async function notifyAssignment(ticket, agent) {
    if (!agent || !agent.email) return false;
    return sendMailSafe({
      subject: `[${ticket.ticketNumber}] Assigned to you: ${ticket.shortDescription}`,
      body: [
        `Hi ${agent.name},`,
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
        footer(ticket),
      ].join('\r\n'),
      toRecipients: [toRecipient(agent.email)],
    });
  }

  /** Status change updates to the requester (includes resolution notes). */
  async function notifyStatusChanged(ticket, context = {}) {
    if (!ticket.requesterEmail) return false;
    const previousState = context.previousState;
    const resolved = ticket.state === 'RESOLVED';
    const subject = resolved
      ? `[${ticket.ticketNumber}] Resolved: ${ticket.shortDescription}`
      : `[${ticket.ticketNumber}] Status update: ${stateLabel(ticket.state)}`;
    const body = [
      `Hi ${ticket.requesterName || 'there'},`,
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
    body.push(footer(ticket));
    return sendMailSafe({
      subject,
      body: body.join('\r\n'),
      toRecipients: [toRecipient(ticket.requesterEmail)],
    });
  }

  /** Alert to the assigned agent (or DL fallback) on requester replies/reopens. */
  async function notifyReplyReceived(ticket, context = {}) {
    const targets = [];
    if (ticket.assignedAgent && ticket.assignedAgent.email) {
      targets.push(ticket.assignedAgent.email);
    }
    if (!targets.length && graphConfig.broadcastDl) targets.push(graphConfig.broadcastDl);
    if (!targets.length) return false;
    const reopened = Boolean(context.reopened);
    return sendMailSafe({
      subject: `[${ticket.ticketNumber}] ${reopened ? 'Reopened' : 'New reply'}: ${ticket.shortDescription}`,
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
        footer(ticket),
      ].join('\r\n'),
      toRecipients: targets.map(toRecipient),
    });
  }

  return {
    transport,
    sendMailSafe,
    notifyNewTicketToDl,
    notifyRequesterAck,
    notifyAssignment,
    notifyStatusChanged,
    notifyReplyReceived,
  };
}

// Default instance bound to Graph/console for API-route usage.
const mailer = createMailer();

module.exports = { createMailer, ...mailer };
