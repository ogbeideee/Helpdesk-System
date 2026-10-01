// Ingestion watchdog.
//
// The one failure this system cannot survive quietly is email ingestion going
// down: employees keep writing to the helpdesk address, nothing errors in the
// UI, and the first person to notice is a requester whose ticket never appears.
// That already happened once (the Gmail OAuth refresh token expired; see
// docs/PROJECT_STATE.md 2026-09-24). This job makes the silence loud.
//
// It watches the operational snapshots the pollers already keep
// (imap/graphStatus: lastPollAt, lastError) and, when ingestion looks stalled,
// raises the alarm exactly once per incident:
//   - an in-app notification for every active administrator (the Notification
//     feed agents already watch), and
//   - an email to each of them through the normal notification transport.
// The alarm clears — with a recovery notification, once per incident — when a
// poll completes again.
//
// Conventions, same as every background job here: one bounded interval guarded
// against overlapping runs, interval read at require time, 0 disables,
// single-instance by design. A watchdog failure is logged and retried by the
// next tick; it must never take anything else down.
const prisma = require('./lib/prisma');
const { imapConfig } = require('./imap/config');
const { graphConfig } = require('./graph/config');
const imapStatus = require('./imap/imapStatus');
const graphStatus = require('./graph/graphStatus');
const notificationService = require('./mailer');

// Read once at boot: INGESTION_WATCHDOG_INTERVAL_MINUTES, default 15.
const INTERVAL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.INGESTION_WATCHDOG_INTERVAL_MINUTES ?? 15)) * 60 * 1000
);

// Read once at boot: INGESTION_WATCHDOG_STALL_MINUTES, default 30 — how long a
// poll may stay silent before the watchdog calls it stalled. The IMAP cadence
// default is 2 minutes, so 30 gives roughly fifteen missed cycles of slack for
// transient network trouble before anyone is woken up.
const STALL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.INGESTION_WATCHDOG_STALL_MINUTES ?? 30)) * 60 * 1000
);

// Alarm state, process-lifetime: exactly one alert per incident, one recovery
// alert when it clears. `null` = no incident; an object = the incident being
// tracked (and warned about).
let activeIncident = null;
let watchdogTimer = null;

/** Which ingestion paths are actually configured — only those are watched. */
function watchedSources() {
  const sources = [];
  if (imapConfig.enabled) sources.push('imap');
  if (graphConfig.enabled) sources.push('graph');
  return sources;
}

/**
 * Is this source stalled? Pure and injectable, so the rule is testable without
 * a clock or a mailbox.
 *
 * A source is stalled when its last recorded poll is older than the stall
 * window — the poller never ran, died, or every cycle has been erroring since.
 * A source that has NEVER polled is stalled too: no news is bad news here,
 * because the process has been up long enough to have polled at least once.
 */
function isStalled(snapshot, { now = new Date(), stallMs = STALL_MS } = {}) {
  if (stallMs <= 0) return false;
  if (!snapshot.lastPollAt) return true;
  const last = new Date(snapshot.lastPollAt).getTime();
  // NaN (a corrupt timestamp) compares false against everything, so it would
  // silently read as "healthy" — invert that: unparsable is stalled.
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > stallMs;
}

/** Snapshot access, injectable for tests. */
function snapshotFor(source) {
  return source === 'imap' ? imapStatus.snapshot() : graphStatus.snapshot();
}

async function activeAdmins(client = prisma) {
  return client.agent.findMany({
    where: { role: 'admin', isActive: true },
    select: { id: true, email: true, name: true },
  });
}

