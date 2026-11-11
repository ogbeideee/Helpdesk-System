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
// with no transport at all. src/mailer.js stays the only place that talks to a
// transport (Graph, SMTP or the console fallback), wrapping these builders in
// sendMailSafe.
//
// Assignment notices link agents to the authenticated ticket page. Requester
// mail stays link-free except for the signed resolution confirmation.
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

/**
 * Escape text for interpolation into an HTML body. Every value that reaches
 * the renderer passes through here: a ticket subject is user input, and an
 * unescaped `&` or `<` would let a requester inject markup into a mail that an
 * agent reads.
 */
function htmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The HTML shell every requester mail shares. Inline styles only — Outlook and
 * Gmail both strip a <style> block in some contexts, and a mail that loses its
 * formatting is worse than a mail that never had any. A plain-text alternative
 * is always sent alongside, so a client that refuses the HTML still reads well.
 */
function htmlShell(inner, options) {
  return require('./notificationLayout').notificationShell(inner, options);
}

/** A bolded `Label: value` fact, the shape the requester mails read as data. */
function htmlFact(label, value) {
  return `<div style="margin:4px 0;">
      <span style="font-weight:600;color:#4b5563;">${htmlEscape(label)}</span>
      <span style="color:#1f2430;">${htmlEscape(value)}</span>
    </div>`;
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

/**
 * The footer every notification carries. Deliberately link-free: a requester has
 * no portal account (their account may be the very thing that is broken).
 * Assignment links are added explicitly by that builder, not by this footer.
 */
function ticketFooter(ticket) {
  const lines = ['', '--', 'IT Helpdesk — TicketDesk', `Ticket: ${ticket.ticketNumber}`];
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
 *
 * Deliberately no priority and no target resolution date: those are the
 * helpdesk's internal triage decisions, and a requester reading "high
 * priority" or a date they have never heard of invites questions the
 * acknowledgement cannot answer. If they need timing, they ask.
 */
function ticketAcknowledgementMail(ticket) {
  if (!ticket.requesterEmail) return null;
  const html = htmlShell(`
    <p style="margin:0 0 14px;font-size:16px;font-weight:600;">${htmlEscape(greeting(ticket.requesterName))}</p>
    <p style="margin:0 0 16px;">Your request has been logged. Our IT team will review it and keep you updated.</p>
    <div style="margin:0 0 18px;padding:12px 14px;background:#ffffff;border:1px solid #e4e7ec;border-radius:6px;">
      ${htmlFact('Subject:', ticket.shortDescription)}
    </div>
    <p style="margin:0;">Keep this email for your ticket reference.</p>`, { title: 'We received your request', ticketNumber: ticket.ticketNumber });
  return {
    subject: ticketSubject(ticket, 'We received your request'),
    body: [
      greeting(ticket.requesterName),
      '',
      'Your request has been logged. Our IT team will review it and keep you updated.',
      '',
      `Ticket:    ${ticket.ticketNumber}`,
      `Subject:   ${ticket.shortDescription}`,
      '',
      'Keep this email for your ticket reference.',
      ticketFooter(ticket),
    ].filter((l) => l !== null).join('\r\n'),
    html,
    toRecipients: [toRecipient(ticket.requesterEmail)],
  };
}

/**
 * INTERNAL — assignment notice to the assigned agent. Returns null when
 * there is no agent or the agent has no email address.
 */
function assignmentMail(ticket, agent) {
  if (!agent || !agent.email) return null;
  let ticketUrl = '';
  try {
    const base = new URL(process.env.PORTAL_BASE_URL || '');
    if (['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && Number.isSafeInteger(ticket.id) && ticket.id > 0) {
      base.search = '';
      base.hash = '';
      base.pathname = base.pathname.replace(/\/+$/, '') + '/';
      base.hash = `/tickets/${ticket.id}`;
      ticketUrl = base.toString();
    }
  } catch { /* Unconfigured or malformed base: keep a usable unlinked notice. */ }
  const mail = {
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
      ...(ticketUrl ? ['', `Open ticket: ${ticketUrl}`] : []),
      ticketFooter(ticket),
    ].join('\r\n'),
    toRecipients: [toRecipient(agent.email)],
  };
  return require('./notificationLayout').decorateMail(mail, { ticketNumber: ticket.ticketNumber, ticketUrl });
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
  // The resolve mail is the ONE email that carries a link — the deliberate
  // exception to the no-links rule. The confirmation page it opens is
  // two-step (the page shows the ticket; a button closes it), so a mail
  // scanner that prefetches the URL cannot close anything: only the POST
  // from the page does.
  const confirmLink = typeof context.confirmUrl === 'string' ? context.confirmUrl : null;
  if (resolved) {
    body.push(
      '',
      'Was your issue resolved?',
    );
    if (confirmLink) {
      body.push(
        `Yes — confirm here: ${confirmLink}`,
        '',
        'If the link does not work, reply to this email and the ticket',
        'will reopen so we can take another look.',
      );
    } else {
      body.push(
        'If this resolves your issue, no action is needed — the ticket',
        'will be closed after confirmation. If you still need help,',
        'reply to this email and the ticket will reopen.'
      );
    }
  }
  body.push(ticketFooter(ticket));
  const resolutionHtml =
    resolved && ticket.resolution
      ? `<div style="margin:14px 0;padding:12px 14px;background:#ffffff;border:1px solid #e4e7ec;border-radius:6px;">
           <div style="font-weight:600;color:#4b5563;margin-bottom:6px;">Resolution</div>
           <div style="color:#1f2430;">${htmlEscape(ticket.resolution).replace(/\r?\n/g, '<br>')}</div>
         </div>`
      : '';
  const closingHtml = resolved
    ? (confirmLink
      ? `<p style="margin:0 0 10px;">Was your issue resolved?</p>
         <p style="margin:0 0 10px;"><a href="${htmlEscape(confirmLink)}"
            style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;
                   text-decoration:none;border-radius:6px;font-weight:600;">Yes, it&apos;s resolved &mdash; close my ticket</a></p>
         <p style="margin:0;color:#6b7280;">If the link does not work, reply to this email and the
            ticket will reopen so we can take another look.</p>`
      : `<p style="margin:0;">If this resolves your issue, no action is needed &mdash; the ticket
        will be closed after confirmation. If you still need help, reply to this email
        and the ticket will reopen.</p>`)
    : '';
  const html = htmlShell(`
    <p style="margin:0 0 14px;font-size:16px;font-weight:600;">${htmlEscape(greeting(ticket.requesterName))}</p>
    <p style="margin:0 0 6px;">Your ticket <strong>${htmlEscape(ticket.ticketNumber)}</strong>
       (<strong>${htmlEscape(ticket.shortDescription)}</strong>) status changed:</p>
    <p style="margin:0 0 16px;">${previousState ? `${htmlEscape(stateLabel(previousState))} &rarr; ` : ''}${htmlEscape(stateLabel(ticket.state))}.</p>
    ${resolutionHtml}
    ${closingHtml}`, { title: resolved ? 'Your ticket is resolved' : `Status update: ${stateLabel(ticket.state)}`, ticketNumber: ticket.ticketNumber });
  return {
    subject,
    body: body.join('\r\n'),
    html,
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
  const quotedHtml = String(body || '')
    .split('\n')
    .map(
      (l) =>
        `<div style="margin:0;color:#243247;">${htmlEscape(l) || '&nbsp;'}</div>`
    )
    .join('');
  const html = htmlShell(`
    <p style="margin:0 0 14px;font-size:16px;font-weight:600;">${htmlEscape(greeting(ticket.requesterName))}</p>
    <p style="margin:0 0 18px;color:#64748b;"><strong>${htmlEscape(agentName)}</strong> from IT Helpdesk</p>
    <div style="margin:0 0 6px;line-height:1.7;">${quotedHtml}</div>`, { title: 'An update from your IT team', ticketNumber: ticket.ticketNumber });
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
    html,
    toRecipients: [toRecipient(ticket.requesterEmail)],
  };
}

/**
 * Legacy reply-alert shape, retained for identifying older queued alerts and
 * regression fixtures. The active mailer never sends this notification.
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
  htmlEscape,
  // shared formatting
  ticketSubject,
  toRecipient,
  recipientsOf,

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
