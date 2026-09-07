/* Gmail OAuth2 (XOAUTH2) tests for the IMAP integration — no real network.

   Parts:
     A. configuration detection (password vs OAuth2 vs misconfigured, secrets
        never copied into the config object or status logs)
     B. token exchange against a MOCKED Google token endpoint (success, cache,
        expiry, refresh failure, unreachable endpoint, missing configuration)
     C. the ImapFlow client factory receives auth: { user, accessToken } for
        OAuth2 and auth: { user, pass } for passwords — nothing else changes
     D. end-to-end XOAUTH2 polling against a mock IMAP server (real ImapFlow):
        ticket creation, auth-failure containment (messages stay unseen), and
        the token being exchanged BEFORE the IMAP connection is attempted
     E. secrets never appear in logs, errors or status snapshots

   Usage: npm run test:imap-oauth  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4217';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('imap-oauth');

const http = require('http');
const net = require('net');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');
const imapStatus = require('../src/imap/imapStatus');
const oauth2 = require('../src/imap/oauth2');
const { readImapEnv, logImapStatus } = require('../src/imap/config');
const { createImapMailService } = require('../src/imap/mailService');

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

const CRLF = '\r\n';
const OAUTH_USER = 'helpdesk@gmail.test';
const OAUTH_PASS = 'unused-app-password';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret-XYZSECRET';
const REFRESH_TOKEN = 'test-refresh-token-1//AbCdEf';

const withEnv = (env, fn) => {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const withEnvAsync = async (env, fn) => {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return await fn(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const OAUTH_ENV = {
  IMAP_OAUTH2_CLIENT_ID: CLIENT_ID,
  IMAP_OAUTH2_CLIENT_SECRET: CLIENT_SECRET,
  IMAP_OAUTH2_REFRESH_TOKEN: REFRESH_TOKEN,
};

/** IMAP config derived from env (so authMode/oauth2 flags are exercised). */
function imapConfigFor(port, overrides = {}) {
  return withEnv({
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: String(port),
    IMAP_SECURE: 'false',
    IMAP_USER: OAUTH_USER,
    IMAP_PASSWORD: undefined,
    ...OAUTH_ENV,
    ...overrides,
  }, () => Object.assign(readImapEnv(), overrides));
}

/* ====================================================================== */
/* Mock Google OAuth2 token endpoint                                        */
/* ====================================================================== */

function createMockTokenEndpoint({ mode = 'ok' } = {}) {
  const state = { requests: 0, bodies: [], tokensIssued: [] };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      state.requests += 1;
      const body = Object.fromEntries(new URLSearchParams(data));
      state.bodies.push(body);
      if (mode === 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
        return;
      }
      const token = `ya29.token-${String(state.tokensIssued.length + 1).padStart(3, '0')}`;
      state.tokensIssued.push(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: token,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://mail.google.com/',
      }));
    });
  });
  return {
    server, state,
    ready: new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    get url() { return `http://127.0.0.1:${server.address().port}/token`; },
  };
}

/* ====================================================================== */
/* Mock IMAP server speaking XOAUTH2 (the real ImapFlow is pointed at it)   */
/* ====================================================================== */

