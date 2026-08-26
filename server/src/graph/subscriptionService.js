// Microsoft Graph change-notification subscription lifecycle.
//
// Responsibility boundary: this service owns ONLY the subscription record —
// create / inspect / renew / delete, plus the periodic renewal timer. It never
// touches tickets. Message handling stays in mailService.js so polling and
// webhook ingestion share one processing path.
//
// Graph subscriptions on messages live at most ~3 days, so a subscription is
// never created and forgotten: a timer renews it well before expiry, and a
// restart reuses the persisted record instead of orphaning it.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { graphConfig, logWebhookStatus } = require('./config');
const graphStatus = require('./graphStatus');

// Graph's documented ceiling for message subscriptions is 4230 minutes.
const MAX_SUBSCRIPTION_MINUTES = 4230;
// Renew once the remaining lifetime drops below this.
const RENEW_WHEN_REMAINING_MS = 12 * 60 * 60 * 1000; // 12 hours

let renewTimer = null;
// Generated once per process when the operator has not pinned one in the env.
let ephemeralClientState = null;

function getDefaultOps() {
  // Lazy require so the Graph SDK + MSAL never load when integration is off.
  const { graphOps } = require('./graphClient');
  return graphOps;
}

function resolveClientState(config) {
  if (config && config.webhookClientState) return config.webhookClientState;
  if (!ephemeralClientState) {
    ephemeralClientState = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralClientState;
}

function subscriptionResource(config) {
  const mailbox = (config && config.sharedMailbox) || graphConfig.sharedMailbox;
  return `/users/${mailbox}/mailFolders('inbox')/messages`;
}

function maxExpiration() {
  return new Date(Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000);
}

/**
 * Constant-time comparison so a mismatching clientState cannot be probed
 * byte-by-byte through response timing.
 */
function clientStateMatches(candidate, expected) {
  const a = Buffer.from(String(candidate == null ? '' : candidate));
  const b = Buffer.from(String(expected == null ? '' : expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createSubscriptionService(options = {}) {
  const logger = options.logger || console;
  const ops = options.ops || null;
  const config = options.config || graphConfig;

  function transport() {
    return ops || getDefaultOps();
  }

  /** The persisted subscription record, or null. */
  async function getStored() {
    const rows = await prisma.graphSubscription.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return rows[0] || null;
  }

  async function clearStored(subscriptionId) {
    if (subscriptionId) {
      await prisma.graphSubscription
        .deleteMany({ where: { subscriptionId } })
        .catch(() => {});
    } else {
      await prisma.graphSubscription.deleteMany({}).catch(() => {});
    }
  }

  /**
   * Validate an inbound notification's clientState against the stored
   * subscription. This is the mechanism Microsoft Graph documents for
   * change notifications without resource data — no custom scheme.
   */
  async function verifyClientState(candidate) {
    const stored = await getStored();
    // Nothing subscribed -> nothing legitimate can arrive.
    if (!stored) return false;
    return clientStateMatches(candidate, stored.clientState);
  }

  /** Create a fresh subscription and persist it. */
  async function createSubscription() {
    if (!config.webhookEnabled) {
      throw new Error('webhook mode is not enabled (WEBHOOK_PUBLIC_URL missing or not https)');
    }
    const clientState = resolveClientState(config);
    const created = await transport().createSubscription({
      notificationUrl: config.notificationUrl,
      clientState,
    });

    // Drop any previous record — one live subscription at a time.
    await clearStored();
    const stored = await prisma.graphSubscription.create({
      data: {
        subscriptionId: String(created.id),
        resource: created.resource || subscriptionResource(config),
        notificationUrl: created.notificationUrl || config.notificationUrl,
        clientState,
        expirationDateTime: new Date(created.expirationDateTime || maxExpiration()),
        lastRenewedAt: new Date(),
      },
    });
    logger.log(
      `[graph] subscription ${stored.subscriptionId} created — expires ${stored.expirationDateTime.toISOString()}`
    );
    return stored;
  }

  /** Extend the current subscription's expiry. */
  async function renewSubscription() {
    const stored = await getStored();
    if (!stored) return { status: 'none' };

    const expiration = maxExpiration();
    try {
      const updated = await transport().renewSubscription(
        stored.subscriptionId,
        expiration.toISOString()
      );
      const record = await prisma.graphSubscription.update({
        where: { subscriptionId: stored.subscriptionId },
        data: {
          expirationDateTime: new Date(
            (updated && updated.expirationDateTime) || expiration
          ),
          lastRenewedAt: new Date(),
        },
      });
      logger.log(
        `[graph] subscription ${record.subscriptionId} renewed — expires ${record.expirationDateTime.toISOString()}`
      );
      return { status: 'renewed', subscription: record };
    } catch (err) {
      // Graph forgets subscriptions that already lapsed; recreate rather than
      // leaving the system silently without notifications.
      const notFound =
        err && (err.statusCode === 404 || err.code === 'ResourceNotFound');
      graphStatus.recordError('subscription-renew', err);
      if (notFound) {
        logger.warn(
          `[graph] subscription ${stored.subscriptionId} no longer exists — recreating`
        );
        await clearStored(stored.subscriptionId);
        const fresh = await createSubscription();
        return { status: 'recreated', subscription: fresh };
      }
      logger.error(`[graph] subscription renewal failed: ${err.message}`);
      throw err;
    }
  }

  /** Delete the live subscription and forget it locally. */
  async function deleteSubscription() {
    const stored = await getStored();
    if (!stored) return { status: 'none' };
    try {
      await transport().deleteSubscription(stored.subscriptionId);
    } catch (err) {
      // A already-gone subscription is still a successful delete for us.
      const notFound =
        err && (err.statusCode === 404 || err.code === 'ResourceNotFound');
      if (!notFound) {
        graphStatus.recordError('subscription-delete', err);
        logger.error(`[graph] subscription delete failed: ${err.message}`);
        throw err;
      }
    }
    await clearStored(stored.subscriptionId);
    logger.log(`[graph] subscription ${stored.subscriptionId} deleted`);
    return { status: 'deleted', subscriptionId: stored.subscriptionId };
  }

  function isExpired(stored, at = Date.now()) {
    return new Date(stored.expirationDateTime).getTime() <= at;
  }

  function needsRenewal(stored, at = Date.now()) {
    return new Date(stored.expirationDateTime).getTime() - at <= RENEW_WHEN_REMAINING_MS;
  }

  /**
   * Make the live subscription match configuration:
   * create when absent, recreate when expired or pointing elsewhere,
   * renew when close to expiry, otherwise leave it alone.
   */
  async function ensureSubscription() {
    if (!config.webhookEnabled) return { status: 'disabled' };

    const stored = await getStored();
    if (!stored) {
      const created = await createSubscription();
      return { status: 'created', subscription: created };
    }

    // Configuration moved (new public URL) -> the old one points at a dead host.
    if (stored.notificationUrl !== config.notificationUrl) {
      logger.log(
        `[graph] notification URL changed (${stored.notificationUrl} -> ${config.notificationUrl}) — recreating subscription`
      );
      await deleteSubscription().catch(() => {});
      const created = await createSubscription();
      return { status: 'recreated', subscription: created };
    }

    if (isExpired(stored)) {
      logger.warn(
        `[graph] subscription ${stored.subscriptionId} expired at ${new Date(stored.expirationDateTime).toISOString()} — recreating`
      );
      await clearStored(stored.subscriptionId);
      const created = await createSubscription();
      return { status: 'recreated', subscription: created };
    }

    if (needsRenewal(stored)) {
      return renewSubscription();
    }

    return { status: 'current', subscription: stored };
  }

  /** Read-only view for health/status reporting. Never exposes clientState. */
  async function inspect() {
    const stored = await getStored();
    if (!stored) {
      return {
        configured: Boolean(config.webhookEnabled),
        active: false,
        status: config.webhookEnabled ? 'not-subscribed' : 'disabled',
        subscriptionId: null,
        expirationDateTime: null,
        expiresInSeconds: null,
        notificationUrl: config.notificationUrl || null,
        resource: null,
        lastRenewedAt: null,
      };
    }
    const expiresAt = new Date(stored.expirationDateTime);
    const expired = expiresAt.getTime() <= Date.now();
    return {
      configured: Boolean(config.webhookEnabled),
      active: !expired,
      status: expired ? 'expired' : 'active',
      subscriptionId: stored.subscriptionId,
      expirationDateTime: expiresAt.toISOString(),
      expiresInSeconds: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
      notificationUrl: stored.notificationUrl,
      resource: stored.resource,
      lastRenewedAt: stored.lastRenewedAt ? stored.lastRenewedAt.toISOString() : null,
    };
  }

  /**
   * Periodic renewal. Runs on an interval so no human has to recreate an
   * expired subscription by hand.
   */
  function startLifecycle() {
    if (!config.webhookEnabled) {
      logWebhookStatus((line) => logger.log(line));
      return false;
    }

    ensureSubscription().catch((err) => {
      graphStatus.recordError('subscription-ensure', err);
      logger.error(
        `[graph] initial subscription setup failed: ${err.message} — polling fallback continues`
      );
    });

    renewTimer = setInterval(() => {
      ensureSubscription().catch((err) => {
        graphStatus.recordError('subscription-renew', err);
        logger.error(
          `[graph] scheduled subscription renewal failed: ${err.message} — polling fallback continues`
        );
      });
    }, config.subscriptionRenewIntervalMs);
    if (renewTimer.unref) renewTimer.unref();

    logger.log(
      `[graph] subscription auto-renewal every ${Math.round(config.subscriptionRenewIntervalMs / 60000)} min`
    );
    return true;
  }

  function stopLifecycle() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  return {
    getStored,
    verifyClientState,
    createSubscription,
    renewSubscription,
    deleteSubscription,
    ensureSubscription,
    inspect,
    startLifecycle,
    stopLifecycle,
    isExpired,
    needsRenewal,
  };
}

// Process-wide default instance used by the server and routes.
let defaultService = null;
function getSubscriptionService() {
  if (!defaultService) defaultService = createSubscriptionService({ logger: console });
  return defaultService;
}

module.exports = {
  createSubscriptionService,
  getSubscriptionService,
  clientStateMatches,
  MAX_SUBSCRIPTION_MINUTES,
  RENEW_WHEN_REMAINING_MS,
};
