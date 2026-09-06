// Single source of truth for the route the subscription points at.
const WEBHOOK_PATH = '/api/webhooks/microsoft-graph';

// The Entra app registration values the integration needs before it can do
// anything. Drives both the enabled derivation and the administrator-facing
// configuration checklist.
const REQUIRED_CONFIGURATION = [
  { variable: 'GRAPH_TENANT_ID', label: 'Tenant ID (Entra directory)', secret: false },
  { variable: 'GRAPH_CLIENT_ID', label: 'Application (client) ID', secret: false },
  { variable: 'GRAPH_CLIENT_SECRET', label: 'Client secret', secret: true },
  { variable: 'GRAPH_SHARED_MAILBOX', label: 'Shared mailbox address', secret: false },
];

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// A tenant may be a GUID, a verified domain name, or a well-known alias.
const TENANT_RE = /^(common|organizations|consumers|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)$/;

/**
 * Read the Microsoft 365 integration configuration straight from the
 * environment. Exported so the administrator API always shows the CURRENT
 * environment (the module-level `graphConfig` is the snapshot the running
 * integration was booted with).
 */
function readGraphEnv() {
  const tenantId = process.env.GRAPH_TENANT_ID || '';
  const clientId = process.env.GRAPH_CLIENT_ID || '';
  const clientSecret = process.env.GRAPH_CLIENT_SECRET || '';
  const sharedMailbox = process.env.GRAPH_SHARED_MAILBOX || '';
  const broadcastDl = process.env.GRAPH_BROADCAST_DL || '';
  const pollIntervalMs = Number(process.env.MAIL_POLL_INTERVAL_MS) || 120000;

  // GRAPH_ENABLED is the operator's explicit off-switch: an operator can
  // disable the integration without unsetting credentials (and the admin UI
  // can then say "configured but disabled" instead of "not configured").
  // Unset means "on whenever the credentials are complete" — the historical
  // behaviour.
  const enabledToggle = String(process.env.GRAPH_ENABLED || '').trim().toLowerCase();
  const explicitlyDisabled = enabledToggle === 'false' || enabledToggle === '0' || enabledToggle === 'no';
  const credentialsComplete = Boolean(tenantId && clientId && clientSecret && sharedMailbox);
  const enabled = credentialsComplete && !explicitlyDisabled;

  // --- Ingestion safety guards ----------------------------------------
  // Protects a real mailbox from being turned into hundreds of tickets the
  // first time the integration is switched on.
  //   GRAPH_INGEST_SINCE          absolute ISO cutoff (wins when set)
  //   GRAPH_INGEST_MAX_AGE_HOURS  relative cutoff, default 24h
  //   GRAPH_POLL_BATCH_SIZE       messages fetched per cycle, default 25
  //   GRAPH_DRY_RUN               parse and log, never create tickets
  const ingestSinceRaw = String(process.env.GRAPH_INGEST_SINCE || '').trim();
  const ingestSince =
    ingestSinceRaw && !Number.isNaN(Date.parse(ingestSinceRaw))
      ? new Date(ingestSinceRaw)
      : null;
  const ingestMaxAgeHours =
    process.env.GRAPH_INGEST_MAX_AGE_HOURS === ''
      ? 24
      : Number(process.env.GRAPH_INGEST_MAX_AGE_HOURS) >= 0
        ? Number(process.env.GRAPH_INGEST_MAX_AGE_HOURS)
        : 24;
  const pollBatchSize = Number(process.env.GRAPH_POLL_BATCH_SIZE) > 0
    ? Math.min(Number(process.env.GRAPH_POLL_BATCH_SIZE), 100)
    : 25;
  const dryRun = String(process.env.GRAPH_DRY_RUN || '').toLowerCase() === 'true';

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
    explicitlyDisabled,
    credentialsComplete,
    ingestSince,
    ingestMaxAgeHours,
    pollBatchSize,
    dryRun,
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
    logger(
      `[graph] ingest guard: ${describeCutoff()} · batch ${graphConfig.pollBatchSize}` +
        (graphConfig.dryRun ? ' · DRY RUN (no tickets will be created)' : '')
    );
    logWebhookStatus(logger);
  } else if (graphConfig.explicitlyDisabled) {
    logger('Microsoft Graph integration disabled (GRAPH_ENABLED=false).');
    logger(
      `[graph] credentials ${graphConfig.credentialsComplete ? 'are present but unused' : 'are not set'} — email ingestion via Graph is off; IMAP and the rest of the app are unaffected.`
    );
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

/**
 * The point in time before which unread mail is ignored.
 * Absolute cutoff wins; otherwise a rolling window; 0 hours disables the guard.
 */
function ingestCutoff(now = Date.now()) {
  if (graphConfig.ingestSince) return graphConfig.ingestSince;
  if (!graphConfig.ingestMaxAgeHours) return null; // explicitly disabled
  return new Date(now - graphConfig.ingestMaxAgeHours * 3600 * 1000);
}

function describeCutoff() {
  if (graphConfig.ingestSince) {
    return `only mail received after ${graphConfig.ingestSince.toISOString()}`;
  }
  if (!graphConfig.ingestMaxAgeHours) return 'no age limit (all unread mail)';
  return `only mail newer than ${graphConfig.ingestMaxAgeHours}h`;
}

/**
 * Static validation of the Entra app configuration — pure shape checking,
 * never a network call. A real connectivity test lives behind the explicit
 * administrator "verify" action in routes/microsoft365.js.
 *
 * Returns { valid, missing, invalid, warnings } where `missing` is a list of
 * required variable names, `invalid` a list of {variable, reason} for values
 * that are present but unusable, and `warnings` advisory messages that do not
 * block operation.
 */
function validateGraphConfig(cfg = graphConfig) {
  const missing = REQUIRED_CONFIGURATION.filter((item) => {
    const value = process.env[item.variable];
    return !value || !String(value).trim();
  }).map((item) => item.variable);

  const invalid = [];
  if (!missing.includes('GRAPH_TENANT_ID') && !tenantIdIsPlausible(cfg.tenantId)) {
    invalid.push({
      variable: 'GRAPH_TENANT_ID',
      reason: 'must be the Entra tenant GUID, a verified domain name, or common/organizations/consumers',
    });
  }
  if (!missing.includes('GRAPH_CLIENT_ID') && !GUID_RE.test(String(cfg.clientId).trim())) {
    invalid.push({
      variable: 'GRAPH_CLIENT_ID',
      reason: 'must be the application (client) GUID from the Entra app registration',
    });
  }
  if (!missing.includes('GRAPH_SHARED_MAILBOX') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(cfg.sharedMailbox).trim())) {
    invalid.push({
      variable: 'GRAPH_SHARED_MAILBOX',
      reason: 'must be the shared mailbox email address',
    });
  }
  if (!missing.includes('GRAPH_CLIENT_SECRET') && /[\r\n]/.test(String(process.env.GRAPH_CLIENT_SECRET))) {
    invalid.push({
      variable: 'GRAPH_CLIENT_SECRET',
      reason: 'must be a single-line value (line breaks suggest a copy/paste error)',
    });
  }

  const warnings = [];
  if (cfg.webhookPublicUrl && !cfg.webhookIsHttps) {
    warnings.push('WEBHOOK_PUBLIC_URL must be https:// — webhook mode is unavailable and polling is used');
  }
  if (cfg.webhookEnabled && !cfg.webhookClientState) {
    warnings.push('GRAPH_WEBHOOK_CLIENT_STATE is not set — a random value is generated per start, so set it explicitly to keep subscriptions valid across restarts');
  }
  if (cfg.enabled && !cfg.broadcastDl) {
    warnings.push('GRAPH_BROADCAST_DL is not set — new-ticket broadcast emails are skipped');
  }

  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid, warnings };
}

function tenantIdIsPlausible(tenantId) {
  const value = String(tenantId || '').trim();
  return GUID_RE.test(value) || TENANT_RE.test(value);
}

/**
 * The administrator-facing integration state, derived from configuration
 * alone (runtime problems are reported separately via lastError):
 *   not_configured — required env values are missing
 *   disabled       — configured but explicitly switched off (GRAPH_ENABLED=false)
 *   enabled        — configured and active
 */
function describeGraphState(cfg = graphConfig) {
  if (cfg.enabled) return 'enabled';
  if (cfg.explicitlyDisabled) return 'disabled';
  return 'not_configured';
}

module.exports = {
  graphConfig,
  readGraphEnv,
  validateGraphConfig,
  describeGraphState,
  REQUIRED_CONFIGURATION,
  logGraphStatus,
  logWebhookStatus,
  ingestCutoff,
  describeCutoff,
  WEBHOOK_PATH,
};
