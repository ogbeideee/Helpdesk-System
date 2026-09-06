// Microsoft 365 integration — administrator configuration view + credential
// verification.
//
// GET  /api/microsoft-365         the full integration picture (read-only)
// POST /api/microsoft-365/verify  explicit credential validation
//
// This endpoint NEVER returns the client secret, an access token, or a
// subscription clientState. Identifiers an administrator needs to compare
// against the Entra portal (tenant ID, client ID, mailbox) are shown in full.
//
// The integration itself is environment-configured; this API reports the
// CURRENT environment (re-read per request), so what an administrator sees
// here is what a restart would activate.
const express = require('express');

const router = express.Router();

// Result of the most recent POST /verify in this process — surfaced by GET so
// a page refresh still shows the last validation outcome. Never holds a token.
let lastVerification = null;

function buildRouter(deps = {}) {
  const logger = deps.logger || console;
  const configModule = deps.configModule || require('../src/graph/config');
  const graphStatus = deps.graphStatus || require('../src/graph/graphStatus');

  // Production transport resolves lazily, so the Graph SDK + MSAL never load
  // merely by viewing this page. Tests inject `ops`.
  function transport() {
    if (deps.ops) return deps.ops;
    return require('../src/graph/graphClient').graphOps;
  }

  function subscriptionView(cfg) {
    if (!cfg.enabled) {
      return { configured: cfg.webhookEnabled, active: false, status: 'disabled' };
    }
    // inspect() only reads the locally persisted subscription record — it
    // never contacts Microsoft, so the page cannot fail because Graph is down.
    return deps.subscriptionInspect
      ? deps.subscriptionInspect()
      : require('../src/graph/subscriptionService')
          .getSubscriptionService()
          .inspect();
  }

  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const cfg = configModule.readGraphEnv();
      const validation = configModule.validateGraphConfig(cfg);
      const runtime = graphStatus.snapshot();

      let subscription;
      try {
        subscription = await subscriptionView(cfg);
      } catch (err) {
        subscription = { configured: cfg.webhookEnabled, active: false, status: 'unknown', error: err.message };
      }

      res.json({
        // not_configured | disabled | enabled — runtime problems are reported
        // through lastError, not by relabeling the configuration state.
        state: configModule.describeGraphState(cfg),
        configured: cfg.credentialsComplete,
        enabled: cfg.enabled,
        explicitlyDisabled: cfg.explicitlyDisabled,
        configuration: {
          tenantId: cfg.tenantId || null,
          clientId: cfg.clientId || null,
          mailbox: cfg.sharedMailbox || null,
          broadcastDlSet: Boolean(cfg.broadcastDl),
          pollIntervalSeconds: Math.round(cfg.pollIntervalMs / 1000),
          pollBatchSize: cfg.pollBatchSize,
          dryRun: cfg.dryRun,
          ingestGuard: {
            since: cfg.ingestSince ? cfg.ingestSince.toISOString() : null,
            maxAgeHours: cfg.ingestMaxAgeHours,
          },
          webhook: {
            enabled: cfg.webhookEnabled,
            notificationUrl: cfg.notificationUrl || null,
            clientStateSet: Boolean(cfg.webhookClientState),
            renewIntervalSeconds: Math.round(cfg.subscriptionRenewIntervalMs / 1000),
          },
        },
        requiredConfiguration: configModule.REQUIRED_CONFIGURATION.map((item) => ({
          variable: item.variable,
          label: item.label,
          // Secrets are reported as set/unset — their value is never sent.
          secret: item.secret,
          present: Boolean(process.env[item.variable] && String(process.env[item.variable]).trim()),
        })),
        validation,
        connection: lastVerification,
        runtime: {
          polling: {
            running: runtime.pollingRunning,
            intervalSeconds: Math.round(cfg.pollIntervalMs / 1000),
            lastPollAt: runtime.lastPollAt,
            lastPollSummary: runtime.lastPollSummary,
          },
          subscription,
          webhook: {
            notificationsReceived: runtime.webhookNotificationsReceived,
            messagesProcessed: runtime.webhookMessagesProcessed,
            lastNotificationAt: runtime.lastWebhookNotificationAt,
          },
          lastSuccessfulProcessing: runtime.lastSuccessAt
            ? {
                at: runtime.lastSuccessAt,
                source: runtime.lastSuccessSource,
                messageId: runtime.lastSuccessMessageId,
                outcome: runtime.lastSuccessOutcome,
              }
            : null,
          lastError: runtime.lastError,
        },
      });
    } catch (err) {
      logger.error(`[m365] status view failed: ${err.message}`);
      res.status(500).json({ error: 'could not build the Microsoft 365 status view' });
    }
  });

  r.post('/verify', async (req, res) => {
    const cfg = configModule.readGraphEnv();
    if (!cfg.credentialsComplete) {
      const validation = configModule.validateGraphConfig(cfg);
      res.status(400).json({
        ok: false,
        error: 'Microsoft 365 is not configured — the required environment values are missing',
        missing: validation.missing,
      });
      return;
    }

    // Explicit, administrator-initiated credential validation: a client-
    // credential token is acquired and a read-only mailbox profile is read.
    // Nothing is created, sent, or marked read. Tests inject `ops`, so no
    // automated test ever contacts Microsoft.
    const checkedAt = new Date().toISOString();
    try {
      const profile = await transport().getMailboxProfile();
      lastVerification = {
        ok: true,
        checkedAt,
        mailbox: { mail: profile.mail || cfg.sharedMailbox, displayName: profile.displayName || null },
      };
    } catch (err) {
      graphStatus.recordError('m365-verify', err);
      logger.error(`[m365] credential verification failed: ${err.message}`);
      lastVerification = { ok: false, checkedAt, error: String(err.message || err).slice(0, 300) };
    }
    res.json(lastVerification);
  });

  return r;
}

router.use(buildRouter());
module.exports = router;
module.exports.buildRouter = buildRouter;
