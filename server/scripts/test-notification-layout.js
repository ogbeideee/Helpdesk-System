// Pure presentation checks: never connect to a database or send real email.
const assert = require('assert/strict');
const { decorateMail } = require('../src/email/notificationLayout');
const { createMailer } = require('../src/mailer');
const { statusUpdateMail } = require('../src/email/outbound');

async function main() {
  const sent = [];
  const mailer = createMailer({ transport: {
    hasBroadcastTarget: () => true,
    broadcastTarget: () => 'team@example.com',
    sendMail: async mail => sent.push(mail),
    sendBroadcastMail: async mail => sent.push(mail),
  } });
  const ticket = {
    ticketNumber: 'INC-123456', shortDescription: 'Excel <script>bad</script>',
    body: '<img src=x onerror=bad>', requesterName: 'Requester',
    requesterEmail: 'requester@example.com', state: 'NEW', category: 'Software',
    priority: 'moderate', team: { name: 'Support' },
    assignedAgent: { email: 'agent@example.com' },
  };
  await mailer.notifyNewTicketToDl(ticket);
  await mailer.notifyRequesterAck(ticket);
  await mailer.notifyAssignment(ticket, { name: 'Agent', email: 'agent@example.com' });
  await mailer.notifyStatusChanged({ ...ticket, state: 'IN_PROGRESS' });
  await mailer.notifyAgentReply(ticket, { agentName: 'Agent', body: '<script>bad</script>' });
  await mailer.notifyReplyReceived(ticket, { fromName: 'Requester' });
  await mailer.notifyReplyReceived(ticket, { fromName: 'Requester', reopened: true });
  for (const subject of ['Ticket reassigned', 'Handover accepted', 'Daily report', 'Email ingestion stalled']) {
    await mailer.sendMailSafe({ subject, body: 'Operational update', toRecipients: [] });
  }
  assert.equal(sent.length, 9, 'received reply/reopen alerts must not send');
  for (const mail of sent) {
    assert(mail.html.includes('IT Helpdesk'));
    assert(mail.html.includes('<table'));
    assert(mail.body);
    assert(!mail.html.includes('<script>'));
    assert(!mail.html.includes('<img'));
    assert(!mail.html.includes('href='));
  }
  assert(sent[2].html.includes('Assigned to you'));
  assert(sent[2].html.includes('INC-123456'));
  assert(!sent[7].html.includes('Reply directly'));
  const warning = decorateMail({ subject: '[INC-123456] Resolution SLA approaching breach: Excel', body: 'Due:    Tomorrow\r\nRemaining:    6 hours' });
  assert(warning.html.includes('#b45309'));
  assert(warning.html.includes('scope="row"'));
  assert(warning.html.includes('6 hours'));
  const breach = decorateMail({ subject: '[INC-123456] Response SLA breached: Excel', body: 'Target passed' });
  assert(breach.html.includes('#b91c1c'));
  const resolve = statusUpdateMail({ ...ticket, state: 'RESOLVED', resolution: '<script>fixed</script>' }, { confirmUrl: 'https://example.com/#/confirm/test' });
  assert(resolve.html.includes('href="https://example.com/#/confirm/test"'));
  assert(!resolve.html.includes('<script>'));
  assert.equal(decorateMail(resolve).html, resolve.html);
  assert.equal(warning.body, 'Due:    Tomorrow\r\nRemaining:    6 hours');
  const fullWarning = decorateMail({subject:'[INC-123456] Resolution SLA approaching breach: Excel',body:'Please review this ticket.\r\n\r\nTicket: INC-123456\r\nSubject: Excel\r\nState: New\r\nSLA: 24 working hours\r\nStatus: Approaching breach\r\nDue: Tomorrow\r\nRemaining: 6 hours\r\n\r\n--\r\nIT Helpdesk — TicketDesk\r\nReply directly to this email to add information to the ticket.'});
  assert(fullWarning.html.includes('scope="row"'));
  assert(fullWarning.html.indexOf('>Remaining</th>') < fullWarning.html.indexOf('>Subject</th>'));
  assert(!fullWarning.html.includes('>Status</th>'));
  const previousBase = process.env.PORTAL_BASE_URL;
  try {
    process.env.PORTAL_BASE_URL = 'https://example.com/support/';
    const { assignmentMail } = require('../src/email/outbound');
    const assignment = assignmentMail({ ...ticket, id: 42 }, { name: 'Agent', email: 'agent@example.com' });
    assert(assignment.html.includes('Message preview</p><blockquote'));
    assert(assignment.html.includes('&lt;img src=x onerror=bad&gt;'));
    assert(assignment.html.includes('>Open ticket</a>'));
    assert(!assignment.html.includes('Open ticket: https://'));
    assert(assignment.body.includes('Open ticket: https://example.com/support/#/tickets/42'));
    assert(assignment.body.includes('Excerpt:'));
    const branded = decorateMail({ subject: '[INC-123456] Resolution SLA approaching breach: Excel', body: 'Due: Tomorrow' });
    assert(branded.html.includes('src="https://example.com/support/email-assets/bestaf-logo.png"'));
    assert(branded.html.includes('alt="BESTAF Technologies"'));
    assert(branded.html.includes('Resolution deadline approaching'));
    assert(branded.html.includes('width="60" height="64"'));
    process.env.PORTAL_BASE_URL = 'https://user:private@example.com/';
    assert(!decorateMail({ subject: 'Update', body: 'Safe text' }).html.includes('<img'));
  } finally {
    if (previousBase === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = previousBase;
  }
  console.log('All notification layout checks passed (delivery paths, escaping, SLA tones, confirmation link, text alternative).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
