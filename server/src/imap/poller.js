// IMAP inbox polling — the timer counterpart of graph/poller.js.
//
// Every cycle: connect, list unseen messages in the configured mailbox, run
// them through the IMAP mail service (decode -> guards -> the shared ticket
// intake), and mark them seen on definitive outcomes. Failures stay unseen for
// natural retry.
//
// Scheduler conventions shared with every background job in this server:
// an interval from configuration, <= 0 disables, the timer never overlaps
// itself, the interval is unref'd so it cannot hold the process open, and any
// cycle failure is caught and logged — the server keeps running and the next
// tick simply retries.
const { imapConfig, logImapStatus } = require('./config');
const imapStatus = require('./imapStatus');

let intervalHandle = null;
let initialHandle = null;
let running = false;
let service = null;

function getService() {
  if (!service) {
    const { createImapMailService } = require('./mailService');
    service = createImapMailService({ logger: console });
  }
  return service;
}

async function pollOnce() {
  const summary = await getService().pollUnread();
  imapStatus.recordPollCycle(summary);
  if (summary.fetched > 0) {
    console.log(
      `[imap] ${summary.fetched} unseen message(s): ` +
        `created=${summary.created}, activity=${summary.comment_added + summary.reopened}, ` +
        `duplicate=${summary.duplicate}, skipped=${summary.skipped_self}, ` +
        `rejected=${summary.rejected}, failed=${summary.failed}`
    );
  }
  return summary;
}

function startImapPoller(options = {}) {
  logImapStatus((line) => console.log(line));

  const config = options.config || imapConfig;
  if (!config.enabled) {
    // Missing configuration must never crash the app — Graph ingestion, the
    // API, the frontend and notifications keep working without IMAP.
    return false;
  }
  if (config.pollIntervalMs <= 0) {
    console.log('[imap] polling timer disabled (IMAP_POLL_INTERVAL_MS=0)');
    return false;
  }

  console.log(
    `[imap] mailbox polling started (every ${Math.round(config.pollIntervalMs / 1000)}s)`
  );
  imapStatus.recordPollingStarted();

  const cycle = async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      await pollOnce();
    } catch (err) {
      imapStatus.recordError('imap-poller', err);
      console.error(`[imap] poll failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  // A short delay after boot so the server comes up even when the mail
  // server is slow to answer; then the regular cadence.
  initialHandle = setTimeout(cycle, 5000);
  initialHandle.unref();

  intervalHandle = setInterval(cycle, config.pollIntervalMs);
  intervalHandle.unref();

  return true;
}

function stopImapPoller() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (initialHandle) clearTimeout(initialHandle);
  intervalHandle = null;
  initialHandle = null;
  imapStatus.recordPollingStopped();
}

module.exports = { startImapPoller, stopImapPoller, pollOnce };
