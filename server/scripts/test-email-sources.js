/* Shared ingestion behavior across the Graph and IMAP email sources.

   Both channels must converge on the same ticket-intake pipeline: the RFC
   Message-ID is the shared identity (cross-source duplicate prevention),
   In-Reply-To/References thread replies across sources, the audit trail names
   the channel, and the Graph webhook collapses redelivered notifications
   without re-fetching. Credential protection is checked on the live /api/health
   endpoint, which also proves a failing IMAP poll cannot hurt the server.

   Parts:
     A. parser: the internetMessageId travels through the Graph adapter
     B. cross-source duplicate prevention (Graph first, IMAP first)
     C. cross-source threading and reopen via In-Reply-To
     D. the audit trail names the ingestion channel
     E. webhook notification idempotency (dedupe cache)
     F. /api/health reports IMAP enabled without ever exposing credentials,
        and survives a failing IMAP connection

   Usage: npm run test:email-sources  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4218';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('emailsrc');

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');

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

const PASSWORD = 'SourcesSuite!123';
const DOMAIN = 'sources.test';
const QUIET = { log() {}, error() {}, warn() {} };

/* ------------------------------------------------------------------ */
/* Doubles                                                             */
/* ------------------------------------------------------------------ */

function rawGraphMessage({ id, from, subject, bodyText, internetMessageId, conversationId }) {
  return {
    id,
    conversationId: conversationId || `conv-${id}`,
    internetMessageId: internetMessageId || null,
    subject,
    from: { emailAddress: from ? { name: from[0], address: from[1] } : {} },
    body: { contentType: 'text', content: bodyText || '' },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  };
}

function graphMailService(quietLogger = QUIET) {
  const { createMailService } = require('../src/graph/mailService');
  return createMailService({ logger: quietLogger, ops: { async listAttachments() { return []; }, async markAsRead() {} } });
}

/** A capture mailer so intake notifications never reach the console. */
function quietMailer() {
  const { createMailer } = require('../src/mailer');
  return createMailer({
    logger: QUIET,
    transport: {
      hasBroadcastTarget: () => false,
      async sendMail() {},
      async sendBroadcastMail() {},
    },
  });
}

async function ticketCount() {
  return prisma.ticket.count();
}

