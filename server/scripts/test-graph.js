/* Microsoft Graph integration tests — no real credentials required.
   The MSAL application and the Graph transport are mocked; the ticket
   intake pipeline runs against the real database.

   Usage: npm run test:graph  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's dev.db.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('graph');

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

/* ------------------------------------------------------------------ */
/* Fake Graph transport (stands in for graphClient.js ops)             */
/* ------------------------------------------------------------------ */
function makeFakeOps(messages) {
  const calls = { listUnread: 0, markAsRead: [], failMarkReadFor: null };
  return {
    calls,
    async listUnreadMessages(top = 25) {
      calls.listUnread += 1;
      return messages.filter((m) => !m.isRead).slice(0, top);
    },
    async markAsRead(messageId) {
      if (calls.failMarkReadFor === messageId) {
        throw new Error('simulated markAsRead outage');
      }
      const m = messages.find((x) => x.id === messageId);
      if (m) m.isRead = true;
      calls.markAsRead.push(messageId);
    },
  };
}

function rawGraphMessage({ id, from, subject, bodyText, html, conversationId }) {
  return {
    id,
    conversationId: conversationId || `conv-${id}`,
    subject,
    from: { emailAddress: from ? { name: from[0], address: from[1] } : {} },
    body: html
      ? { contentType: 'html', content: html }
      : { contentType: 'text', content: bodyText || '' },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  };
}

const MARK = 'gtest-';

