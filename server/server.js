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

// Authenticated API
app.use('/api/tickets', require('./src/authMiddleware').requireAuth, require('./routes/tickets'));
app.use('/api/stats', require('./src/authMiddleware').requireAuth, require('./routes/stats'));
app.use('/api/dashboard', require('./src/authMiddleware').requireAuth, require('./routes/dashboard'));
app.use('/api/agents', require('./routes/agents'));

// Reference data for the client — read-only, authenticated.
app.get('/api/teams', require('./src/authMiddleware').requireAuth, async (req, res) => {
  try {
    res.json(await prisma.team.findMany({ orderBy: { key: 'asc' } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assignment groups (routing targets) with live capacity info.
app.get('/api/assignment-groups', require('./src/authMiddleware').requireAuth, async (req, res) => {
  try {
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

// Operational status for administrators. Deliberately contains no secrets:
// no access token, no client secret, no subscription clientState.
app.get('/api/health', async (req, res) => {
  const { graphConfig } = require('./src/graph/config');
  const graphStatus = require('./src/graph/graphStatus');
  const status = graphStatus.snapshot();

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

  require('./src/graph/poller').startPolling();

  // Webhook subscription lifecycle. Safe no-op when WEBHOOK_PUBLIC_URL is
  // absent — polling remains the ingestion path.
  require('./src/graph/subscriptionService').getSubscriptionService().startLifecycle();
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  require('./src/graph/poller').stopPolling();
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
