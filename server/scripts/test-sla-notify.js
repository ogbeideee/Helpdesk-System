/* SLA notifications (src/slaNotifier.js, driven through the sweeper).

   Notifications ride the sweeper's exactly-once event claim, so this suite
   drives sweepSla() directly with fixed instants — deterministic, no sleeps,
   no server — and passes a capturing mailer transport. In-app delivery is
   asserted from Notification rows; email delivery from the captured mails.

   Calendar under test: Mon–Fri 08:00–17:00 Africa/Lagos. Sweep instants are
   asserted per ticket: earlier fixtures stay in the database and remain
   legitimate candidates for later sweeps, so per-ticket filtering (by
   ticketId and ticket number) keeps every assertion exact.

   Usage: npm run test:sla-notify  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4192';
// Exercised through the same portal link the mailer already builds.
process.env.PORTAL_BASE_URL = 'https://portal.slanotify.test';
// Background workers are off; the suite drives sweepSla directly. Read by
// slaSweeper at require time — must be set before the requires below.
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('sla-notify');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const sla = require('../src/slaService');
const sweeper = require('../src/slaSweeper');
const { createMailer } = require('../src/mailer');
const { nextTicketNumber } = require('../src/ticketNumbers');

const PASSWORD = 'SlaNotifyPass!123';
const DOMAIN = 'slanotify.example';

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

// Lagos wall-clock instants for the week of Monday 2026-09-07.
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';
const MON2 = '2026-09-14';
const d = (day, time) => new Date(`${day}T${time}+01:00`);
const DUE_RESPONSE_MON_10 = d(MON, '10:00').toUTCString();
const DUE_RESOLUTION_WED_15 = d(WED, '15:00').toUTCString();

// Capturing transport: every mail the SLA notifier would send lands here.
const sentEmails = [];
const testMailer = createMailer({
  transport: { async sendMail(mail) { sentEmails.push(mail); } },
});
const sweep = (at) => sweeper.sweepSla({ now: at, mailer: testMailer });

const notificationsFor = (ticketId) =>
  prisma.notification.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });
const emailsFor = (ticketNumber) => sentEmails.filter((e) => e.subject.includes(ticketNumber));
const recipientsOf = (mail) => mail.toRecipients.map((r) => r.emailAddress.address);

async function mkTicket(overrides = {}) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'SLA notify fixture ticket',
      body: 'SLA notify fixture body',
      category: 'Inquiry / Help',
      priority: 'moderate',
      state: 'NEW',
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      ...overrides,
    },
  });
}

// A ticket (with current assignment) + its cycle 1, started at a fixed instant.
async function mkCycle(startedAt, { assigneeId = null, teamId = null } = {}) {
  const ticket = await mkTicket({ assignedAgentId: assigneeId, teamId });
  const cycle = await sla.startCycle(ticket, { cycleNumber: 1, startedAt });
  return { ticket, cycle };
}

async function mkAgent(email, { isActive = true } = {}) {
  return prisma.agent.create({
    data: {
      name: email.split('@')[0],
      email,
      role: 'agent',
      isActive,
      isAvailable: true,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
    },
  });
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const team = await prisma.team.create({ data: { key: 'sla-notify-team', name: 'SLA Notify Team' } });
  const agent = await mkAgent(`tester@${DOMAIN}`);
  const lead = await mkAgent(`lead@${DOMAIN}`);
  await prisma.teamMembership.create({
    data: { agentId: lead.id, teamId: team.id, isLead: true },
  });

  /* ---- N1. response approaching: agent + lead get distinguishable alerts */
  console.log('\n--- N1. response approaching notification ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });

    await sweep(d(MON, '09:30')); // before the 25% threshold: nothing yet
    eq('N1 nothing notified before the window', (await notificationsFor(ticket.id)).length, 0);

    await sweep(d(MON, '09:50')); // inside the window (10 working minutes left)
    const rows = await notificationsFor(ticket.id);
    eq('N1 agent and lead both notified', rows.length, 2);
    eq('N1 recipients are the assignee and the lead', rows.map((r) => r.agentId).sort((a, b) => a - b).join(','), [agent.id, lead.id].sort((a, b) => a - b).join(','));
    check('N1 in-app type distinguishes approaching', rows.every((r) => r.type === 'sla_approaching_breach'), JSON.stringify(rows.map((r) => r.type)));
    check('N1 title names the response clock and ticket', rows.every((r) => r.title === `Response SLA approaching breach on ${ticket.ticketNumber}`), JSON.stringify(rows.map((r) => r.title)));
    check('N1 body carries the short description', rows.every((r) => r.body.includes(`"${ticket.shortDescription}"`)), JSON.stringify(rows.map((r) => r.body)));
    check('N1 body carries the remaining working time', rows.every((r) => r.body.includes('10 minutes of working time left')), JSON.stringify(rows.map((r) => r.body)));
    check('N1 body carries the due time', rows.every((r) => r.body.includes(DUE_RESPONSE_MON_10)), JSON.stringify(rows.map((r) => r.body)));

    const mails = emailsFor(ticket.ticketNumber);
    eq('N1 one email per recipient', mails.length, 2);
    eq('N1 emails go to agent + lead only (never the requester)', mails.map(recipientsOf).flat().sort().join(','), [agent.email, lead.email].sort().join(','));
    check('N1 email subject follows the [ticket] convention', mails.every((m) => m.subject === `[${ticket.ticketNumber}] Response SLA approaching breach: ${ticket.shortDescription}`), JSON.stringify(mails.map((m) => m.subject)));
    const toAgent = mails.find((m) => recipientsOf(m)[0] === agent.email);
    check('N1 email greets the recipient', toAgent.body.includes(`Hi ${agent.name},`), toAgent.body);
    check('N1 email names the applicable target', toAgent.body.includes('SLA:        Response target — 1 working hour'), toAgent.body);
    check('N1 email states the SLA status', toAgent.body.includes('Status:     Approaching breach — 25% of the response window remains'), toAgent.body);
    check('N1 email carries the due time', toAgent.body.includes(`Due:        ${DUE_RESPONSE_MON_10}`), toAgent.body);
    check('N1 email carries the remaining working time', toAgent.body.includes('Remaining:  10 minutes of working time'), toAgent.body);
    check('N1 email carries the portal link', toAgent.body.includes(`View in portal: https://portal.slanotify.test/tickets/${ticket.id}`), toAgent.body);
    check('N1 email keeps the mailer footer', toAgent.body.includes('IT Helpdesk — TicketDesk'), toAgent.body);
  }

  /* ---- N2. resolution approaching --------------------------------------- */
  console.log('\n--- N2. resolution approaching notification ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });
    await sla.recordFirstResponse(ticket, { at: d(MON, '09:30'), responderId: agent.id });

    await sweep(d(WED, '10:00')); // past the Wed 09:00 approach, before Wed 15:00 due
    const rows = await notificationsFor(ticket.id);
    eq('N2 agent and lead both notified', rows.length, 2);
    check('N2 in-app type distinguishes approaching', rows.every((r) => r.type === 'sla_approaching_breach'), JSON.stringify(rows.map((r) => r.type)));
    check('N2 title names the resolution clock', rows.every((r) => r.title === `Resolution SLA approaching breach on ${ticket.ticketNumber}`), JSON.stringify(rows.map((r) => r.title)));
    check('N2 body carries the remaining working time', rows.every((r) => r.body.includes('5 hours of working time left')), JSON.stringify(rows.map((r) => r.body)));
    check('N2 answered response clock never notified', rows.every((r) => !r.title.includes('Response SLA')), JSON.stringify(rows.map((r) => r.title)));

    const mails = emailsFor(ticket.ticketNumber);
    eq('N2 one email per recipient', mails.length, 2);
    check('N2 email names the resolution clock and target', mails.every((m) => m.body.includes('SLA:        Resolution target — 24 working hours (moderate priority)')), JSON.stringify(mails.map((m) => m.subject)));
    check('N2 email carries the resolution due time', mails.every((m) => m.body.includes(`Due:        ${DUE_RESOLUTION_WED_15}`)), JSON.stringify(mails.map((m) => m.subject)));
  }

  /* ---- N3. response breach ---------------------------------------------- */
  console.log('\n--- N3. response breach notification ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });

    await sweep(d(MON, '10:05')); // past the due instant, unanswered
    const rows = await notificationsFor(ticket.id);
    eq('N3 agent and lead both notified', rows.length, 2);
    check('N3 in-app type distinguishes breach', rows.every((r) => r.type === 'sla_breach'), JSON.stringify(rows.map((r) => r.type)));
    check('N3 title names the response clock', rows.every((r) => r.title === `Response SLA breached on ${ticket.ticketNumber}`), JSON.stringify(rows.map((r) => r.title)));

    const mails = emailsFor(ticket.ticketNumber);
    eq('N3 one email per recipient', mails.length, 2);
    check('N3 email subject names the breach', mails.every((m) => m.subject === `[${ticket.ticketNumber}] Response SLA breached: ${ticket.shortDescription}`), JSON.stringify(mails.map((m) => m.subject)));
    check('N3 email states the breach status', mails.every((m) => m.body.includes('Status:     Breached — the target passed with no agent response recorded')), JSON.stringify(mails.map((m) => m.subject)));
    check('N3 breached mail carries no remaining-time line', mails.every((m) => !m.body.includes('Remaining:')), JSON.stringify(mails.map((m) => m.subject)));
  }

  /* ---- N4. resolution breach -------------------------------------------- */
  console.log('\n--- N4. resolution breach notification ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });
    await sla.recordFirstResponse(ticket, { at: d(MON, '09:30'), responderId: agent.id });

    await sweep(d(WED, '16:00')); // past the Wed 15:00 due instant
    const rows = await notificationsFor(ticket.id);
    eq('N4 agent and lead both notified', rows.length, 2);
    check('N4 title names the resolution clock', rows.every((r) => r.title === `Resolution SLA breached on ${ticket.ticketNumber}`), JSON.stringify(rows.map((r) => r.title)));
    check('N4 answered response clock never notified', rows.every((r) => !r.title.includes('Response SLA')), JSON.stringify(rows.map((r) => r.title)));

    const mails = emailsFor(ticket.ticketNumber);
    eq('N4 one email per recipient', mails.length, 2);
    check('N4 email states the breach status', mails.every((m) => m.body.includes('Status:     Breached — the target passed without resolution')), JSON.stringify(mails.map((m) => m.subject)));
    check('N4 email names the resolution target', mails.every((m) => m.body.includes('SLA:        Resolution target — 24 working hours (moderate priority)')), JSON.stringify(mails.map((m) => m.subject)));
  }

  /* ---- N5. agent who is also the group lead is notified once ------------- */
  console.log('\n--- N5. agent/group lead duplication prevented ---');
  {
    const soloTeam = await prisma.team.create({ data: { key: 'sla-notify-solo', name: 'SLA Notify Solo' } });
    const solo = await mkAgent(`solo@${DOMAIN}`);
    await prisma.teamMembership.create({
      data: { agentId: solo.id, teamId: soloTeam.id, isLead: true },
    });
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: solo.id, teamId: soloTeam.id });

    await sweep(d(MON, '09:50'));
    const rows = await notificationsFor(ticket.id);
    eq('N5 exactly one notification for the agent-lead', rows.length, 1);
    eq('N5 it went to the agent-lead', rows[0].agentId, solo.id);
    const mails = emailsFor(ticket.ticketNumber);
    eq('N5 exactly one email', mails.length, 1);
    eq('N5 email went to the agent-lead once', recipientsOf(mails[0]).join(','), solo.email);
  }

  /* ---- N6. repeated sweeps never duplicate notifications ----------------- */
  console.log('\n--- N6. repeated sweeps do not duplicate ---');
  {
    const { ticket } = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });

    await sweep(d(MON, '09:50'));
    await sweep(d(MON, '09:50')); // identical instant again
    await sweep(d(MON, '09:55'));
    eq('N6 approaching notified exactly once per recipient', (await notificationsFor(ticket.id)).length, 2);

    await sweep(d(MON, '10:05'));
    await sweep(d(MON, '10:05')); // identical instant again
    eq('N6 breach adds exactly one per recipient', (await notificationsFor(ticket.id)).length, 4);
    eq('N6 breach emails sent exactly once per recipient', emailsFor(ticket.ticketNumber).length, 4);

    await sweep(d(MON, '10:20'));
    await sweep(d(TUE, '09:00'));
    eq('N6 still four notifications after further sweeps', (await notificationsFor(ticket.id)).length, 4);
    eq('N6 still four emails after further sweeps', emailsFor(ticket.ticketNumber).length, 4);
  }

  /* ---- N7. resolved / closed tickets stay silent ------------------------- */
  console.log('\n--- N7. resolved and closed tickets do not notify ---');
  {
    const resolved = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });
    await prisma.ticket.update({ where: { id: resolved.ticket.id }, data: { state: 'RESOLVED' } });
    const closed = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id, teamId: team.id });
    await prisma.ticket.update({ where: { id: closed.ticket.id }, data: { state: 'CLOSED' } });

    await sweep(d(MON2, '09:00')); // far past both clocks
    eq('N7 resolved ticket notified nobody', (await notificationsFor(resolved.ticket.id)).length, 0);
    eq('N7 closed ticket notified nobody', (await notificationsFor(closed.ticket.id)).length, 0);
    eq('N7 no emails for the resolved ticket', emailsFor(resolved.ticket.ticketNumber).length, 0);
    eq('N7 no emails for the closed ticket', emailsFor(closed.ticket.ticketNumber).length, 0);
  }

  /* ---- N8. missing assignee / group lead handled safely ------------------ */
  console.log('\n--- N8. missing assignee or group lead ---');
  {
    // Tuesday sweeps catch exactly the response clock of the fixtures below
    // (their resolution clocks are not due until Wednesday).
    const nobody = await mkCycle(d(MON, '09:00'), {});
    const agentOnly = await mkCycle(d(MON, '09:00'), { assigneeId: agent.id });
    const leadlessTeam = await prisma.team.create({ data: { key: 'sla-notify-nolead', name: 'SLA Notify No Lead' } });
    const unassigned = await mkCycle(d(MON, '09:00'), { teamId: leadlessTeam.id });
    const inactiveAgent = await mkAgent(`inactive@${DOMAIN}`, { isActive: false });
    const inactiveWithLead = await mkCycle(d(MON, '09:00'), { assigneeId: inactiveAgent.id, teamId: team.id });
    const inactiveTeam = await prisma.team.create({ data: { key: 'sla-notify-inactive', name: 'SLA Notify Inactive' } });
    const nobodyActive = await mkCycle(d(MON, '09:00'), { assigneeId: inactiveAgent.id, teamId: inactiveTeam.id });

    await sweep(d(TUE, '09:05'));
    eq('N8 no assignee and no group: notified nobody, no crash', (await notificationsFor(nobody.ticket.id)).length, 0);
    eq('N8 assignee without a group: one notification', (await notificationsFor(agentOnly.ticket.id)).length, 1);
    eq('N8 assignee without a group: the assignee got it', (await notificationsFor(agentOnly.ticket.id))[0].agentId, agent.id);
    eq('N8 group without a lead and no assignee: notified nobody', (await notificationsFor(unassigned.ticket.id)).length, 0);
    eq('N8 inactive assignee with active lead: one notification', (await notificationsFor(inactiveWithLead.ticket.id)).length, 1);
    eq('N8 inactive assignee with active lead: the lead got it', (await notificationsFor(inactiveWithLead.ticket.id))[0].agentId, lead.id);
    eq('N8 nobody active: notified nobody', (await notificationsFor(nobodyActive.ticket.id)).length, 0);

    const emailed = [
      ...emailsFor(nobody.ticket.ticketNumber),
      ...emailsFor(unassigned.ticket.ticketNumber),
      ...emailsFor(nobodyActive.ticket.ticketNumber),
    ];
    eq('N8 recipient-less tickets produced no emails', emailed.length, 0);
    const agentOnlyMails = emailsFor(agentOnly.ticket.ticketNumber);
    eq('N8 agent-only ticket emailed exactly once', agentOnlyMails.length, 1);
    eq('N8 agent-only email went to the assignee', recipientsOf(agentOnlyMails[0]).join(','), agent.email);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    testdb.drop();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('SUITE ERROR:', err);
    await prisma.$disconnect().catch(() => {});
    testdb.drop();
    process.exit(1);
  });