async function main() {
  await ensureTeams(prisma);
  // The application seeds these on every start, so routing here matches
  // what a real install does.
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  // A deterministic eligible agent in accounts (password-reset emails).
  const agent = await prisma.agent.upsert({
    where: { email: `${MARK}agent@example.com` },
    create: {
      name: `${MARK}Agent`,
      email: `${MARK}agent@example.com`,
      isActive: true,
      teamId: (await prisma.team.findUnique({ where: { key: 'accounts' } })).id,
      skillLevel: 3,
      passwordHash: 'x',
    },
    update: { isActive: true, skillLevel: 3 },
  });
  await prisma.agent.updateMany({
    where: { teamId: agent.teamId, email: { not: agent.email } },
    data: { lastAssignedAt: new Date('2020-01-01T00:00:00Z') },
  });
  await prisma.agent.update({ where: { id: agent.id }, data: { lastAssignedAt: null } });

  /* ================================================================== */
  /* 1. Authentication: acquisition, caching, expiry-driven renewal     */
  /* ================================================================== */
  {
    const tokenModule = require('../src/graph/msalToken');
    tokenModule._resetTokenCache();

    let acquisitions = 0;
    let expiresAt = Date.now() + 3600 * 1000; // valid for an hour
    tokenModule._injectAuthClient(() => ({
      async acquireTokenByClientCredential() {
        acquisitions += 1;
        return { accessToken: `token-${acquisitions}`, expiresOn: new Date(expiresAt) };
      },
    }));

    const t1 = await tokenModule.getAccessToken();
    const t2 = await tokenModule.getAccessToken();
    check('token acquired via client credentials', t1 === 'token-1');
    check('token cached across calls (no re-acquisition)', t2 === 'token-1' && acquisitions === 1);

    // Simulate expiry: push the cached token inside the 5-minute renewal margin.
    const cache = tokenModule._peekCache();
    cache.expiresAtMs = Date.now() + 60 * 1000;
    const t3 = await tokenModule.getAccessToken();
    check('near-expiry token triggers renewal', t3 === 'token-2' && acquisitions === 2);

    // forceRefresh bypasses the cache even when the token looks fresh.
    const t4 = await tokenModule.getAccessToken({ forceRefresh: true });
    check('forceRefresh bypasses cache (401 recovery path)', t4 === 'token-3' && acquisitions === 3);

    tokenModule._resetTokenCache();
  }

  /* ================================================================== */
  /* 2. Email normalization                                             */
  /* ================================================================== */
  {
    const { createMailService } = require('../src/graph/mailService');
    const svc = createMailService({ ops: makeFakeOps([]) });
    const n = svc.normalizeMessage(
      rawGraphMessage({
        id: 'abc123',
        from: ['Jane Doe', 'jane@company.com'],
        subject: '  My laptop will not start  ',
        html: '<html><body><div>Laptop dead since Monday.</div><p>&amp; urgent</p></body></html>',
        conversationId: 'conv-xyz',
      })
    );
    check('normalizes message id + conversation id', n.messageId === 'abc123' && n.conversationId === 'conv-xyz');
    check('extracts sender address and display name', n.senderEmail === 'jane@company.com' && n.senderName === 'Jane Doe');
    check('trims subject', n.subject === 'My laptop will not start');
    check('converts HTML body to text', n.body.includes('Laptop dead since Monday.') && !/<\w+>/.test(n.body) && n.body.includes('& urgent'));
  }

  /* ================================================================== */
  /* 3–5. New email -> ticket; unread processing; read-marking; dedupe  */
  /* ================================================================== */
  let mailSvc;
  const inbox = [];
  {
    const ops = makeFakeOps(inbox);
    const { createMailService } = require('../src/graph/mailService');
    mailSvc = createMailService({ ops });

    inbox.push(
      rawGraphMessage({
        id: `${MARK}m1`,
        from: ['Olivia Stone', 'olivia@company.com'],
        subject: 'Forgot my password again',
        bodyText: 'Cannot sign in since the weekend reset.',
      }),
      rawGraphMessage({
        id: `${MARK}m-html`,
        from: ['Ben Ray', 'ben@company.com'],
        subject: 'Printer offline',
        html: '<html><body><p>Printer shows offline on 3rd floor.</p></body></html>',
      })
    );

    const summary = await mailSvc.pollUnread();
    check('poll lists only unread messages', ops.calls.listUnread >= 1);
    check('both new emails became tickets', summary.created === 2, JSON.stringify(summary));

    const t1 = await prisma.ticket.findUnique({ where: { graphMessageId: `${MARK}m1` } });
    check('ticket created from normalized email', Boolean(t1));
    check('classified as Password Reset by keyword rules', t1.category === 'Password Reset', t1.category);
    check('priority MODERATE + state NEW', t1.priority === 'moderate' && t1.state === 'NEW');
    check('assignment engine attached an agent', t1.assignedAgentId !== null);
    check('processed message marked as read', ops.calls.markAsRead.includes(`${MARK}m1`));

    const t2 = await prisma.ticket.findUnique({ where: { graphMessageId: `${MARK}m-html` } });
    check('HTML email created a ticket with text body', Boolean(t2) && t2.body.includes('3rd floor'));

    // Re-delivery of the same message id must not duplicate.
    const m1 = inbox.find((m) => m.id === `${MARK}m1`);
    m1.isRead = false; // simulate the mailbox reporting it unread again
    const summary2 = await mailSvc.pollUnread();
    check('duplicate messageId never creates a second ticket', summary2.created === 0 && summary2.duplicate === 1);
    const dupCount = await prisma.ticket.count({ where: { graphMessageId: `${MARK}m1` } });
    check('still exactly one ticket for that message', dupCount === 1);
  }

  /* ================================================================== */
  /* 6. Failed processing leaves the message unread (retry next cycle)  */
  /* ================================================================== */
  {
    let attempt = 0;
    // The Graph path now hands a NormalizedEmail to the shared ingestion
    // service, so the injected double receives that shape.
    const flakyIntake = async (email) => {
      if (email.messageId === `${MARK}m-flaky` && attempt === 0) {
        attempt += 1;
        throw new Error('transient database hiccup');
      }
      attempt += 1;
      return require('../src/services/emailIngestion').ingestNormalizedEmail(email);
    };
    const ops = makeFakeOps(inbox);
    const { createMailService } = require('../src/graph/mailService');
    const svc = createMailService({ ops, intake: flakyIntake });

    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-flaky`,
        from: ['Cara Holt', 'cara@company.com'],
        subject: 'VPN drops every few minutes',
        bodyText: 'Constant disconnects.',
      })
    );

    const s1 = await svc.pollUnread();
    check('failed cycle reports failure and does NOT mark read', s1.failed === 1 && !ops.calls.markAsRead.includes(`${MARK}m-flaky`));
    check(
      'failed message produced no ticket yet',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m-flaky` } })) === 0
    );

    const s2 = await svc.pollUnread();
    check('message retried on next cycle and succeeded', s2.created === 1 && ops.calls.markAsRead.includes(`${MARK}m-flaky`));
    check('ticket exists after successful retry', (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m-flaky` } })) === 1);
  }

  /* ================================================================== */
  /* 7. Ticket-number replies are skipped (threading deferred)          */
  /* ================================================================== */
  {
    const ops = makeFakeOps(inbox);
    const { createMailService } = require('../src/graph/mailService');
    const svc = createMailService({ ops });

    const existing = await prisma.ticket.findFirst({
      where: { graphMessageId: `${MARK}m1` },
    });

    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-reply-tagged`,
        from: ['Olivia Stone', 'olivia@company.com'],
        subject: `RE: [${existing.ticketNumber}] Forgot my password again`,
        bodyText: 'Any update on this?',
      })
    );

    const beforeComments = await prisma.comment.count({ where: { ticketId: existing.id } });
    const s = await svc.pollUnread();
    // Reply handling is live now: a [INC-…] subject threads the mail onto the
    // existing ticket as an activity instead of being skipped.
    check('reply with existing [INC-…] subject becomes an activity', s.comment_added === 1, JSON.stringify(s));
    check(
      'reply appended exactly one comment to the ticket',
      (await prisma.comment.count({ where: { ticketId: existing.id } })) === beforeComments + 1
    );
    check(
      'no new ticket from the reply',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m-reply-tagged` } })) === 0
    );
    check('reply marked read so it is not re-fetched', ops.calls.markAsRead.includes(`${MARK}m-reply-tagged`));

    // A reference to a NON-existing ticket number is treated as new email.
    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-bogus-ref`,
        from: ['Nate Wolf', 'nate@company.com'],
        subject: '[INC-999999] monitor arm request',
        bodyText: 'Requesting a second monitor arm.',
      })
    );
    const s2 = await svc.pollUnread();
    check('non-existent ticket number in subject is NOT treated as a reply', s2.created === 1);
  }

  /* ================================================================== */
  /* 8. Permanently invalid mail is rejected once (not retried forever) */
  /* ================================================================== */
  {
    const ops = makeFakeOps(inbox);
    const { createMailService } = require('../src/graph/mailService');
    const svc = createMailService({ ops });
    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-nosender`,
        from: null,
        subject: 'no sender system notice',
        bodyText: '?',
      })
    );
    const s = await svc.pollUnread();
    check('invalid message rejected without ticket', s.rejected === 1 && ops.calls.markAsRead.includes(`${MARK}m-nosender`));
  }

  /* ================================================================== */
  /* 9. Missing Graph configuration -> disabled, never crashes          */
  /* ================================================================== */
  {
    const { graphConfig, logGraphStatus } = require('../src/graph/config');
    const lines = [];
    logGraphStatus((l) => lines.push(l));
    check(
      'missing credentials log the exact disabled line',
      lines.some((l) => l === 'Microsoft Graph integration disabled.')
    );
    check('graphConfig.enabled is false without credentials', graphConfig.enabled === false);

    // startPolling must return early without throwing or scheduling work.
    const poller = require('../src/graph/poller');
    let threw = null;
    try {
      poller.startPolling();
      poller.stopPolling();
    } catch (err) {
      threw = err;
    }
    check('poller starts/stops cleanly while disabled', threw === null);
  }

  /* ---- cleanup ------------------------------------------------------- */
  const tickets = await prisma.ticket.findMany({
    where: { graphMessageId: { startsWith: MARK } },
    select: { id: true },
  });
  for (const tk of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: tk.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: tk.id } });
    await prisma.ticket.delete({ where: { id: tk.id } }).catch(() => {});
  }
  await prisma.agent.delete({ where: { id: agent.id } }).catch(() => {});

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
