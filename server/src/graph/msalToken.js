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

async function getAccessToken({ forceRefresh = false } = {}) {
  // Never assume a cached token stays valid forever: anything inside the
  // expiry margin (or after it) triggers a fresh acquisition.
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() < cachedToken.expiresAtMs - EXPIRY_MARGIN_MS
  ) {
    return cachedToken.token;
  }

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

/* ---- test hooks (not used in production paths) ----------------------- */
function _injectAuthClient(factory) {
  authClientFactory = factory;
}
function _resetTokenCache() {
  cca = null;
  cachedToken = null;
  authClientFactory = null;
}
function _peekCache() {
  return cachedToken;
}

module.exports = { getAccessToken, _injectAuthClient, _resetTokenCache, _peekCache };
