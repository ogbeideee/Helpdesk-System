/* Email integration foundation: the outbound email layer.

   Part A pins the shared formatting (subject convention, footer, greeting,
   excerpt, recipients shape). Part B pins the per-type message builders:
   content plus the explicit recipient classes (requester vs internal), and
   that a requester mail without a requester is never assembled. Part C drives
   the mailer API against a capturing transport: exactly one mail per notify
   call, transport failures swallowed to `false`, missing recipients refused.
   Part D runs the real flows in-process against the isolated database with an
   injected mailer: intake (new / duplicate / reply / reopen), SLA alerts and
   the scheduled report — proving recipients, requester/internal separation
   and duplicate-send protection survive the refactor. Part E drives the live
   API with the development console transport and reads its log: a portal
   creation produces exactly one requester acknowledgement, an internal note
   produces no email at all, a public reply and a resolution email the
   requester once each. Part F pins the wiring: subject construction and the
   footer live only in the email layer.

   Usage: npm run test:email  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4214';
// Background workers are off; this suite drives everything directly.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
// Must be set before the email modules load: they resolve the portal link
// once at require time. The DL address enables the reply-alert fallback path.
process.env.PORTAL_BASE_URL = 'http://portal.test';
process.env.GRAPH_BROADCAST_DL = 'helpdesk-dl@email.test';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('emailint');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const outbound = require('../src/email/outbound');
const { createMailer } = require('../src/mailer');
const mailerModule = require('../src/mailer');
const slaNotifier = require('../src/slaNotifier');
const reportScheduler = require('../src/reportScheduler');
const settingsService = require('../src/services/settingsService');
const { intakeEmailMessage } = require('../src/services/ticketIntake');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'EmailSuite!123';
const DOMAIN = 'email.test';
const ADMIN_EMAIL = `admin@${DOMAIN}`;
const REQUESTER = `requester@${DOMAIN}`;
const DL = 'helpdesk-dl@email.test';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transport that records every mail instead of sending anything. */
function captureTransport() {
  return {
    sent: [],
    broadcasts: [],
    hasBroadcastTarget: () => true,
    async sendMail(mail) { this.sent.push(mail); },
    async sendBroadcastMail(mail) { this.broadcasts.push(mail); },
  };
}

/** The mailer API bound to a capturing transport — what flows receive. */
function captureMailer() {
  return createMailer({ transport: captureTransport(), logger: { log() {}, error() {}, warn() {} } });
}

/** Transport whose sendMail/sendBroadcastMail always fail. */
function failingTransport() {
  return {
    hasBroadcastTarget: () => true,
    async sendMail() { throw new Error('transport down'); },
    async sendBroadcastMail() { throw new Error('transport down'); },
  };
}

function recipientAddresses(mail) {
  return (mail.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address);
}

