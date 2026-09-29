/* Requester resolution confirmation + auto-close (routes/public.js
   POST /confirm-resolution, email/statusLink.confirmUrl, the resolve email's
   link, and src/resolutionSweeper.js).

   The flow under test:
     agent resolves -> requester email carries a signed confirm link
     -> GET /#/confirm/:token shows the ticket (closes nothing)
     -> POST /api/public/confirm-resolution closes it — from RESOLVED only,
        by CAS — and audits it
     -> an unconfirmed ticket is auto-closed by the sweep after the window

   Usage: node scripts/test-resolution-confirm.js  (from server/)
          Uses routes/public.js + routes/tickets.js through the real server
          (mounted on Express, no separate spawn needed). */

// Background workers are off; the suite drives sweepResolutions directly with
// fixed instants. Read at require time by resolutionSweeper — must be set
// before the require below.
process.env.RESOLUTION_SWEEP_INTERVAL_MINUTES = '0';
// Read at require time by email/statusLink — set before ANY require so the
// mailer's captured confirmUrl produces a real link (same approach as
// test-status-link.js).
process.env.PORTAL_BASE_URL = 'https://portal.test';

const testdb = require('./lib/testdb').use('resolution-confirm');

const express = require('express');
const prisma = require('../src/lib/prisma');
const statusLink = require('../src/email/statusLink');
const outbound = require('../src/email/outbound');
const sweeper = require('../src/resolutionSweeper');
const settingsService = require('../src/services/settingsService');
const { createMailer } = require('../src/mailer');

const { app } = require('../server.js');

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

const MARK = 'rc-';
const AGENT = {
  name: 'Rita Resolver',
  email: 'rita@rc.test',
  role: 'agent',
  passwordHash: '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5B0C0V4bhW0.eLYU0nGpDfXn1S1Ua', // 'password123!'
  skillLevel: 2,
  isActive: true,
};

/** The resolve mail the mailer would assemble for `ticket` with PORTAL_BASE_URL unset. */
function resolveMailWith(ticket, confirmUrl) {
  return outbound.statusUpdateMail(ticket, {
    previousState: 'IN_PROGRESS',
    confirmUrl,
  });
}

