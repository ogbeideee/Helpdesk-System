/* Email ingestion tests: normalized email -> existing ticket pipeline.

   Exercises the real database and the real intake/assignment code. No
   Microsoft Graph, no credentials, no network.

   Usage: npm run test:ingest  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's dev.db.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('ingest');

const prisma = require('./../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');
const { parseEmail } = require('../src/email/emailParser');
const { ingestRawEmail, ingestNormalizedEmail, toIntakePayload } =
  require('../src/services/emailIngestion');

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

const MARK = 'ingest-test-';
const DOMAIN = 'ingest.example';
const quiet = { log() {}, warn() {}, error() {} };

/** Build a raw simulated email in the dev/provider-agnostic format. */
function rawEmail({ id, from, name, subject, body, html, conversationId }) {
  return {
    messageId: `${MARK}${id}`,
    conversationId: conversationId || `${MARK}conv-${id}`,
    from: { name: name || null, email: from },
    subject,
    body: html || body || '',
    bodyType: html ? 'html' : 'text',
    receivedAt: new Date().toISOString(),
    attachments: [],
  };
}

const ingest = (raw) => ingestRawEmail(raw, { logger: quiet });

async function cleanup() {
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { graphMessageId: { startsWith: MARK } },
        { requesterEmail: { endsWith: `@${DOMAIN}` } },
      ],
    },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
  await prisma.comment.deleteMany({ where: { graphMessageId: { startsWith: MARK } } });
  await prisma.agent.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
}