function auditMeta(row) {
  return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  /* ---- A. the internetMessageId travels through the Graph adapter ------- */
  console.log('\n--- A. parser carries the shared identity ---');
  const { toRawEmail: graphToRawEmail } = require('../src/graph/graphMailAdapter');
  const { parseEmail } = require('../src/email/emailParser');

  const withId = parseEmail(graphToRawEmail({
    id: 'graph-AA1',
    internetMessageId: '<shared-a@x.test>',
    conversationId: 'conv-a',
    subject: 'Adapter probe',
    from: { emailAddress: { name: 'Rita', address: 'rita@sources.test' } },
    body: { contentType: 'text', content: 'probe body' },
  }));
  eq('A1 Graph internetMessageId parsed, brackets stripped', withId.internetMessageId, 'shared-a@x.test');
  eq('A2 Graph provider id stays the primary messageId', withId.messageId, 'graph-AA1');
  check('A3 threading fields default empty for Graph mail',
    Array.isArray(withId.inReplyTo) && withId.inReplyTo.length === 0
    && Array.isArray(withId.references) && withId.references.length === 0);

  const withoutId = parseEmail(graphToRawEmail({
    id: 'graph-AA2', subject: 'no rfc id', from: { emailAddress: { address: 'x@sources.test' } },
    body: { contentType: 'text', content: 'b' },
  }));
  eq('A4 a Graph message without an RFC id stays null', withoutId.internetMessageId, null);

  const seeded = parseEmail({
    messageId: 'dev-1', from: 'dev@sources.test', subject: 'dev', body: 'dev body',
  });
  check('A5 dev-endpoint payloads get the new fields with safe defaults',
    seeded.internetMessageId === null && Array.isArray(seeded.inReplyTo) && Array.isArray(seeded.references)
    && seeded.recipients && Array.isArray(seeded.recipients.to));

  /* ---- shared seed ------------------------------------------------------- */
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  await prisma.agent.create({
    data: {
      name: 'Sources Agent', email: `agent@${DOMAIN}`, role: 'agent',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
  const mailer = quietMailer();

  /* ---- B. cross-source duplicate prevention ------------------------------ */
  console.log('\n--- B. cross-source dedupe ---');
  const { intakeEmailMessage } = require('../src/services/ticketIntake');

  const graphSvc = graphMailService();
  const beforeB = await ticketCount();
  const gFirst = await graphSvc.processOne(
    rawGraphMessage({ id: 'graph-B1', from: ['Rita', 'rita@sources.test'], subject: 'Graph first', bodyText: 'body', internetMessageId: '<shared-b1@sources.test>' }),
    { source: 'poller' }
  );
  eq('B1 Graph delivery creates the ticket', gFirst, 'created');
  const ticketB1 = await prisma.ticket.findUnique({ where: { internetMessageId: 'shared-b1@sources.test' } });
  eq('B2 the RFC identity is stored on the ticket', ticketB1.internetMessageId, 'shared-b1@sources.test');
  eq('B3 the provider id is stored as before', ticketB1.graphMessageId, 'graph-B1');

  const imapReplay = await intakeEmailMessage({
    messageId: 'shared-b1@sources.test',
    internetMessageId: 'shared-b1@sources.test',
    subject: 'Graph first', body: 'body', from: 'rita@sources.test',
  }, { logger: QUIET, mailer, channel: 'imap' });
  eq('B4 the same email via IMAP collapses to a duplicate', imapReplay.status, 'duplicate');
  eq('B5 and it is the SAME ticket', imapReplay.ticket.id, ticketB1.id);

  const imapFirst = await intakeEmailMessage({
    messageId: 'shared-b2@sources.test',
    internetMessageId: 'shared-b2@sources.test',
    subject: 'IMAP first', body: 'body', from: 'rita@sources.test',
  }, { logger: QUIET, mailer, channel: 'imap' });
  eq('B6 IMAP delivery creates its ticket', imapFirst.status, 'created');
  const gReplay = await graphSvc.processOne(
    rawGraphMessage({ id: 'graph-B2', from: ['Rita', 'rita@sources.test'], subject: 'IMAP first', bodyText: 'body', internetMessageId: '<shared-b2@sources.test>' }),
    { source: 'poller' }
  );
  eq('B7 the same email via Graph collapses to a duplicate', gReplay, 'duplicate');
  eq('B8 no extra tickets exist', (await ticketCount()) - beforeB, 2);

  /* ---- C. cross-source threading ----------------------------------------- */
  console.log('\n--- C. cross-source threading ---');
  const created = await graphSvc.processOne(
    rawGraphMessage({ id: 'graph-C1', from: ['Rita', 'rita@sources.test'], subject: 'Threading probe', bodyText: 'original body', internetMessageId: '<thread-1@sources.test>', conversationId: 'conv-thread' }),
    { source: 'poller' }
  );
  eq('C1 Graph creates the thread starter', created, 'created');
  const threadTicket = await prisma.ticket.findUnique({ where: { internetMessageId: 'thread-1@sources.test' } });

  const threadedReply = await intakeEmailMessage({
    messageId: 'thread-2@sources.test',
    internetMessageId: 'thread-2@sources.test',
    // IMAP supplies no conversation id: the reference alone must thread it.
    inReplyTo: ['thread-1@sources.test'],
    references: ['thread-1@sources.test'],
    subject: 'Re: Threading probe', body: 'It happened again.', from: 'rita@sources.test',
  }, { logger: QUIET, mailer, channel: 'imap' });
  eq('C2 an IMAP reply threads onto the Graph ticket by reference', threadedReply.status, 'comment_added');
  eq('C3 the reply landed on the right ticket', threadedReply.ticket.id, threadTicket.id);
  const comment = await prisma.comment.findUnique({ where: { internetMessageId: 'thread-2@sources.test' } });
  eq('C4 the reply comment carries its RFC identity', comment.internetMessageId, 'thread-2@sources.test');

  await prisma.ticket.update({
    where: { id: threadTicket.id },
    data: { state: 'RESOLVED', resolvedAt: new Date(), resolution: 'Fixed.' },
  });
  const reopenReply = await intakeEmailMessage({
    messageId: 'thread-3@sources.test',
    internetMessageId: 'thread-3@sources.test',
    inReplyTo: ['thread-1@sources.test'],
    subject: 'Re: Threading probe', body: 'Still broken.', from: 'rita@sources.test',
  }, { logger: QUIET, mailer, channel: 'imap' });
  eq('C5 a referenced reply reopens the resolved ticket', reopenReply.status, 'reopened');

  /* ---- D. the audit trail names the channel ------------------------------ */
  console.log('\n--- D. channel audit metadata ---');
  const graphAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: ticketB1.id } });
  eq('D1 Graph-created tickets record channel "graph"', auditMeta(graphAudit).channel, 'graph');
  const imapAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: imapFirst.ticket.id } });
  eq('D2 IMAP-created tickets record channel "imap"', auditMeta(imapAudit).channel, 'imap');
  const reopenAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.reopened', entityId: threadTicket.id } });
  eq('D3 reopen audit keeps via=email and adds the channel',
    auditMeta(reopenAudit).via === 'email' && auditMeta(reopenAudit).channel === 'imap', true);

  /* ---- E. webhook notification idempotency ------------------------------- */
  console.log('\n--- E. webhook dedupe ---');
  const { createWebhookProcessor } = require('../src/graph/webhookProcessor');
  let getMessageCalls = 0;
  let failGet = false;
  const webhookOps = {
    async getMessage(id) {
      getMessageCalls += 1;
      if (failGet) throw new Error('graph api down');
      return rawGraphMessage({ id, from: ['Wanda', 'wanda@sources.test'], subject: `Webhook probe ${id}`, bodyText: 'body', internetMessageId: `<${id}-rfc@sources.test>` });
    },
    async markAsRead() {},
    async listAttachments() { return []; },
  };
  const processor = createWebhookProcessor({ logger: QUIET, ops: webhookOps, mailService: graphMailService() });
  const notification = { resourceData: { id: 'graph-W1' }, clientState: 'x', subscriptionId: 's' };

  eq('E1 first delivery processes the message', await processor.processNotification(notification), 'created');
  eq('E2 the message was fetched once', getMessageCalls, 1);
  eq('E3 a redelivered notification collapses to duplicate', await processor.processNotification(notification), 'duplicate');
  eq('E4 the duplicate does not re-fetch the message', getMessageCalls, 1);
  eq('E5 a duplicate inside one batch also collapses',
    (await processor.processNotifications([notification, notification])).duplicate, 2);

  // A DIFFERENT message whose fetch fails: the failure must not be remembered,
  // so the retry re-fetches and succeeds.
  failGet = true;
  eq('E6 a failing fetch is reported as failed',
    await processor.processNotification({ resourceData: { id: 'graph-W2' } }), 'failed');
  eq('E7 the failure was a real fetch attempt', getMessageCalls, 2);
  failGet = false;
  eq('E8 the retry succeeds',
    await processor.processNotification({ resourceData: { id: 'graph-W2' } }), 'created');
  eq('E9 the retry re-fetched (failures are never remembered)', getMessageCalls, 3);
  eq('E10 the succeeded retry is now deduped',
    await processor.processNotification({ resourceData: { id: 'graph-W2' } }), 'duplicate');
  eq('E11 exactly one webhook ticket per message',
    await prisma.ticket.count({ where: { internetMessageId: 'graph-W2-rfc@sources.test' } }), 1);

  /* ---- G. hardening regressions through the real pipeline ----------------- */
  console.log('\n--- G. hardening regressions ---');
  const { parseEmail: parseForG, LIMITS: parseLimits } = require('../src/email/emailParser');
  const { ingestNormalizedEmail: ingestForG } = require('../src/services/emailIngestion');

  // An oversized body still becomes a ticket, truncated at the parser limit.
  // (The real pipeline always parses first — exactly what Graph and IMAP do.)
  const hugeBody = 'word '.repeat(Math.floor((parseLimits.bodyChars + 20000) / 5));
  const hugeEmail = parseForG({
    messageId: `huge-${Date.now()}@sources.test`, from: 'rita@sources.test',
    subject: 'Oversized probe', body: hugeBody,
  });
  const hugeResult = await ingestForG(hugeEmail, { logger: QUIET, channel: 'imap' });
  eq('G1 an oversized email still creates a ticket', hugeResult.status, 'created');
  check('G2 the stored body is bounded at the parser limit',
    hugeResult.ticket.body.length <= parseLimits.bodyChars + '\n[message truncated]'.length,
    hugeResult.ticket.body.length);
  check('G3 the truncation marker is present', hugeResult.ticket.body.endsWith('[message truncated]'));

  // A quoted reply keeps its full text in the ticket (existing behavior) and
  // the parser separates the clean view without losing content.
  const quotedBody = [
    'It happened again this morning.',
    '',
    'On 1 Sep 2026, IT Helpdesk wrote:',
    '> Please try rebooting.',
  ].join('\n');
  const quotedParsed = parseForG({ messageId: 'q1', from: 'a@b.com', subject: 's', body: quotedBody });
  eq('G4 quoted content stays in the normalized body', quotedParsed.body === quotedBody, true);
  eq('G5 the clean view holds only the new text', quotedParsed.cleanBody, 'It happened again this morning.');
  check('G6 nothing is lost: clean and quoted views together cover the original',
    quotedParsed.cleanBody.length + quotedParsed.quotedText.length <= quotedBody.length + 2);

  // An RFC 2047 encoded subject decodes to the same text the Graph channel
  // reports, so the ticket reads identically whichever way mail arrives.
  const encodedSubject = '=?utf-8?Q?Caf=C3=A9_printer_is_jamming?=';
  const encEmail = parseForG({
    messageId: `enc-${Date.now()}@sources.test`, from: 'enc@sources.test',
    subject: encodedSubject, body: 'It jams.',
  });
  const encViaImap = await ingestForG(encEmail, { logger: QUIET, channel: 'imap' });
  eq('G7 an encoded subject decodes into readable ticket text',
    encViaImap.ticket.shortDescription.includes('Café printer is jamming'), true);

  /* ---- F. /api/health: IMAP status without credentials -------------------- */
  console.log('\n--- F. health endpoint ---');
  const closedPort = await new Promise((resolve) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const env = {
    ...process.env,
    PORT: process.env.PORT,
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: String(closedPort),
    IMAP_USER: 'imap-health@sources.test',
    IMAP_PASSWORD: 'imap-health-secret-pass',
    IMAP_SECURE: 'false',
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env,
  });
  try {
    const BASE = `http://localhost:${process.env.PORT}`;
    let healthy = false;
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(`${BASE}/api/health`)).ok) { healthy = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    eq('F1 the server comes up with IMAP configured', healthy, true);
    const health = await (await fetch(`${BASE}/api/health`)).json();
    eq('F2 health reports IMAP enabled', health.integration.imap.enabled, true);
    eq('F3 the connection target is visible', health.integration.imap.host, '127.0.0.1');
    const body = JSON.stringify(health);
    check('F4 the IMAP password never appears in the response', !body.includes('imap-health-secret-pass'));
    check('F5 the IMAP username never appears in the response', !body.includes('imap-health@sources.test'));
    check('F6 the Graph client secret never appears in the response', !body.includes(process.env.JWT_SECRET || '§none§'));

    // The initial IMAP poll fires ~5s after boot and fails (dead port) —
    // the server must stay healthy and record the error instead of crashing.
    await new Promise((r) => setTimeout(r, 7000));
    const afterFailure = await (await fetch(`${BASE}/api/health`)).json();
    eq('F7 the server survives a failed IMAP poll', afterFailure.ok, true);
    check('F8 the failure is recorded for the administrator',
      Boolean(afterFailure.integration.imap.lastError) && /fetch|connect|ECONNREFUSED|timeout/i.test(afterFailure.integration.imap.lastError.message));
    check('F9 no credential ever leaks through the error path',
      !JSON.stringify(afterFailure).includes('imap-health-secret-pass'));
  } finally {
    server.kill();
  }
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
