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
  assert.equal(sent.length, 11);
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
  assert(sent[5].html.includes('Requester'));
  assert(!sent[9].html.includes('Reply directly'));
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
  console.log('All notification layout checks passed (delivery paths, escaping, SLA tones, confirmation link, text alternative).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