async function raiseAlarm(sources, client) {
  const message =
    `Email ingestion has not completed a polling cycle for over ` +
    `${Math.round(STALL_MS / 60000)} minutes (${sources.join(', ')}). ` +
    'New emails are not becoming tickets until this is fixed.';
  console.error(`[watchdog] ALARM: ${message}`);

  let admins = [];
  try {
    admins = await activeAdmins(client);
  } catch (err) {
    console.error(`[watchdog] could not load administrators: ${err.message}`);
    return;
  }

  for (const admin of admins) {
    try {
      await client.notification.create({
        data: {
          agentId: admin.id,
          type: 'ingestion_stalled',
          title: 'Email ingestion stalled',
          body: message,
        },
      });
    } catch (err) {
      console.error(`[watchdog] in-app alert failed for ${admin.email}: ${err.message}`);
    }
    try {
      await notificationService.sendMailSafe({
        subject: `[helpdesk] Email ingestion stalled (${sources.join(', ')})`,
        body: `${message}\r\n\r\nCheck /api/health (integration.lastError) and the server logs.`,
        toRecipients: [{ emailAddress: { address: admin.email } }],
      });
    } catch (err) {
      console.error(`[watchdog] email alert failed for ${admin.email}: ${err.message}`);
    }
  }
}

async function clearAlarm(previous, client) {
  console.log('[watchdog] ingestion recovered — a polling cycle completed again');
  let admins = [];
  try {
    admins = await activeAdmins(client);
  } catch {
    return; // recovery alerting is best-effort
  }
  for (const admin of admins) {
    try {
      await client.notification.create({
        data: {
          agentId: admin.id,
          type: 'ingestion_recovered',
          title: 'Email ingestion recovered',
          body: 'A mailbox polling cycle completed again. Tickets are flowing.',
        },
      });
    } catch {
      /* best effort */
    }
  }
  void previous;
}

/**
 * One watchdog pass. Everything is injectable so the whole rule is testable
 * without a mailbox: pass `snapshots` (map source -> snapshot) and `now`.
 *
 * @returns {{stalled: string[], cleared: boolean, raised: boolean, disabled?: boolean}}
 */
async function checkIngestion({
  client = prisma,
  now = new Date(),
  snapshots = null,
  notify = true,
  // Injectable watched-source list (tests); defaults to the real config.
  forcedSources = null,
} = {}) {
  const sources = forcedSources || watchedSources();
  if (sources.length === 0) {
    return { stalled: [], cleared: false, raised: false, disabled: true };
  }

  const stalled = sources.filter((source) =>
    isStalled((snapshots || {})[source] || snapshotFor(source), { now })
  );

  // Nothing wrong: clear any incident exactly once.
  if (stalled.length === 0) {
    if (activeIncident) {
      const previous = activeIncident;
      activeIncident = null;
      if (notify) await clearAlarm(previous, client);
      return { stalled, cleared: true, raised: false };
    }
    return { stalled, cleared: false, raised: false };
  }

  // Stalled: raise the alarm once per incident. A still-stalled later pass
  // stays quiet — one alarm per incident, not one per tick.
  if (!activeIncident) {
    activeIncident = { since: now.toISOString(), sources: stalled.slice() };
    if (notify) await raiseAlarm(stalled, client);
    return { stalled, cleared: false, raised: true };
  }
  return { stalled, cleared: false, raised: false };
}

function startIngestionWatchdog({ logger = console } = {}) {
  if (INTERVAL_MS <= 0) {
    logger.log('[watchdog] ingestion watchdog disabled (INGESTION_WATCHDOG_INTERVAL_MINUTES=0)');
    return false;
  }
  const sources = watchedSources();
  if (sources.length === 0) {
    logger.log('[watchdog] no ingestion path configured — watchdog idle');
    return false;
  }

  let running = false;
  watchdogTimer = setInterval(async () => {
    if (running) return; // never overlap two passes
    running = true;
    try {
      await checkIngestion({});
    } catch (err) {
      logger.error(`[watchdog] check failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  if (watchdogTimer.unref) watchdogTimer.unref();

  logger.log(
    `[watchdog] ingestion watchdog every ${INTERVAL_MS / 60000} min ` +
      `(alarm after ${STALL_MS / 60000} min without a poll; watching ${sources.join(', ')})`
  );
  return true;
}

function stopIngestionWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  activeIncident = null;
}

module.exports = {
  INTERVAL_MS,
  STALL_MS,
  watchedSources,
  isStalled,
  checkIngestion,
  startIngestionWatchdog,
  stopIngestionWatchdog,
};
