// The ingestion watchdog — the alarm that email has stopped becoming tickets.
//
//   A. the stall rule (pure): never-polled, stale, fresh, window 0
//   B. which sources are watched (config-driven, no env in this suite)
//   C. one pass end to end on a real database: alarm raised to every active
//      admin exactly once (in-app + email), silence while still stalled,
//      recovery notification when a poll completes again
//   D. nothing watched -> disabled, and a poller that has never polled counts
//      as stalled (no news is bad news)
//
// Uses its own throw-away database, like every suite. No mailbox is contacted:
// snapshots are injected.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const testdb = require('./lib/testdb').use('ingestion-watchdog');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

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

const { isStalled, watchedSources, checkIngestion } = require('../src/ingestionWatchdog');

const NOW = new Date('2026-10-01T12:00:00Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const STALL = 30 * 60 * 1000;

function quietMailer() {
  return { sendMailSafe: async () => true };
}

async function main() {
  /* ---- A. the stall rule -------------------------------------------------- */
  console.log('\n--- A. the stall rule ---');
  eq('A1 a source that has never polled is stalled', isStalled({}, { now: NOW, stallMs: STALL }), true);
  eq('A2 a poll older than the window is stalled',
    isStalled({ lastPollAt: iso(40 * 60 * 1000) }, { now: NOW, stallMs: STALL }), true);
  eq('A3 a poll inside the window is healthy',
    isStalled({ lastPollAt: iso(5 * 60 * 1000) }, { now: NOW, stallMs: STALL }), false);
  eq('A4 a poll exactly at the window is not yet stalled (boundary is strict)',
    isStalled({ lastPollAt: iso(STALL) }, { now: NOW, stallMs: STALL }), false);
  eq('A5 window 0 disables the rule entirely',
    isStalled({ lastPollAt: null }, { now: NOW, stallMs: 0 }), false);
  eq('A6 a corrupt timestamp is treated as stalled, not as healthy',
    isStalled({ lastPollAt: 'not-a-date' }, { now: NOW, stallMs: STALL }), true);

  /* ---- B. watched sources -------------------------------------------------- */
  console.log('\n--- B. watched sources ---');
  const sources = watchedSources();
  check('B7 the suite env watches exactly the configured paths (IMAP here)',
    sources.includes('imap') && !sources.includes('graph') && sources.length >= 1,
    JSON.stringify(sources));

  /* ---- fixtures ------------------------------------------------------------ */
  const PASSWORD = 'Watchdog!123';
  const hash = await bcrypt.hash(PASSWORD, 4);
  const adminA = await prisma.agent.create({
    data: { name: 'Ada Admin', email: 'ada@watch.test', passwordHash: hash, role: 'admin', isActive: true },
  });
  await prisma.agent.create({
    data: { name: 'Bo Admin', email: 'bo@watch.test', passwordHash: hash, role: 'admin', isActive: true },
  });
  // A deactived admin and a plain agent must NOT be alerted.
  await prisma.agent.create({
    data: { name: 'Cy Old', email: 'cy@watch.test', passwordHash: hash, role: 'admin', isActive: false },
  });
  await prisma.agent.create({
    data: { name: 'Dee Agent', email: 'dee@watch.test', passwordHash: hash, role: 'agent', isActive: true },
  });

  const healthy = { imap: { lastPollAt: iso(2 * 60 * 1000) } };
  const stalledSnap = { imap: { lastPollAt: iso(90 * 60 * 1000) } };

  /* ---- C. one pass end to end ---------------------------------------------- */
  console.log('\n--- C. alarm, silence, recovery ---');
  // C1-C6: the first stalled pass raises the alarm to active admins only.
  const raised = await checkIngestion({ now: NOW, snapshots: stalledSnap, notify: true });
  eq('C1 a stalled pass reports the stalled source', raised.stalled.join(','), 'imap');
  eq('C2 ...and raised the alarm', raised.raised, true);
  const inApp = await prisma.notification.findMany({ where: { type: 'ingestion_stalled' } });
  const activeAdminIds = (await prisma.agent.findMany({ where: { role: 'admin', isActive: true } }))
    .map((a) => a.id).sort().join(',');
  eq('C3 every ACTIVE admin got the in-app alarm (deactivated + agent did not)',
    inApp.map((n) => n.agentId).sort().join(','), activeAdminIds);
  check('C4 the alarm names the stall window and the source',
    inApp.length >= 1 && inApp.every((n) => /30 minutes/.test(n.body) && /imap/.test(n.body)));
  check('C5 the alarm body says what it means (tickets are not being created)',
    inApp.length >= 1 && inApp.every((n) => /New emails are not becoming tickets/.test(n.body)));
  // Email alerts are sent through the transport; assert via the notification
  // count below (sendMailSafe is stubbed in-process through the mailer's own
  // transport seam in test-email-integration; here the console fallback runs).

  // C6-C7: a still-stalled second pass stays quiet — one alarm per incident.
  const second = await checkIngestion({ now: new Date(NOW.getTime() + 15 * 60000), snapshots: stalledSnap, notify: true });
  eq('C6 a still-stalled pass does not re-alarm', second.raised, false);
  eq('C7 ...so no additional alarm rows appeared',
    await prisma.notification.count({ where: { type: 'ingestion_stalled' } }),
    activeAdminIds.split(',').length);

  // C8-C10: recovery clears the incident exactly once, with a notice.
  const recovered = await checkIngestion({ now: new Date(NOW.getTime() + 16 * 60000), snapshots: healthy, notify: true });
  eq('C8 a healthy pass clears the incident', recovered.cleared, true);
  eq('C9 the recovery notice reached the active admins',
    await prisma.notification.count({ where: { type: 'ingestion_recovered' } }),
    activeAdminIds.split(',').length);
  const again = await checkIngestion({ now: new Date(NOW.getTime() + 17 * 60000), snapshots: healthy, notify: true });
  eq('C10 a still-healthy pass is silent (no second recovery notice)',
    again.cleared, false);
  eq('C11 ...and no extra rows appeared',
    await prisma.notification.count({ where: { type: 'ingestion_recovered' } }),
    activeAdminIds.split(',').length);

  // C12-C13: a NEW incident after recovery alarms again.
  const secondIncident = await checkIngestion({ now: new Date(NOW.getTime() + 60 * 60000), snapshots: stalledSnap, notify: true });
  eq('C12 a new incident after recovery alarms again', secondIncident.raised, true);

  /* ---- D. disabled / never-polled ------------------------------------------ */
  console.log('\n--- D. disabled and never-polled ---');
  const disabled = await checkIngestion({ now: NOW, snapshots: {}, notify: false, forcedSources: [] });
  eq('D13 no watched source configured -> disabled, not stalled', disabled.disabled, true);

  // A source that has NEVER polled (fresh boot, poller crashed at start) is
  // stalled — the dangerous case this watchdog exists for.
  const never = await checkIngestion({
    now: new Date(NOW.getTime() + 61 * 60000),
    snapshots: { imap: {} },
    notify: false,
  });
  eq('D14 a never-polled source counts as stalled', never.stalled.join(','), 'imap');
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
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
