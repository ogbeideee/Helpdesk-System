// Attachment byte-cache eviction.
//
// The bytes stored for an inbound attachment are a cache, not the record: the
// source message stays in the shared mailbox, and services/attachmentFetchService
// re-reads it on a miss. This job is what keeps the cache a cache — without it
// the directory only ever grows, which is exactly the "keeping them forever"
// this design set out to avoid.
//
// Conventions, same as the handover, SLA and resolution sweepers:
//   - One bounded interval, guarded against overlapping runs (sweepRunning).
//   - Interval read at require time (process-lifetime config); the TTL is read
//     here too, and 0 disables eviction entirely.
//   - Deleting a cached object is never data loss, so a failure is logged and
//     the next run retries — nothing is escalated and nothing is repaired.
//   - Single-instance by design, like every background job in this codebase.
const {
  resolveAttachmentRootDir,
  sweepAttachmentCache,
} = require('./services/attachmentStorage');

// Read once at boot: days to keep a cached byte, default 30. 0 = keep forever.
const TTL_DAYS = (() => {
  const raw = Number(process.env.ATTACHMENT_CACHE_TTL_DAYS);
  if (!Number.isFinite(raw)) return 30;
  return Math.max(0, Math.trunc(raw));
})();

// Read once at boot: ATTACHMENT_CACHE_SWEEP_INTERVAL_MINUTES, default 360.
const INTERVAL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.ATTACHMENT_CACHE_SWEEP_INTERVAL_MINUTES ?? 360)) * 60 * 1000
);

let sweepTimer = null;
let sweepRunning = false;

function formatMb(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * One eviction pass. Everything is injectable so the policy is testable without
 * a filesystem clock: `now` decides which files are old, `ttlDays` the window,
 * `rootDir` the cache.
 */
async function runAttachmentCacheSweep({
  rootDir = resolveAttachmentRootDir(),
  ttlDays = TTL_DAYS,
  now = new Date(),
  logger = console,
} = {}) {
  const summary = await sweepAttachmentCache({ rootDir, ttlDays, now, logger });
  if (summary.disabled) return summary;
  if (summary.removed > 0) {
    logger.log(
      `[attachments] evicted ${summary.removed} cached file(s) older than ${ttlDays} day(s) ` +
        `(${formatMb(summary.freedBytes)} freed)`
    );
  }
  if (summary.failed > 0) {
    logger.warn(`[attachments] ${summary.failed} cached file(s) could not be evicted (see above)`);
  }
  return summary;
}

function startAttachmentCacheSweeper({ logger = console } = {}) {
  if (TTL_DAYS <= 0) {
    logger.log(
      '[attachments] byte-cache eviction disabled (ATTACHMENT_CACHE_TTL_DAYS=0) — cached bytes are kept'
    );
    return false;
  }
  if (INTERVAL_MS <= 0) {
    logger.log(
      '[attachments] byte-cache sweep disabled (ATTACHMENT_CACHE_SWEEP_INTERVAL_MINUTES=0)'
    );
    return false;
  }

  sweepTimer = setInterval(async () => {
    if (sweepRunning) return; // never overlap two sweeps
    sweepRunning = true;
    try {
      await runAttachmentCacheSweep({ logger });
    } catch (err) {
      logger.error(`[attachments] byte-cache sweep failed: ${err.message}`);
    } finally {
      sweepRunning = false;
    }
  }, INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();

  logger.log(
    `[attachments] byte-cache sweep every ${INTERVAL_MS / 60000} min (keeping ${TTL_DAYS} day(s); ` +
      'a miss re-reads the source message)'
  );
  return true;
}

function stopAttachmentCacheSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepRunning = false;
}

module.exports = {
  TTL_DAYS,
  runAttachmentCacheSweep,
  startAttachmentCacheSweeper,
  stopAttachmentCacheSweeper,
};
