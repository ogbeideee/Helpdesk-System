/* Scheduled weekly/monthly reports.

   Part A pins the period-boundary math pure: previous completed week and
   month in Africa/Lagos, the year rollover, the same instants under a UTC
   configuration, and the Lagos-weekend instant that lands in the NEXT week
   (the timezone-boundary case). Part B drives the settings system over HTTP
   (admin-only configuration, invalid recipients rejected). Part C proves the
   dormant state: no recipients, no send, no audit rows. The CLI dry run (Part
   D) exercises the manual path end-to-end before anything has been sent.
   Part E pins the delivered email's contents and recipients against fixed
   fixtures, Part F the duplicate-send protection, Part G mailer failure and
   retry, Part H an empty period, Part I the scheduler tick (due/not-due/
   disabled) and Part J the interval wiring conventions.

   Fixtures are seeded relative to the previous completed Lagos week computed
   by the same boundary function the scheduler uses, so the suite is stable
   whatever day it runs on. SLA content is a manually completed cycle (the
   same shape the backfill writes) so the email's SLA section and notable
   breaches have something real to show — the SLA values themselves come from
   the existing reporting services, never recomputed here.

   Usage: npm run test:scheduled-reports  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4212';
// Background workers off; the suite drives everything directly (Part J covers
// the scheduler's own wiring conventions).
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('scheduled-reports');

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const scheduler = require('../src/reportScheduler');
const settingsService = require('../src/services/settingsService');
const slaService = require('../src/slaService');
const calendar = require('../src/slaClock');
const { nextTicketNumber } = require('../src/ticketNumbers');

const BASE = `http://localhost:${process.env.PORT}`;
const PASSWORD = 'ScheduledReports!123';
const DOMAIN = 'reports.test';
const ADMIN_EMAIL = `admin@${DOMAIN}`;
const LAGOS = 'Africa/Lagos';
const HOUR = 3600 * 1000;

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

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitForServer(proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

/** Injectable transport: records mail, optionally fails selected subjects. */
function fakeTransport({ fail } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      if (fail && fail(mail)) throw new Error('smtp down');
      sent.push(mail);
    },
  };
}

