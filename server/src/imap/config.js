// IMAP ingestion configuration — the IMAP counterpart of graph/config.js.
//
// The integration is opt-in: it is enabled only when a host, a username and a
// password are all configured. Nothing here is ever logged except the safe
// fields (host, port, mailbox, cadence); the password is never logged, never
// stored in the database and never included in API responses or audit events.
function readImapEnv() {
  const host = String(process.env.IMAP_HOST || '').trim();
  const user = String(process.env.IMAP_USER || '').trim();
  const password = String(process.env.IMAP_PASSWORD || '');
  const mailbox = String(process.env.IMAP_MAILBOX || '').trim() || 'INBOX';

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

  const enabled = Boolean(host && user && password);

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
    enabled,
  };
}

const imapConfig = readImapEnv();

function logImapStatus(logger, config = imapConfig) {
  if (!config.enabled) {
    logger('IMAP integration disabled.');
    logger(
      '[imap] set IMAP_HOST, IMAP_USER and IMAP_PASSWORD to enable it. ' +
        'Graph ingestion and notifications are unaffected.'
    );
    return;
  }
  logger(
    `[imap] enabled — ${config.secure ? 'imaps' : 'imap'}://${config.host}:${config.port}` +
      ` mailbox=${config.mailbox} · polling every ${Math.round(config.pollIntervalMs / 1000)}s` +
      ` · batch ${config.pollBatchSize}` +
      (config.pollIntervalMs === 0 ? ' · TIMER DISABLED (IMAP_POLL_INTERVAL_MS=0)' : '')
  );
  if (!config.tlsRejectUnauthorized) {
    logger('[imap] TLS certificate validation is OFF (IMAP_TLS_REJECT_UNAUTHORIZED=false)');
  }
}

module.exports = { imapConfig, logImapStatus, readImapEnv };
