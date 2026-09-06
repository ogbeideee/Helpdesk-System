// Turns a Microsoft Graph change notification into the SAME processing the
// poller performs.
//
// The only thing webhook ingestion adds over polling is the trigger: instead of
// listing unread mail on a timer, Graph tells us a message id. From there the
// flow is identical —
//
//   retrieve message -> mailService.processOne (normalize -> guards -> intake
//   -> duplicate check -> ticket/activity -> assignment -> notifications ->
//   mark read)
//
// No ticket creation, classification or assignment logic lives here.
const graphStatus = require('./graphStatus');

/** Lifecycle events Graph sends on the same endpoint as change notifications. */
const LIFECYCLE_EVENTS = new Set([
  'reauthorizationRequired',
  'subscriptionRemoved',
  'missed',
]);

/**
 * Pull the message id out of a notification.
 * resourceData.id is authoritative; the resource path is the documented
 * fallback ("Users/{id}/Messages/{id}").
 */
function extractMessageId(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const fromData =
    notification.resourceData &&
    typeof notification.resourceData === 'object' &&
    notification.resourceData.id;
  if (fromData) return String(fromData);

  const resource = typeof notification.resource === 'string' ? notification.resource : '';
  // Both documented shapes: "Users/{id}/Messages/{id}" and "users/{id}/messages('{id}')".
  const match = resource.match(/messages(?:\(['"]?|\/)([^'")/]+)['"]?\)?$/i);
  return match ? match[1] : null;
}

/** A notification we can actually act on. */
function isValidNotification(notification) {
  if (!notification || typeof notification !== 'object') return false;
  if (notification.lifecycleEvent) return true;
  return Boolean(extractMessageId(notification));
}

function createWebhookProcessor(options = {}) {
  const logger = options.logger || console;
  const ops = options.ops || null;
  const mailServiceOverride = options.mailService || null;
  const subscriptionServiceOverride = options.subscriptionService || null;
  // Graph redelivers notifications (its own retries, or two notifications for
  // one edit). The database unique constraints are the hard idempotency
  // guarantee, but re-fetching the message just to learn it is a duplicate is
  // pure waste — so definitive outcomes are remembered briefly.
  const dedupeTtlMs = options.dedupeTtlMs || 10 * 60 * 1000;
  const recentOutcomes = new Map();

  function rememberOutcome(messageId, outcome) {
    if (!messageId) return;
    // Bounded: drop the oldest entries once the cache grows too large.
    if (recentOutcomes.size >= 1000) {
      const oldest = recentOutcomes.keys().next().value;
      recentOutcomes.delete(oldest);
    }
    recentOutcomes.set(messageId, { outcome, at: Date.now() });
  }

  function cachedOutcome(messageId) {
    const hit = messageId && recentOutcomes.get(messageId);
    if (!hit) return null;
    if (Date.now() - hit.at > dedupeTtlMs) {
      recentOutcomes.delete(messageId);
      return null;
    }
    return hit.outcome;
  }

  function transport() {
    if (ops) return ops;
    return require('./graphClient').graphOps;
  }

  function mailService() {
    if (mailServiceOverride) return mailServiceOverride;
    // Same construction the poller uses — one processing path, one behaviour.
    const { createMailService } = require('./mailService');
    return createMailService({ logger, ...(ops ? { ops } : {}) });
  }

  function subscriptionService() {
    if (subscriptionServiceOverride) return subscriptionServiceOverride;
    return require('./subscriptionService').getSubscriptionService();
  }

  /**
   * Graph asks us to re-authorize or tells us the subscription vanished.
   * Both are fixed by the ordinary ensure/renew path.
   */
  async function handleLifecycle(notification) {
    const event = notification.lifecycleEvent;
    logger.warn(`[webhook] lifecycle event: ${event}`);
    const svc = subscriptionService();
    try {
      if (event === 'subscriptionRemoved' || event === 'reauthorizationRequired') {
        await svc.ensureSubscription();
        return 'lifecycle_handled';
      }
      // "missed" means Graph dropped notifications — polling is exactly the
      // safety net for that, so we only flag it.
      logger.warn('[webhook] missed notifications reported — polling fallback will recover them');
      return 'lifecycle_missed';
    } catch (err) {
      graphStatus.recordError('webhook-lifecycle', err);
      logger.error(`[webhook] lifecycle handling failed for ${event}: ${err.message}`);
      return 'failed';
    }
  }

  /**
   * Process a single change notification.
   * Returns an outcome bucket mirroring the poller's vocabulary, plus
   * 'invalid' for unusable payloads and 'failed' for transient errors.
   */
  async function processNotification(notification) {
    if (!isValidNotification(notification)) {
      logger.warn('[webhook] malformed notification ignored');
      return 'invalid';
    }

    if (notification.lifecycleEvent) {
      if (!LIFECYCLE_EVENTS.has(notification.lifecycleEvent)) {
        logger.warn(`[webhook] unknown lifecycle event ${notification.lifecycleEvent} ignored`);
        return 'invalid';
      }
      return handleLifecycle(notification);
    }

    const messageId = extractMessageId(notification);

    // A definitive outcome for this message is already known (within the TTL):
    // a redelivered notification collapses to 'duplicate' without re-fetching.
    const cached = cachedOutcome(messageId);
    if (cached) {
      logger.log(`[webhook] notification for ${messageId} already processed (${cached}) — skipping`);
      return 'duplicate';
    }

    let raw;
    try {
      raw = await transport().getMessage(messageId);
    } catch (err) {
      // Retrieval failure must NOT mark anything processed — the message stays
      // unread in the mailbox and the next poll picks it up.
      graphStatus.recordError('webhook-retrieve', err);
      logger.error(
        `[webhook] could not retrieve message ${messageId}: ${err.message} — ` +
          'left for the polling fallback'
      );
      return 'failed';
    }

    if (!raw || !raw.id) {
      graphStatus.recordError('webhook-retrieve', new Error('empty message payload'));
      logger.error(
        `[webhook] Graph returned no message body for ${messageId} — left for the polling fallback`
      );
      return 'failed';
    }

    let outcome;
    try {
      // The shared pipeline. Idempotency (graphMessageId) lives inside it, so a
      // redelivered notification collapses to 'duplicate'.
      outcome = await mailService().processOne(raw, { source: 'webhook' });
    } catch (err) {
      graphStatus.recordError('webhook-process', err);
      logger.error(
        `[webhook] processing failed for ${messageId}: ${err.message} — left for the polling fallback`
      );
      return 'failed';
    }

    if (outcome === 'failed') {
      graphStatus.recordError(
        'webhook-process',
        new Error(`processing did not complete for ${messageId}`)
      );
      return 'failed';
    }

    // Definitive -> remember, so Graph's redeliveries (and duplicate entries
    // inside one batch) collapse to 'duplicate' without a re-fetch.
    rememberOutcome(messageId, outcome);

    // Success is recorded inside the shared pipeline (mailService), so the
    // poller and the webhook report through exactly one code path.
    return outcome;
  }

  /**
   * Process a whole notification batch. One bad notification never prevents
   * the rest of the batch from being handled.
   */
  async function processNotifications(notifications) {
    const list = Array.isArray(notifications) ? notifications : [];
    const summary = {
      received: list.length,
      created: 0,
      comment_added: 0,
      reopened: 0,
      duplicate: 0,
      skipped_self: 0,
      rejected: 0,
      failed: 0,
      invalid: 0,
      lifecycle_handled: 0,
      lifecycle_missed: 0,
    };
    for (const notification of list) {
      const outcome = await processNotification(notification);
      if (summary[outcome] !== undefined) summary[outcome] += 1;
    }
    return summary;
  }

  return { processNotification, processNotifications, extractMessageId, recentOutcomes };
}

module.exports = {
  createWebhookProcessor,
  extractMessageId,
  isValidNotification,
  LIFECYCLE_EVENTS,
};
