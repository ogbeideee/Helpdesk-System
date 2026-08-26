// Single source of truth for the route the subscription points at.
const WEBHOOK_PATH = '/api/webhooks/microsoft-graph';

function readGraphEnv() {
  const tenantId = process.env.GRAPH_TENANT_ID || '';
  const clientId = process.env.GRAPH_CLIENT_ID || '';
  const clientSecret = process.env.GRAPH_CLIENT_SECRET || '';
  const sharedMailbox = process.env.GRAPH_SHARED_MAILBOX || '';
  const broadcastDl = process.env.GRAPH_BROADCAST_DL || '';
  const pollIntervalMs = Number(process.env.MAIL_POLL_INTERVAL_MS) || 120000;

  const enabled = Boolean(
    tenantId && clientId && clientSecret && sharedMailbox
  );

  // --- Change notifications (webhook) ---------------------------------
  // Entirely optional. Without WEBHOOK_PUBLIC_URL the app keeps running and
  // ingestion falls back to polling, which is the local-development default.
  const webhookPublicUrl = String(process.env.WEBHOOK_PUBLIC_URL || '').trim();
  const webhookBase = webhookPublicUrl.replace(/\/+$/, '');
  // Graph only delivers to public HTTPS endpoints.
  const webhookIsHttps = /^https:\/\//i.test(webhookBase);
  const notificationUrl = webhookBase ? `${webhookBase}${WEBHOOK_PATH}` : '';
  const webhookEnabled = Boolean(enabled && webhookBase && webhookIsHttps);
  // clientState is the mechanism Graph documents for validating that an
  // inbound notification really came from our subscription.
  const webhookClientState = String(process.env.GRAPH_WEBHOOK_CLIENT_STATE || '').trim();
  const subscriptionRenewIntervalMs =
    Number(process.env.GRAPH_SUBSCRIPTION_RENEW_INTERVAL_MS) || 30 * 60 * 1000;

  return {
    tenantId,
    clientId,
    clientSecret,
    sharedMailbox,
    broadcastDl,
    pollIntervalMs,
    enabled,
    webhookPublicUrl: webhookBase,
    webhookIsHttps,
    notificationUrl,
    webhookEnabled,
    webhookClientState,
    subscriptionRenewIntervalMs,
  };
}

const graphConfig = readGraphEnv();

function logGraphStatus(logger) {
  const missing = [
    !process.env.GRAPH_TENANT_ID && 'GRAPH_TENANT_ID',
    !process.env.GRAPH_CLIENT_ID && 'GRAPH_CLIENT_ID',
    !process.env.GRAPH_CLIENT_SECRET && 'GRAPH_CLIENT_SECRET',
    !process.env.GRAPH_SHARED_MAILBOX && 'GRAPH_SHARED_MAILBOX',
  ].filter(Boolean);
  if (graphConfig.enabled) {
    logger('Microsoft Graph integration enabled.');
    logger(
      `[graph] mailbox=${graphConfig.sharedMailbox} · polling every ${Math.round(graphConfig.pollIntervalMs / 1000)}s`
    );
    if (!graphConfig.broadcastDl) {
      logger('[graph] GRAPH_BROADCAST_DL not set — team broadcast emails will be skipped');
    }
    logWebhookStatus(logger);
  } else {
    logger('Microsoft Graph integration disabled.');
    logger(
      `[graph] missing env vars: ${missing.join(', ')}. The API and frontend keep running; email ingestion is off and notifications are logged locally.`
    );
  }
}

// Explains, in one place, why webhook mode is or is not active. Missing or
// non-HTTPS configuration is a normal, non-fatal state: polling still runs.
function logWebhookStatus(logger) {
  if (graphConfig.webhookEnabled) {
    logger(`[graph] webhook mode enabled — notifications to ${graphConfig.notificationUrl}`);
    if (!graphConfig.webhookClientState) {
      logger(
        '[graph] GRAPH_WEBHOOK_CLIENT_STATE not set — a random value is generated per start; ' +
          'set it in the environment so subscriptions survive a restart'
      );
    }
    return;
  }
  if (!graphConfig.webhookPublicUrl) {
    logger(
      '[graph] WEBHOOK_PUBLIC_URL not set — webhook mode unavailable; ' +
        'using polling fallback for inbound email'
    );
  } else if (!graphConfig.webhookIsHttps) {
    logger(
      `[graph] WEBHOOK_PUBLIC_URL must be https:// (got ${graphConfig.webhookPublicUrl}) — ` +
        'webhook mode unavailable; using polling fallback'
    );
  }
}

module.exports = { graphConfig, logGraphStatus, logWebhookStatus, WEBHOOK_PATH };
