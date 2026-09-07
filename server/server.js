require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const prisma = require('./src/lib/prisma');

const app = express();
app.use(cors());
app.use(express.json());

// Public routes (auth endpoints + health + the Graph change-notification
// callback, which Microsoft calls unauthenticated and authenticates via
// clientState inside the route).
app.use('/api/auth', require('./routes/auth'));
app.use('/api/webhooks', require('./routes/webhooks'));

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
    const [teams, openRows, unassignedRows, agentRows] = await Promise.all([
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
    ]);
    const openByTeam = new Map(openRows.map((r) => [r.teamId, r._count._all]));
    const unassignedByTeam = new Map(unassignedRows.map((r) => [r.teamId, r._count._all]));
    const agentsByTeam = new Map();
    for (const a of agentRows) {
      agentsByTeam.set(a.teamId, (agentsByTeam.get(a.teamId) || 0) + 1);
    }
    const rules = require('./src/services/assignmentEngine').loadConfig();
    res.json(
      teams.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        activeAgents: agentsByTeam.get(t.id) || 0,
        openTickets: openByTeam.get(t.id) || 0,
        unassignedTickets: unassignedByTeam.get(t.id) || 0,
        minSkillLevel: rules.categories && Object.values(rules.categories).some((c) => c.group === t.key)
          ? Math.min(...Object.values(rules.categories).filter((c) => c.group === t.key).map((c) => c.minSkillLevel ?? 1))
          : 1,
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

  let subscription = { configured: false, active: false, status: 'disabled' };
  if (graphConfig.enabled) {
    try {
      subscription = await require('./src/graph/subscriptionService')
        .getSubscriptionService()
        .inspect();
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
      notificationUrl: graphConfig.notificationUrl || null,
      mailbox: graphConfig.sharedMailbox || null,
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

app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`Ticketing API listening on http://localhost:${PORT}`);

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
  // overlapping runs; every move is concurrency-safe.
  require('./src/services/workloadService').startRebalancer({ logger: console });

  // Handover expiry. Bounded and guarded against overlapping sweeps; a paused
  // (recipient unavailable) request is skipped by construction.
  require('./src/services/handoverService').startExpirySweeper({ logger: console });

  // SLA approaching-breach/breach detection. Bounded, index-led scans guarded
  // against overlapping sweeps; records TicketSlaEvent history and cycle latch
  // flags only — ticket state and mirrors are never touched here. A no-op with
  // SLA_SWEEP_INTERVAL_MS=0.
  require('./src/slaSweeper').startSlaSweeper({ logger: console });

  // Scheduled weekly/monthly reports. Reads the configured recipients and
  // send moments from the settings system; a failed report is logged and
  // audited, never fatal. A no-op with REPORT_SCHEDULER_INTERVAL_MS=0.
  require('./src/reportScheduler').startReportScheduler({ logger: console });

  require('./src/graph/poller').startPolling();

  // IMAP ingestion — the alternative email source feeding the same ticket
  // intake pipeline. A safe no-op unless IMAP_HOST/IMAP_USER/IMAP_PASSWORD
  // are configured; a failed cycle is logged and the next tick retries.
  require('./src/imap/poller').startImapPoller();

  // Webhook subscription lifecycle. Safe no-op when WEBHOOK_PUBLIC_URL is
  // absent — polling remains the ingestion path.
  require('./src/graph/subscriptionService').getSubscriptionService().startLifecycle();
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

module.exports = app;
