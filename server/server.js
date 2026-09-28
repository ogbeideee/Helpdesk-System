require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { Prisma } = require('@prisma/client');
const path = require('path');
const prisma = require('./src/lib/prisma');

const app = express();
// Deployed behind the Fly.io proxy — honor one hop of X-Forwarded-For so
// rate limiting keys on the real client address, not the proxy's.
app.set('trust proxy', 1);
app.use(cors());
// gzip every response — the SPA bundle and API payloads alike. Express serves
// no compression by default, so a first visit previously downloaded the bundle
// uncompressed.
app.use(compression());
app.use(express.json());

// Public routes (auth endpoints + health + the requester status lookup + the
// Graph change-notification callback, which Microsoft calls unauthenticated
// and authenticates via clientState inside the route).
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/public', require('./routes/public'));

// Development-only tooling (email parser harness). The router itself returns
// 404 when NODE_ENV=production, and it never creates or stores anything.
app.use('/api/dev', require('./routes/dev'));

// Authenticated API
app.use('/api/tickets', require('./src/authMiddleware').requireAuth, require('./routes/tickets'));
app.use('/api/stats', require('./src/authMiddleware').requireAuth, require('./routes/stats'));
app.use('/api/dashboard', require('./src/authMiddleware').requireAuth, require('./routes/dashboard'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/routing', require('./routes/routing'));
app.use('/api/workload', require('./routes/workload'));
app.use('/api/handovers', require('./routes/handovers'));
// Remote access sessions — application-side foundation only (request/start/
// end/cancel bookkeeping tied to a ticket; no remote-control transport).
app.use('/api/remote-access', require('./src/authMiddleware').requireAuth, require('./routes/remoteAccess'));
// SLA settings — administrator-only, reading and writing alike.
app.use('/api/sla', require('./src/authMiddleware').requireAdmin, require('./routes/sla'));
// Unified audit trail — administrator-only, read-only.
app.use('/api/audit', require('./src/authMiddleware').requireAdmin, require('./routes/audit'));
// Operational reports — administrator-only, read-only.
app.use('/api/reports', require('./src/authMiddleware').requireAdmin, require('./routes/reports'));
// Email parsing rules — administrator-only configuration of the keyword rules
// the parser evaluates on inbound mail.
app.use('/api/email-rules', require('./src/authMiddleware').requireAdmin, require('./routes/emailRules'));
// Email relevance triage — administrator-only policy, monitoring and the
// emergency auto-skip stop. The Groq key remains an environment secret.
app.use('/api/email-triage', require('./routes/emailTriage'));
// Microsoft 365 integration — administrator-only configuration status and
// credential verification. Never returns secrets or tokens.
app.use('/api/microsoft-365', require('./src/authMiddleware').requireAdmin, require('./routes/microsoft365'));

// Reference data for the client — read-only, authenticated.
app.get('/api/teams', require('./src/authMiddleware').requireAuth, async (req, res) => {
  try {
    res.json(await prisma.team.findMany({ orderBy: { key: 'asc' } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assignment groups (routing targets) with live capacity info.
app.get('/api/assignment-groups', require('./src/authMiddleware').requireAuth, async (req, res) => {  try {
    const { OPEN_STATES } = require('./src/states');
    const assignmentEngine = require('./src/services/assignmentEngine');
    const [teams, openRows, unassignedRows, agentRows, skillBars] = await Promise.all([
      prisma.team.findMany({ orderBy: { key: 'asc' } }),
      prisma.ticket.groupBy({
        by: ['teamId'],
        _count: { _all: true },
        where: { state: { in: OPEN_STATES } },
      }),
      prisma.ticket.groupBy({
        by: ['teamId'],
        _count: { _all: true },
        where: { state: { in: OPEN_STATES }, assignedAgentId: null },
      }),
      prisma.agent.findMany({ where: { isActive: true }, select: { teamId: true } }),
      assignmentEngine.groupSkillBars(),
    ]);
    const openByTeam = new Map(openRows.map((r) => [r.teamId, r._count._all]));
    const unassignedByTeam = new Map(unassignedRows.map((r) => [r.teamId, r._count._all]));
    const agentsByTeam = new Map();
    for (const a of agentRows) {
      agentsByTeam.set(a.teamId, (agentsByTeam.get(a.teamId) || 0) + 1);
    }
    res.json(
      teams.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        activeAgents: agentsByTeam.get(t.id) || 0,
        openTickets: openByTeam.get(t.id) || 0,
        unassignedTickets: unassignedByTeam.get(t.id) || 0,
        // The bar the engine applies to this group — the lowest minimum skill
        // among its active routing rules — not a second copy of it.
        minSkillLevel: skillBars.get(t.id) || 1,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assignment pools — per-group view of who is online, unavailable or offline,
// with the current ticket load. Read-only, built from the same availability
// columns the assignment engine enforces.
app.get('/api/assignment-pools', require('./src/authMiddleware').requireAuth, async (req, res) => {
  try {
    res.json({ pools: await require('./src/services/assignmentPoolService').listGroupPools() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Operational status for administrators. Deliberately contains no secrets:
// no access token, no client secret, no subscription clientState, and no IMAP
// username or password.
app.get('/api/health', async (req, res) => {
  const { graphConfig } = require('./src/graph/config');
  const { imapConfig } = require('./src/imap/config');
  const graphStatus = require('./src/graph/graphStatus');
  const imapStatus = require('./src/imap/imapStatus');
  const status = graphStatus.snapshot();
  const imap = imapStatus.snapshot();

  // Subscription state is reported, but its notificationUrl is stripped: it is
  // built from WEBHOOK_PUBLIC_URL, so echoing it on this unauthenticated route
  // republishes the deployment's own domain. The path is already public in
  // /api/webhooks, so nothing operational is lost. An administrator reads the
  // real URL from GET /api/microsoft-365 (behind requireAdmin).
  let subscription = { configured: false, active: false, status: 'disabled' };
  if (graphConfig.enabled) {
    try {
      const inspected = await require('./src/graph/subscriptionService')
        .getSubscriptionService()
        .inspect();
      const { notificationUrl, ...publicShape } = inspected || {};
      subscription = publicShape;
    } catch (err) {
      subscription = { configured: graphConfig.webhookEnabled, active: false, status: 'unknown', error: err.message };
    }
  }

  res.json({
    ok: true,
    // Unchanged for existing consumers.
    graph: graphConfig.enabled ? 'enabled' : 'disabled',
    time: new Date().toISOString(),
    integration: {
      graphEnabled: graphConfig.enabled,
      webhookEnabled: graphConfig.webhookEnabled,
      webhookReason: graphConfig.webhookEnabled
        ? null
        : !graphConfig.enabled
          ? 'graph integration disabled'
          : !graphConfig.webhookPublicUrl
            ? 'WEBHOOK_PUBLIC_URL not set'
            : !graphConfig.webhookIsHttps
              ? 'WEBHOOK_PUBLIC_URL must be https'
              : null,
      // The shared mailbox and the notification URL are deliberately NOT
      // reported here. This endpoint is unauthenticated, so publishing them
      // handed the live ingestion target to anyone who asked — the one value
      // this deployment treats as a secret. Administrators read both from
      // GET /api/microsoft-365, which is behind requireAdmin.
      notificationUrlConfigured: Boolean(graphConfig.notificationUrl),
      mailboxConfigured: Boolean(graphConfig.sharedMailbox),
      polling: {
        running: status.pollingRunning,
        intervalSeconds: Math.round(graphConfig.pollIntervalMs / 1000),
        lastPollAt: status.lastPollAt,
        lastPollSummary: status.lastPollSummary,
      },
      subscription,
      webhook: {
        notificationsReceived: status.webhookNotificationsReceived,
        messagesProcessed: status.webhookMessagesProcessed,
        lastNotificationAt: status.lastWebhookNotificationAt,
      },
      lastSuccessfulProcessing: status.lastSuccessAt
        ? {
            at: status.lastSuccessAt,
            source: status.lastSuccessSource,
            messageId: status.lastSuccessMessageId,
            outcome: status.lastSuccessOutcome,
          }
        : null,
      lastError: status.lastError,
      imap: {
        enabled: imapConfig.enabled,
        // 'oauth2' (XOAUTH2) | 'password' (LOGIN) | 'disabled' — the mode is
        // safe to report; the credentials behind it never are. A partially
        // configured OAuth2 block is flagged so an administrator can fix the
        // env vars without any secret ever leaving the server.
        authMode: imapConfig.enabled ? imapConfig.authMode : 'disabled',
        oauth2Misconfigured: imapConfig.oauth2Misconfigured === true,
        // Connection target so an administrator can see WHERE mail is polled
        // from — never the credentials used to authenticate.
        host: imapConfig.enabled ? imapConfig.host : null,
        port: imapConfig.enabled ? imapConfig.port : null,
        secure: imapConfig.enabled ? imapConfig.secure : null,
        mailbox: imapConfig.enabled ? imapConfig.mailbox : null,
        polling: {
          running: imap.pollingRunning,
          intervalSeconds: imapConfig.pollIntervalMs > 0 ? Math.round(imapConfig.pollIntervalMs / 1000) : null,
          lastPollAt: imap.lastPollAt,
          lastPollSummary: imap.lastPollSummary,
        },
        lastSuccessfulProcessing: imap.lastSuccessAt
          ? { at: imap.lastSuccessAt, messageId: imap.lastSuccessMessageId, outcome: imap.lastSuccessOutcome }
          : null,
        lastError: imap.lastError,
      },
    },
  });
});

// Static SPA. Vite fingerprints files under assets/, so they can be cached
// forever — a new deploy produces new filenames and a stale cache is never
// wrong. index.html must revalidate, otherwise a returning visitor keeps
// running the previous deployment's bundle.
app.use(express.static(path.join(__dirname, '..', 'client', 'dist'), {
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// NOTE: Everything from here down is the "standalone server" concern — binding a
// TCP port and running the long-lived background timers. server.js is THE entry
// point (`node server.js`, the Docker CMD); the export at the bottom exists so
// tests and tooling can mount the Express `app` without opening a port.

// ---------------------------------------------------------------------------
// Background jobs — these ALL rely on a long-lived process and are started
// ONLY in standalone mode (see below). Single-instance by design: polling,
// rebalancing and the sweepers guard against overlapping runs within a
// process but there is no cross-process leader election, so run exactly one
// machine (fly.toml: min_machines_running = 1). A second poller is NOT merely
// wasteful: two of them can list the same unseen message, both pass intake's
// dedupe pre-check, and one loses the insert race on the unique message
// identity. That loser is now reported as a duplicate rather than an error
// (ticketIntake.isMessageIdentityConflict), so it stays correct — but it still
// doubles the IMAP and Graph API traffic, and it is not the design.
//   - workload rebalancer      (server/src/services/workloadService)
//   - handover expiry sweeper  (server/src/services/handoverService)
//   - SLA sweeper             (server/src/slaSweeper)
//   - report scheduler        (server/src/reportScheduler)
//   - Graph mailbox poller     (server/src/graph/poller)
//   - IMAP mailbox poller      (server/src/imap/poller)
//   - Graph subscription      lifecycle (server/src/graph/subscriptionService)
// ---------------------------------------------------------------------------

async function bootStartupChecks() {
  // Prisma client freshness guard. The generated client (node_modules/.prisma)
  // is NOT rebuilt when prisma/schema.prisma changes — pulling new code without
  // re-running `prisma generate` leaves every query touching a newer relation
  // (e.g. Ticket.slaCycles) dying with PrismaClientValidationError ("Unknown
  // field … for include statement"). Validate one such relation up front and
  // fail boot with the fix instead of returning 500s from every route.
  // The validation error is raised client-side, so a stale client is detected
  // even before the database is reachable; other errors (e.g. the database
  // being down) are only warned about and boot continues as before.
  try {
    await prisma.ticket.findFirst({
      where: { id: -1 },
      include: { slaCycles: { select: { id: true } } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientValidationError) {
      console.error(
        '[boot] The generated Prisma Client does not match prisma/schema.prisma.\n' +
          '[boot] Queries using newer fields (e.g. Ticket.slaCycles) would fail on every request.\n' +
          '[boot] Fix: from server/ run  npm run db:generate  and start the server again.\n' +
          '[boot] Re-run it after every git pull that touches server/prisma/. If generate\n' +
          '[boot] fails with EPERM, stop the running dev server first (it locks the query\n' +
          '[boot] engine DLL); OneDrive-synced project folders can also block the write.'
      );
      process.exit(1);
    }
    console.warn(
      `[boot] prisma client check skipped (${err.name}): ${String(err.message).split('\n')[0]}`
    );
  }
}

function startBackgroundJobs() {
  // One-time initial-administrator bootstrap. Inert as soon as any active
  // admin exists, so it can never mint a second one.
  require('./src/services/userService')
    .bootstrapInitialAdmin({ logger: console })
    .then((r) => {
      if (r.status === 'skipped') {
        console.log('[users] INITIAL_ADMIN_EMAIL not set — no administrator bootstrap');
      } else if (r.status === 'inert') {
        console.log(`[users] administrator bootstrap inert (${r.reason})`);
      }
    })
    .catch((err) => console.error(`[users] administrator bootstrap failed: ${err.message}`));

  // Starter routing rules, seeded only when none exist. Administrator edits
  // are never overwritten.
  require('./src/services/defaultRoutingRules')
    .ensureDefaultRoutingRules({ logger: console })
    .catch((err) => console.error(`[routing] default rule seeding failed: ${err.message}`));

  // Background workload balancing. Bounded per cycle and guarded against
  // overlapping runs; every move is concurrency-safe. No-op with
  // REBALANCE_INTERVAL_MS=0.
  require('./src/services/workloadService').startRebalancer({ logger: console });

  // Handover expiry. Bounded and guarded against overlapping sweeps; a paused
  // (recipient unavailable) request is skipped by construction. No-op with
  // HANDOVER_SWEEP_INTERVAL_MS=0.
  require('./src/services/handoverService').startExpirySweeper({ logger: console });

  // SLA approaching-breach/breach detection. Bounded, index-led scans guarded
  // against overlapping sweeps; no-op with SLA_SWEEP_INTERVAL_MS=0.
  require('./src/slaSweeper').startSlaSweeper({ logger: console });

  // Scheduled weekly/monthly reports. No-op with REPORT_SCHEDULER_INTERVAL_MS=0.
  require('./src/reportScheduler').startReportScheduler({ logger: console });

  require('./src/graph/poller').startPolling();

  // Outbound mail. Graph wins when configured, SMTP next, otherwise the
  // console fallback. Only the safe fields are ever printed.
  require('./src/smtp/config').logSmtpStatus((line) => console.log(line));

  // IMAP ingestion — safe no-op unless IMAP_HOST/IMAP_USER/IMAP_PASSWORD
  // are configured; a failed cycle is logged and the next tick retries.
  require('./src/imap/poller').startImapPoller();

  // Webhook subscription lifecycle. Safe no-op when WEBHOOK_PUBLIC_URL is
  // absent — polling remains the ingestion path.
  require('./src/graph/subscriptionService').getSubscriptionService().startLifecycle();
}

const isStandalone = require.main === module;

if (isStandalone) {
  const PORT = process.env.PORT || 4000;
  const server = app.listen(PORT, async () => {
    console.log(`Ticketing API listening on http://localhost:${PORT}`);

    await bootStartupChecks();

    startBackgroundJobs();
  });

  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down`);
    require('./src/graph/poller').stopPolling();
    require('./src/imap/poller').stopImapPoller();
    require('./src/services/workloadService').stopRebalancer();
    require('./src/services/handoverService').stopExpirySweeper();
    require('./src/slaSweeper').stopSlaSweeper();
    require('./src/reportScheduler').stopReportScheduler();
    require('./src/graph/subscriptionService').getSubscriptionService().stopLifecycle();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Export the app so a hosting platform can mount it without starting the listener or
// the background jobs (the 7 background timers run ONLY in standalone mode above).
module.exports = { app, startBackgroundJobs, bootStartupChecks };
