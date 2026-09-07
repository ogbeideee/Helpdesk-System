// Gmail OAuth2 (XOAUTH2) access-token retrieval for the IMAP integration.
//
// ImapFlow accepts auth: { user, accessToken } — SASL XOAUTH2 — which is what
// Gmail requires for accounts without an App Password. This module turns the
// three configured credentials (client id, client secret, refresh token) into
// a short-lived access token via Google's standard refresh grant, fetched
// right before the IMAP connection is created.
//
// Hard guarantees (mirroring the rest of the IMAP integration):
//   - The refresh token, client secret and access token exist ONLY in the
//     process environment and process memory. They are never written to the
//     database or filesystem, never logged, and never embedded in errors,
//     status snapshots or API responses.
//   - Exactly one token request per call — no retry loops. A failed refresh
//     surfaces an actionable error; the poller already contains per-cycle
//     failures, so the next poll cycle naturally retries.
//   - Access tokens are cached in memory until shortly before expiry so one
//     token serves many poll cycles.
//
// The refresh token must be consented for the Gmail IMAP scope:
//   https://mail.google.com/
// (Google's refresh grant returns a token scoped to whatever the refresh
// token was originally consented for — the scope is fixed at consent time,
// not per request — so it is documented here and in .env.example rather than
// sent on the wire.)
const crypto = require('crypto');

const GMAIL_IMAP_SCOPE = 'https://mail.google.com/';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Refresh comfortably before the documented expiry so a token can never die
// mid-connection; 60s is far below any sane poll interval.
const EXPIRY_SKEW_MS = 60 * 1000;

// In-memory cache, keyed by a fingerprint of the credentials (never the
// credentials themselves). Never persisted anywhere.
const tokenCache = new Map();

function readOauth2Env() {
  return {
    clientId: String(process.env.IMAP_OAUTH2_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.IMAP_OAUTH2_CLIENT_SECRET || ''),
    refreshToken: String(process.env.IMAP_OAUTH2_REFRESH_TOKEN || ''),
    // Where to exchange the refresh token. Defaults to Google's endpoint;
    // tests point it at a local mock instead of the real network.
    tokenUrl: String(process.env.IMAP_OAUTH2_TOKEN_URL || '').trim() || DEFAULT_TOKEN_URL,
  };
}

/** Which required env vars are missing — names only, never values. */
function missingOauth2Vars(oauth2 = readOauth2Env()) {
  const missing = [];
  if (!oauth2.clientId) missing.push('IMAP_OAUTH2_CLIENT_ID');
  if (!oauth2.clientSecret) missing.push('IMAP_OAUTH2_CLIENT_SECRET');
  if (!oauth2.refreshToken) missing.push('IMAP_OAUTH2_REFRESH_TOKEN');
  return missing;
}

/** Stable per-credential cache key. The credentials themselves are never used. */
function fingerprint(oauth2) {
  return crypto
    .createHash('sha256')
    .update(`${oauth2.clientId}\n${oauth2.clientSecret}\n${oauth2.refreshToken}`)
    .digest('hex');
}

/** A still-valid cached token, or undefined. Expired entries are dropped. */
function cachedToken(oauth2, now = Date.now()) {
  const key = fingerprint(oauth2);
  const entry = tokenCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt - EXPIRY_SKEW_MS <= now) {
    tokenCache.delete(key);
    return undefined;
  }
  return entry.accessToken;
}

module.exports = {
  GMAIL_IMAP_SCOPE,
  DEFAULT_TOKEN_URL,
  readOauth2Env,
  missingOauth2Vars,
  getAccessToken,
  _resetOauthCache,
};

/**
 * The XOAUTH2 access token for the configured Gmail account.
 *
 * Resolves (from cache or a single refresh-grant exchange) with the bearer
 * token for IMAP_USER. Throws an actionable error that never contains any
 * secret when the configuration is incomplete, the endpoint is unreachable,
 * or Google rejects the grant.
 *
 * @param {{ credentials?: object, tokenUrl?: string, fetchImpl?: Function, now?: Function }} [options]
 * @returns {Promise<string>}
 */
async function getAccessToken(options = {}) {
  const oauth2 = options.credentials || readOauth2Env();
  const now = options.now ? options.now() : Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const tokenUrl = options.tokenUrl || oauth2.tokenUrl;

  const cached = cachedToken(oauth2, now);
  if (cached) return cached;

  const missing = missingOauth2Vars(oauth2);
  if (missing.length > 0) {
    throw new Error(
      '[imap] OAuth2 is misconfigured: ' +
        missing.join(', ') +
        ' must ALL be set (or remove them all to fall back to password authentication). ' +
        'No IMAP connection was attempted.'
    );
  }

  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth2.refreshToken,
        client_id: oauth2.clientId,
        client_secret: oauth2.clientSecret,
      }).toString(),
    });
  } catch (err) {
    throw new Error(
      '[imap] could not reach the OAuth2 token endpoint for a Gmail access ' +
        `token: ${err && err.message ? err.message : 'network error'}. ` +
        'Check the server can reach accounts.google.com — the next poll cycle will retry.'
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (
    !response.ok ||
    !payload ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0
  ) {
    // Google's error body carries an error code plus a human description;
    // neither ever embeds credentials. Only those known-safe fields are
    // surfaced, so no secret can leak through this message.
    const code =
      payload && typeof payload.error === 'string' && payload.error
        ? payload.error
        : `HTTP ${response.status}`;
    const hints = {
      invalid_grant:
        'the refresh token was revoked, expired, or issued for a different client — generate a new one for the https://mail.google.com/ scope',
      invalid_client:
        'IMAP_OAUTH2_CLIENT_ID or IMAP_OAUTH2_CLIENT_SECRET does not match this refresh token',
      unauthorized_client:
        'this client may not use the given refresh token — re-issue the token with the same client',
    };
    throw new Error(
      `[imap] Gmail OAuth2 token refresh failed (${code}). ` +
        (hints[code] || 'check the IMAP_OAUTH2_* configuration') +
        '. The next poll cycle will retry; password authentication (IMAP_PASSWORD) is unaffected.'
    );
  }

  const expiresIn = Number(payload.expires_in);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3600 * 1000;
  tokenCache.set(fingerprint(oauth2), { accessToken: payload.access_token, expiresAt });
  return payload.access_token;
}

/* ---- test hook --------------------------------------------------------- */
function _resetOauthCache() {
  tokenCache.clear();
}