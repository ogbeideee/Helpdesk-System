/* Integration checks for the relevance gate's place in ticket intake. */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const testdb = require('./lib/testdb').use('email-triage-intake');

const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { intakeEmailMessage } = require('../src/services/ticketIntake');
const triageService = require('../src/services/emailTriageService');
const triagePolicy = require('../src/services/emailTriagePolicy');

const MARK = 'triage-intake-';
const quiet = { log() {}, warn() {}, error() {} };
const mailer = {
  notifyNewTicketToDl: async () => {},
  notifyRequesterAck: async () => {},
  notifyAssignment: async () => {},
  notifyReplyReceived: async () => {},
};

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function payload(overrides = {}) {
  return {
    messageId: `${MARK}${Math.random().toString(36).slice(2, 10)}`,
    internetMessageId: `${MARK}${Math.random().toString(36).slice(2, 10)}@example.test`,
    from: 'employee@example.test',
    subject: 'VPN is not working',
    body: 'I cannot connect to the VPN since this morning.',
    cleanBody: 'I cannot connect to the VPN since this morning.',
    ...overrides,
  };
}

async function cleanup() {
  await prisma.emailTriageDecision.deleteMany({ where: { messageKey: { startsWith: MARK } } });
  const tickets = await prisma.ticket.findMany({
    where: { OR: [{ graphMessageId: { startsWith: MARK } }, { internetMessageId: { startsWith: MARK } }] },
    select: { id: true },
  });
  const ids = tickets.map((row) => row.id);
  await prisma.comment.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketAuditLog.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.auditEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketSlaEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketSlaCycle.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
  await prisma.setting.deleteMany({ where: { key: { startsWith: 'intakeRelevance' } } });
}

async function main() {
  await ensureTeams(prisma);
  await cleanup();

  const decisionMessage = {
    messageId: `${MARK}decision-message`,
    internetMessageId: `${MARK}decision-message@example.test`,
    requesterEmail: 'hr-announcements@example.com',
    subject: 'Annual HR announcement',
    body: 'Informational announcement with no request.',
    cleanBody: 'Informational announcement with no request.',
  };
  const persisted = await triageService.screenMessage(decisionMessage, {
    client: prisma,
    settings: {
      mode: 'auto_skip',
      threshold: 95,
      requireApprovedSender: true,
      approvedSenders: ['hr-announcements@example.com'],
      skipReasonCodes: [...triagePolicy.SAFE_SKIP_REASON_CODES],
    },
    config: { ...triageService.getRuntimeConfig(), apiKey: 'test-key' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          disposition: 'skip', confidence: 0.99, reasonCode: 'informational_announcement',
          reason: 'No action is requested.', evidence: [],
        }) } }],
      }),
    }),
    logger: quiet,
  });
  const decisionRow = await prisma.emailTriageDecision.findUnique({
    where: { messageKey: decisionMessage.internetMessageId },
  });
  check('real decision table accepts a safe triage result', persisted.action === 'skipped_non_ticket' && Boolean(decisionRow));
  check('real decision row stores no subject or body', decisionRow && !JSON.stringify(decisionRow).includes(decisionMessage.subject) && !JSON.stringify(decisionRow).includes(decisionMessage.body));

  let calls = 0;
  const triageOverride = {
    async screenMessage(message) {
      calls += 1;
      if (message.subject === 'Annual HR announcement') {
        return { action: 'skipped_non_ticket', reasonCode: 'informational_announcement' };
      }
      return { action: 'ticket_candidate', reasonCode: 'ticket' };
    },
  };

  const before = await prisma.ticket.count();
  const skipped = await intakeEmailMessage(
    payload({
      subject: 'Annual HR announcement',
      body: 'The annual HR announcement is for information only.',
      cleanBody: 'The annual HR announcement is for information only.',
    }),
    { logger: quiet, mailer, triageService: triageOverride },
  );
  check('approved relevance result becomes skipped_non_ticket', skipped.status === 'skipped_non_ticket', JSON.stringify(skipped));
  check('skipped_non_ticket creates no ticket', await prisma.ticket.count() === before);
  check('relevance service ran once for the new message', calls === 1);

  const created = await intakeEmailMessage(payload(), { logger: quiet, mailer, triageService: triageOverride });
  check('ticket candidate continues through normal intake', created.status === 'created', JSON.stringify({ status: created.status }));
  check('normal intake still creates a ticket', await prisma.ticket.count() === before + 1);
  check('normal intake still runs the assignment engine', Boolean(created.assignment));
  check('relevance service ran for the ticket candidate', calls === 2);

  const originalId = created.ticket.internetMessageId || created.ticket.graphMessageId;
  const callsBeforeReply = calls;
  const reply = await intakeEmailMessage(
    payload({
      subject: `Re: ${created.ticket.ticketNumber}`,
      inReplyTo: [originalId],
      body: 'Adding more detail to my existing request.',
      cleanBody: 'Adding more detail to my existing request.',
    }),
    { logger: quiet, mailer, triageService: triageOverride },
  );
  check('existing-ticket reply bypasses relevance triage', reply.status === 'comment_added' && calls === callsBeforeReply, JSON.stringify({ status: reply.status, calls }));

  await cleanup();
  if (failures) {
    console.error(`\n${failures} email triage intake test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll email triage intake tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