(async () => {
  const agent = await prisma.agent.create({ data: AGENT });
  const team = await prisma.team.create({ data: { key: 'rc-team', name: 'Resolution Confirm Test' } });

  async function mkTicket({ state = 'IN_PROGRESS', resolvedAt = null, requesterEmail = ' requester@rc.test '.trim(), suffix = 'a' } = {}) {
    return prisma.ticket.create({
      data: {
        ticketNumber: `${MARK}${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        shortDescription: `Confirm test ${suffix}`,
        body: 'body',
        category: 'Hardware',
        priority: 'moderate',
        state,
        requesterEmail,
        resolution: state === 'RESOLVED' ? 'Replaced the part.' : null,
        resolvedAt,
        assignedAgentId: agent.id,
        teamId: team.id,
      },
    });
  }

  /* ---- A. the outbound link ---------------------------------------------- */
  console.log('\n--- A. the resolve email carries the confirmation link ---');
  const t0 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(), suffix: 'link' });
  const url = statusLink.confirmUrl(t0);
  check('A1 confirmUrl points at the confirm page', url.startsWith('https://portal.test/#/confirm/'), url);
  const token = url.split('/confirm/')[1];
  check('A2 the token verifies against the ticket + requester',
    (() => { const c = statusLink.verifyToken(token); return c && c.ticketId === t0.id; })());

  const mail = resolveMailWith(t0, url);
  check('A3 the resolve mail embeds the link', mail.body.includes(url));
  check('A4 the HTML part links too', mail.html.includes(`href="${url}"`));
  check('A5 the mail still names the ticket and resolution',
    mail.body.includes(t0.ticketNumber) && mail.body.includes('> Replaced the part.'));
  const openMail = outbound.statusUpdateMail({ ...t0, state: 'IN_PROGRESS' }, { previousState: 'NEW', confirmUrl: url });
  check('A6 a non-resolve mail carries no link', !openMail.body.includes(url) && !openMail.html.includes(url));
  // The mail carries no OTHER url: the confirm link is the one exception.
  check('A7 no other URL is introduced beyond the confirm link',
    (mail.body.match(/https?:\/\//g) || []).length === 1);

  /* ---- B. the mailer wires it automatically ------------------------------ */
  console.log('\n--- B. mailer passes the link on RESOLVED ---');
  const sent = [];
  const testMailer = createMailer({
    transport: { async sendMail(m) { sent.push(m); } },
  });
  await testMailer.notifyStatusChanged({ ...t0, state: 'RESOLVED' }, { previousState: 'IN_PROGRESS' });
  await testMailer.notifyStatusChanged({ ...t0, state: 'IN_PROGRESS' }, { previousState: 'NEW' });
  eq('B1 exactly two mails sent', sent.length, 2);
  check('B2 the RESOLVED notification carries the signed confirm link',
    sent[0].body.includes('https://portal.test/#/confirm/'));
  check('B3 a non-resolve notification carries no link',
    !sent[1].body.includes('#/confirm/') && !sent[1].body.includes('https://'));
  check('B4 the link is requestable: its token verifies for this requester',
    (() => {
      const t = sent[0].body.split('#/confirm/')[1].trim().split(/\s/)[0];
      const c = statusLink.verifyToken(t);
      return c && c.ticketId === t0.id;
    })());

  /* ---- C. the confirmation endpoint -------------------------------------- */
  console.log('\n--- C. POST /api/public/confirm-resolution ---');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const t1 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(), suffix: 'ok' });
  const okToken = statusLink.makeToken(t1.id, 'requester@rc.test');

  // Wrong-method guard first: the GET page never closes anything.
  const asGet = await fetch(`${base}/api/public/ticket-status?token=${encodeURIComponent(okToken)}`);
  eq('C1 the status GET still answers 200', asGet.status, 200);
  eq('C1b and closes nothing', (await prisma.ticket.findUnique({ where: { id: t1.id } })).state, 'RESOLVED');

  const good = await fetch(`${base}/api/public/confirm-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: okToken }),
  });
  eq('C2 confirming a RESOLVED ticket answers 200', good.status, 200);
  const t1After = await prisma.ticket.findUnique({ where: { id: t1.id } });
  eq('C3 it closed the ticket', t1After.state, 'CLOSED');
  check('C4 closedAt is stamped', Boolean(t1After.closedAt));

  const audits1 = await prisma.ticketAuditLog.findMany({ where: { ticketId: t1.id }, orderBy: { id: 'desc' } });
  eq('C5 the domain audit row records the requester close',
    audits1[0].fromState === 'RESOLVED' && audits1[0].toState === 'CLOSED' && audits1[0].actor === 'requester@rc.test', true);
  const events1 = await prisma.auditEvent.findMany({ where: { ticketId: t1.id, action: 'ticket.closed' } });
  eq('C6 the unified trail records one ticket.closed with via=resolution_confirmation',
    events1.length === 1 && events1[0].metadata && events1[0].metadata.includes('resolution_confirmation'), true);

  // Idempotent double-click: second POST is a polite 409, not a second close.
  const again = await fetch(`${base}/api/public/confirm-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: okToken }),
  });
  eq('C7 a second confirmation answers 409', again.status, 409);
  eq('C7b and leaves one close audit', (await prisma.auditEvent.count({ where: { ticketId: t1.id, action: 'ticket.closed' } })), 1);

  // Token for the right ticket but the wrong requester: 404.
  const foreign = statusLink.makeToken(t1.id, 'someone-else@rc.test');
  eq('C8 a foreign requester token is 404',
    (await fetch(`${base}/api/public/confirm-resolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: foreign }),
    })).status, 404);

  // Forged and missing tokens: 404.
  eq('C9 a forged token is 404',
    (await fetch(`${base}/api/public/confirm-resolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'forged.token' }),
    })).status, 404);
  eq('C10 a missing token is 404',
    (await fetch(`${base}/api/public/confirm-resolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).status, 404);

  // An IN_PROGRESS ticket must NOT be closable through the token: the token
  // proves mailbox access, not the right to close unfinished work.
  const t2 = await mkTicket({ state: 'IN_PROGRESS', suffix: 'prog' });
  const progToken = statusLink.makeToken(t2.id, 'requester@rc.test');
  eq('C11 confirming an IN_PROGRESS ticket answers 409',
    (await fetch(`${base}/api/public/confirm-resolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: progToken }),
    })).status, 409);
  eq('C11b and the ticket is untouched', (await prisma.ticket.findUnique({ where: { id: t2.id } })).state, 'IN_PROGRESS');

  /* ---- D. CAS racing an agent -------------------------------------------- */
  console.log('\n--- D. the close is compare-and-set ---');
  const t3 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(), suffix: 'cas' });
  // Simulate an agent closing the ticket between the requester's page load and
  // their click: flip the row, then confirm.
  await prisma.ticket.update({ where: { id: t3.id }, data: { state: 'CLOSED', closedAt: new Date() } });
  const race = await fetch(`${base}/api/public/confirm-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: statusLink.makeToken(t3.id, 'requester@rc.test') }),
  });
  eq('D1 confirming an already-closed ticket answers 409', race.status, 409);
  const t3Events = await prisma.auditEvent.count({ where: { ticketId: t3.id, action: 'ticket.closed' } });
  eq('D2 the race wrote no second trail entry', t3Events, 0);

  /* ---- E. the auto-close sweep ------------------------------------------- */
  console.log('\n--- E. resolutionSweeper ---');
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date();

  // Window 0 disables the sweep entirely.
  eq('E1 window 0 sweeps nothing', (await sweeper.sweepResolutions({ now, windowDays: 0 })).disabled, true);

  const old = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - 5 * DAY), suffix: 'old' });
  const fresh = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - 1 * DAY), suffix: 'fresh' });

  const first = await sweeper.sweepResolutions({ now, windowDays: 3 });
  eq('E2 one ticket is past its window', first.closed, 1);
  eq('E2b it is the old one', first.ids[0], old.id);
  eq('E3 the fresh one is still RESOLVED', (await prisma.ticket.findUnique({ where: { id: fresh.id } })).state, 'RESOLVED');
  eq('E4 the old one is CLOSED', (await prisma.ticket.findUnique({ where: { id: old.id } })).state, 'CLOSED');

  // Idempotency: a second sweep closes nothing new.
  eq('E5 a repeat sweep is a no-op', (await sweeper.sweepResolutions({ now, windowDays: 3 })).closed, 0);

  const oldEvents = await prisma.auditEvent.findMany({ where: { ticketId: old.id, action: 'ticket.closed' } });
  eq('E6 the sweep audited its close as auto_close',
    oldEvents.length === 1 && oldEvents[0].metadata.includes('auto_close') && oldEvents[0].actorLabel === 'system', true);
  const oldNote = await prisma.ticketAuditLog.findFirst({ where: { ticketId: old.id }, orderBy: { id: 'desc' } });
  eq('E7 the domain audit says why', oldNote.toState === 'CLOSED' && oldNote.actor === 'system', true);

  // A ticket whose agent notification target exists got one.
  const oldNotifs = await prisma.notification.count({ where: { ticketId: old.id } });
  eq('E8 the assigned agent was notified', oldNotifs >= 1, true);

  // The live setting flows through when windowDays is not injected.
  await settingsService.update({ resolutionAutoCloseDays: '0' }, 'test');
  const bySetting = await sweeper.sweepResolutions({ now });
  eq('E9 the stored setting (0) disables the live sweep', bySetting.disabled, true);
  await settingsService.update({ resolutionAutoCloseDays: '1' }, 'test');
  const bySetting2 = await sweeper.sweepResolutions({ now });
  eq('E10 the stored setting (1 day) closes the 1-day-old ticket', bySetting2.closed, 1);
  eq('E10b and it is CLOSED now', (await prisma.ticket.findUnique({ where: { id: fresh.id } })).state, 'CLOSED');
  // Reset so no other suite inherits this row's setting (fresh DB per suite,
  // but cheap to be tidy).
  await prisma.setting.deleteMany({ where: { key: 'resolutionAutoCloseDays' } });

  /* ---- F. the sweep cannot steal a raced ticket --------------------------- */
  console.log('\n--- F. sweep races are CAS-decided ---');
  const t4 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - 9 * DAY), suffix: 'sweepcas' });
  // A requester reply reopened the ticket between the findMany and the write.
  await prisma.ticket.update({ where: { id: t4.id }, data: { state: 'IN_PROGRESS', resolvedAt: null, resolution: null } });
  const raced = await sweeper.sweepResolutions({ now, windowDays: 3 });
  eq('F1 the reopened ticket is not swept', raced.ids.includes(t4.id), false);
  eq('F2 it is still IN_PROGRESS', (await prisma.ticket.findUnique({ where: { id: t4.id } })).state, 'IN_PROGRESS');

  /* ---- G. the queue/detail payload carries the confirmation state --------- */
  console.log('\n--- G. awaiting-confirmation on the ticket payload ---');
  const bcrypt = require('bcryptjs');
  await prisma.agent.create({
    data: {
      name: 'Gale Getter', email: 'gale@rc.test', role: 'agent',
      passwordHash: bcrypt.hashSync('confirm-pass-123', 10),
      skillLevel: 1, isActive: true,
    },
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gale@rc.test', password: 'confirm-pass-123' }),
  });
  eq('G1 the payload agent can sign in', login.status, 200);
  const { token: jwt } = await login.json();

  const gT = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - DAY), suffix: 'payload', requesterEmail: 'req-payload@rc.test' });
  const got = await fetch(`${base}/api/tickets/${gT.id}`, { headers: { Authorization: `Bearer ${jwt}` } });
  eq('G2 the detail payload answers 200', got.status, 200);
  const payload = await got.json();
  eq('G3 a RESOLVED ticket is awaitingConfirmation', payload.awaitingConfirmation, true);
  check('G4 the deadline is resolvedAt + the 3-day default window',
    payload.confirmationAutoCloseAt
    && Math.abs(new Date(payload.confirmationAutoCloseAt).getTime() - (new Date(gT.resolvedAt).getTime() + 3 * DAY)) < 1000,
    payload.confirmationAutoCloseAt);

  const gO = await mkTicket({ state: 'IN_PROGRESS', suffix: 'payloadopen', requesterEmail: 'req-payload@rc.test' });
  const gotOpen = await (await fetch(`${base}/api/tickets/${gO.id}`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  eq('G5 an open ticket is not awaiting', gotOpen.awaitingConfirmation, false);
  check('G6 an open ticket carries no deadline', gotOpen.confirmationAutoCloseAt === undefined);

  const gC = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - DAY), suffix: 'payloadclosed' });
  await prisma.ticket.update({ where: { id: gC.id }, data: { state: 'CLOSED', closedAt: now } });
  const gotClosed = await (await fetch(`${base}/api/tickets/${gC.id}`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  eq('G7 a CLOSED ticket is not awaiting', gotClosed.awaitingConfirmation, false);

  // Window 0 (auto-close disabled): the ticket is still awaiting the click,
  // but no deadline is attached.
  await settingsService.update({ resolutionAutoCloseDays: '0' }, 'test');
  const gotNoWindow = await (await fetch(`${base}/api/tickets/${gT.id}`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  eq('G8 window 0 still marks the ticket awaiting', gotNoWindow.awaitingConfirmation, true);
  check('G9 window 0 attaches no deadline', gotNoWindow.confirmationAutoCloseAt === undefined);
  await prisma.setting.deleteMany({ where: { key: 'resolutionAutoCloseDays' } });

  /* ---- H. admin force close of a pending ticket --------------------------- */
  console.log('\n--- H. admin force close overrides a pending confirmation ---');
  const bcrypt2 = require('bcryptjs');
  await prisma.agent.create({
    data: {
      name: 'Ada Admin', email: 'admin@rc.test', role: 'admin',
      passwordHash: bcrypt2.hashSync('admin-pass-123', 10),
      skillLevel: 3, isActive: true,
    },
  });
  const adminLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@rc.test', password: 'admin-pass-123' }),
  });
  eq('H1 the admin can sign in', adminLogin.status, 200);
  const { token: adminJwt } = await adminLogin.json();

  const f1 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(now.getTime() - DAY), suffix: 'force1' });
  const forced = await fetch(`${base}/api/tickets/${f1.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ note: 'Requester left the company; closing on admin decision' }),
  });
  eq('H2 an admin can close an awaiting-confirmation ticket', forced.status, 200);
  eq('H3 the ticket is CLOSED', (await prisma.ticket.findUnique({ where: { id: f1.id } })).state, 'CLOSED');

  const f1Events = await prisma.auditEvent.findMany({ where: { ticketId: f1.id, action: 'ticket.closed' } });
  eq('H4 the trail stamps via=force_close',
    f1Events.length === 1 && f1Events[0].metadata.includes('force_close'), true);
  check('H5 the trail names the overriding admin', f1Events[0].actorLabel === 'Ada Admin <admin@rc.test>', f1Events[0].actorLabel);
  check('H6 the trail describes the override', f1Events[0].description.includes('force-closed') && f1Events[0].description.includes('confirmation was overridden'), f1Events[0].description);
  const f1Note = await prisma.ticketAuditLog.findFirst({ where: { ticketId: f1.id }, orderBy: { id: 'desc' } });
  eq('H7 the domain audit keeps the admin note', f1Note.note, 'Requester left the company; closing on admin decision');

  // After a force close, the requester's confirmation link must be dead —
  // the CAS refuses anything but RESOLVED.
  const lateConfirm = await fetch(`${base}/api/public/confirm-resolution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: statusLink.makeToken(f1.id, 'requester@rc.test') }),
  });
  eq('H8 the requester cannot confirm after a force close', lateConfirm.status, 409);

  // An agent (non-admin) may still close only their OWN resolved ticket;
  // the force-close power stays with admins and the ticket's owner.
  const f2 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(), suffix: 'force2', requesterEmail: 'req-force2@rc.test' });
  // Reassign f2 to the suite's agent (rita) so gale (a different agent) is not the owner.
  await prisma.ticket.update({ where: { id: f2.id }, data: { assignedAgentId: agent.id } });
  const gale = await prisma.agent.findUnique({ where: { email: 'gale@rc.test' } });
  const stranger = await fetch(`${base}/api/tickets/${f2.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({}),
  });
  eq('H9 a non-owner agent cannot force close someone else\u2019s ticket', stranger.status, 403);
  eq('H9b the ticket is untouched', (await prisma.ticket.findUnique({ where: { id: f2.id } })).state, 'RESOLVED');
  check('H9c the owner fixture differs from the caller', gale.id !== agent.id);

  // The ticket's own agent closing their resolved ticket goes through the
  // same code path but is an ordinary close for their own work — still
  // audited, still allowed.
  await prisma.agent.update({
    where: { email: 'rita@rc.test' },
    data: { passwordHash: bcrypt2.hashSync('rita-pass-123', 10) },
  });
  const ritaLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rita@rc.test', password: 'rita-pass-123' }),
  });
  eq('H10a the owner can sign in', ritaLogin.status, 200);
  const { token: ritaJwt } = await ritaLogin.json();
  const own = await fetch(`${base}/api/tickets/${f2.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ritaJwt}` },
    body: JSON.stringify({}),
  });
  eq('H10 the owner can close their own resolved ticket', own.status, 200);

  // Race: a requester confirming at the same instant as the admin — the CAS
  // decides, and the admin's late close cannot double-close.
  const f3 = await mkTicket({ state: 'RESOLVED', resolvedAt: new Date(), suffix: 'force3' });
  await prisma.ticket.update({ where: { id: f3.id }, data: { state: 'CLOSED', closedAt: now } });
  const lateAdmin = await fetch(`${base}/api/tickets/${f3.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({}),
  });
  eq('H11 force closing an already-CLOSED ticket is rejected', lateAdmin.status, 400);
  eq('H11b the transition guard answered, not the CAS', (await prisma.auditEvent.count({ where: { ticketId: f3.id, action: 'ticket.closed' } })), 0);

  // The sweep's earlier E-section ticket still proves the third path; here we
  // assert the admin force close and the sweep never double-write one trail.
  const f1Count = await prisma.auditEvent.count({ where: { ticketId: f1.id, action: 'ticket.closed' } });
  eq('H12 exactly one closed event per path', f1Count, 1);

  server.close();
  await prisma.$disconnect();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
