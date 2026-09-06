const { ConfidentialClientApplication } = require('@azure/msal-node');
const { graphConfig } = require('./config');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
// Renew tokens this many milliseconds before they actually expire so an
// in-flight request never uses a stale credential.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

let cca = null;
let cachedToken = null;
let authClientFactory = null;
// Shared in-flight acquisition: concurrent callers wait on ONE token request
// instead of stampeding the Entra token endpoint with parallel client-credential
// grants on a cold cache.
let inflight = null;

function getClient() {
  if (!cca) {
    if (authClientFactory) {
      // Test hook — allows injecting a mock MSAL application.
      cca = authClientFactory();
    } else {
      cca = new ConfidentialClientApplication({
        auth: {
          clientId: graphConfig.clientId,
          authority: `https://login.microsoftonline.com/${graphConfig.tenantId}`,
          clientSecret: graphConfig.clientSecret,
        },
        system: {
          loggerOptions: {
            loggerCallback: () => {},
            piiLoggingEnabled: false,
            logLevel: 3,
          },
        },
      });
    }
  }
  return cca;
}

async function acquire() {
  const result = await getClient().acquireTokenByClientCredential({
    scopes: [GRAPH_SCOPE],
  });
  if (!result || !result.accessToken) {
    throw new Error('MSAL returned no access token');
  }

  // expiresOn is normally a Date; be defensive about string forms/null.
  const expiresMs = result.expiresOn
    ? new Date(result.expiresOn).getTime()
    : Date.now() + DEFAULT_TOKEN_TTL_MS;

  cachedToken = {
    token: result.accessToken,
    expiresAtMs: Number.isFinite(expiresMs) ? expiresMs : Date.now() + DEFAULT_TOKEN_TTL_MS,
  };
  return cachedToken.token;
}

async function getAccessToken({ forceRefresh = false } = {}) {
  // An unconfigured integration must fail with a message an administrator can
  // act on, not MSAL's "invalid client" for an empty client id. An injected
  // auth client (the test hook below) stands in for a configured tenant, so
  // it bypasses this guard exactly as it bypasses the real MSAL calls.
  if (!graphConfig.enabled && !authClientFactory) {
    const err = new Error(
      'Microsoft Graph is not configured — set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, ' +
        'GRAPH_CLIENT_SECRET and GRAPH_SHARED_MAILBOX (see .env.example)'
    );
    err.code = 'GRAPH_NOT_CONFIGURED';
    throw err;
  }

  // Never assume a cached token stays valid forever: anything inside the
  // expiry margin (or after it) triggers a fresh acquisition.
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() < cachedToken.expiresAtMs - EXPIRY_MARGIN_MS
  ) {
    return cachedToken.token;
  }

  if (!inflight) {
    inflight = acquire().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/* ---- test hooks (not used in production paths) ----------------------- */
function _injectAuthClient(factory) {
  authClientFactory = factory;
}
function _resetTokenCache() {
  cca = null;
  cachedToken = null;
  authClientFactory = null;
  inflight = null;
}
function _peekCache() {
  return cachedToken;
}

module.exports = { getAccessToken, _injectAuthClient, _resetTokenCache, _peekCache };