function createMockImapServer({ messages = [], rejectAuth = false, authCaps = ['AUTH=XOAUTH2'] } = {}) {
  const state = {
    connections: 0,
    oauthAttempts: [],
    logins: [],
    authFailures: 0,
    selects: 0,
    searches: 0,
    fetches: [],
    seenUids: [],
  };

  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.write(`* OK Mock IMAP4rev1 ready${CRLF}`);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary');
      let idx;
      while ((idx = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    socket.on('error', () => {});

    function send(line) {
      socket.write(line + CRLF, 'binary');
    }

    /** Parse the XOAUTH2 SASL payload: user=<u>\x01auth=Bearer <t>\x01\x01 */
    function parseOauthPayload(b64) {
      try {
        const text = Buffer.from(b64, 'base64').toString('utf8');
        const m = text.match(/^user=([^\u0001]*)\u0001auth=Bearer ([^\u0001]*)\u0001/);
        return m ? { user: m[1], token: m[2] } : null;
      } catch (_) {
        return null;
      }
    }

    function handle(line) {
      const match = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) return;
      const [, tag, command, rest] = match;
      const cmd = command.toUpperCase();

      if (cmd === 'CAPABILITY') {
        send(`* CAPABILITY IMAP4rev1 ${authCaps.join(' ')} IDLE`);
        send(`${tag} OK CAPABILITY completed`);
      } else if (cmd === 'ID') {
        send('* ID nil');
        send(`${tag} OK ID completed`);
      } else if (cmd === 'AUTHENTICATE' && /^XOAUTH2\b/i.test(rest.trim())) {
        const parts = rest.trim().split(/\s+/);
        const payload = parts.length > 1 ? parseOauthPayload(parts[1]) : null;
        if (payload) state.oauthAttempts.push(payload);
        if (rejectAuth || !payload) {
          state.authFailures += 1;
          send(`${tag} NO [AUTHENTICATIONFAILED] invalid sasl token`);
        } else if (payload.user === OAUTH_USER) {
          send(`${tag} OK [CAPABILITY IMAP4rev1] authenticated`);
        } else {
          state.authFailures += 1;
          send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        }
      } else if (cmd === 'LOGIN') {
        const creds = rest.match(/"([^"]*)"\s+"([^"]*)"/) || rest.match(/^(\S+)\s+(\S+)$/);
        const user = creds ? creds[1] : '';
        state.logins.push(user);
        if (rejectAuth) {
          state.authFailures += 1;
          send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        } else {
          send(`${tag} OK [CAPABILITY IMAP4rev1] logged in`);
        }
      } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        state.selects += 1;
        send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
        send(`* ${messages.length} EXISTS`);
        send('* 0 RECENT');
        send('* OK [UIDVALIDITY 2222] UIDs valid');
        send(`* OK [UIDNEXT ${messages.length + 1}] next uid`);
        send(`${tag} OK [READ-WRITE] SELECT completed`);
      } else if (cmd === 'UID' && /\bSEARCH\b/i.test(rest)) {
        state.searches += 1;
        const unseen = messages.filter((m) => !state.seenUids.includes(m.uid)).map((m) => m.uid);
        send(`* SEARCH ${unseen.join(' ')}`.trimEnd());
        send(`${tag} OK SEARCH completed`);
      } else if (cmd === 'UID' && /\bFETCH\b/i.test(rest)) {
        const uid = parseInt((rest.match(/FETCH\s+(\d+)/i) || [])[1], 10);
        const message = messages.find((m) => m.uid === uid);
        state.fetches.push(uid);
        if (!message) {
          send(`${tag} OK FETCH completed`);
          return;
        }
        const body = Buffer.from(message.raw, 'utf8');
        socket.write(`* 1 FETCH (UID ${uid} INTERNALDATE "01-Sep-2026 09:00:00 +0000" BODY[] {${body.length}}${CRLF}`, 'binary');
        socket.write(body, 'binary');
        socket.write(`)${CRLF}`, 'binary');
        send(`${tag} OK FETCH completed`);
      } else if (cmd === 'UID' && /\bSTORE\b/i.test(rest)) {
        const uid = parseInt((rest.match(/STORE\s+(\d+)/i) || [])[1], 10);
        if (/^\+/.test(rest.split(/\s+/)[2] || '')) state.seenUids.push(uid);
        send(`${tag} OK STORE completed`);
      } else if (cmd === 'LOGOUT') {
        send('* BYE mock server closing');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
      } else {
        send(`${tag} OK ${cmd} completed`);
      }
    }
  });

  return {
    server, state,
    ready: new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  };
}

/* ====================================================================== */
/* Message builder + helpdesk seed                                          */
/* ====================================================================== */

const PASSWORD = 'ImapSuite!123';
const DOMAIN = 'gmail.test';

