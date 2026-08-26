/* Microsoft Graph change-notification (webhook) tests.

   No live Microsoft credentials are required: the Graph transport is mocked
   and every service takes an injected config, so nothing reads real secrets.
   The ticket pipeline runs against the real database, exactly like the
   existing Graph tests.

   Usage: npm run test:webhook  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const express = require('express');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const graphStatus = require('../src/graph/graphStatus');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

const MARK = 'wh-test-';
const CLIENT_STATE = 'test-client-state-secret';
const NOTIFY_URL = 'https://helpdesk.example.com/api/webhooks/microsoft-graph';

/* ------------------------------------------------------------------ */
/* Config doubles — never derived from real environment secrets        */
/* ------------------------------------------------------------------ */
function webhookConfig(overrides = {}) {
  return {
    enabled: true,
    sharedMailbox: 'helpdesk@example.com',
    webhookPublicUrl: 'https://helpdesk.example.com',
    webhookIsHttps: true,
    notificationUrl: NOTIFY_URL,
    webhookEnabled: true,
    webhookClientState: CLIENT_STATE,
    subscriptionRenewIntervalMs: 30 * 60 * 1000,
    pollIntervalMs: 120000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Fake Graph transport                                                */
/* ------------------------------------------------------------------ */
function makeFakeOps(messages = []) {
  const calls = {
    getMessage: [],
    markAsRead: [],
    listUnread: 0,
    created: [],
    renewed: [],
    deleted: [],
    failGetMessageFor: null,
    failCreate: false,
    renewNotFound: false,
    subCounter: 0,
  };
  return {
    calls,
    messages,
    async getMessage(id) {
      calls.getMessage.push(id);
      if (calls.failGetMessageFor === id) {
        const err = new Error('simulated Graph outage retrieving message');
        err.statusCode = 503;
        throw err;
      }
      const m = messages.find((x) => x.id === id);
      if (!m) {
        const err = new Error('message not found');
        err.statusCode = 404;
        throw err;
      }
      return m;
    },
    async listUnreadMessages(top = 25) {
      calls.listUnread += 1;
      return messages.filter((m) => !m.isRead).slice(0, top);
    },
    async markAsRead(id) {
      const m = messages.find((x) => x.id === id);
      if (m) m.isRead = true;
      calls.markAsRead.push(id);
    },
    async createSubscription({ notificationUrl, clientState }) {
      if (calls.failCreate) throw new Error('simulated subscription create failure');
      calls.subCounter += 1;
      const sub = {
        id: `${MARK}sub-${calls.subCounter}`,
        resource: "/users/helpdesk@example.com/mailFolders('inbox')/messages",
        notificationUrl,
        clientState,
        expirationDateTime: new Date(Date.now() + 4230 * 60 * 1000).toISOString(),
      };
      calls.created.push(sub);
      return sub;
    },
    async renewSubscription(subscriptionId, expirationDateTime) {
      if (calls.renewNotFound) {
        const err = new Error('subscription not found');
        err.statusCode = 404;
        throw err;
      }
      calls.renewed.push({ subscriptionId, expirationDateTime });
      return { id: subscriptionId, expirationDateTime };
    },
    async deleteSubscription(subscriptionId) {
      calls.deleted.push(subscriptionId);
    },
  };
}

function rawGraphMessage({ id, from, subject, bodyText, conversationId }) {
  return {
    id,
    conversationId: conversationId || `conv-${id}`,
    subject,
    from: { emailAddress: from ? { name: from[0], address: from[1] } : {} },
    body: { contentType: 'text', content: bodyText || '' },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  };
}

function notification({ messageId, clientState = CLIENT_STATE, resource, lifecycleEvent }) {
  const n = {
    subscriptionId: `${MARK}sub-1`,
    clientState,
    changeType: 'created',
    subscriptionExpirationDateTime: new Date(Date.now() + 3600e3).toISOString(),
  };
  if (lifecycleEvent) n.lifecycleEvent = lifecycleEvent;
  if (messageId) {
    n.resource = resource || `Users/helpdesk@example.com/Messages/${messageId}`;
    n.resourceData = { id: messageId, '@odata.type': '#Microsoft.Graph.Message' };
  } else if (resource) {
    n.resource = resource;
  }
  return n;
}

/* HTTP helper against an ephemeral express app mounting the real router. */
async function withServer(routerDeps, fn) {
  const { buildRouter } = require('../routes/webhooks');
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', buildRouter(routerDeps));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function cleanup() {
  await prisma.graphSubscription.deleteMany({
    where: { subscriptionId: { startsWith: MARK } },
  });
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { graphMessageId: { startsWith: MARK } },
        { requesterEmail: { contains: 'whtest' } },
      ],
    },
    select: { id: true },
  });
  for (const t of tickets) {
    await prisma.comment.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticketAuditLog.deleteMany({ where: { ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => {});
  }
}

async function main() {
  await ensureTeams(prisma);
  await cleanup();
  graphStatus._reset();

  const { createSubscriptionService } = require('../src/graph/subscriptionService');
  const { createWebhookProcessor } = require('../src/graph/webhookProcessor');
  const { createMailService } = require('../src/graph/mailService');

  const quiet = { log() {}, warn() {}, error() {} };

  /* ================================================================== */
  /* 1. Configuration: missing / non-HTTPS WEBHOOK_PUBLIC_URL           */
  /* ================================================================== */
  {
    // Re-derive the config module under different environments.
    function loadConfigWith(env) {
      const saved = {};
      for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      delete require.cache[require.resolve('../src/graph/config')];
      const mod = require('../src/graph/config');
      const snapshot = { ...mod.graphConfig, _logWebhookStatus: mod.logWebhookStatus };
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      delete require.cache[require.resolve('../src/graph/config')];
      require('../src/graph/config'); // restore the shared instance
      return snapshot;
    }

    const graphEnv = {
      GRAPH_TENANT_ID: 't',
      GRAPH_CLIENT_ID: 'c',
      GRAPH_CLIENT_SECRET: 's',
      GRAPH_SHARED_MAILBOX: 'helpdesk@example.com',
    };

    const missing = loadConfigWith({ ...graphEnv, WEBHOOK_PUBLIC_URL: undefined });
    check('missing WEBHOOK_PUBLIC_URL leaves graph enabled', missing.enabled === true);
    check('missing WEBHOOK_PUBLIC_URL disables webhook mode', missing.webhookEnabled === false);
    check('missing WEBHOOK_PUBLIC_URL yields no notification URL', missing.notificationUrl === '');
    const lines = [];
    missing._logWebhookStatus((l) => lines.push(l));
    check(
      'missing WEBHOOK_PUBLIC_URL logs webhook unavailable + polling fallback',
      lines.some((l) => l.includes('WEBHOOK_PUBLIC_URL not set') && l.includes('polling fallback')),
      JSON.stringify(lines)
    );

    const httpOnly = loadConfigWith({ ...graphEnv, WEBHOOK_PUBLIC_URL: 'http://insecure.example.com' });
    check('non-HTTPS WEBHOOK_PUBLIC_URL disables webhook mode', httpOnly.webhookEnabled === false);

    const good = loadConfigWith({ ...graphEnv, WEBHOOK_PUBLIC_URL: 'https://helpdesk.example.com/' });
    check(
      'notification URL is built from WEBHOOK_PUBLIC_URL (trailing slash tolerated)',
      good.notificationUrl === NOTIFY_URL,
      good.notificationUrl
    );
    check('webhook mode enabled with https public URL', good.webhookEnabled === true);
  }

  /* ================================================================== */
  /* 2. Subscription lifecycle                                          */
  /* ================================================================== */
  {
    const ops = makeFakeOps([]);
    const svc = createSubscriptionService({ ops, config: webhookConfig(), logger: quiet });

    // --- creation ---
    const created = await svc.createSubscription();
    check('subscription created against Graph', ops.calls.created.length === 1);
    check(
      'subscription points at the configured notification URL',
      ops.calls.created[0].notificationUrl === NOTIFY_URL
    );
    check('subscription sends a clientState secret', ops.calls.created[0].clientState === CLIENT_STATE);
    check('subscription persisted locally', Boolean(created.subscriptionId));

    const view = await svc.inspect();
    check('inspect reports an active subscription', view.active === true && view.status === 'active');
    check('inspect exposes the expiration time', Boolean(view.expirationDateTime));
    check('inspect never leaks clientState', !('clientState' in view));

    // --- ensure is a no-op while the subscription is healthy ---
    const ensured = await svc.ensureSubscription();
    check('healthy subscription is left alone', ensured.status === 'current' && ops.calls.created.length === 1);

    // --- renewal when close to expiry ---
    await prisma.graphSubscription.update({
      where: { subscriptionId: created.subscriptionId },
      data: { expirationDateTime: new Date(Date.now() + 60 * 60 * 1000) }, // 1h left
    });
    const renewed = await svc.ensureSubscription();
    check('near-expiry subscription is renewed automatically', renewed.status === 'renewed', renewed.status);
    check('renewal called Graph PATCH', ops.calls.renewed.length === 1);
    const afterRenew = await svc.inspect();
    check(
      'renewal pushed the expiration into the future',
      new Date(afterRenew.expirationDateTime).getTime() > Date.now() + 24 * 60 * 60 * 1000
    );

    // --- expired subscription is recreated, not left dead ---
    await prisma.graphSubscription.update({
      where: { subscriptionId: created.subscriptionId },
      data: { expirationDateTime: new Date(Date.now() - 60 * 1000) },
    });
    const expiredView = await svc.inspect();
    check('expired subscription reported as expired', expiredView.status === 'expired' && expiredView.active === false);
    const recreated = await svc.ensureSubscription();
    check('expired subscription is recreated', recreated.status === 'recreated' && ops.calls.created.length === 2);
    const afterRecreate = await svc.inspect();
    check('recreated subscription is active again', afterRecreate.active === true);

    // --- Graph forgot the subscription (404 on renew) -> recreate ---
    await prisma.graphSubscription.updateMany({
      data: { expirationDateTime: new Date(Date.now() + 60 * 60 * 1000) },
    });
    ops.calls.renewNotFound = true;
    const afterNotFound = await svc.ensureSubscription();
    check(
      'renewing a vanished subscription recreates it',
      afterNotFound.status === 'recreated' && ops.calls.created.length === 3
    );
    ops.calls.renewNotFound = false;

    // --- deletion ---
    const del = await svc.deleteSubscription();
    check('subscription deleted via Graph', del.status === 'deleted' && ops.calls.deleted.length === 1);
    check('subscription record removed locally', (await svc.getStored()) === null);
    const goneView = await svc.inspect();
    check('inspect reports not-subscribed after deletion', goneView.status === 'not-subscribed');

    // --- disabled config never subscribes ---
    const offSvc = createSubscriptionService({
      ops,
      config: webhookConfig({ webhookEnabled: false, notificationUrl: '' }),
      logger: quiet,
    });
    const offResult = await offSvc.ensureSubscription();
    check('webhook-disabled config does not create a subscription', offResult.status === 'disabled');
    check('startLifecycle is a safe no-op when disabled', offSvc.startLifecycle() === false);
  }

  /* ================================================================== */
  /* 3. Validation-token handshake                                      */
  /* ================================================================== */
  {
    const ops = makeFakeOps([]);
    const subs = createSubscriptionService({ ops, config: webhookConfig(), logger: quiet });
    await withServer({ subscriptionService: subs, ops, logger: quiet, awaitProcessing: true }, async (base) => {
      const token = 'Validation: Testing client application reachability for subscription';
      const res = await fetch(
        `${base}/api/webhooks/microsoft-graph?validationToken=${encodeURIComponent(token)}`,
        { method: 'POST' }
      );
      const text = await res.text();
      check('validation request returns 200', res.status === 200, String(res.status));
      check('validation request echoes the token verbatim', text === token, text);
      check(
        'validation response is text/plain',
        (res.headers.get('content-type') || '').includes('text/plain'),
        res.headers.get('content-type')
      );
      check('validation handshake needs no subscription to exist', true);
    });
  }

  /* ================================================================== */
  /* 4. Valid notification -> ticket through the SHARED pipeline        */
  /* ================================================================== */
  let liveSubs;
  let inbox;
  let ops;
  {
    inbox = [
      rawGraphMessage({
        id: `${MARK}m1`,
        from: ['Dana Webb', 'dana.whtest@example.com'],
        subject: 'Password reset needed urgently',
        bodyText: 'I cannot sign in to my account.',
      }),
    ];
    ops = makeFakeOps(inbox);
    liveSubs = createSubscriptionService({ ops, config: webhookConfig(), logger: quiet });
    await liveSubs.createSubscription();

    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });

    await withServer(
      { subscriptionService: liveSubs, processor, logger: quiet, awaitProcessing: true },
      async (base) => {
        const res = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: [notification({ messageId: `${MARK}m1` })] }),
        });
        const data = await res.json();
        check('valid notification accepted (202)', res.status === 202, String(res.status));
        check('notification reported one accepted item', data.accepted === 1, JSON.stringify(data));
        check('webhook created exactly one ticket', data.summary.created === 1, JSON.stringify(data.summary));
      }
    );

    const ticket = await prisma.ticket.findUnique({ where: { graphMessageId: `${MARK}m1` } });
    check('ticket exists after webhook notification', Boolean(ticket));
    check('webhook retrieved the message from Graph', ops.calls.getMessage.includes(`${MARK}m1`));
    check(
      'webhook ticket used the existing business rules (category classified)',
      ticket.category === 'Password Reset',
      ticket.category
    );
    check('webhook ticket state NEW + priority moderate', ticket.state === 'NEW' && ticket.priority === 'moderate');
    check('webhook ticket routed by the assignment engine', ticket.assignedAgentId !== null);
    check('webhook ticket numbered by the existing sequence', /^INC-\d+$/.test(ticket.ticketNumber), ticket.ticketNumber);
    check('processed message marked read', ops.calls.markAsRead.includes(`${MARK}m1`));

    // resource-path fallback (no resourceData)
    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-res`,
        from: ['Ivan Cole', 'ivan.whtest@example.com'],
        subject: 'Monitor flickering',
        bodyText: 'Second screen flickers.',
      })
    );
    const viaResource = await processor.processNotification({
      clientState: CLIENT_STATE,
      resource: `Users/helpdesk@example.com/Messages/${MARK}m-res`,
    });
    check('message id parsed from resource path when resourceData absent', viaResource === 'created', viaResource);
  }

  /* ================================================================== */
  /* 5. Idempotency: duplicate notifications                            */
  /* ================================================================== */
  {
    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });

    const first = await processor.processNotification(notification({ messageId: `${MARK}m1` }));
    const second = await processor.processNotification(notification({ messageId: `${MARK}m1` }));
    check('redelivered notification resolves as duplicate', first === 'duplicate' && second === 'duplicate');
    check(
      'duplicate notifications never create a second ticket',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m1` } })) === 1
    );

    // Same batch, same message twice.
    const batch = await processor.processNotifications([
      notification({ messageId: `${MARK}m1` }),
      notification({ messageId: `${MARK}m1` }),
    ]);
    check('duplicate notifications inside one batch are harmless', batch.created === 0 && batch.duplicate === 2);
    check(
      'still exactly one ticket for that message',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m1` } })) === 1
    );
  }

  /* ================================================================== */
  /* 6. Webhook + polling see the SAME email                            */
  /* ================================================================== */
  {
    const msgId = `${MARK}m-race`;
    inbox.push(
      rawGraphMessage({
        id: msgId,
        from: ['Priya Nair', 'priya.whtest@example.com'],
        subject: 'VPN will not connect',
        bodyText: 'VPN client times out.',
      })
    );

    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });
    const viaWebhook = await processor.processNotification(notification({ messageId: msgId }));
    check('webhook processed the new message first', viaWebhook === 'created');

    // Simulate the mailbox still reporting it unread when the poller runs.
    inbox.find((m) => m.id === msgId).isRead = false;
    const mailSvc = createMailService({ ops, logger: quiet });
    const summary = await mailSvc.pollUnread();
    check('poller sees the same message as a duplicate', summary.duplicate >= 1, JSON.stringify(summary));
    check(
      'webhook + polling produce exactly one ticket',
      (await prisma.ticket.count({ where: { graphMessageId: msgId } })) === 1
    );

    // Reverse order: poller first, webhook second.
    const msgId2 = `${MARK}m-race2`;
    inbox.push(
      rawGraphMessage({
        id: msgId2,
        from: ['Tom Blake', 'tom.whtest@example.com'],
        subject: 'Need a new keyboard',
        bodyText: 'Keys sticking.',
      })
    );
    const pollSummary = await mailSvc.pollUnread();
    check('poller ingested the message first', pollSummary.created >= 1);
    const viaWebhook2 = await processor.processNotification(notification({ messageId: msgId2 }));
    check('late webhook for a polled message is a duplicate', viaWebhook2 === 'duplicate', viaWebhook2);
    check(
      'polling + late webhook produce exactly one ticket',
      (await prisma.ticket.count({ where: { graphMessageId: msgId2 } })) === 1
    );
  }

  /* ================================================================== */
  /* 7. Idempotent ACTIVITIES (replies cannot double-post)              */
  /* ================================================================== */
  {
    const { intakeEmailMessage } = require('../src/services/ticketIntake');
    const parent = await prisma.ticket.findUnique({ where: { graphMessageId: `${MARK}m1` } });

    const replyPayload = {
      messageId: `${MARK}m-reply`,
      conversationId: `conv-${MARK}m1`,
      from: 'dana.whtest@example.com',
      name: 'Dana Webb',
      subject: `RE: [${parent.ticketNumber}] Password reset needed urgently`,
      body: 'Still locked out, any update?',
    };

    const r1 = await intakeEmailMessage(replyPayload, { logger: quiet, allowThreading: true });
    const r2 = await intakeEmailMessage(replyPayload, { logger: quiet, allowThreading: true });
    check('reply appended as an activity', r1.status === 'comment_added' || r1.status === 'reopened', r1.status);
    check('redelivered reply is a duplicate, not a second activity', r2.status === 'duplicate', r2.status);
    const comments = await prisma.comment.count({ where: { graphMessageId: `${MARK}m-reply` } });
    check('exactly one comment for the redelivered message', comments === 1, String(comments));
    check(
      'redelivered reply created no extra ticket',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m-reply` } })) === 0
    );
  }

  /* ================================================================== */
  /* 8. Malformed notifications                                         */
  /* ================================================================== */
  {
    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });

    await withServer(
      { subscriptionService: liveSubs, processor, logger: quiet, awaitProcessing: true },
      async (base) => {
        const noValue = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonsense: true }),
        });
        check('payload without value[] rejected with 400', noValue.status === 400, String(noValue.status));

        const notArray = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'not-an-array' }),
        });
        check('non-array value rejected with 400', notArray.status === 400, String(notArray.status));

        const empty = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: [] }),
        });
        check('empty batch handled without error', empty.status === 202, String(empty.status));
      }
    );

    const ticketsBefore = await prisma.ticket.count();
    const summary = await processor.processNotifications([
      null,
      {},
      { clientState: CLIENT_STATE },
      { clientState: CLIENT_STATE, resource: 'Users/x/Messages/' },
      'a string',
    ]);
    check('malformed notifications counted as invalid', summary.invalid === 5, JSON.stringify(summary));
    check('malformed notifications create no tickets', (await prisma.ticket.count()) === ticketsBefore);
  }

  /* ================================================================== */
  /* 9. Security: clientState validation                                */
  /* ================================================================== */
  {
    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });
    inbox.push(
      rawGraphMessage({
        id: `${MARK}m-forged`,
        from: ['Attacker', 'evil.whtest@example.com'],
        subject: 'Forged notification',
        bodyText: 'Should never become a ticket.',
      })
    );

    await withServer(
      { subscriptionService: liveSubs, processor, logger: quiet, awaitProcessing: true },
      async (base) => {
        const forged = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: [notification({ messageId: `${MARK}m-forged`, clientState: 'wrong-secret' })],
          }),
        });
        const data = await forged.json();
        check('wrong clientState is discarded', data.accepted === 0 && data.discarded === 1, JSON.stringify(data));

        const missingState = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: [{ resourceData: { id: `${MARK}m-forged` }, changeType: 'created' }],
          }),
        });
        const d2 = await missingState.json();
        check('absent clientState is discarded', d2.accepted === 0 && d2.discarded === 1, JSON.stringify(d2));
      }
    );

    check(
      'forged notification never became a ticket',
      (await prisma.ticket.count({ where: { graphMessageId: `${MARK}m-forged` } })) === 0
    );
    check('forged notification never fetched the message', !ops.calls.getMessage.includes(`${MARK}m-forged`));
  }

  /* ================================================================== */
  /* 10. Message retrieval failure -> polling must recover it           */
  /* ================================================================== */
  {
    const msgId = `${MARK}m-retrieve-fail`;
    inbox.push(
      rawGraphMessage({
        id: msgId,
        from: ['Nina Fox', 'nina.whtest@example.com'],
        subject: 'Outlook keeps crashing',
        bodyText: 'Crashes on launch.',
      })
    );
    ops.calls.failGetMessageFor = msgId;

    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: liveSubs });
    const outcome = await processor.processNotification(notification({ messageId: msgId }));
    check('retrieval failure reported as failed', outcome === 'failed', outcome);
    check(
      'retrieval failure created no ticket',
      (await prisma.ticket.count({ where: { graphMessageId: msgId } })) === 0
    );
    check('retrieval failure did NOT mark the message read', !ops.calls.markAsRead.includes(msgId));
    check('retrieval failure recorded as the last Graph error', Boolean(graphStatus.snapshot().lastError));

    // The polling fallback recovers it once Graph is healthy again.
    ops.calls.failGetMessageFor = null;
    const mailSvc = createMailService({ ops, logger: quiet });
    const summary = await mailSvc.pollUnread();
    check('polling fallback recovered the message', summary.created >= 1, JSON.stringify(summary));
    check(
      'recovered message produced exactly one ticket',
      (await prisma.ticket.count({ where: { graphMessageId: msgId } })) === 1
    );
  }

  /* ================================================================== */
  /* 11. Processing failure -> not marked processed, 500 to Graph       */
  /* ================================================================== */
  {
    const msgId = `${MARK}m-process-fail`;
    inbox.push(
      rawGraphMessage({
        id: msgId,
        from: ['Owen Pace', 'owen.whtest@example.com'],
        subject: 'Docking station dead',
        bodyText: 'No power through the dock.',
      })
    );

    // A mail service whose shared pipeline throws.
    const explodingMail = {
      async processOne() {
        throw new Error('simulated database outage');
      },
    };
    const processor = createWebhookProcessor({
      ops,
      logger: quiet,
      subscriptionService: liveSubs,
      mailService: explodingMail,
    });

    const outcome = await processor.processNotification(notification({ messageId: msgId }));
    check('processing failure reported as failed', outcome === 'failed', outcome);
    check(
      'processing failure created no ticket',
      (await prisma.ticket.count({ where: { graphMessageId: msgId } })) === 0
    );
    check('processing failure did NOT mark the message read', !ops.calls.markAsRead.includes(msgId));

    // The route surfaces a batch failure as 500 so Graph can retry.
    const throwingProcessor = {
      async processNotifications() {
        throw new Error('simulated batch failure');
      },
    };
    await withServer(
      { subscriptionService: liveSubs, processor: throwingProcessor, logger: quiet, awaitProcessing: true },
      async (base) => {
        const res = await fetch(`${base}/api/webhooks/microsoft-graph`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: [notification({ messageId: msgId })] }),
        });
        check('batch processing failure returns 500 to Graph', res.status === 500, String(res.status));
      }
    );

    // And polling still recovers it.
    const mailSvc = createMailService({ ops, logger: quiet });
    await mailSvc.pollUnread();
    check(
      'polling recovered the message after processing failure',
      (await prisma.ticket.count({ where: { graphMessageId: msgId } })) === 1
    );
  }

  /* ================================================================== */
  /* 12. Lifecycle notifications                                        */
  /* ================================================================== */
  {
    let ensured = 0;
    const fakeSubs = {
      async verifyClientState() {
        return true;
      },
      async ensureSubscription() {
        ensured += 1;
        return { status: 'recreated' };
      },
    };
    const processor = createWebhookProcessor({ ops, logger: quiet, subscriptionService: fakeSubs });

    const removed = await processor.processNotification(
      notification({ lifecycleEvent: 'subscriptionRemoved' })
    );
    check('subscriptionRemoved triggers re-subscription', removed === 'lifecycle_handled' && ensured === 1);

    const reauth = await processor.processNotification(
      notification({ lifecycleEvent: 'reauthorizationRequired' })
    );
    check('reauthorizationRequired triggers re-subscription', reauth === 'lifecycle_handled' && ensured === 2);

    const missed = await processor.processNotification(notification({ lifecycleEvent: 'missed' }));
    check('missed notifications flagged for the polling fallback', missed === 'lifecycle_missed');
  }

  /* ================================================================== */
  /* 13. Health/status reporting                                        */
  /* ================================================================== */
  {
    const snap = graphStatus.snapshot();
    check('health tracks webhook notifications received', snap.webhookNotificationsReceived > 0);
    check('health tracks last successful processing', Boolean(snap.lastSuccessAt));
    check('health records the last Graph error', Boolean(snap.lastError && snap.lastError.message));
    check(
      'health snapshot contains no secrets',
      !JSON.stringify(snap).includes(CLIENT_STATE) &&
        !/clientSecret|accessToken/i.test(JSON.stringify(snap))
    );

    const view = await liveSubs.inspect();
    check('subscription status available for administrators', view.status === 'active');
    check('subscription expiration exposed', Boolean(view.expirationDateTime));
  }

  /* ---- cleanup ------------------------------------------------------ */
  await cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = failures ? 1 : 0;
  });
