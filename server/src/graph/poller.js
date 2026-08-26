// Inbox polling — the development-first ingestion trigger.
// Every cycle: list unread messages in the shared mailbox, run them through
// the Graph mail service (normalize -> guards -> ticket intake), and let the
// service decide read/unread state. Failures stay unread for natural retry.
const { graphConfig, logGraphStatus } = require('./config');
const graphStatus = require('./graphStatus');

let intervalHandle = null;
let running = false;
let service = null;

function getService() {
  if (!service) {
    const { createMailService } = require('./mailService');
    service = createMailService({ logger: console });
  }
  return service;
}

async function pollOnce() {
  const summary = await getService().pollUnread();
  graphStatus.recordPollCycle(summary);
  if (summary.fetched > 0) {
    console.log(
      `[poller] ${summary.fetched} unread message(s): ` +
        `created=${summary.created}, duplicate=${summary.duplicate}, ` +
        `skipped=${summary.skipped_self + summary.skipped_reply}, rejected=${summary.rejected}, failed=${summary.failed}`
    );
  }
  return summary;
}

function startPolling() {
  logGraphStatus((line) => console.log(line));

  if (!graphConfig.enabled) {
    // Missing credentials must never crash the app — the API, frontend,
    // simulated-email endpoint and notifications keep working without Graph.
    return;
  }

  console.log(
    `[poller] shared mailbox polling started (every ${Math.round(graphConfig.pollIntervalMs / 1000)}s)`
  );
  graphStatus.recordPollingStarted();

  setTimeout(() => {
    if (running) return;
    running = true;
    pollOnce()
      .catch((err) => console.error(`[poller] initial run failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, 5000).unref();

  intervalHandle = setInterval(async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      await pollOnce();
    } catch (err) {
      graphStatus.recordError('poller', err);
      console.error(`[poller] poll failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, graphConfig.pollIntervalMs);
  intervalHandle.unref();
}

function stopPolling() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  graphStatus.recordPollingStopped();
}

module.exports = { startPolling, stopPolling, pollOnce };
