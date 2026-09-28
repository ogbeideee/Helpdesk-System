/* Requester self-service ticket status (routes/public.js + email/statusLink.js).

   Covers against the REAL server over an isolated database:
     A. token round-trip — make/verify, tamper rejection, wrong email/id
     B. statusUrl — only with PORTAL_BASE_URL and a requester email
     C. the HTTP endpoint — valid token answers the public ticket shape;
        forged/unknown tokens are 404; no body, comments or agent details leak
     D. no requester or internal mail carries a self-service status link
     E. the endpoint is rate-limited per IP */

process.env.PORT = process.env.PORT || '4197';
process.env.PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || 'https://portal.test';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('status-link');

const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const statusLink = require('../src/email/statusLink');
const outbound = require('../src/email/outbound');

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

const MARK = 'status-test-';

async function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`http://localhost:${process.env.PORT}/api/health`)).ok) return proc; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

async function stopServer(proc) {
  proc.kill();
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
}

(async () => {
  const ticket = await prisma.ticket.create({
    data: {
      ticketNumber: `${MARK}001`,
      shortDescription: 'Printer on fire',
      body: 'The printer in accounts is on fire.',
      category: 'Hardware',
      priority: 'high',
      state: 'IN_PROGRESS',
      requesterEmail: 'requester@status.test',
      requesterName: 'Ruth Requester',
    },
  });

  /* ---- A. token round-trip -------------------------------------------- */
  console.log('\n--- A. signed tokens ---');
  const token = statusLink.makeToken(ticket.id, 'requester@status.test');
  check('A1 a fresh token verifies', Boolean(statusLink.verifyToken(token)));
  eq('A2 the claims carry the ticket id', statusLink.verifyToken(token).ticketId, ticket.id);
  eq('A3 emails compare case-insensitively on verify input',
    statusLink.verifyToken(statusLink.makeToken(ticket.id, 'REQUESTER@status.test')) !== null, true);
  eq('A4 a tampered signature is rejected', statusLink.verifyToken(`${token}x`), null);
  eq('A5 a mangled token is rejected', statusLink.verifyToken('not-a-token'), null);
  eq('A6 an empty token is rejected', statusLink.verifyToken(''), null);

  /* ---- B. statusUrl gating ---------------------------------------------- */
  console.log('\n--- B. statusUrl ---');
  check('B1 the url points into the portal status page',
    statusLink.statusUrl(ticket) === `https://portal.test/#/status/${token}`);
  eq('B2 no requester email → no link', statusLink.statusUrl({ id: 1, requesterEmail: null }), null);

  /* ---- C. the HTTP endpoint -------------------------------------------- */
  console.log('\n--- C. public endpoint ---');
  const server = await startServer();
  const okRes = await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status?token=${encodeURIComponent(token)}`);
  const okBody = await okRes.json();
  eq('C1 a valid token answers 200', okRes.status, 200);
  eq('C2 it returns the ticket number', okBody.ticketNumber, ticket.ticketNumber);
  eq('C3 it returns the live state', okBody.state, 'IN_PROGRESS');
  check('C4 no body text is exposed', !('body' in okBody));
  check('C5 no comments are exposed', !('comments' in okBody));
  check('C6 no agent fields are exposed',
    !('assignedAgentId' in okBody) && !('assignedAgent' in okBody));
  eq('C7 a forged token is 404',
    (await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status?token=forged.token`)).status, 404);
  eq('C8 a missing token is 404',
    (await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status`)).status, 404);
  // Valid signature, wrong email → the ticket lookup must not match.
  const wrongEmail = statusLink.makeToken(ticket.id, 'someone-else@status.test');
  eq('C9 a token for a different requester is 404',
    (await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status?token=${encodeURIComponent(wrongEmail)}`)).status, 404);
  // Valid signature, ticket id that does not exist.
  const wrongTicket = statusLink.makeToken(999999, 'requester@status.test');
  eq('C10 a token for an unknown ticket is 404',
    (await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status?token=${encodeURIComponent(wrongTicket)}`)).status, 404);

  /* ---- D. no email carries a self-service link -------------------------- */
  console.log('\n--- D. requester emails are link-free ---');
  const ack = outbound.ticketAcknowledgementMail(ticket);
  check('D1 the acknowledgement carries no status link', !ack.body.includes('#/status/'));
  check('D2 the acknowledgement carries no URL at all', !/https?:\/\//.test(ack.body));
  const update = outbound.statusUpdateMail({ ...ticket, state: 'RESOLVED' });
  check('D3 the status update carries no status link', !update.body.includes('#/status/'));
  // The ticket number is the only handle a requester gets — reply to the mail.
  check('D4 the acknowledgement still names the ticket', ack.body.includes(ticket.ticketNumber));
  // Internal mails are link-free for the same reason.
  const broadcast = outbound.newTicketBroadcastMail(ticket);
  check('D5 the internal broadcast carries no link', !/https?:\/\/|#\/status\//.test(broadcast.body));

  /* ---- E. rate limiting -------------------------------------------------- */
  console.log('\n--- E. rate limiting ---');
  // 30 requests per window per IP; the loop above used ~12, so pad to the cap.
  let last;
  for (let i = 0; i < 30; i++) {
    last = await fetch(`http://localhost:${process.env.PORT}/api/public/ticket-status?token=forged.${i}`);
  }
  eq('E1 repeated probing is eventually 429', last.status, 429);

  await stopServer(server);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
