// IMAP ingestion configuration — the IMAP counterpart of graph/config.js.
//
// The integration is opt-in: it is enabled when a host, a username and either
// a password or a complete OAuth2 (XOAUTH2) credential set are configured.
// OAuth2 — for Gmail accounts without an App Password — takes precedence when
// IMAP_OAUTH2_CLIENT_ID, IMAP_OAUTH2_CLIENT_SECRET and IMAP_OAUTH2_REFRESH_TOKEN
// are ALL set; otherwise the classic password path is used unchanged.
// Nothing here is ever logged except the safe fields (host, port, mailbox,
// cadence, auth mode); no credential is ever logged, stored in the database
// or included in API responses or audit events, and no secret is ever copied
// into the returned config object.
const { readOauth2Env, missingOauth2Vars } = require('./oauth2');

function readImapEnv() {
  const host = String(process.env.IMAP_HOST || '').trim();
  const user = String(process.env.IMAP_USER || '').trim();
  const password = String(process.env.IMAP_PASSWORD || '');
  const mailbox = String(process.env.IMAP_MAILBOX || '').trim() || 'INBOX';

  // Gmail OAuth2 (XOAUTH2) — an optional alternative to IMAP_PASSWORD for
  // accounts (typically Gmail) where an App Password is unavailable. When all
  // three IMAP_OAUTH2_* variables are set, OAuth2 takes precedence and
  // IMAP_PASSWORD is ignored. The secrets stay in the environment: none of
  // them are ever copied into the returned config object.
  const oauth2 = readOauth2Env();
  const oauth2Complete = Boolean(oauth2.clientId && oauth2.clientSecret && oauth2.refreshToken);
  const oauth2Partial =
    !oauth2Complete && Boolean(oauth2.clientId || oauth2.clientSecret || oauth2.refreshToken);

  // TLS is the default (993); IMAP_SECURE=false allows legacy plaintext or
  // STARTTLS-only servers on 143. IMAP_TLS_REJECT_UNAUTHORIZED=false accepts
  // self-signed certificates for on-premise servers.
  const secureEnv = String(process.env.IMAP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv ? !['false', '0', 'no'].includes(secureEnv) : true;
  const portRaw = Number(process.env.IMAP_PORT);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : secure ? 993 : 143;

  const rejectEnv = String(process.env.IMAP_TLS_REJECT_UNAUTHORIZED || '').trim().toLowerCase();
  const tlsRejectUnauthorized = !['false', '0', 'no'].includes(rejectEnv);

  const pollIntervalRaw = Number(process.env.IMAP_POLL_INTERVAL_MS);
  // Default cadence 2 minutes; scheduler convention shared with every
  // background job: an explicit 0 (or negative) disables the timer entirely.
  const pollIntervalMs = Number.isFinite(pollIntervalRaw)
    ? Math.trunc(pollIntervalRaw)
    : 120000;

  // Per-cycle batch cap, mirroring GRAPH_POLL_BATCH_SIZE.
  const batchRaw = Number(process.env.IMAP_POLL_BATCH_SIZE);
  const pollBatchSize = Number.isFinite(batchRaw) && batchRaw > 0
    ? Math.min(Math.trunc(batchRaw), 100)
    : 25;

  // Enabled with either authentication mode; a partially set OAuth2 block is
  // reported as misconfigured but never blocks the password path.
  const enabled = Boolean(host && user && (password || oauth2Complete));

  return {
    host,
    port,
    secure,
    user,
    password,
    mailbox,
    pollIntervalMs,
    pollBatchSize,
    tlsRejectUnauthorized,
    // 'oauth2' (XOAUTH2) | 'password' (LOGIN) | 'disabled'
    authMode: oauth2Complete ? 'oauth2' : password && user ? 'password' : 'disabled',
    oauth2Configured: oauth2Complete,
    oauth2Misconfigured: oauth2Partial,
    enabled,
  };
}

const imapConfig = readImapEnv();

function logImapStatus(logger, config = imapConfig) {
  if (!config.enabled) {
    if (config.oauth2Misconfigured) {
      logger(
        '[imap] OAuth2 is only partially configured — ' +
          `${missingOauth2Vars().join(', ')} missing. ` +
          'Set ALL of them (with IMAP_HOST and IMAP_USER) for Gmail XOAUTH2, ' +
          'or remove them all to use password authentication.'
      );
    }
    logger('IMAP integration disabled.');
    logger(
      '[imap] set IMAP_HOST, IMAP_USER and (IMAP_PASSWORD or the full ' +
        'IMAP_OAUTH2_* set) to enable it. ' +
        'Graph ingestion and notifications are unaffected.'
    );
    return;
  }
  // The auth mode is safe to log; the credentials behind it never are.
  const authLabel = config.authMode === 'oauth2' ? 'OAuth2/XOAUTH2' : 'password auth';
  logger(
    `[imap] enabled — ${config.secure ? 'imaps' : 'imap'}://${config.host}:${config.port}` +
      ` (${authLabel})` +
      ` mailbox=${config.mailbox} · polling every ${Math.round(config.pollIntervalMs / 1000)}s` +
      ` · batch ${config.pollBatchSize}` +
      (config.pollIntervalMs === 0 ? ' · TIMER DISABLED (IMAP_POLL_INTERVAL_MS=0)' : '')
  );
  if (config.oauth2Misconfigured) {
    logger(
      '[imap] OAuth2 is only partially configured — ' +
        `${missingOauth2Vars().join(', ')} missing — so password authentication is used.`
    );
  }
  if (!config.tlsRejectUnauthorized) {
    logger('[imap] TLS certificate validation is OFF (IMAP_TLS_REJECT_UNAUTHORIZED=false)');
  }
}

module.exports = { imapConfig, logImapStatus, readImapEnv };