/** A ticket-shaped literal; the builders never touch the database. */
function ticketShape(overrides = {}) {
  return {
    id: 101,
    ticketNumber: 'TK-4242',
    shortDescription: 'Laptop will not start',
    body: 'The laptop shows a black screen in the mornings.',
    category: 'Hardware',
    priority: 'high',
    state: 'IN_PROGRESS',
    requesterEmail: REQUESTER,
    requesterName: 'Rita Requester',
    team: { name: 'Service Desk' },
    assignedAgent: { name: 'Ada Agent', email: `ada@${DOMAIN}` },
    dueAt: new Date('2026-09-07T16:00:00Z'),
    resolution: null,
    ...overrides,
  };
}

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  /* ---- A. shared formatting -------------------------------------------- */
  console.log('\n--- A. shared formatting ---');
  const subjectTicket = ticketShape();
  eq('A1 subject convention', outbound.ticketSubject(subjectTicket, 'Hello there'), '[TK-4242] Hello there');
  eq('A2 state label', outbound.stateLabel('IN_PROGRESS'), 'In Progress');
  eq('A3 greeting fallback', outbound.greeting(null), 'Hi there,');
  eq('A4 greeting with name', outbound.greeting('Rita'), 'Hi Rita,');
  eq('A5 requester display with name', outbound.requesterDisplay(subjectTicket), 'Rita Requester <requester@email.test>');
  eq('A6 requester display without name',
    outbound.requesterDisplay(ticketShape({ requesterName: null })), REQUESTER);
  eq('A7 excerpt collapses whitespace', outbound.excerpt('a\n  b\tc'), 'a b c');
  eq('A8 excerpt truncates', outbound.excerpt('x'.repeat(700), 600).length, 601); // 600 + ellipsis
  eq('A9 slaLine without due date', outbound.slaLine(ticketShape({ dueAt: null })), '');
  check('A10 slaLine with due date', outbound.slaLine(subjectTicket).includes('Target resolution:')
    && outbound.slaLine(subjectTicket).includes('high priority'));
  const footer = outbound.ticketFooter(subjectTicket);
  check('A11 footer names the ticket', footer.includes('Ticket: TK-4242'));
  check('A12 footer links the portal', footer.includes('View in portal: http://portal.test/tickets/101'));
  check('A13 footer invites the reply-by-email flow', footer.includes('Reply directly to this email'));
  check('A14 footer uses CRLF lines', footer.includes('\r\n'));
  const ack = outbound.ticketAcknowledgementMail(subjectTicket);
  eq('A15 toRecipient shape', JSON.stringify(outbound.toRecipient('a@b.c')),
    JSON.stringify({ emailAddress: { address: 'a@b.c' } }));
  eq('A16 recipientsOf collects to+cc',
    outbound.recipientsOf({ toRecipients: [outbound.toRecipient('a@b.c')], ccRecipients: [outbound.toRecipient('d@e.f')] }),
    'a@b.c, d@e.f');

  /* ---- B. message builders: content + recipient classes ---------------- */
  console.log('\n--- B. message builders ---');

  // B1-B3 requester acknowledgement
  check('B1 ack subject', ack.subject === '[TK-4242] We received your request');
  check('B2 ack recipient is the requester only',
    JSON.stringify(recipientAddresses(ack)) === JSON.stringify([REQUESTER]));
  check('B3 ack greets the requester and carries the ticket facts',
    ack.body.startsWith('Hi Rita Requester,')
    && ack.body.includes('Your request has been logged')
    && ack.body.includes('Ticket:    TK-4242')
    && ack.body.includes('Laptop will not start')
    && ack.body.includes('Priority:  high')
    && ack.body.includes('Ticket: TK-4242'));
  eq('B4 ack falls back to a generic greeting',
    outbound.ticketAcknowledgementMail(ticketShape({ requesterName: null })).body.startsWith('Hi there,'), true);
  eq('B5 ack refuses to assemble without a requester', outbound.ticketAcknowledgementMail(ticketShape({ requesterEmail: null })), null);

  // B6-B8 status update
  const resolvedMail = outbound.statusUpdateMail(
    ticketShape({ state: 'RESOLVED', resolution: 'Replaced the power supply.' }),
    { previousState: 'IN_PROGRESS' }
  );
  check('B6 resolved subject', resolvedMail.subject === '[TK-4242] Resolved: Laptop will not start');
  check('B7 resolved mail carries the resolution note',
    resolvedMail.body.includes('Resolution:') && resolvedMail.body.includes('> Replaced the power supply.'));
  check('B8 resolved mail shows the transition',
    resolvedMail.body.includes('In Progress -> Resolved'));
  const progressMail = outbound.statusUpdateMail(
    ticketShape({ state: 'IN_PROGRESS', resolution: 'stale note must not leak' }),
    { previousState: 'NEW' }
  );
  eq('B9 open state subject', progressMail.subject, '[TK-4242] Status update: In Progress');
  check('B10 resolution text only on RESOLVED', !progressMail.body.includes('stale note must not leak'));
  eq('B11 status mail refuses without a requester',
    outbound.statusUpdateMail(ticketShape({ requesterEmail: '' })), null);

  // B12-B14 agent reply to requester
  const reply = outbound.agentReplyMail({ ticket: subjectTicket, agentName: 'Ada Agent', body: 'Line one.\nLine two.' });
  check('B12 open-ticket reply subject', reply.subject === '[TK-4242] New message about your request');
  check('B13 reply quotes every line for the requester',
    reply.body.includes('> Line one.') && reply.body.includes('> Line two.'));
  check('B14 reply names the agent and closes with the ticket id',
    reply.body.includes('Ada Agent from the IT Helpdesk wrote:')
    && reply.body.includes(`IT Helpdesk — Ticket TK-4242`));
  check('B15 reply recipient is the requester only',
    JSON.stringify(recipientAddresses(reply)) === JSON.stringify([REQUESTER]));
  const replyResolved = outbound.agentReplyMail({
    ticket: ticketShape({ state: 'RESOLVED' }), agentName: 'Ada Agent', body: 'done',
  });
  eq('B16 reply subject on a finished ticket', replyResolved.subject, '[TK-4242] Update on your request');
  eq('B17 reply refuses without a requester',
    outbound.agentReplyMail({ ticket: ticketShape({ requesterEmail: null }), agentName: 'A', body: 'x' }), null);

  // B18-B19 assignment notice (internal)
  const assignment = outbound.assignmentMail(subjectTicket, subjectTicket.assignedAgent);
  check('B18 assignment subject', assignment.subject === '[TK-4242] Assigned to you: Laptop will not start');
  check('B19 assignment recipient is the agent only',
    JSON.stringify(recipientAddresses(assignment)) === JSON.stringify([`ada@${DOMAIN}`]));
  check('B20 assignment body carries the context block',
    assignment.body.startsWith('Hi Ada Agent,')
    && assignment.body.includes('Requester:  Rita Requester <requester@email.test>')
    && assignment.body.includes('Team: ') === false
    && assignment.body.includes('(Service Desk)'));
  eq('B21 assignment refuses without an agent', outbound.assignmentMail(subjectTicket, null), null);
  eq('B22 assignment refuses an agent without email',
    outbound.assignmentMail(subjectTicket, { name: 'No Address', email: null }), null);

  // B23-B24 team broadcast (internal; recipients are the transport's business)
  const broadcast = outbound.newTicketBroadcastMail(subjectTicket);
  eq('B23 broadcast subject', broadcast.subject, '[TK-4242] Hardware: Laptop will not start');
  check('B24 broadcast carries the triage block',
    broadcast.body.includes('New ticket received.')
    && broadcast.body.includes('Requester:  Rita Requester <requester@email.test>')
    && broadcast.body.includes('Assigned:   Ada Agent <ada@email.test>')
    && broadcast.body.includes('Assigned automatically'));
  const unassigned = outbound.newTicketBroadcastMail(ticketShape({ assignedAgent: null, team: null }));
  check('B25 unassigned broadcast asks the team to claim',
    unassigned.body.includes('Team:       Unassigned (triage)')
    && unassigned.body.includes('Assignment is pending'));
  eq('B26 broadcast has no direct recipients (transport targets the DL)',
    broadcast.toRecipients, undefined);

  // B27-B29 reply alert (internal)
  const alert = outbound.replyAlertMail(subjectTicket, { fromName: 'Rita Requester <requester@email.test>' });
  eq('B27 reply-alert subject', alert.subject, '[TK-4242] New reply: Laptop will not start');
  const reopened = outbound.replyAlertMail(subjectTicket, { reopened: true });
  eq('B28 reopened subject', reopened.subject, '[TK-4242] Reopened: Laptop will not start');
  check('B29 reopened wording', reopened.body.includes('it has been reopened')
    && reopened.body.includes('In Progress (reopened)'));
  check('B30 reply alert falls back to the raw address without a display name',
    alert.body.includes(`From:      Rita Requester <requester@email.test>`)
    && outbound.replyAlertMail(ticketShape({ requesterName: null })).body.includes(`From:      ${REQUESTER}`));

  /* ---- C. mailer API against a capturing transport ---------------------- */
  console.log('\n--- C. mailer API ---');
  const quiet = { log() {}, error() {}, warn() {} };

  const cap = captureTransport();
  const mailer = createMailer({ transport: cap, logger: quiet });
  eq('C1 ack returns true', await mailer.notifyRequesterAck(subjectTicket), true);
  eq('C2 ack sends exactly one mail', cap.sent.length, 1);
  eq('C3 status update sends exactly one mail',
    (await mailer.notifyStatusChanged(subjectTicket, { previousState: 'NEW' }), cap.sent.length), 2);
  eq('C4 agent reply sends exactly one mail',
    (await mailer.notifyAgentReply(subjectTicket, { agentName: 'Ada Agent', body: 'hi' }), cap.sent.length), 3);
  eq('C5 assignment sends exactly one mail',
    (await mailer.notifyAssignment(subjectTicket, subjectTicket.assignedAgent), cap.sent.length), 4);
  eq('C6 reply alert sends exactly one mail',
    (await mailer.notifyReplyReceived(subjectTicket, {}), cap.sent.length), 5);
  eq('C7 broadcast uses the broadcast channel, not sendMail',
    (await mailer.notifyNewTicketToDl(subjectTicket), cap.broadcasts.length), 1);
  check('C8 requester mails only ever address the requester',
    [0, 1, 2].every((i) => JSON.stringify(recipientAddresses(cap.sent[i])) === JSON.stringify([REQUESTER])));
  check('C9 internal mails never address the requester',
    JSON.stringify(recipientAddresses(cap.sent[3])) === JSON.stringify([`ada@${DOMAIN}`])
    && JSON.stringify(recipientAddresses(cap.sent[4])) === JSON.stringify([`ada@${DOMAIN}`]));
  check('C10 mailer output equals the assembled builder output',
    cap.sent[0].subject === ack.subject && cap.sent[0].body === ack.body);

  // C11-C14 missing/invalid recipients are refused, not sent
  const cap2 = captureTransport();
  const mailer2 = createMailer({ transport: cap2, logger: quiet });
  eq('C11 ack without a requester sends nothing',
    (await mailer2.notifyRequesterAck(ticketShape({ requesterEmail: null })), cap2.sent.length), 0);
  eq('C12 assignment without an agent sends nothing',
    (await mailer2.notifyAssignment(subjectTicket, null), cap2.sent.length), 0);
  eq('C13 reply alert with no assignee falls back to the DL',
    recipientAddresses((await mailer2.notifyReplyReceived(ticketShape({ assignedAgent: null }), {}), cap2.sent[0]))[0], DL);
  eq('C14 the DL fallback mail is still one mail', cap2.sent.length, 1);

  // C15-C18 transport failures are swallowed and logged, never thrown
  const errors = [];
  const errLogger = { log() {}, warn() {}, error: (m) => errors.push(m) };
  const mailer3 = createMailer({ transport: failingTransport(), logger: errLogger });
  eq('C15 sendMailSafe reports failure', await mailer3.sendMailSafe({ subject: 's', body: 'b', toRecipients: [] }), false);
  eq('C16 ack tolerates a dead transport', await mailer3.notifyRequesterAck(subjectTicket), false);
  eq('C17 broadcast tolerates a dead transport', await mailer3.notifyNewTicketToDl(subjectTicket), false);
  check('C18 failures are logged for the operator', errors.length >= 3);

  // C19 no broadcast target -> skipped, nothing sent
  const cap3 = captureTransport();
  cap3.hasBroadcastTarget = () => false;
  const mailer4 = createMailer({ transport: cap3, logger: quiet });
  eq('C19 broadcast without a target is skipped', await mailer4.notifyNewTicketToDl(subjectTicket), false);
  eq('C20 nothing was sent', cap3.broadcasts.length + cap3.sent.length, 0);

  /* ---- D. real flows with an injected mailer ---------------------------- */
  console.log('\n--- D. flows (isolated database) ---');
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });

  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  const leadAgent = await prisma.agent.create({
    data: {
      name: 'Lee Lead', email: `lead@${DOMAIN}`, role: 'agent',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
  const adminAgent = await prisma.agent.create({
    data: {
      name: 'Email Admin', email: ADMIN_EMAIL, role: 'admin',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
  await prisma.teamMembership.create({
    data: { teamId: defaultTeam.id, agentId: leadAgent.id, isLead: true },
  });

  // D1 intake of a brand-new message
  const flowMailer = captureMailer();
  const flowCap = flowMailer.transport;
  const created = await intakeEmailMessage({
    messageId: '<flow-new@email.test>',
    subject: 'VPN drops every hour',
    body: 'The VPN client disconnects on its own.',
    from: REQUESTER,
    name: 'Rita Requester',
  }, { logger: quiet, mailer: flowMailer });
  eq('D1 intake creates the ticket', created.status, 'created');
  eq('D2 intake sends one broadcast', flowCap.broadcasts.length, 1);
  eq('D3 intake sends exactly two direct mails (ack + assignment)', flowCap.sent.length, 2);
  check('D4 ack addresses the requester, assignment the agent',
    JSON.stringify(flowCap.sent.flatMap(recipientAddresses).map((a) => (a === REQUESTER ? 'requester' : 'agent')).sort())
      === JSON.stringify(['agent', 'requester']));
  check('D5 no mail mixes audiences',
    flowCap.sent.every((m) => recipientAddresses(m).length === 1));
  check('D6 ack subject follows the convention',
    flowCap.sent.some((m) => m.subject === `[${created.ticket.ticketNumber}] We received your request`));

  // D7-D8 duplicate replay sends nothing at all
  const beforeDup = flowCap.sent.length + flowCap.broadcasts.length;
  const dup = await intakeEmailMessage({
    messageId: '<flow-new@email.test>',
    subject: 'VPN drops every hour',
    body: 'The VPN client disconnects on its own.',
    from: REQUESTER,
  }, { logger: quiet, mailer: flowCap });
  eq('D7 replay is reported as a duplicate', dup.status, 'duplicate');
  eq('D8 duplicate replay sends nothing', flowCap.sent.length + flowCap.broadcasts.length, beforeDup);

  // D9 requester reply alerts the agent, never the requester
  const replyMailer = captureMailer();
  const replyCap = replyMailer.transport;
  const replyIn = await intakeEmailMessage({
    messageId: '<flow-reply@email.test>',
    subject: `Re: ${created.ticket.ticketNumber} VPN drops every hour`,
    body: 'It happened again just now.',
    from: REQUESTER,
  }, { logger: quiet, mailer: replyMailer });
  eq('D9 reply is appended', replyIn.status, 'comment_added');
  eq('D10 reply alert is exactly one mail', replyCap.sent.length, 1);
  check('D11 reply alert goes to the assigned agent only',
    JSON.stringify(recipientAddresses(replyCap.sent[0])) === JSON.stringify([`lead@${DOMAIN}`]));
  check('D12 reply alert never copies the requester', !replyCap.sent[0].subject.includes(REQUESTER));

  // D13 reply on a resolved ticket reopens with reopened wording
  await prisma.ticket.update({
    where: { id: created.ticket.id },
    data: { state: 'RESOLVED', resolvedAt: new Date(), resolution: 'Reset the client.' },
  });
  const reopenMailer = captureMailer();
  const reopenCap = reopenMailer.transport;
  const reopenIn = await intakeEmailMessage({
    messageId: '<flow-reopen@email.test>',
    subject: `Re: ${created.ticket.ticketNumber} VPN drops every hour`,
    body: 'Still broken after your fix.',
    from: REQUESTER,
  }, { logger: quiet, mailer: reopenMailer });
  eq('D13 reply on resolved reopens', reopenIn.status, 'reopened');
  eq('D14 reopened alert subject', reopenCap.sent[0].subject,
    `[${created.ticket.ticketNumber}] Reopened: VPN drops every hour`);

  // D15-D17 SLA alerts: agents only, requester excluded, no recipients -> silent
  // Ada is a plain member (created after the intake flow so the round-robin
  // above stays deterministic): assignee + lead must BOTH be notified.
  const adaAgent = await prisma.agent.create({
    data: {
      name: 'Ada Agent', email: `ada@${DOMAIN}`, role: 'agent',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
  const slaTicket = await prisma.ticket.create({
    data: {
      ticketNumber: `TK-SLA-${await prisma.ticket.count().then((n) => n + 1)}`,
      shortDescription: 'SLA alert probe',
      body: 'probe',
      category: 'Hardware', priority: 'high', state: 'IN_PROGRESS', source: 'portal',
      requesterEmail: REQUESTER,
      teamId: defaultTeam.id, assignedAgentId: adaAgent.id,
    },
  });
  const slaMailer = captureMailer();
  const slaCap = slaMailer.transport;
  const notified = await slaNotifier.notifySlaEvent({
    client: prisma, ticket: slaTicket, kind: 'approaching', clock: 'response',
    dueAt: new Date(Date.now() + 3600 * 1000), mailer: slaMailer,
  });
  eq('D15 assignee and lead are notified', notified, 2);
  eq('D16 one mail per recipient, no more', slaCap.sent.length, 2);
  const slaRecipients = slaCap.sent.flatMap(recipientAddresses);
  check('D17 SLA mail recipients are agent addresses only, never the requester',
    slaRecipients.length === 2
    && slaRecipients.includes(`ada@${DOMAIN}`)
    && slaRecipients.includes(`lead@${DOMAIN}`)
    && !slaRecipients.includes(REQUESTER));
  check('D18 SLA subject follows the convention',
    slaCap.sent[0].subject.startsWith(`[${slaTicket.ticketNumber}] Response SLA approaching breach:`));
  eq('D19 in-app rows ride the same event',
    await prisma.notification.count({ where: { ticketId: slaTicket.id, type: 'sla_approaching_breach' } }), 2);

  const orphanTicket = await prisma.ticket.create({
    data: {
      ticketNumber: 'TK-SLA-ORPHAN',
      shortDescription: 'Nobody home',
      body: 'probe', category: 'Hardware', priority: 'low', state: 'NEW', source: 'portal',
      requesterEmail: REQUESTER,
      // no assignee; default team has a lead, so detach it entirely
    },
  });
  const orphanMailer = captureMailer();
  const orphanCap = orphanMailer.transport;
  eq('D20 ticket with no assignee and no group notifies nobody',
    await slaNotifier.notifySlaEvent({
      client: prisma, ticket: orphanTicket, kind: 'breach', clock: 'resolution',
      dueAt: new Date(Date.now() - 3600 * 1000), mailer: orphanMailer,
    }), 0);
  eq('D21 nothing sent for the orphan', orphanCap.sent.length, 0);

  // D22-D24 scheduled report: configured admin recipients only; dedupe holds
  await settingsService.update(
    { reportRecipients: `boss@${DOMAIN}, ops@${DOMAIN}` }, 'suite', prisma);
  const reportMailer = captureMailer();
  const reportCap = reportMailer.transport;
  const fixedNow = new Date('2026-09-09T09:15:00Z');
  const sentOut = await reportScheduler.sendScheduledReport({
    kind: 'weekly', now: fixedNow, client: prisma, mailer: reportMailer, logger: quiet,
  });
  eq('D22 weekly report sends', sentOut.status, 'sent');
  eq('D23 one report mail', reportCap.sent.length, 1);
  check('D24 report goes only to the configured recipients',
    JSON.stringify(recipientAddresses(reportCap.sent[0]).sort())
      === JSON.stringify([`boss@${DOMAIN}`, `ops@${DOMAIN}`].sort()));
  check('D25 report subject carries the period label',
    /^\[IT Helpdesk\] Weekly report /.test(reportCap.sent[0].subject));
  const again = await reportScheduler.sendScheduledReport({
    kind: 'weekly', now: fixedNow, client: prisma, mailer: reportMailer, logger: quiet,
  });
  eq('D26 re-run is already_sent', again.status, 'already_sent');
  eq('D27 dedupe prevents a second report mail', reportCap.sent.length, 1);

  /* ---- E. live API: internal-note protection via the console transport -- */
  console.log('\n--- E. live API (console transport) ---');
  let out = '';
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env },
  });
  server.stdout.on('data', (d) => { out += d.toString(); });
  try {
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await sleep(250);
    }
    await sleep(500); // startup banner settles
    out = '';

    const login = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: PASSWORD } });
    eq('E1 admin logs in', login.status, 200);
    const admin = login.data.token;

    const emailsTo = (text, address) => {
      let count = 0;
      let idx = text.indexOf('EMAIL NOTIFICATION');
      while (idx !== -1) {
        if (text.slice(idx, idx + 120).includes(`To: ${address}\n`)) count += 1;
        idx = text.indexOf('EMAIL NOTIFICATION', idx + 1);
      }
      return count;
    };
    const drain = async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (out.length === last) break;
        last = out.length;
      }
      return out;
    };

    // E2: portal creation — exactly one ack to the requester, no duplicates
    const created2 = await req('/api/tickets', {
      method: 'POST', token: admin,
      body: { shortDescription: 'Email integration probe', body: 'Probe body.', requesterEmail: REQUESTER },
    });
    eq('E2 portal create succeeds', created2.status, 201);
    let slice = await drain();
    eq('E3 exactly one requester acknowledgement', emailsTo(slice, REQUESTER), 1);
    check('E4 the team broadcast rode the broadcast channel', slice.includes('NEW TICKET NOTIFICATION'));
    const ticketId = created2.data.id;

    // E5: an internal note emails nobody
    out = '';
    const internal = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST', token: admin, body: { body: 'Internal: check the warranty.', isInternal: true },
    });
    eq('E5 internal note accepted', internal.status, 201);
    slice = await drain();
    eq('E6 internal note sends no email at all', emailsTo(slice, REQUESTER) + (slice.match(/EMAIL NOTIFICATION/g) || []).length, 0);

    // E7: a public reply emails the requester exactly once
    out = '';
    const publicReply = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST', token: admin, body: { body: 'We are on it — update tomorrow.', isInternal: false },
    });
    eq('E7 public reply accepted', publicReply.status, 201);
    slice = await drain();
    eq('E8 exactly one requester mail for the public reply', emailsTo(slice, REQUESTER), 1);
    check('E9 the reply subject announces a new message', slice.includes('New message about your request'));

    // E10: the lifecycle needs NEW -> IN_PROGRESS first; that transition
    // emails the requester once, then the resolution emails once, quoting
    // the resolution note.
    out = '';
    const started2 = await req(`/api/tickets/${ticketId}/status`, {
      method: 'POST', token: admin, body: { state: 'IN_PROGRESS' },
    });
    eq('E10a start succeeds', started2.status, 200);
    slice = await drain();
    eq('E10b exactly one requester mail for the start', emailsTo(slice, REQUESTER), 1);
    out = '';
    const resolved2 = await req(`/api/tickets/${ticketId}/status`, {
      method: 'POST', token: admin,
      body: { state: 'RESOLVED', resolution: 'Rebooted the probe.' },
    });
    eq('E10 resolve succeeds', resolved2.status, 200);
    slice = await drain();
    eq('E11 exactly one requester mail for the resolution', emailsTo(slice, REQUESTER), 1);
    check('E12 the resolution mail quotes the note', slice.includes('> Rebooted the probe.'));

    // E13: the dead-transport path cannot crash a live request — the public
    // reply endpoint stays 201 even when the mailer's transport throws. The
    // default console transport cannot throw, so this is proven at the mailer
    // level in C15-C17; here we prove the endpoint is unaffected by mail
    // volume (fire-and-forget semantics).
    out = '';
    const second = await req(`/api/tickets/${ticketId}/notes`, {
      method: 'POST', token: admin, body: { body: 'Another public line.', isInternal: false },
    });
    eq('E13 fire-and-forget reply stays 201', second.status, 201);
  } finally {
    server.kill();
  }

  /* ---- F. wiring: formatting lives only in the email layer -------------- */
  console.log('\n--- F. wiring ---');
  const fs = require('fs');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  eq('F1 the notes route no longer assembles mail inline',
    read('routes/tickets.js').includes('sendMailSafe('), false);
  const subjectSites = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(p, 'utf8');
        if (text.includes('ticketNumber}] ')) subjectSites.push(path.basename(p));
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  walk(path.join(__dirname, '..', 'routes'));
  eq('F2 ticket-subject construction is centralized in outbound.js',
    subjectSites.join(','), 'outbound.js');
  check('F3 the SLA notifier reuses the shared footer',
    read('src/slaNotifier.js').includes('ticketFooter(')
    && !read('src/slaNotifier.js').includes('IT Helpdesk — TicketDesk'));
  check('F4 the mailer keeps the safe-send API',
    typeof mailerModule.sendMailSafe === 'function'
    && typeof mailerModule.notifyAgentReply === 'function'
    && typeof mailerModule.notifyRequesterAck === 'function'
    && typeof mailerModule.notifyStatusChanged === 'function'
    && typeof mailerModule.notifyAssignment === 'function'
    && typeof mailerModule.notifyReplyReceived === 'function'
    && typeof mailerModule.notifyNewTicketToDl === 'function');
  check('F5 the outbound layer never references credentials',
    !read('src/email/outbound.js').match(/passwordHash|secret|token/i));
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
