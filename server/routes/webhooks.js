// POST /api/webhooks/microsoft-graph — Microsoft Graph change notifications.
//
// This controller is deliberately thin. It only:
//   1. answers Graph's subscription validation handshake
//   2. authenticates the callback via clientState (Graph's documented mechanism)
//   3. hands the parsed notifications to the shared webhook processor
//
// Ticket creation, classification, assignment and notification all happen in
// the existing pipeline reached through mailService — never here.
const express = require('express');
const graphStatus = require('../src/graph/graphStatus');
const { createWebhookProcessor } = require('../src/graph/webhookProcessor');
const { getSubscriptionService } = require('../src/graph/subscriptionService');

const router = express.Router();

// Background work started by a request, tracked so tests can await it and so
// shutdown can let it drain.
const pending = new Set();

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

/** Await all in-flight notification processing (test/shutdown helper). */
async function flushPending() {
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
}

function buildRouter(deps = {}) {
  const logger = deps.logger || console;
  const processor =
    deps.processor || createWebhookProcessor({ logger, ...(deps.ops ? { ops: deps.ops } : {}) });
  const subscriptions = deps.subscriptionService || getSubscriptionService();
  // Synchronous processing makes assertions deterministic in tests; production
  // answers Graph first and processes after (Graph expects a fast response).
  const awaitProcessing = deps.awaitProcessing === true;

  const r = express.Router();

  r.post('/microsoft-graph', async (req, res) => {
    // --- 1. Subscription validation handshake -------------------------
    // Graph calls the endpoint with ?validationToken=... before creating a
    // subscription and expects the raw token echoed back as text/plain 200.
    const validationToken = req.query && req.query.validationToken;
    if (validationToken !== undefined) {
      const token = String(validationToken);
      logger.log('[webhook] responding to Graph subscription validation request');
      res.status(200).type('text/plain').send(token);
      return;
    }

    const body = req.body;
    const notifications = body && Array.isArray(body.value) ? body.value : null;

    // --- 2. Malformed payloads ----------------------------------------
    if (!notifications) {
      logger.warn('[webhook] rejected payload without a value[] array');
      res.status(400).json({ error: 'invalid notification payload' });
      return;
    }

    graphStatus.recordWebhookNotification(notifications.length);

    // --- 3. Authenticate every notification via clientState -----------
    // Anything we cannot match against the stored subscription is discarded.
    const verified = [];
    let unauthorized = 0;
    for (const n of notifications) {
      const ok = await subscriptions
        .verifyClientState(n && n.clientState)
        .catch(() => false);
      if (ok) verified.push(n);
      else unauthorized += 1;
    }

    if (unauthorized > 0) {
      logger.warn(
        `[webhook] discarded ${unauthorized} notification(s) with an invalid clientState`
      );
    }

    // Nothing authentic in the batch: tell the caller plainly.
    if (verified.length === 0) {
      res.status(202).json({
        accepted: 0,
        discarded: unauthorized,
        reason: 'clientState validation failed',
      });
      return;
    }

    // --- 4. Hand off to the shared pipeline ---------------------------
    if (awaitProcessing) {
      let summary;
      try {
        summary = await processor.processNotifications(verified);
      } catch (err) {
        graphStatus.recordError('webhook', err);
        logger.error(`[webhook] batch processing failed: ${err.message}`);
        // 500 lets Graph retry; polling recovers regardless. Nothing was
        // marked processed.
        res.status(500).json({ error: 'processing failed' });
        return;
      }
      // A partial failure still returns 202 — the message stays unread and the
      // poller will retry it, so asking Graph to redeliver adds nothing.
      res.status(202).json({ accepted: verified.length, discarded: unauthorized, summary });
      return;
    }

    // Production path: acknowledge immediately (Graph times out in ~3s), then
    // process. Failures leave the mail unread for the polling fallback.
    track(
      processor.processNotifications(verified).catch((err) => {
        graphStatus.recordError('webhook', err);
        logger.error(
          `[webhook] batch processing failed: ${err.message} — polling fallback will recover`
        );
      })
    );

    res.status(202).json({ accepted: verified.length, discarded: unauthorized });
  });

  return r;
}

// Default production router.
router.use(buildRouter());

module.exports = router;
module.exports.buildRouter = buildRouter;
module.exports.flushPending = flushPending;
