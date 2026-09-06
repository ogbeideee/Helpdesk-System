/* Microsoft 365 / Microsoft Graph integration — configuration model, admin
   view, and resilience. NO real Microsoft tenant, credentials, or network
   calls: MSAL, the Graph SDK transport and the IMAP client are all mocked.
   The ticket intake pipeline runs against the real (isolated) database.

   A. Configuration model — env-driven states + static credential validation
   B. Token handling — in-memory cache, in-flight sharing, forced refresh
   C. Pagination — @odata.nextLink following, budget, page cap
   D. Throttling + transient failures — Retry-After, backoff, 401 refresh
   E. Subscription lifecycle across a restart (persisted record reuse)
   F. Ingestion recovery after a Graph outage
   G. Admin API /api/microsoft-365 — states, checklist, secrets, verify
   H. Channel independence — Graph failure ≠ IMAP failure and vice versa
   I. The real server boots normally with Graph completely unconfigured
   J. Explicit disable + unconfigured guard (module reload scenarios)

   Usage: npm run test:m365  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4226';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';
process.env.REPORT_SCHEDULER_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('m365');

// Base credentials for the suite. Set BEFORE any graph module is required, so
// the module-level config snapshot is a fully configured, enabled integration.
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_SECRET = 'm365-suite-client-secret';
const MAILBOX = 'helpdesk@m365suite.test';
process.env.GRAPH_TENANT_ID = TENANT_ID;
process.env.GRAPH_CLIENT_ID = CLIENT_ID;
process.env.GRAPH_CLIENT_SECRET = CLIENT_SECRET;
process.env.GRAPH_SHARED_MAILBOX = MAILBOX;

const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const QUIET = { log() {}, warn() {}, error() {} };

const GRAPH_ENV_KEYS = [
  'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SHARED_MAILBOX',
  'GRAPH_BROADCAST_DL', 'GRAPH_ENABLED', 'WEBHOOK_PUBLIC_URL', 'GRAPH_WEBHOOK_CLIENT_STATE',
  'MAIL_POLL_INTERVAL_MS', 'GRAPH_INGEST_MAX_AGE_HOURS', 'GRAPH_INGEST_SINCE',
  'GRAPH_POLL_BATCH_SIZE', 'GRAPH_DRY_RUN', 'GRAPH_SUBSCRIPTION_RENEW_INTERVAL_MS',
];

/** Run fn with exactly the given GRAPH_* environment (everything else cleared). */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of GRAPH_ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of GRAPH_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
    return await fn();
  } finally {
    for (const k of GRAPH_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const BASE_CREDS = {
  GRAPH_TENANT_ID: TENANT_ID,
  GRAPH_CLIENT_ID: CLIENT_ID,
  GRAPH_CLIENT_SECRET: CLIENT_SECRET,
  GRAPH_SHARED_MAILBOX: MAILBOX,
};

function rawGraphMessage({ id, from, subject, bodyText, conversationId, html }) {
  return {
    id,
    conversationId: conversationId || `conv-${id}`,
    internetMessageId: `<${id}@m365suite.test>`,
    subject,
    from: { emailAddress: { address: from, name: 'M365 Requester' } },
    body: html
      ? { contentType: 'html', content: html }
      : { contentType: 'text', content: bodyText || '' },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    hasAttachments: false,
  };
}

(async () => {
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: QUIET });

  /* ==================================================================== */
  /* A. Configuration model                                               */
  /* ==================================================================== */
  console.log('\n--- A. configuration model ---');
  const {
    readGraphEnv, validateGraphConfig, describeGraphState, REQUIRED_CONFIGURATION,
  } = require('../src/graph/config');

  await withEnv({}, async () => {
    const cfg = readGraphEnv();
    eq('A1 nothing set -> integration disabled', cfg.enabled, false);
    eq('A2 nothing set -> credentials incomplete', cfg.credentialsComplete, false);
    eq('A3 nothing set -> state not_configured', describeGraphState(cfg), 'not_configured');
    const v = validateGraphConfig(cfg);
    eq('A4 validation lists all four missing values', v.missing.length, 4);
    eq('A5 validation is invalid while incomplete', v.valid, false);
    eq('A6 the checklist has exactly four required values', REQUIRED_CONFIGURATION.length, 4);
    check('A7 only the client secret is flagged secret',
      REQUIRED_CONFIGURATION.filter((i) => i.secret).length === 1
      && REQUIRED_CONFIGURATION.find((i) => i.secret).variable === 'GRAPH_CLIENT_SECRET');
  });

  await withEnv({ ...BASE_CREDS }, async () => {
    const cfg = readGraphEnv();
    eq('A8 complete credentials enable the integration', cfg.enabled, true);
    eq('A9 complete credentials -> state enabled', describeGraphState(cfg), 'enabled');
    eq('A10 valid configuration validates', validateGraphConfig(cfg).valid, true);
    eq('A11 no explicit toggle by default', cfg.explicitlyDisabled, false);
  });

  await withEnv({ ...BASE_CREDS, GRAPH_ENABLED: 'false' }, async () => {
    const cfg = readGraphEnv();
    eq('A12 GRAPH_ENABLED=false disables with credentials present', cfg.enabled, false);
    eq('A13 the disable is explicit', cfg.explicitlyDisabled, true);
    eq('A14 credentials still count as complete', cfg.credentialsComplete, true);
    eq('A15 state is "configured but disabled"', describeGraphState(cfg), 'disabled');
  });

  await withEnv({ ...BASE_CREDS, GRAPH_ENABLED: 'true' }, async () => {
    const cfg = readGraphEnv();
    eq('A16 GRAPH_ENABLED=true with full credentials stays enabled', cfg.enabled, true);
  });

  await withEnv({
    GRAPH_TENANT_ID: TENANT_ID, GRAPH_CLIENT_ID: CLIENT_ID, GRAPH_SHARED_MAILBOX: MAILBOX,
    GRAPH_ENABLED: 'true',
  }, async () => {
    const cfg = readGraphEnv();
    eq('A17 enabled toggle cannot compensate for a missing secret', cfg.enabled, false);
    eq('A18 still reported as not configured', describeGraphState(cfg), 'not_configured');
  });

  await withEnv({ ...BASE_CREDS, GRAPH_CLIENT_ID: 'not-a-guid' }, async () => {
    const v = validateGraphConfig(readGraphEnv());
    eq('A19 a non-GUID client id is invalid', v.invalid[0] && v.invalid[0].variable, 'GRAPH_CLIENT_ID');
    eq('A20 the configuration does not validate', v.valid, false);
    check('A21 the client id problem is explained', /GUID/i.test(v.invalid[0].reason));
  });

  await withEnv({ ...BASE_CREDS, GRAPH_TENANT_ID: 'bad tenant!' }, async () => {
    const v = validateGraphConfig(readGraphEnv());
    eq('A22 an unusable tenant value is invalid', v.invalid[0] && v.invalid[0].variable, 'GRAPH_TENANT_ID');
  });
  await withEnv({ ...BASE_CREDS, GRAPH_TENANT_ID: 'mrsholdings.com' }, async () => {
    eq('A23 a verified-domain tenant is valid', validateGraphConfig(readGraphEnv()).valid, true);
  });

  await withEnv({ ...BASE_CREDS, GRAPH_SHARED_MAILBOX: 'nope' }, async () => {
    const v = validateGraphConfig(readGraphEnv());
    eq('A24 a non-address mailbox is invalid', v.invalid[0] && v.invalid[0].variable, 'GRAPH_SHARED_MAILBOX');
  });

  await withEnv({ ...BASE_CREDS, GRAPH_CLIENT_SECRET: 'two\r\nlines' }, async () => {
    const v = validateGraphConfig(readGraphEnv());
    eq('A25 a multiline client secret is flagged (copy/paste guard)',
      v.invalid[0] && v.invalid[0].variable, 'GRAPH_CLIENT_SECRET');
  });

  await withEnv({ ...BASE_CREDS, WEBHOOK_PUBLIC_URL: 'https://suite.example', GRAPH_ENABLED: 'true' }, async () => {
    const v = validateGraphConfig(readGraphEnv());
    check('A26 a missing client state with webhook mode warns',
      v.warnings.some((w) => w.includes('GRAPH_WEBHOOK_CLIENT_STATE')));
    eq('A27 warnings do not invalidate the configuration', v.valid, true);
  });

  await withEnv({ ...BASE_CREDS, MAIL_POLL_INTERVAL_MS: '45000' }, async () => {
    eq('A28 readGraphEnv re-reads the environment per call', readGraphEnv().pollIntervalMs, 45000);
  });

  /* ==================================================================== */
  /* B. Token handling (mocked MSAL)                                      */
  /* ==================================================================== */
  console.log('\n--- B. token handling ---');
  const msalToken = require('../src/graph/msalToken');
  let acquisitions = 0;
  // _resetTokenCache() also drops the injected factory, so ALWAYS re-inject
  // immediately after a reset — a real ConfidentialClientApplication would
  // otherwise contact the real Entra endpoint, which tests must never do.
  function injectCountingMsal({ expiresInMs = 3600 * 1000 } = {}) {
    acquisitions = 0;
    msalToken._resetTokenCache();
    msalToken._injectAuthClient(() => ({
      async acquireTokenByClientCredential() {
        acquisitions += 1;
        return { accessToken: `token-${acquisitions}`, expiresOn: new Date(Date.now() + expiresInMs) };
      },
    }));
  }

  injectCountingMsal();
  const first = await msalToken.getAccessToken();
  eq('B1 the first call acquires a token', first, 'token-1');
  eq('B2 a cached call does not re-acquire', await msalToken.getAccessToken(), 'token-1');
  eq('B3 exactly one acquisition so far', acquisitions, 1);
  eq('B4 forceRefresh acquires anew', await msalToken.getAccessToken({ forceRefresh: true }), 'token-2');

  injectCountingMsal();
  const [c1, c2, c3] = await Promise.all([
    msalToken.getAccessToken(), msalToken.getAccessToken(), msalToken.getAccessToken(),
  ]);
  eq('B5 concurrent callers share one acquisition', acquisitions, 1);
  check('B6 they all receive the same token', c1 === c2 && c2 === c3);

  // A token that is already inside the expiry margin must never be reused.
  injectCountingMsal({ expiresInMs: 4 * 60 * 1000 });
  await msalToken.getAccessToken();
  await msalToken.getAccessToken();
  eq('B7 a token inside the expiry margin is refreshed', acquisitions, 2);

  /* ==================================================================== */
  /* C. Pagination                                                        */
  /* ==================================================================== */
  console.log('\n--- C. pagination ---');
  const graphClient = require('../src/graph/graphClient');

  function makePageSdk(pages) {
    const state = { pageIdx: 0, requests: [] };
    const client = {
      api(requestPath) {
        const b = {
          _filter: null, _top: null,
          filter(v) { b._filter = v; return b; },
          orderby() { return b; },
          top(v) { b._top = v; return b; },
          select() { return b; },
          async get() {
            state.requests.push({ path: requestPath, top: b._top, filter: b._filter });
            const i = state.pageIdx;
            state.pageIdx += 1;
            const page = pages[Math.min(i, pages.length - 1)];
            const body = { value: page.value };
            if (page.hasNext) body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/$next?page=${i + 1}`;
            return body;
          },
        };
        return b;
      },
    };
    return { client, state };
  }

  function page(value, hasNext) {
    return { value: value.map((n) => ({ id: `m-${n}`, subject: `msg ${n}` })), hasNext };
  }

  graphClient._injectClientFactory(() => {
    throw new Error('client factory should be set per scenario');
  });

  // C-scenario helper: inject an SDK, run, reset.
  async function withSdk(sdk, fn) {
    graphClient._injectClientFactory(() => sdk.client);
    try {
      return await fn();
    } finally {
      graphClient._resetForTests();
    }
  }

  {
    const sdk = makePageSdk([page([1, 2], true), page([3, 4], false)]);
    await withSdk(sdk, async () => {
      const out = await graphClient.graphOps.listUnreadMessages(25);
      eq('C1 pages are followed via the next link', out.length, 4);
      eq('C2 the first request is the mailbox query', sdk.state.requests[0].path.includes("/mailFolders('inbox')"), true);
      eq('C3 the follow-up request is the verbatim next link', sdk.state.requests[1].path.startsWith('https://graph.microsoft.com/v1.0/$next'), true);
      check('C4 the unread filter rides only on the first request',
        sdk.state.requests[0].filter.includes('isRead eq false') && sdk.state.requests[1].filter === null);
      check('C5 order is preserved across pages', out.map((m) => m.id).join(','), 'm-1,m-2,m-3,m-4');
    });
  }

  {
    const sdk = makePageSdk([page([1, 2], true), page([3, 4], true), page([5, 6], true), page([7, 8], true), page([9, 10], true)]);
    await withSdk(sdk, async () => {
      const out = await graphClient.graphOps.listUnreadMessages(5);
      eq('C6 the caller budget is honored across pages', out.length, 5);
      eq('C7 fetching stops once the budget is met', sdk.state.requests.length, 3);
    });
  }

  {
    const pages = [];
    for (let i = 0; i < 30; i += 1) pages.push(page(Array.from({ length: 10 }, (_, j) => i * 10 + j), true));
    const sdk = makePageSdk(pages);
    await withSdk(sdk, async () => {
      const out = await graphClient.graphOps.listUnreadMessages(1000);
      eq('C8 the page cap bounds a huge backlog', sdk.state.requests.length, 10);
      eq('C9 the capped result stays within a sane size', out.length, 100);
    });
  }

  {
    const sdk = makePageSdk([page([1, 2], false)]);
    await withSdk(sdk, async () => {
      const out = await graphClient.graphOps.listUnreadMessages(25, { since: new Date('2026-01-01T00:00:00Z') });
      eq('C10 a single page needs no follow-up', sdk.state.requests.length, 1);
      check('C11 the since cutoff rides on the mailbox query', sdk.state.requests[0].filter.includes('receivedDateTime ge'));
      eq('C12 the page is returned as-is', out.length, 2);
    });
  }

  /* ==================================================================== */
  /* D. Transient failures + throttling                                   */
  /* ==================================================================== */
  console.log('\n--- D. throttling and transient failures ---');
  // Each block re-injects: _resetForTests() restores the real sleep, and no
  // test in this suite may actually wait.
  const sleeps = [];
  function injectFakeSleep() {
    graphClient._injectSleep(async (ms) => { sleeps.push(ms); });
  }

  function makeFlakySdk(failures, payload) {
    const attempts = { count: 0 };
    const client = {
      api() {
        return {
          select() { return this; },
          async get() {
            attempts.count += 1;
            if (attempts.count <= failures.length) throw failures[attempts.count - 1];
            return payload;
          },
        };
      },
    };
    return { client, attempts };
  }

  {
    sleeps.length = 0;
    injectFakeSleep();
    const throttled = Object.assign(new Error('throttled'), { statusCode: 429, headers: { 'retry-after': '0.01' } });
    const sdk = makeFlakySdk([throttled], { id: 'ok-1' });
    graphClient._injectClientFactory(() => sdk.client);
    const out = await graphClient.graphOps.getMessage('ok-1').catch(() => null);
    eq('D1 a throttled request is retried and succeeds', out && out.id, 'ok-1');
    eq('D2 the Retry-After header is honored', JSON.stringify(sleeps), JSON.stringify([10]));
    graphClient._resetForTests();
  }

  {
    sleeps.length = 0;
    injectFakeSleep();
    const sdk = makeFlakySdk(
      [Object.assign(new Error('unavailable'), { statusCode: 503 }), Object.assign(new Error('gateway'), { statusCode: 504 })],
      { id: 'ok-2' }
    );
    graphClient._injectClientFactory(() => sdk.client);
    const out = await graphClient.graphOps.getMessage('ok-2').catch(() => null);
    eq('D3 503/504 are retried', out && out.id, 'ok-2');
    eq('D4 without Retry-After an exponential backoff is used', JSON.stringify(sleeps), JSON.stringify([2000, 4000]));
    graphClient._resetForTests();
  }

  {
    sleeps.length = 0;
    injectFakeSleep();
    const always = Object.assign(new Error('still throttled'), { statusCode: 429, headers: { 'retry-after': '0.01' } });
    const sdk = makeFlakySdk([always, always, always, always, always], { id: 'never' });
    graphClient._injectClientFactory(() => sdk.client);
    let threw = false;
    try { await graphClient.graphOps.getMessage('never'); } catch { threw = true; }
    eq('D5 persistent throttling eventually fails loudly', threw, true);
    eq('D6 retries are bounded', sdk.attempts.count, 4);
    eq('D7 exactly three backoffs happened', sleeps.length, 3);
    graphClient._resetForTests();
  }

  {
    sleeps.length = 0;
    injectFakeSleep();
    const bad = Object.assign(new Error('bad request'), { statusCode: 400 });
    const sdk = makeFlakySdk([bad], { id: 'ok-3' });
    graphClient._injectClientFactory(() => sdk.client);
    let threw = false;
    try { await graphClient.graphOps.getMessage('ok-3'); } catch { threw = true; }
    eq('D8 a non-transient 4xx is never retried', threw, true);
    eq('D9 no backoff ran for it', sleeps.length, 0);
    graphClient._resetForTests();
  }

  {
    // 401 -> one forced token refresh, then the request replays.
    msalToken._resetTokenCache();
    acquisitions = 0;
    msalToken._injectAuthClient(() => ({
      async acquireTokenByClientCredential() {
        acquisitions += 1;
        return { accessToken: `token-${acquisitions}`, expiresOn: new Date(Date.now() + 3600 * 1000) };
      },
    }));
    const unauthorized = Object.assign(new Error('expired token'), { statusCode: 401 });
    const sdk = makeFlakySdk([unauthorized], { id: 'ok-4' });
    graphClient._injectClientFactory(() => sdk.client);
    const out = await graphClient.graphOps.getMessage('ok-4').catch(() => null);
    eq('D10 a 401 triggers one forced token refresh', acquisitions, 1);
    eq('D11 the request is replayed after the refresh', out && out.id, 'ok-4');
    graphClient._resetForTests();
  }

  /* ==================================================================== */
  /* E. Subscription lifecycle across a restart                           */
  /* ==================================================================== */
  console.log('\n--- E. subscription restart/recovery ---');
  const { createSubscriptionService } = require('../src/graph/subscriptionService');

  await prisma.graphSubscription.deleteMany({});
  const webhookConfig = {
    webhookEnabled: true,
    notificationUrl: 'https://suite.example/api/webhooks/microsoft-graph',
    sharedMailbox: MAILBOX,
    webhookClientState: 'suite-client-state',
    subscriptionRenewIntervalMs: 60000,
  };

  function makeSubOps() {
    const calls = { created: [], renewed: [], deleted: [] };
    let n = 0;
    return {
      calls,
      async createSubscription({ notificationUrl }) {
        n += 1;
        calls.created.push(notificationUrl);
        return {
          id: `sub-${n}`,
          resource: `/users/${MAILBOX}/mailFolders('inbox')/messages`,
          notificationUrl,
          expirationDateTime: new Date(Date.now() + 4230 * 60 * 1000).toISOString(),
        };
      },
      async renewSubscription(id, expirationDateTime) {
        calls.renewed.push(id);
        return { expirationDateTime };
      },
      async deleteSubscription(id) {
        calls.deleted.push(id);
      },
    };
  }

  {
    const ops1 = makeSubOps();
    const svc1 = createSubscriptionService({ logger: QUIET, ops: ops1, config: webhookConfig });
    const created = await svc1.ensureSubscription();
    eq('E1 a fresh start creates the subscription', created.status, 'created');
    eq('E2 the subscription is persisted locally', (await svc1.getStored()).subscriptionId, 'sub-1');

    // "Restart": a brand-new service instance over the same database record.
    const ops2 = makeSubOps();
    const svc2 = createSubscriptionService({ logger: QUIET, ops: ops2, config: webhookConfig });
    const afterRestart = await svc2.ensureSubscription();
    eq('E3 a restart reuses the persisted subscription', afterRestart.status, 'current');
    eq('E4 no duplicate subscription was created at Microsoft', ops2.calls.created.length, 0);

    await prisma.graphSubscription.updateMany({
      data: { expirationDateTime: new Date(Date.now() - 1000) },
    });
    const ops3 = makeSubOps();
    const svc3 = createSubscriptionService({ logger: QUIET, ops: ops3, config: webhookConfig });
    const recreated = await svc3.ensureSubscription();
    eq('E5 an expired subscription is recreated after downtime', recreated.status, 'recreated');

    await prisma.graphSubscription.updateMany({
      data: { expirationDateTime: new Date(Date.now() + 6 * 3600 * 1000) },
    });
    const ops4 = makeSubOps();
    const svc4 = createSubscriptionService({ logger: QUIET, ops: ops4, config: webhookConfig });
    const renewed = await svc4.ensureSubscription();
    eq('E6 a near-expiry subscription is renewed', renewed.status, 'renewed');
    eq('E7 the renewal went to the existing subscription id', ops4.calls.renewed[0], 'sub-1');

    const view = await svc4.inspect();
    eq('E8 inspect reports the live subscription as active', view.status, 'active');
    check('E9 inspect never exposes the clientState', !('clientState' in view));
    await prisma.graphSubscription.deleteMany({});
  }

  /* ==================================================================== */
  /* F. Ingestion recovery after a Graph outage                           */
  /* ==================================================================== */
  console.log('\n--- F. recovery after a Graph outage ---');
  const { createMailService } = require('../src/graph/mailService');

  {
    const stamp = Date.now();
    const sender = `outage-${stamp}@m365suite.test`;
    const outageOps = {
      async listUnreadMessages() {
        throw Object.assign(new Error('Graph outage (simulated 503)'), { statusCode: 503 });
      },
      async getMessage() { throw new Error('Graph outage'); },
      async listAttachments() { return []; },
      async markAsRead() { throw new Error('should not be reached'); },
    };
    const svc = createMailService({ logger: QUIET, ops: outageOps });

    let pollError = null;
    try { await svc.pollUnread(); } catch (err) { pollError = err; }
    check('F1 a dead Graph transport surfaces to the poller (which catches it)', pollError && /Graph outage/.test(pollError.message));
    eq('F2 nothing was ingested during the outage',
      await prisma.ticket.count({ where: { requesterEmail: sender } }), 0);

    // Recovery: the transport comes back with the same unread message.
    const goodOps = {
      async listUnreadMessages(top) {
        return [rawGraphMessage({
          id: `outage-${stamp}`, from: sender, subject: `Outage recovery ${stamp}`,
          bodyText: 'The mailbox was unreachable, now it is back.',
        })].slice(0, top);
      },
      async getMessage(id) { return rawGraphMessage({ id, from: sender, subject: `Outage recovery ${stamp}`, bodyText: 'back' }); },
      async listAttachments() { return []; },
      async markAsRead(id) { goodOps.read = (goodOps.read || []).concat(id); },
    };
    const recovered = createMailService({ logger: QUIET, ops: goodOps });
    const summary = await recovered.pollUnread();
    eq('F3 the poller retries after recovery', summary.created, 1);
    eq('F4 the recovered message is marked read', (goodOps.read || [])[0], `outage-${stamp}`);
    eq('F5 the ticket exists exactly once (idempotent retry by construction)',
      await prisma.ticket.count({ where: { requesterEmail: sender } }), 1);
  }

  /* ==================================================================== */
  /* G. Admin API /api/microsoft-365                                      */
  /* ==================================================================== */
  console.log('\n--- G. admin API ---');
  const express = require('express');
  const { buildRouter } = require('../routes/microsoft365');
  const { requireAdmin } = require('../src/authMiddleware');
  const graphStatus = require('../src/graph/graphStatus');

  const verifyOps = {
    async getMailboxProfile() {
      return { id: 'mb-1', displayName: 'IT Helpdesk', mail: 'ithelpdesk@m365suite.test' };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/microsoft-365', requireAdmin, buildRouter({ ops: verifyOps, logger: QUIET }));
  await new Promise((resolve) => { app.listen(process.env.PORT, resolve); });
  const BASE = `http://localhost:${process.env.PORT}`;

  async function req(pathname, { method = 'GET', token, body } = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, data, text };
  }

  const PASSWORD = 'M365Suite!123';
  const DOMAIN = 'm365admin.test';
  const mkAgent = async (name, email, role) => {
    const a = await prisma.agent.create({
      data: {
        name, email, role: 'agent', isActive: true, isAvailable: true, skillLevel: 2,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
      },
    });
    if (role === 'admin') await prisma.agent.update({ where: { id: a.id }, data: { role: 'admin' } });
    return a;
  };
  await mkAgent('M365 Admin', `admin@${DOMAIN}`, 'admin');
  await mkAgent('Plain Agent', `agent@${DOMAIN}`, 'agent');
  const adminLogin = await req('/api/auth/login', { method: 'POST', body: { email: `admin@${DOMAIN}`, password: PASSWORD } });
  const agentLogin = await req('/api/auth/login', { method: 'POST', body: { email: `agent@${DOMAIN}`, password: PASSWORD } });
  const admin = adminLogin.data.token;
  const agent = agentLogin.data.token;
  check('G0 the admin token was issued', Boolean(admin));

  eq('G1 the endpoint requires authentication', (await req('/api/microsoft-365')).status, 401);
  eq('G2 a non-administrator is refused', (await req('/api/microsoft-365', { token: agent })).status, 403);

  await withEnv({}, async () => {
    const view = await req('/api/microsoft-365', { token: admin });
    eq('G3 unconfigured environment reports not_configured', view.data.state, 'not_configured');
    eq('G4 configured is false', view.data.configured, false);
    eq('G5 every required value is listed as missing',
      view.data.requiredConfiguration.filter((i) => !i.present).length, 4);
    eq('G6 the verify action refuses an unconfigured system', (await req('/api/microsoft-365/verify', { method: 'POST', token: admin })).status, 400);
    eq('G7 the refusal lists what is missing', (await req('/api/microsoft-365/verify', { method: 'POST', token: admin })).data.missing.length, 4);
    eq('G8 the subscription is reported disabled with the integration', view.data.runtime.subscription.status, 'disabled');
  });

  await withEnv({ ...BASE_CREDS, GRAPH_ENABLED: 'false' }, async () => {
    const view = await req('/api/microsoft-365', { token: admin });
    eq('G9 GRAPH_ENABLED=false reports the disabled state', view.data.state, 'disabled');
    eq('G10 explicitlyDisabled is surfaced', view.data.explicitlyDisabled, true);
    eq('G11 the mailbox is still shown for comparison', view.data.configuration.mailbox, MAILBOX);
  });

  await withEnv({ ...BASE_CREDS }, async () => {
    const view = await req('/api/microsoft-365', { token: admin });
    eq('G12 configured+on reports enabled', view.data.state, 'enabled');
    eq('G13 the tenant id is visible for portal comparison', view.data.configuration.tenantId, TENANT_ID);
    eq('G14 the client id is visible', view.data.configuration.clientId, CLIENT_ID);
    check('G15 the poll interval is reported', view.data.configuration.pollIntervalSeconds > 0);

    const verify = await req('/api/microsoft-365/verify', { method: 'POST', token: admin });
    eq('G16 credential verification succeeds against the (mocked) tenant', verify.data.ok, true);
    eq('G17 the verified mailbox is reported', verify.data.mailbox.mail, 'ithelpdesk@m365suite.test');
    const after = await req('/api/microsoft-365', { token: admin });
    eq('G18 the last verification is surfaced on the status view', after.data.connection.ok, true);
    check('G19 no token appears in the connection view', !JSON.stringify(after.data.connection).toLowerCase().includes('token'));
  });

  await withEnv({
    ...BASE_CREDS,
    GRAPH_CLIENT_SECRET: 'SUPER-SECRET-VALUE-123',
    GRAPH_WEBHOOK_CLIENT_STATE: 'CLIENT-STATE-XYZ',
    WEBHOOK_PUBLIC_URL: 'https://suite.example',
  }, async () => {
    const view = await req('/api/microsoft-365', { token: admin });
    check('G20 the client secret never crosses the API', !view.text.includes('SUPER-SECRET-VALUE-123'));
    check('G21 the webhook clientState never crosses the API', !view.text.includes('CLIENT-STATE-XYZ'));
    eq('G22 the secret is only reported as set (hidden)',
      view.data.requiredConfiguration.find((i) => i.variable === 'GRAPH_CLIENT_SECRET').present, true);
    eq('G23 the clientState presence is a boolean', view.data.configuration.webhook.clientStateSet, true);
    eq('G24 webhook mode is reported enabled with the https URL',
      view.data.configuration.webhook.notificationUrl, 'https://suite.example/api/webhooks/microsoft-graph');
  });

  {
    // Verification failure: recorded as an integration error, reported honestly.
    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use('/api/microsoft-365', requireAdmin, buildRouter({
      ops: { async getMailboxProfile() { throw new Error('AADSTS simulated denial'); } },
      logger: QUIET,
    }));
    await new Promise((resolve) => { const s = failingApp.listen(0, resolve); failingApp.port = s.address().port; });
    const url = `http://localhost:${failingApp.port}`;
    await withEnv({ ...BASE_CREDS }, async () => {
      const res = await fetch(`${url}/api/microsoft-365/verify`, {
        method: 'POST', headers: { Authorization: `Bearer ${admin}` },
      });
      const data = await res.json();
      eq('G25 a failed verification reports ok=false', data.ok, false);
      check('G26 the failure message is passed through', /AADSTS/.test(data.error));
      eq('G27 the failure is recorded as an integration error', graphStatus.snapshot().lastError.source, 'm365-verify');
    });
  }

  await withEnv({ ...BASE_CREDS, GRAPH_CLIENT_ID: 'not-a-guid' }, async () => {
    const view = await req('/api/microsoft-365', { token: admin });
    eq('G28 a validation problem is surfaced on the status view',
      view.data.validation.invalid[0] && view.data.validation.invalid[0].variable, 'GRAPH_CLIENT_ID');
  });

  /* ==================================================================== */
  /* H. Channel independence                                              */
  /* ==================================================================== */
  console.log('\n--- H. channel independence ---');
  const { createImapMailService } = require('../src/imap/mailService');

  const imapConfig = {
    host: 'imap.mock', port: 993, secure: true, user: 'helpdesk@imap.mock',
    password: 'unused', mailbox: 'INBOX', pollBatchSize: 10, tlsRejectUnauthorized: false,
  };

  function rfc822({ messageId, from, subject, body }) {
    return Buffer.from(
      `From: ${from}\r\nTo: helpdesk@imap.mock\r\nSubject: ${subject}\r\n` +
      `Message-ID: <${messageId}>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
    );
  }

  function makeImapClient({ uids = [], sourceByUid = {}, connectError = null } = {}) {
    return {
      seen: [],
      async connect() { if (connectError) throw connectError; },
      async getMailboxLock() { return { release() {} }; },
      async search() { return uids; },
      async fetchOne(uid) {
        const source = sourceByUid[String(uid)];
        return source ? { source, internalDate: new Date() } : null;
      },
      async messageFlagsAdd(uid) { this.seen.push(String(uid)); return true; },
      async logout() { return true; },
      close() {},
    };
  }

  {
    // Graph is down. IMAP must not care.
    const graphOutage = createMailService({
      logger: QUIET,
      ops: { async listUnreadMessages() { throw new Error('Graph is down'); } },
    });
    let graphError = null;
    try { await graphOutage.pollUnread(); } catch (err) { graphError = err; }
    check('H1 the Graph cycle failed as designed', Boolean(graphError));

    const stamp = Date.now();
    const imap = createImapMailService({
      logger: QUIET,
      config: imapConfig,
      clientFactory: () => makeImapClient({
        uids: [501],
        sourceByUid: { 501: rfc822({
          messageId: `imap-while-graph-down-${stamp}@m365suite.test`,
          from: `imap-h1-${stamp}@m365suite.test`,
          subject: `IMAP while Graph is down ${stamp}`,
          body: 'IMAP keeps working when Graph is unavailable.',
        }) },
      }),
    });
    const summary = await imap.pollUnread();
    eq('H2 IMAP still delivers mail while Graph is unavailable', summary.created, 1);
  }

  {
    // IMAP is down. The Graph webhook path must not care.
    const imapDown = createImapMailService({
      logger: QUIET,
      config: imapConfig,
      clientFactory: () => makeImapClient({ connectError: new Error('IMAP connection refused') }),
    });
    let imapError = null;
    try { await imapDown.pollUnread(); } catch (err) { imapError = err; }
    check('H3 the IMAP cycle failed as designed', Boolean(imapError));

    const stamp = Date.now();
    const sender = `webhook-${stamp}@m365suite.test`;
    const ops = {
      async getMessage(id) {
        return rawGraphMessage({
          id, from: sender, subject: `Webhook while IMAP is down ${stamp}`,
          bodyText: 'The webhook path keeps working when IMAP is unavailable.',
        });
      },
      async listAttachments() { return []; },
      async markAsRead() {},
    };
    const { createWebhookProcessor } = require('../src/graph/webhookProcessor');
    const processor = createWebhookProcessor({ logger: QUIET, ops });
    const outcome = await processor.processNotification({ resourceData: { id: `wh-${stamp}` } });
    eq('H4 the Graph webhook still delivers mail while IMAP is down', outcome, 'created');
  }

  {
    // Cross-source duplicate delivery: the same RFC identity through both
    // channels collapses to one ticket.
    const stamp = Date.now();
    const sender = `dup-${stamp}@m365suite.test`;
    const internetMessageId = `<cross-source-${stamp}@m365suite.test>`;
    const subject = `Cross-source duplicate ${stamp}`;
    const message = {
      ...rawGraphMessage({
        id: `graph-${stamp}`, from: sender, subject,
        bodyText: 'delivered twice', conversationId: `conv-${stamp}`,
      }),
      internetMessageId,
    };

    const graphOps = {
      async getMessage(id) { return { ...message, id }; },
      async listAttachments() { return []; },
      async markAsRead() {},
    };
    const graph = createMailService({ logger: QUIET, ops: graphOps });
    const first = await graph.processOne(message);
    eq('H5 the Graph delivery creates the ticket', first, 'created');

    const imap = createImapMailService({
      logger: QUIET,
      config: imapConfig,
      clientFactory: () => makeImapClient({
        uids: [601],
        sourceByUid: { 601: rfc822({ messageId: internetMessageId, from: sender, subject, body: 'delivered twice' }) },
      }),
    });
    const summary = await imap.pollUnread();
    eq('H6 the IMAP delivery of the same email is a duplicate', summary.duplicate, 1);
    eq('H7 no second ticket exists', await prisma.ticket.count({ where: { requesterEmail: sender } }), 1);
  }

  /* ==================================================================== */
  /* I. The real server boots with Graph completely unconfigured          */
  /* ==================================================================== */
  console.log('\n--- I. boot without Graph ---');
  {
    // Empty strings, not deletions: a developer's server/.env must never be
    // able to leak credentials into the spawned child (dotenv never overrides
    // a variable that is already defined).
    const childEnv = { ...process.env };
    for (const k of GRAPH_ENV_KEYS) childEnv[k] = '';
    for (const k of ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD', 'IMAP_PORT']) childEnv[k] = '';
    childEnv.PORT = '4228';
    childEnv.REBALANCE_INTERVAL_MS = '0';
    childEnv.HANDOVER_SWEEP_INTERVAL_MS = '0';
    childEnv.SLA_SWEEP_INTERVAL_MS = '0';
    childEnv.REPORT_SCHEDULER_INTERVAL_MS = '0';
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: childEnv,
    });
    try {
      const bootBase = 'http://localhost:4228';
      let ready = false;
      for (let i = 0; i < 120; i += 1) {
        if (server.exitCode !== null) break;
        try { if ((await fetch(`${bootBase}/api/health`)).ok) { ready = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      eq('I1 the server boots normally with Graph unconfigured', ready, true);
      if (ready) {
        const health = await (await fetch(`${bootBase}/api/health`)).json();
        eq('I2 health reports the Graph integration as disabled', health.integration.graphEnabled, false);
        eq('I3 IMAP is disabled too and nothing crashed', health.integration.imap.enabled, false);
        eq('I4 the webhook is off', health.integration.webhookEnabled, false);
      }
    } finally {
      server.kill();
    }
  }

  /* ==================================================================== */
  /* J. Explicit disable + unconfigured guard (module reload scenarios)   */
  /* ==================================================================== */
  console.log('\n--- J. disable switch and unconfigured guard ---');
  const CONFIG_PATH = require.resolve('../src/graph/config');
  const MSAL_PATH = require.resolve('../src/graph/msalToken');
  const POLLER_PATH = require.resolve('../src/graph/poller');

  function reload(paths) {
    for (const p of paths) delete require.cache[p];
  }

  await withEnv({ ...BASE_CREDS, GRAPH_ENABLED: 'false' }, async () => {
    reload([CONFIG_PATH, POLLER_PATH]);
    const poller = require(POLLER_PATH);
    poller.startPolling();
    const { snapshot } = require('../src/graph/graphStatus');
    eq('J1 startPolling is a no-op while explicitly disabled', snapshot().pollingRunning, false);
  });

  await withEnv({}, async () => {
    reload([CONFIG_PATH, POLLER_PATH]);
    const poller = require(POLLER_PATH);
    poller.startPolling();
    const { snapshot } = require('../src/graph/graphStatus');
    eq('J2 startPolling is a no-op when unconfigured', snapshot().pollingRunning, false);

    reload([CONFIG_PATH, MSAL_PATH]);
    const unconfigured = require(MSAL_PATH);
    let err = null;
    try { await unconfigured.getAccessToken(); } catch (e) { err = e; }
    eq('J3 an unconfigured integration refuses token acquisition', err && err.code, 'GRAPH_NOT_CONFIGURED');
    check('J4 the refusal explains what to set', /GRAPH_TENANT_ID/.test(err && err.message));
  });

  // Leave the module graph as the suite found it (env already restored).
  reload([CONFIG_PATH, MSAL_PATH, POLLER_PATH]);
  require(CONFIG_PATH);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  await prisma.$disconnect().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(`SUITE ERROR: ${err.stack || err}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