function rawMessage({ from, subject, messageId, text }) {
  return [
    `From: ${from}`,
    `To: IT Helpdesk <${OAUTH_USER}>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'Date: Tue, 01 Sep 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text || '',
    '',
  ].join(CRLF);
}

async function seedHelpdesk() {
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  return prisma.agent.create({
    data: {
      name: 'Oauth Agent', email: `agent@${DOMAIN}`, role: 'agent',
      isActive: true, isAvailable: true, skillLevel: 3,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), teamId: defaultTeam.id,
    },
  });
}

/* ====================================================================== */
/* Main                                                                     */
/* ====================================================================== */

async function main() {
  await seedHelpdesk();

  /* ---- A. configuration detection ---------------------------------------- */
  console.log('\n--- A. configuration ---');

  const passwordCfg = withEnv({
    IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: 'pw',
    IMAP_OAUTH2_CLIENT_ID: undefined, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => readImapEnv());
  eq('A1 password mode is the default', passwordCfg.authMode, 'password');
  eq('A2 password config enables IMAP', passwordCfg.enabled, true);
  eq('A3 no OAuth2 flags on the password path', passwordCfg.oauth2Configured, false);
  eq('A4 no misconfiguration flag when OAuth2 is untouched', passwordCfg.oauth2Misconfigured, false);

  const oauthCfg = withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: undefined, ...OAUTH_ENV,
  }, () => readImapEnv());
  eq('A5 OAuth2 detected when all three vars are set', oauthCfg.authMode, 'oauth2');
  eq('A6 OAuth2 enables IMAP without a password', oauthCfg.enabled, true);
  eq('A7 OAuth2 reported as configured', oauthCfg.oauth2Configured, true);
  eq('A8 no misconfiguration when complete', oauthCfg.oauth2Misconfigured, false);

  const precedenceCfg = withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: OAUTH_PASS, ...OAUTH_ENV,
  }, () => readImapEnv());
  eq('A9 OAuth2 takes precedence over a configured password', precedenceCfg.authMode, 'oauth2');

  const partialCfg = withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: undefined,
    IMAP_OAUTH2_CLIENT_ID: CLIENT_ID, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => readImapEnv());
  eq('A10 partial OAuth2 without a password stays disabled', partialCfg.enabled, false);
  eq('A11 partial OAuth2 is reported as misconfigured', partialCfg.oauth2Misconfigured, true);
  eq('A12 partial OAuth2 does not claim the oauth2 mode', partialCfg.authMode, 'disabled');

  const partialWithPassword = withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: OAUTH_PASS,
    IMAP_OAUTH2_CLIENT_ID: CLIENT_ID, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => readImapEnv());
  eq('A13 partial OAuth2 falls back to the password path', partialWithPassword.authMode, 'password');
  eq('A14 ...and is still flagged as misconfigured', partialWithPassword.oauth2Misconfigured, true);
  eq('A15 the password path stays enabled', partialWithPassword.enabled, true);

  const noneCfg = withEnv({
    IMAP_HOST: 'mail.x', IMAP_USER: 'u@x', IMAP_PASSWORD: undefined,
    IMAP_OAUTH2_CLIENT_ID: undefined, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => readImapEnv());
  eq('A16 host+user without either credential is disabled', noneCfg.enabled, false);
  eq('A17 mode is disabled', noneCfg.authMode, 'disabled');

  const serialized = JSON.stringify(oauthCfg) + JSON.stringify(passwordCfg);
  check('A18 the config object never contains the client secret', !serialized.includes(CLIENT_SECRET));
  check('A19 the config object never contains the refresh token', !serialized.includes(REFRESH_TOKEN));

  const logLines = [];
  withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: undefined, ...OAUTH_ENV,
  }, () => logImapStatus((l) => logLines.push(l), readImapEnv()));
  check('A20 the status log never contains the client secret', !logLines.join('\n').includes(CLIENT_SECRET));
  check('A21 the status log never contains the refresh token', !logLines.join('\n').includes(REFRESH_TOKEN));
  check('A22 the status log names the OAuth2 mode', logLines.join('\n').includes('OAuth2/XOAUTH2'));

  const misconfiguredLog = [];
  withEnv({
    IMAP_HOST: 'imap.gmail.com', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: undefined,
    IMAP_OAUTH2_CLIENT_ID: CLIENT_ID, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => logImapStatus((l) => misconfiguredLog.push(l), readImapEnv()));
  check('A23 a partial OAuth2 config is called out in the status log',
    misconfiguredLog.join('\n').includes('IMAP_OAUTH2_CLIENT_SECRET'));

  /* ---- B. token exchange (mocked Google endpoint) ------------------------- */
  console.log('\n--- B. token exchange ---');
  const tokenEndpoint = createMockTokenEndpoint();
  await tokenEndpoint.ready;
  oauth2._resetOauthCache();

  const envForTokens = { ...OAUTH_ENV, IMAP_OAUTH2_TOKEN_URL: tokenEndpoint.url };

  const token1 = await withEnvAsync(envForTokens, () => oauth2.getAccessToken());
  eq('B1 the token endpoint issued an access token', token1, 'ya29.token-001');
  eq('B2 exactly one token request was made', tokenEndpoint.state.requests, 1);
  const firstBody = tokenEndpoint.state.bodies[0];
  eq('B3 the refresh grant is used', firstBody.grant_type, 'refresh_token');
  eq('B4 the configured refresh token is exchanged (server-side only)', firstBody.refresh_token, REFRESH_TOKEN);
  eq('B5 the configured client id is sent', firstBody.client_id, CLIENT_ID);
  eq('B6 the configured client secret is sent', firstBody.client_secret, CLIENT_SECRET);

  const token1Again = await withEnvAsync(envForTokens, () => oauth2.getAccessToken());
  eq('B7 the cached token is reused', token1Again, token1);
  eq('B8 no extra request for the cached token', tokenEndpoint.state.requests, 1);

  const tokenFuture = await withEnvAsync(envForTokens, () =>
    oauth2.getAccessToken({ now: () => Date.now() + 2 * 60 * 60 * 1000 }));
  eq('B9 an expired token is refreshed', tokenFuture, 'ya29.token-002');
  eq('B10 the refresh produced a second request', tokenEndpoint.state.requests, 2);

  const rejectEndpoint = createMockTokenEndpoint({ mode: 'reject' });
  await rejectEndpoint.ready;
  oauth2._resetOauthCache(); // force a real exchange: the cached token must not mask the failure
  let rejectErr = null;
  try {
    await withEnvAsync({ ...OAUTH_ENV, IMAP_OAUTH2_TOKEN_URL: rejectEndpoint.url }, () => oauth2.getAccessToken());
  } catch (err) { rejectErr = err; }
  check('B11 a rejected refresh throws an actionable error', Boolean(rejectErr));
  check('B12 the error names the Google error code', rejectErr && /invalid_grant/.test(rejectErr.message));
  check('B13 the error carries remediation guidance', rejectErr && /refresh token/i.test(rejectErr.message));
  eq('B14 a failed exchange is attempted exactly once (no retry loop)', rejectEndpoint.state.requests, 1);
  check('B15 the failure message never contains the client secret', rejectErr && !rejectErr.message.includes(CLIENT_SECRET));
  check('B16 the failure message never contains the refresh token', rejectErr && !rejectErr.message.includes(REFRESH_TOKEN));

  // A failed exchange must not poison the cache: the next cycle retries once.
  const recovered = await withEnvAsync(envForTokens, () =>
    oauth2.getAccessToken({ now: () => Date.now() + 3 * 60 * 60 * 1000 }));
  eq('B17 the next attempt after a failure succeeds again', recovered, 'ya29.token-003');

  // Unreachable endpoint — the shape a network outage produces.
  const deadPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  let netErr = null;
  oauth2._resetOauthCache(); // force a real exchange instead of a cache hit
  try {
    await withEnvAsync({ ...OAUTH_ENV, IMAP_OAUTH2_TOKEN_URL: `http://127.0.0.1:${deadPort}/token` }, () => oauth2.getAccessToken());
  } catch (err) { netErr = err; }
  check('B18 an unreachable token endpoint throws an actionable error', Boolean(netErr));
  check('B19 the network error explains the failure and the retry path',
    netErr && /token endpoint/.test(netErr.message) && /retry/.test(netErr.message));

  let missingErr = null;
  try {
    await withEnvAsync({
      IMAP_OAUTH2_CLIENT_ID: undefined, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
    }, () => oauth2.getAccessToken());
  } catch (err) { missingErr = err; }
  check('B20 missing OAuth2 configuration is reported with the variable names',
    missingErr && missingErr.message.includes('IMAP_OAUTH2_CLIENT_ID') &&
    missingErr.message.includes('IMAP_OAUTH2_CLIENT_SECRET') && missingErr.message.includes('IMAP_OAUTH2_REFRESH_TOKEN'));
  check('B21 the missing-config error never leaks values',
    missingErr && !missingErr.message.includes(CLIENT_SECRET) && !missingErr.message.includes(REFRESH_TOKEN));

  // Re-prime the token cache for section C (the resets above emptied it).
  const reprime = await withEnvAsync(envForTokens, () =>
    oauth2.getAccessToken({ now: () => Date.now() + 4 * 60 * 60 * 1000 }));
  eq('B22 a fresh cycle refreshes again after the failures', reprime, 'ya29.token-004');

  tokenEndpoint.server.close();
  rejectEndpoint.server.close();

  /* ---- C. ImapFlow auth wiring (stubbed client, no sockets) --------------- */
  console.log('\n--- C. ImapFlow auth wiring ---');
  const { defaultClientFactory } = require('../src/imap/mailService');
  const imapflowPath = require.resolve('imapflow');
  require('imapflow'); // ensure the module is cached so it can be stubbed
  const imapflowModule = require.cache[imapflowPath];
  const realImapflowExports = imapflowModule.exports;
  const constructed = [];
  class StubImapFlow {
    constructor(opts) { constructed.push(opts); }
  }
  imapflowModule.exports = { ...realImapflowExports, ImapFlow: StubImapFlow };
  try {
    // The factory reads credentials from the env; provide the test set so the
    // token cache (keyed by credential fingerprint) is hit — no network.
    await withEnvAsync(OAUTH_ENV, async () => {
    const connOpts = (c) => {
      const { auth, ...rest } = c;
      return rest;
    };
    const oauthShapeConfig = {
      host: 'imap.gmail.com', port: 993, secure: true, user: OAUTH_USER, password: '',
      mailbox: 'INBOX', tlsRejectUnauthorized: true, authMode: 'oauth2',
    };
    await defaultClientFactory(oauthShapeConfig);
    const oauthClient = constructed[constructed.length - 1];
    eq('C1 OAuth2 hands ImapFlow an accessToken', oauthClient.auth.accessToken, 'ya29.token-004');
    eq('C2 ...and no password', oauthClient.auth.pass, undefined);
    eq('C3 the user is the Gmail address', oauthClient.auth.user, OAUTH_USER);

    const passwordShapeConfig = {
      ...oauthShapeConfig, authMode: 'password', password: OAUTH_PASS,
    };
    await defaultClientFactory(passwordShapeConfig);
    const passwordClient = constructed[constructed.length - 1];
    eq('C4 the password path still sends user+pass', passwordClient.auth.pass, OAUTH_PASS);
    eq('C5 the password path sends no accessToken', passwordClient.auth.accessToken, undefined);
    eq('C6 the password path user is unchanged', passwordClient.auth.user, OAUTH_USER);

    // Both credentials set: the config decides, and oauth2 wins (see A9).
    await defaultClientFactory({ ...passwordShapeConfig, authMode: 'oauth2' });
    const bothClient = constructed[constructed.length - 1];
    check('C7 OAuth2 wins when both credential sets exist',
      Boolean(bothClient.auth.accessToken) && bothClient.auth.pass === undefined);

    check('C8 only the auth block differs between the two modes',
      JSON.stringify(connOpts(oauthClient)) === JSON.stringify(connOpts(bothClient)));
    });
  } finally {
    imapflowModule.exports = realImapflowExports;
  }

  /* ---- D. end-to-end XOAUTH2 polling (real ImapFlow) ---------------------- */
  console.log('\n--- D. end-to-end XOAUTH2 polling ---');
  oauth2._resetOauthCache();
  const dTokens = createMockTokenEndpoint();
  await dTokens.ready;

  const imap1 = createMockImapServer({
    messages: [{
      uid: 1,
      raw: rawMessage({
        from: 'Rita Requester <rita@gmail.test>',
        subject: 'Laptop will not boot',
        messageId: '<oauth-1@gmail.test>',
        text: 'The laptop shows a black screen on power on.',
      }),
    }],
  });
  await imap1.ready;

  const dEnv = {
    IMAP_HOST: '127.0.0.1', IMAP_SECURE: 'false', IMAP_USER: OAUTH_USER, IMAP_PASSWORD: undefined,
    ...OAUTH_ENV, IMAP_OAUTH2_TOKEN_URL: dTokens.url,
  };
  const config1 = await withEnvAsync({ ...dEnv, IMAP_PORT: String(imap1.server.address().port) }, () => readImapEnv());
  const logs1 = [];
  const quiet = { log: (l) => logs1.push(String(l)), warn: (l) => logs1.push(String(l)), error: (l) => logs1.push(String(l)) };
  // The factory reads its credentials from the environment at connection time
  // (as in production), so the env stays active for the whole poll.
  const summary1 = await withEnvAsync({ ...dEnv, IMAP_PORT: String(imap1.server.address().port) }, () =>
    createImapMailService({ logger: quiet, config: config1 }).pollUnread());
  eq('D1 the message became a ticket through the shared pipeline', summary1.created, 1);
  eq('D2 one token exchange served the whole cycle', dTokens.state.requests, 1);
  eq('D3 ImapFlow authenticated via XOAUTH2', imap1.state.oauthAttempts.length, 1);
  eq('D4 the SASL user is IMAP_USER', imap1.state.oauthAttempts[0].user, OAUTH_USER);
  eq('D5 the SASL bearer token is the issued access token', imap1.state.oauthAttempts[0].token, 'ya29.token-001');
  eq('D6 the message was marked seen after a definitive outcome', imap1.state.seenUids.join(','), '1');
  const t1 = await prisma.ticket.findFirst({ where: { internetMessageId: 'oauth-1@gmail.test' } });
  check('D7 the ticket exists with the expected identity', Boolean(t1));
  eq('D8 LOGIN was never attempted in OAuth2 mode', imap1.state.logins.length, 0);

  // OAuth2 authentication failure: contained, nothing marked, nothing processed.
  const imap2 = createMockImapServer({
    rejectAuth: true,
    messages: [{
      uid: 1,
      raw: rawMessage({
        from: 'rita@gmail.test', subject: 'VPN drops', messageId: '<oauth-2@gmail.test>',
        text: 'The VPN disconnects every ten minutes.',
      }),
    }],
  });
  await imap2.ready;
  const config2 = await withEnvAsync({ ...dEnv, IMAP_PORT: String(imap2.server.address().port) }, () => readImapEnv());
  let authErr = null;
  try {
    await withEnvAsync({ ...dEnv, IMAP_PORT: String(imap2.server.address().port) }, () =>
      createImapMailService({ logger: quiet, config: config2 }).pollUnread());
  } catch (err) { authErr = err; }
  check('D9 an XOAUTH2 rejection surfaces as a clean error', Boolean(authErr));
  eq('D10 the rejected message was never marked seen', imap2.state.seenUids.length, 0);
  eq('D11 no ticket was created from the rejected message',
    await prisma.ticket.count({ where: { internetMessageId: 'oauth-2@gmail.test' } }), 0);
  check('D12 the auth failure message never leaks the access token',
    authErr && !String(authErr.message).includes('ya29.token-'));
  check('D13 the auth failure message never leaks the refresh token',
    authErr && !String(authErr.message).includes(REFRESH_TOKEN));

  // Token exchange happens BEFORE any IMAP connection: with the token endpoint
  // unreachable, the mail server is never even contacted.
  const deadPortD = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const imap3 = createMockImapServer({ messages: [] });
  await imap3.ready;
  const config3 = await withEnvAsync({
    ...dEnv, IMAP_PORT: String(imap3.server.address().port), IMAP_OAUTH2_TOKEN_URL: `http://127.0.0.1:${deadPortD}/token`,
  }, () => readImapEnv());
  let tokenErrD = null;
  oauth2._resetOauthCache(); // force a real exchange so the dead endpoint is contacted
  try {
    await withEnvAsync({
      ...dEnv, IMAP_PORT: String(imap3.server.address().port), IMAP_OAUTH2_TOKEN_URL: `http://127.0.0.1:${deadPortD}/token`,
    }, () => createImapMailService({ logger: quiet, config: config3 }).pollUnread());
  } catch (err) { tokenErrD = err; }
  check('D14 a failed token exchange aborts the cycle with an actionable error', Boolean(tokenErrD));
  check('D15 the token error explains the failure and the retry path',
    tokenErrD && /token endpoint/.test(tokenErrD.message) && /retry/.test(tokenErrD.message));
  eq('D16 no IMAP connection was attempted without a token', imap3.state.connections, 0);

  imap1.server.close();
  imap2.server.close();
  imap3.server.close();
  dTokens.server.close();

  /* ---- E. secrets never reach logs, errors or status ---------------------- */
  console.log('\n--- E. secret hygiene ---');
  const logBlob = logs1.join('\n');
  check('E1 polling logs never contain the access token', !logBlob.includes('ya29.token-'));
  check('E2 polling logs never contain the client secret', !logBlob.includes(CLIENT_SECRET));
  check('E3 polling logs never contain the refresh token', !logBlob.includes(REFRESH_TOKEN));

  // Status snapshots are what /api/health returns — they must stay secret-free.
  const statusBlob = JSON.stringify(imapStatus.snapshot());
  check('E4 the status snapshot never contains the access token', !statusBlob.includes('ya29.token-'));
  check('E5 the status snapshot never contains the client secret', !statusBlob.includes(CLIENT_SECRET));
  check('E6 the status snapshot never contains the refresh token', !statusBlob.includes(REFRESH_TOKEN));

  // The in-memory token cache itself is the only place a token lives — and it
  // is keyed by a credential fingerprint, not by the credentials.
  oauth2._resetOauthCache();
  console.log('\n--- F. password path regression ---');
  const pwImap = createMockImapServer({
    authCaps: [],
    messages: [{
      uid: 1,
      raw: rawMessage({
        from: 'Bob <bob@gmail.test>', subject: 'Mouse double-clicks',
        messageId: '<pw-1@gmail.test>', text: 'The left mouse button double-clicks on its own.',
      }),
    }],
  });
  await pwImap.ready;
  const pwConfig = await withEnvAsync({
    IMAP_HOST: '127.0.0.1', IMAP_PORT: String(pwImap.server.address().port), IMAP_SECURE: 'false',
    IMAP_USER: OAUTH_USER, IMAP_PASSWORD: OAUTH_PASS,
    IMAP_OAUTH2_CLIENT_ID: undefined, IMAP_OAUTH2_CLIENT_SECRET: undefined, IMAP_OAUTH2_REFRESH_TOKEN: undefined,
  }, () => readImapEnv());
  eq('F1 the password config derives the password mode', pwConfig.authMode, 'password');
  const pwLogs = [];
  const pwSummary = await createImapMailService({ logger: { log: (l) => pwLogs.push(String(l)), warn: () => {}, error: () => {} }, config: pwConfig }).pollUnread();
  eq('F2 the password path still creates tickets', pwSummary.created, 1);
  eq('F3 the password path still uses LOGIN', pwImap.state.logins.length, 1);
  eq('F4 the password path never attempts XOAUTH2', pwImap.state.oauthAttempts.length, 0);
  eq('F5 seen handling is unchanged', pwImap.state.seenUids.join(','), '1');
  pwImap.server.close();
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();