async function main() {
  await ensureTeams(prisma);
  // The application seeds these on every start, so the routing decisions
  // exercised below are the ones a real install actually makes.
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  await cleanup();

  // A deterministic senior agent in "accounts" so Password Reset routing has a
  // predictable target. Existing agents are pushed back in the round-robin.
  const accounts = await prisma.team.findUnique({ where: { key: 'accounts' } });
  const agent = await prisma.agent.create({
    data: {
      name: 'Ingest Test Agent',
      email: `agent@${DOMAIN}`,
      isActive: true,
      teamId: accounts.id,
      skillLevel: 3,
      passwordHash: 'x',
      lastAssignedAt: null,
    },
  });
  await prisma.agent.updateMany({
    where: { teamId: accounts.id, email: { not: agent.email } },
    data: { lastAssignedAt: new Date() },
  });

  /* ================================================================ */
  /* 1. New email -> new ticket                                       */
  /* ================================================================ */
  let firstTicket;
  {
    const { email, result } = await ingest(
      rawEmail({
        id: 'new-1',
        from: `olivia@${DOMAIN}`,
        name: 'Olivia Stone',
        subject: 'Forgot my password and cannot sign in',
        html: '<p>Hello IT,</p><p>I forgot my password and cannot sign in.</p>',
      })
    );

    eq('new email: status is created', result.status, 'created');
    firstTicket = result.ticket;
    check('new email: ticket created', Boolean(firstTicket));

    // Field mapping from the normalized model (requirement 2)
    eq('mapping: subject -> shortDescription', firstTicket.shortDescription, 'Forgot my password and cannot sign in');
    eq('mapping: body -> body', firstTicket.body, 'Hello IT,\n\nI forgot my password and cannot sign in.');
    eq('mapping: senderEmail -> requesterEmail', firstTicket.requesterEmail, `olivia@${DOMAIN}`);
    eq('mapping: senderName -> requesterName', firstTicket.requesterName, 'Olivia Stone');
    eq('mapping: messageId -> graphMessageId', firstTicket.graphMessageId, `${MARK}new-1`);
    eq('mapping: conversationId -> graphConversationId', firstTicket.graphConversationId, `${MARK}conv-new-1`);
    check('new email: HTML was converted (no markup in ticket body)', !/<[^>]+>/.test(firstTicket.body));

    // Existing numbering system (requirement 2)
    check('numbering: existing scheme used', /^INC-\d{6}$/.test(firstTicket.ticketNumber), firstTicket.ticketNumber);

    // 7. Category classification still works
    eq('classification: Password Reset', firstTicket.category, 'Password Reset');
    eq('classification: default intake priority', firstTicket.priority, 'moderate');
    eq('classification: initial state', firstTicket.state, 'NEW');

    // 8. Assignment still works
    eq('assignment: routed to accounts group', firstTicket.teamId, accounts.id);
    eq('assignment: engine picked the eligible agent', firstTicket.assignedAgentId, agent.id);
    check('assignment: result reported', result.assignment && result.assignment.groupKey === 'accounts', JSON.stringify(result.assignment));

    // 9. Audit log still works
    const audits = await prisma.ticketAuditLog.findMany({ where: { ticketId: firstTicket.id }, orderBy: { id: 'asc' } });
    eq('audit: one entry on creation', audits.length, 1);
    check('audit: NEW state recorded', audits[0].toState === 'NEW' && audits[0].fromState === null);
    check('audit: routing captured in the note', audits[0].note.includes('Ingest Test Agent'), audits[0].note);

    // parser output is surfaced alongside the ticket
    eq('parser: normalized email returned', email.messageId, `${MARK}new-1`);
    eq('parser: isHtml recorded', email.isHtml, true);
  }

  /* ================================================================ */
  /* 2. Reply identified by ticket number -> activity                 */
  /* ================================================================ */
  {
    const { result } = await ingest(
      rawEmail({
        id: 'reply-number',
        from: `olivia@${DOMAIN}`,
        name: 'Olivia Stone',
        subject: `RE: [${firstTicket.ticketNumber}] Forgot my password and cannot sign in`,
        body: 'Any update on this please?',
        conversationId: `${MARK}unrelated-conversation`,
      })
    );

    eq('ticket-number reply: status is comment_added', result.status, 'comment_added');
    eq('ticket-number reply: attached to the original ticket', result.ticket.id, firstTicket.id);
    check('ticket-number reply: activity created', Boolean(result.comment));
    check('ticket-number reply: marked as requester + via email', result.comment.isRequester === true && result.comment.viaEmail === true);
    eq('ticket-number reply: body stored', result.comment.body, 'Any update on this please?');
    eq('ticket-number reply: messageId stamped on the activity', result.comment.graphMessageId, `${MARK}reply-number`);

    const madeTicket = await prisma.ticket.count({ where: { graphMessageId: `${MARK}reply-number` } });
    eq('ticket-number reply: no second ticket created', madeTicket, 0);
    eq('ticket-number reply: state unchanged (still NEW)', result.ticket.state, 'NEW');
  }

  /* ================================================================ */
  /* 3. Reply identified by conversation id -> activity               */
  /* ================================================================ */
  {
    const { result } = await ingest(
      rawEmail({
        id: 'reply-conv',
        from: `olivia@${DOMAIN}`,
        name: 'Olivia Stone',
        // No ticket number anywhere — only the conversation id matches.
        subject: 'One more thing about my sign-in problem',
        body: 'It also happens on my phone.',
        conversationId: `${MARK}conv-new-1`,
      })
    );

    eq('conversation reply: status is comment_added', result.status, 'comment_added');
    eq('conversation reply: matched the right ticket', result.ticket.id, firstTicket.id);
    check('conversation reply: activity created', Boolean(result.comment));
    eq('conversation reply: no new ticket', await prisma.ticket.count({ where: { graphMessageId: `${MARK}reply-conv` } }), 0);

    // A different requester on the same conversation must NOT thread in.
    const { result: stranger } = await ingest(
      rawEmail({
        id: 'reply-conv-stranger',
        from: `someone.else@${DOMAIN}`,
        name: 'Someone Else',
        subject: 'Unrelated laptop problem',
        body: 'My laptop battery drains quickly.',
        conversationId: `${MARK}conv-new-1`,
      })
    );
    eq('conversation reply: different requester creates its own ticket', stranger.status, 'created');
    check('conversation reply: stranger ticket is separate', stranger.ticket.id !== firstTicket.id);
  }

  /* ================================================================ */
  /* 4. Duplicate messageId -> ignored                                */
  /* ================================================================ */
  {
    const ticketsBefore = await prisma.ticket.count();
    const commentsBefore = await prisma.comment.count();

    // Replay the original new-ticket email.
    const { result: dupTicket } = await ingest(
      rawEmail({
        id: 'new-1',
        from: `olivia@${DOMAIN}`,
        name: 'Olivia Stone',
        subject: 'Forgot my password and cannot sign in',
        html: '<p>Hello IT,</p><p>I forgot my password and cannot sign in.</p>',
      })
    );
    eq('duplicate: replayed new-ticket email is a duplicate', dupTicket.status, 'duplicate');
    eq('duplicate: resolves to the original ticket', dupTicket.ticket.id, firstTicket.id);
    // The duplicate path must report the ticket as it really is: still routed
    // and still assigned, not looking like an untriaged ticket.
    eq('duplicate: reported ticket keeps its group', dupTicket.ticket.teamId, accounts.id);
    eq('duplicate: reported ticket keeps its agent', dupTicket.ticket.assignedAgentId, agent.id);
    check('duplicate: team relation hydrated', dupTicket.ticket.team && dupTicket.ticket.team.key === 'accounts', JSON.stringify(dupTicket.ticket.team));
    check('duplicate: agent relation hydrated', dupTicket.ticket.assignedAgent && dupTicket.ticket.assignedAgent.email === agent.email);

    // Replay the reply email.
    const { result: dupReply } = await ingest(
      rawEmail({
        id: 'reply-number',
        from: `olivia@${DOMAIN}`,
        name: 'Olivia Stone',
        subject: `RE: [${firstTicket.ticketNumber}] Forgot my password and cannot sign in`,
        body: 'Any update on this please?',
      })
    );
    eq('duplicate: replayed reply is a duplicate', dupReply.status, 'duplicate');

    eq('duplicate: no ticket was created', await prisma.ticket.count(), ticketsBefore);
    eq('duplicate: no activity was created', await prisma.comment.count(), commentsBefore);
    eq('duplicate: still exactly one ticket for that messageId', await prisma.ticket.count({ where: { graphMessageId: `${MARK}new-1` } }), 1);
    eq('duplicate: still exactly one activity for that messageId', await prisma.comment.count({ where: { graphMessageId: `${MARK}reply-number` } }), 1);

    // Ten replays in a row change nothing.
    for (let i = 0; i < 10; i++) {
      await ingest(
        rawEmail({
          id: 'new-1',
          from: `olivia@${DOMAIN}`,
          name: 'Olivia Stone',
          subject: 'Forgot my password and cannot sign in',
          html: '<p>Hello IT,</p><p>I forgot my password and cannot sign in.</p>',
        })
      );
    }
    eq('duplicate: ten replays are a no-op', await prisma.ticket.count(), ticketsBefore);
  }

  /* ================================================================ */
  /* 5. Requester reply to a RESOLVED ticket -> reopen                */
  /* ================================================================ */
  {
    const { result: created } = await ingest(
      rawEmail({
        id: 'resolved-base',
        from: `farid@${DOMAIN}`,
        name: 'Farid Osman',
        subject: 'Docking station will not charge',
        body: 'No power through the dock.',
      })
    );
    const target = created.ticket;

    await prisma.ticket.update({
      where: { id: target.id },
      data: { state: 'RESOLVED', resolvedAt: new Date(), resolution: 'Replaced the dock.' },
    });

    const auditsBefore = await prisma.ticketAuditLog.count({ where: { ticketId: target.id } });

    const { result: reply } = await ingest(
      rawEmail({
        id: 'resolved-reply',
        from: `farid@${DOMAIN}`,
        name: 'Farid Osman',
        subject: `Re: [${target.ticketNumber}] Docking station will not charge`,
        body: 'It stopped working again this morning.',
      })
    );

    eq('resolved reply: status is reopened', reply.status, 'reopened');
    eq('resolved reply: state back to IN_PROGRESS', reply.ticket.state, 'IN_PROGRESS');
    check('resolved reply: activity recorded', Boolean(reply.comment));

    const fresh = await prisma.ticket.findUnique({ where: { id: target.id } });
    check('resolved reply: resolution cleared by existing rules', fresh.resolvedAt === null && fresh.resolution === null);

    const audits = await prisma.ticketAuditLog.findMany({ where: { ticketId: target.id }, orderBy: { id: 'desc' }, take: 1 });
    eq('resolved reply: audit entry added', await prisma.ticketAuditLog.count({ where: { ticketId: target.id } }), auditsBefore + 1);
    check('resolved reply: audit shows RESOLVED -> IN_PROGRESS', audits[0].fromState === 'RESOLVED' && audits[0].toState === 'IN_PROGRESS', JSON.stringify(audits[0]));
    check('resolved reply: audit note names the reopen rule', audits[0].note === 'Reopened by requester reply', audits[0].note);
    eq('resolved reply: audit actor is the requester', audits[0].actor, `farid@${DOMAIN}`);
  }

  /* ================================================================ */
  /* 6. Requester reply to a CLOSED ticket -> reopen                  */
  /* ================================================================ */
  {
    const { result: created } = await ingest(
      rawEmail({
        id: 'closed-base',
        from: `greta@${DOMAIN}`,
        name: 'Greta Lindqvist',
        subject: 'OneDrive sync stuck again',
        body: 'Sync has not moved for two days.',
      })
    );
    const target = created.ticket;

    await prisma.ticket.update({
      where: { id: target.id },
      data: { state: 'CLOSED', resolvedAt: new Date(), closedAt: new Date(), resolution: 'Client reset.' },
    });

    const { result: reply } = await ingest(
      rawEmail({
        id: 'closed-reply',
        from: `greta@${DOMAIN}`,
        name: 'Greta Lindqvist',
        subject: `RE: [${target.ticketNumber}] OneDrive sync stuck again`,
        body: 'This is happening again.',
      })
    );

    eq('closed reply: status is reopened', reply.status, 'reopened');
    eq('closed reply: state back to IN_PROGRESS', reply.ticket.state, 'IN_PROGRESS');

    const fresh = await prisma.ticket.findUnique({ where: { id: target.id } });
    check('closed reply: closedAt cleared', fresh.closedAt === null && fresh.resolvedAt === null);
    eq('closed reply: no new ticket created', await prisma.ticket.count({ where: { graphMessageId: `${MARK}closed-reply` } }), 0);

    const audits = await prisma.ticketAuditLog.findMany({ where: { ticketId: target.id }, orderBy: { id: 'desc' }, take: 1 });
    check('closed reply: audit shows CLOSED -> IN_PROGRESS', audits[0].fromState === 'CLOSED' && audits[0].toState === 'IN_PROGRESS');

    // Reopening twice from one message must not double up.
    const { result: replay } = await ingest(
      rawEmail({
        id: 'closed-reply',
        from: `greta@${DOMAIN}`,
        name: 'Greta Lindqvist',
        subject: `RE: [${target.ticketNumber}] OneDrive sync stuck again`,
        body: 'This is happening again.',
      })
    );
    eq('closed reply: replay is a duplicate, not a second reopen', replay.status, 'duplicate');
    eq('closed reply: exactly one activity for that message', await prisma.comment.count({ where: { graphMessageId: `${MARK}closed-reply` } }), 1);
  }

  /* ================================================================ */
  /* 7. Classification across categories                              */
  /* ================================================================ */
  {
    const cases = [
      ['cls-hw', 'Laptop screen cracked after a drop', 'The screen is physically damaged.', 'Hardware'],
      ['cls-sw', 'Outlook keeps crashing on launch', 'The application closes immediately.', 'Software'],
      ['cls-pw', 'Need a password reset for my account', 'Locked out after too many attempts.', 'Password Reset'],
    ];
    for (const [id, subject, body, expected] of cases) {
      const { result } = await ingest(
        rawEmail({ id, from: `cls.${id}@${DOMAIN}`, name: 'Class Tester', subject, body })
      );
      eq(`classification: "${subject.slice(0, 34)}…" -> ${expected}`, result.ticket.category, expected);
      check(`classification: ${expected} routed to a group`, result.ticket.teamId !== null);
    }
  }

  /* ================================================================ */
  /* 8. Separation of concerns + mapping contract                     */
  /* ================================================================ */
  {
    const normalized = parseEmail(
      rawEmail({ id: 'contract', from: `c@${DOMAIN}`, name: 'C Tester', subject: 'Contract check', body: 'Body text.' })
    );
    const payload = toIntakePayload(normalized);
    eq('contract: payload keys', Object.keys(payload).sort().join(','), 'body,conversationId,from,messageId,name,subject');
    check('contract: mapper adds no ticket fields', !('category' in payload) && !('priority' in payload) && !('state' in payload));

    // Ingesting an already-normalized email works without re-parsing.
    const direct = await ingestNormalizedEmail(normalized, { logger: quiet });
    eq('contract: ingestNormalizedEmail creates a ticket', direct.status, 'created');
    check('contract: attachments carried through', Array.isArray(direct.attachments));
  }

  /* ================================================================ */
  /* 9. Invalid input is rejected before touching the database        */
  /* ================================================================ */
  {
    const ticketsBefore = await prisma.ticket.count();
    let threw = null;
    try {
      await ingest({ subject: 'no ids', body: 'x' });
    } catch (err) {
      threw = err;
    }
    check('invalid: unparseable email throws before ingestion', threw !== null && Array.isArray(threw.errors));
    eq('invalid: no ticket created', await prisma.ticket.count(), ticketsBefore);

    // Parses fine, but intake rejects it (no subject).
    let threw2 = null;
    try {
      await ingest(rawEmail({ id: 'no-subject', from: `x@${DOMAIN}`, name: 'X', subject: '', body: 'body only' }));
    } catch (err) {
      threw2 = err;
    }
    check('invalid: subject-less email rejected by intake', threw2 !== null && threw2.errors.some((e) => e.includes('subject')), threw2 ? threw2.message : 'no throw');
    eq('invalid: still no ticket created', await prisma.ticket.count(), ticketsBefore);
  }

  await cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