async function mkTicket({ created, state, priority, teamId, agentId, firstResponseAt, resolvedAt, closedAt }) {
  return prisma.ticket.create({
    data: {
      ticketNumber: await nextTicketNumber(prisma),
      shortDescription: 'Scheduled report fixture',
      body: 'fixture body',
      category: 'Inquiry / Help',
      priority,
      state,
      source: 'portal',
      requesterEmail: `requester@${DOMAIN}`,
      createdAt: created,
      ...(teamId !== undefined ? { teamId } : {}),
      ...(agentId !== undefined ? { assignedAgentId: agentId } : {}),
      ...(firstResponseAt !== undefined ? { firstResponseAt } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
    },
  });
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  const now = new Date();
  const period = scheduler.previousWeekPeriod(now, LAGOS);
  const at = (hours) => new Date(period.start.getTime() + hours * HOUR);

  // ---- fixtures inside the previous completed Lagos week -----------------
  const alpha = await prisma.team.create({ data: { key: 'alpha', name: 'Alpha Team' } });
  const beta = await prisma.team.create({ data: { key: 'beta', name: 'Beta Team' } });
  const mkAgent = (name, email, role, teamId) =>
    prisma.agent.create({
      data: {
        name, email, role, ...(teamId ? { teamId } : {}),
        isActive: true, isAvailable: true, passwordHash: bcrypt.hashSync(PASSWORD, 4),
      },
    });
  await mkAgent('Reports Admin', ADMIN_EMAIL, 'admin', null);
  const agent1 = await mkAgent('Agent One', `one@${DOMAIN}`, 'agent', alpha.id);
  const agent2 = await mkAgent('Agent Two', `two@${DOMAIN}`, 'agent', beta.id);

  await mkTicket({ created: at(1), state: 'NEW', priority: 'low', teamId: alpha.id, agentId: agent1.id });
  const t2 = await mkTicket({
    created: at(26), state: 'RESOLVED', priority: 'moderate', teamId: beta.id, agentId: agent2.id,
    firstResponseAt: calendar.defaultCalendar.addWorkingMs(at(26), 4 * HOUR),
    resolvedAt: calendar.defaultCalendar.addWorkingMs(at(26), 26 * HOUR),
  });
  await mkTicket({ created: at(51), state: 'RESOLVED', priority: 'moderate', teamId: alpha.id, agentId: agent1.id,
    firstResponseAt: at(53), resolvedAt: at(63) });
  await mkTicket({ created: at(76), state: 'CLOSED', priority: 'high', teamId: beta.id, agentId: agent2.id,
    resolvedAt: at(82), closedAt: at(84) });

  // SLA content for t2: a manually completed cycle (backfill-shaped) whose
  // response (4 working hours against a 1-hour target) and resolution
  // (26 working hours against a 24-hour target) are both breached. The
  // slaReport service computes the breach states live from the frozen
  // instants — the fixtures only place the timestamps.
  const t2full = await prisma.ticket.findUnique({ where: { id: t2.id } });
  await slaService.startCycle(t2full, {
    cycleNumber: 1,
    startedAt: t2.createdAt,
    actor: 'system',
    source: 'live',
    syncTicket: false,
    policy: slaService.defaultSlaPolicy(),
    holidays: [],
  });
  const cycle = await prisma.ticketSlaCycle.findFirst({ where: { ticketId: t2.id } });
  await prisma.ticketSlaCycle.update({
    where: { id: cycle.id },
    data: {
      endedAt: t2.resolvedAt,
      resolvedAt: t2.resolvedAt,
      responseDurationMs: 4 * HOUR,
      resolutionDurationMs: 26 * HOUR,
    },
  });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    await waitForServer(server);
    const adminLogin = await req('/api/auth/login', {
      method: 'POST', body: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    eq('login admin', adminLogin.status, 200);
    const admin = adminLogin.data.token;
    const agentLogin = await req('/api/auth/login', {
      method: 'POST', body: { email: `one@${DOMAIN}`, password: PASSWORD },
    });
    const agent = agentLogin.data.token;

    /* ---- A. period boundaries (pure) ------------------------------------- */
    console.log('\n--- A. period boundaries ---');
    const wk = scheduler.previousWeekPeriod(T('2026-09-09T10:00Z'), LAGOS); // a Wednesday
    eq('A1 previous week starts Mon 00:00 Lagos (Sun 23:00Z)', wk.start.toISOString(), '2026-08-30T23:00:00.000Z');
    eq('A2 previous week ends Sun 24:00 Lagos (exclusive)', wk.end.toISOString(), '2026-09-06T23:00:00.000Z');
    eq('A3 inclusive query bound is 1ms earlier', wk.to.toISOString(), '2026-09-06T22:59:59.999Z');
    eq('A4 period key', wk.period, 'weekly:2026-08-31');

    const mo = scheduler.previousMonthPeriod(T('2026-09-09T10:00Z'), LAGOS);
    eq('A5 previous month starts Aug 1 00:00 Lagos', mo.start.toISOString(), '2026-07-31T23:00:00.000Z');
    eq('A6 previous month ends Sep 1 00:00 Lagos', mo.end.toISOString(), '2026-08-31T23:00:00.000Z');
    eq('A7 period key', mo.period, 'monthly:2026-08');

    const jan = scheduler.previousMonthPeriod(T('2027-01-05T12:00Z'), LAGOS);
    eq('A8 year rollover period', jan.period, 'monthly:2026-12');
    eq('A9 year rollover start', jan.start.toISOString(), '2026-11-30T23:00:00.000Z');

    const wkUtc = scheduler.previousWeekPeriod(T('2026-09-09T10:00Z'), 'UTC');
    eq('A10 UTC configuration shifts the boundary', wkUtc.start.toISOString(), '2026-08-31T00:00:00.000Z');

    // Sun 23:30 UTC is Mon 00:30 in Lagos: in Lagos the previous week is the
    // one that just ended (Aug 31), while in UTC the instant is still Sunday
    // of the Aug 31 week, so the previous week is Aug 24. Same instant,
    // different week — the timezone boundary in one assertion pair.
    const edge = scheduler.previousWeekPeriod(T('2026-09-06T23:30Z'), LAGOS);
    eq('A11 Lagos rolls the week over at the weekend boundary', edge.period, 'weekly:2026-08-31');
    const edgeUtc = scheduler.previousWeekPeriod(T('2026-09-06T23:30Z'), 'UTC');
    eq('A12 UTC keeps the instant in the older week', edgeUtc.period, 'weekly:2026-08-24');
    eq('A13 tzWall weekday is ISO (Mon=1)', scheduler.tzWall(T('2026-09-06T23:30Z'), LAGOS).weekday, 1);

    /* ---- B. recipient configuration through the settings system ----------- */
    console.log('\n--- B. recipient configuration ---');
    eq('B1 agent cannot configure reports',
      (await req('/api/sla/settings', { method: 'PATCH', token: agent, body: { reportRecipients: 'x@y.z' } })).status, 403);
    const bad = await req('/api/sla/settings', {
      method: 'PATCH', token: admin, body: { reportRecipients: 'not-an-email' },
    });
    eq('B2 invalid recipient rejected', bad.status, 400);
    const saved = await req('/api/sla/settings', {
      method: 'PATCH', token: admin,
      body: {
        reportRecipients: 'boss@reports.test, ops@reports.test',
        reportWeeklyDay: 1, reportMonthlyDay: 1, reportSendHour: 9,
      },
    });
    eq('B3 admin configures recipients + schedule', saved.status, 200);
    // The settings API response is scoped to the SLA group, so the effective
    // values are read back through the settings service (same store).
    const effective = await settingsService.getAll(prisma, 'reports');
    eq('B4 recipients stored canonically', effective.reportRecipients, 'boss@reports.test, ops@reports.test');
    eq('B5 schedule keys effective',
      effective.reportWeeklyDay === 1 && effective.reportSendHour === 9 && effective.reportMonthlyDay === 1, true);

    /* ---- C. dormant without recipients ------------------------------------- */
    // (ran before B configured them — recreated here by clearing the key)
    console.log('\n--- C. no recipients, no send ---');
    await settingsService.update({ reportRecipients: '' }, 'suite', prisma);
    const transport0 = fakeTransport();
    const dormant = await scheduler.sendScheduledReport({ kind: 'weekly', mailer: { sendMailSafe: async () => { throw new Error('must not be called'); } } });
    eq('C1 dormant status', dormant.status, 'no_recipients');
    const dormantTick = await scheduler.runDueReports({ mailer: { sendMailSafe: async () => { throw new Error('must not be called'); } } });
    eq('C2 tick stays dormant', dormantTick.weekly, 'no_recipients');
    await settingsService.update({ reportRecipients: 'boss@reports.test, ops@reports.test' }, 'suite', prisma);

    /* ---- D. manual path: CLI dry run ---------------------------------------- */
    console.log('\n--- D. CLI dry run ---');
    const cli = execFileSync(process.execPath,
      [path.join(__dirname, 'send-scheduled-report.js'), '--kind=weekly', '--dry-run'],
      { env: { ...process.env }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    check('D1 dry run reports the recipients', cli.includes('would send to: boss@reports.test, ops@reports.test'));
    check('D2 dry run renders the report body', cli.includes('WEEKLY HELPDESK REPORT') && cli.includes('Created: 4'));
    check('D3 dry run names the period', cli.includes(periodLabelFixture()));

    /* ---- E. delivered contents ---------------------------------------------- */
    console.log('\n--- E. weekly report contents ---');
    const transport = fakeTransport();
    const sent = await scheduler.sendScheduledReport({ kind: 'weekly', mailer: fakeMailer(transport) });
    eq('E1 status sent', sent.status, 'sent');
    eq('E2 exactly one mail', transport.sent.length, 1);
    const mail = transport.sent[0];
    check('E3 subject carries the kind and period', /Weekly report /.test(mail.subject) && mail.subject.includes(periodLabelFixture()));
    eq('E4 recipients are exactly the configured admins',
      JSON.stringify(mail.toRecipients.map((r) => r.emailAddress.address)),
      JSON.stringify(['boss@reports.test', 'ops@reports.test']));
    check('E5 volume in the body', mail.body.includes('Created: 4') && mail.body.includes('Resolved: 3'));
    check('E6 status and priority distributions in the body',
      mail.body.includes('BY STATUS') && mail.body.includes('IN_PROGRESS') && mail.body.includes('BY PRIORITY'));
    check('E7 group/agent performance in the body',
      mail.body.includes('Alpha Team') && mail.body.includes('Agent Two'));
    check('E8 first-response and resolution metrics in the body',
      mail.body.includes('FIRST RESPONSE') && mail.body.includes('RESOLUTION'));
    check('E9 SLA section comes from the reporting service',
      mail.body.includes('SLA PERFORMANCE') && mail.body.includes('Compliance: 0% (0 of 1 completed cycles met)'));
    check('E10 notable breaches name the breached priority', mail.body.includes('priority moderate: 1 response, 1 resolution'));
    check('E11 no requester addresses anywhere in the mail', !mail.body.includes('requester@') && !JSON.stringify(mail).includes('requester@'));
    const sentRows = await prisma.auditEvent.findMany({ where: { action: 'report.sent' } });
    eq('E12 one sent audit row', sentRows.length, 1);
    eq('E13 audit actor', sentRows[0].actorLabel, 'system (report scheduler)');
    const meta = JSON.parse(sentRows[0].metadata);
    eq('E14 audit metadata carries the period key', meta.period, sent.periodKey);
    eq('E15 audit metadata carries the subject', meta.subject, mail.subject);

    /* ---- F. duplicate-send protection ---------------------------------------- */
    console.log('\n--- F. duplicate protection ---');
    const again = await scheduler.sendScheduledReport({ kind: 'weekly', mailer: fakeMailer(transport) });
    eq('F1 replay is already_sent', again.status, 'already_sent');
    eq('F2 no second mail', transport.sent.length, 1);
    eq('F3 still one sent audit row', await prisma.auditEvent.count({ where: { action: 'report.sent' } }), 1);

    /* ---- G. mailer failure and retry ------------------------------------------ */
    console.log('\n--- G. mailer failure ---');
    const failing = fakeTransport({ fail: () => true });
    const failed = await scheduler.sendScheduledReport({ kind: 'monthly', mailer: fakeMailer(failing) });
    eq('G1 failed status', failed.status, 'failed');
    eq('G2 nothing delivered', failing.sent.length, 0);
    const failedRows = await prisma.auditEvent.findMany({ where: { action: 'report.failed' } });
    eq('G3 failure audited', failedRows.length, 1);
    eq('G4 failure does not mark the period sent',
      await scheduler.alreadySent(prisma, failed.period), false);
    const retried = await scheduler.sendScheduledReport({ kind: 'monthly', mailer: fakeMailer(transport) });
    eq('G5 retry succeeds', retried.status, 'sent');
    eq('G6 retry audited as sent',
      (await prisma.auditEvent.findMany({ where: { action: 'report.sent' } })).length, 2);

    /* ---- H. empty period -------------------------------------------------------- */
    console.log('\n--- H. empty period ---');
    const later = new Date(now.getTime() + 14 * 24 * HOUR);
    const emptyTransport = fakeTransport();
    const empty = await scheduler.sendScheduledReport({ kind: 'weekly', now: later, mailer: fakeMailer(emptyTransport) });
    eq('H1 empty period still delivers', empty.status, 'sent');
    check('H2 body shows zero volume', emptyTransport.sent[0].body.includes('Created: 0') && emptyTransport.sent[0].body.includes('Resolved: 0'));
    check('H3 body says no breaches recorded', emptyTransport.sent[0].body.includes('none recorded in this period'));

    /* ---- I. scheduler tick -------------------------------------------------------- */
    console.log('\n--- I. scheduler tick ---');
    // A mid-week moment (Thursday 12:00 Lagos) inside the week AFTER the
    // fixture week: always past any send hour, and its "previous week" is
    // always the fixture week — the exact period Part E already delivered.
    const weekLater = new Date(period.end.getTime() + 3.5 * 24 * HOUR);
    const settings = await settingsService.getAll(prisma);
    eq('I1 setup: weekly enabled', settings.reportWeeklyEnabled, 1);
    await settingsService.update({ reportMonthlyEnabled: 0 }, 'suite', prisma);
    const tick = await scheduler.runDueReports({ now: weekLater, mailer: fakeMailer(transport) });
    eq('I2 weekly period already delivered by E — the tick does not resend', tick.weekly, 'already_sent');
    eq('I3 disabled monthly is not due', tick.monthly, 'not_due');
    await settingsService.update({ reportWeeklyEnabled: 0 }, 'suite', prisma);
    const tick2 = await scheduler.runDueReports({ now: weekLater, mailer: fakeMailer(transport) });
    eq('I4 disabled weekly is not due', tick2.weekly, 'not_due');
    eq('I5 the ticks delivered no additional mail',
      transport.sent.length, 2 /* E weekly + G monthly */);

    /* ---- J. interval wiring conventions --------------------------------------------- */
    console.log('\n--- J. interval wiring ---');
    eq('J1 interval disabled by env returns false', scheduler.startReportScheduler({ logger: { log: () => {}, error: () => {} } }), false);
    scheduler.stopReportScheduler(); // must be a safe no-op
    check('J7 stop without start does not throw', true);

    /* ---- K. audit trail cleanliness --------------------------------------------------- */
    console.log('\n--- K. audit trail ---');
    const reportRows = await prisma.auditEvent.findMany({ where: { action: { startsWith: 'report.' } } });
    check('K1 only report.sent / report.failed rows written by the runner',
      reportRows.every((r) => r.action === 'report.sent' || r.action === 'report.failed'));
    eq('K2 rows match deliveries (3 sent + 1 failed)',
      reportRows.length, 4);
  } finally {
    server.kill();
  }
}

function T(s) { return new Date(s); }
function fakeMailer(transport) {
  // Same wrapper the real mailer applies: sendMailSafe that reports failure
  // instead of throwing.
  return {
    async sendMailSafe(mail) {
      try {
        await transport.sendMail(mail);
        return true;
      } catch {
        return false;
      }
    },
  };
}
function periodLabelFixture() {
  // The human label for the fixture week, built by the same renderer helper.
  const p = scheduler.previousWeekPeriod(new Date(), LAGOS);
  return scheduler.periodLabel('weekly', p);
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
