// Outbound SMTP transport — the third transport behind src/mailer.js.
//
// Precedence there is Microsoft Graph (M365 tenants) -> SMTP (any provider,
// including a Gmail account using an App Password) -> the console fallback
// that logs the notification. This module is the SMTP option: it reads the
// configuration, reports it, and exposes exactly the transport interface the
// mailer already speaks (`sendMail`, `sendBroadcastMail`,
// `hasBroadcastTarget`), so no caller changes when it is selected.
//
// The integration is opt-in and enabled when a host, a user and a password are
// configured. No credential is ever logged, returned through the config object,
// copied into the database, or included in an API response — only the host,
// port, the sender address and the auth mode are ever printed.
const nodemailer = require('nodemailer');

function readSmtpEnv() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  // SMTP_FROM defaults to the authenticated user: almost every provider only
  // permits sending as the identity it authenticated.
  const from = String(process.env.SMTP_FROM || user).trim();
  const fromName = String(process.env.SMTP_FROM_NAME || 'IT Helpdesk').trim();
  // The new-ticket broadcast target. Falls back to the Graph DL name so a
  // migration from Graph to SMTP does not silently stop the team alert.
  const broadcastDl = String(
    process.env.SMTP_BROADCAST_DL || process.env.GRAPH_BROADCAST_DL || ''
  ).trim();

  // Implicit TLS (465) by default; SMTP_SECURE=false selects STARTTLS on 587.
  const secureEnv = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv ? !['false', '0', 'no'].includes(secureEnv) : true;
  const portRaw = Number(process.env.SMTP_PORT);
  const port =
    Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : secure ? 465 : 587;

  const rejectEnv = String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '').trim().toLowerCase();
  const tlsRejectUnauthorized = !['false', '0', 'no'].includes(rejectEnv);

  const enabled = Boolean(host && user && pass && from);

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    fromName,
    broadcastDl,
    tlsRejectUnauthorized,
    enabled,
  };
}

/**
 * The subset of the configuration that is safe to log, print, or hand to an
 * admin route. `readSmtpEnv()` keeps the password because the transport needs it,
 * so anything that leaves this module must go through here — the password is
 * never part of a printable shape.
 */
function publicSmtpConfig(config = smtpConfig) {
  const { pass, ...safe } = config;
  return safe;
}


const smtpConfig = readSmtpEnv();

function logSmtpStatus(logger, config = smtpConfig) {
  if (!config.enabled) {
    logger(
      'SMTP outbound disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS (and ' +
        'SMTP_FROM if it differs from SMTP_USER) to send real mail; without it ' +
        'notifications are logged to the console.'
    );
    return;
  }
  logger(
    `[smtp] enabled — ${config.secure ? 'smtps' : 'smtp+starttls'}://${config.host}:${config.port}` +
      ` · from ${config.from}` +
      (config.broadcastDl
        ? ` · broadcast ${config.broadcastDl}`
        : ' · no broadcast target (SMTP_BROADCAST_DL unset)')
  );
  if (!config.tlsRejectUnauthorized) {
    logger('[smtp] TLS certificate validation is OFF (SMTP_TLS_REJECT_UNAUTHORIZED=false)');
  }
}

/** `{ emailAddress: { address, name } }` -> nodemailer's `{ address, name }`. */
function toAddress(recipient) {
  if (!recipient) return null;
  if (typeof recipient === 'string') return { address: recipient };
  const address = recipient.emailAddress || recipient;
  const value = typeof address === 'string' ? address : address.address;
  if (!value) return null;
  const name = (typeof address === 'object' && address.name) || recipient.name;
  return name ? { address: value, name } : { address: value };
}

function addressList(recipients) {
  return (recipients || []).map(toAddress).filter(Boolean);
}


/**
 * Build the transport. The transporter is created lazily and reused, so nodemailer
 * keeps one pooled connection instead of reconnecting per notification.
 *
 * `createTransport` is an injection seam for the test suite (see
 * scripts/test-smtp.js), which must exercise composition without opening a
 * socket. It defaults to the real nodemailer factory.
 */
function createSmtpTransport(config = smtpConfig, options = {}) {
  if (!config.enabled) {
    throw new Error('[smtp] transport requested but SMTP is not configured');
  }
  const createTransport =
    options.createTransport || ((opts) => nodemailer.createTransport(opts));
  let transporter = null;
  function get() {
    if (!transporter) {
      transporter = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
        // Notification mail is fire-and-forget: a slow provider must never hold
        // a request open, so failures surface as a rejected send, not a hang.
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
    }
    return transporter;
  }

  function compose(mail) {
    const to = addressList(mail.toRecipients);
    const cc = addressList(mail.ccRecipients);
    if (!to.length && !cc.length) {
      throw new Error('[smtp] refusing to send a message with no recipient');
    }
    return {
      from: { name: config.fromName, address: config.from },
      to,
      ...(cc.length ? { cc } : {}),
      subject: mail.subject,
      // The builders already emit CRLF-wrapped plain text, which is exactly what
      // RFC 5322 wants; do not re-wrap or re-encode it.
      text: String(mail.body || ''),
    };
  }

  return {
    name: 'smtp',
    hasBroadcastTarget: () => Boolean(config.broadcastDl),
    async sendMail(mail) {
      return get().sendMail(compose(mail));
    },
    async sendBroadcastMail(mail) {
      if (!config.broadcastDl) {
        throw new Error('[smtp] no broadcast target (SMTP_BROADCAST_DL unset)');
      }
      return get().sendMail(compose({ ...mail, toRecipients: [config.broadcastDl] }));
    },
    /** The address the transport would broadcast to, for the reply-alert fallback. */
    broadcastTarget: () => config.broadcastDl || null,
  };
}

module.exports = {
  smtpConfig,
  readSmtpEnv,
  publicSmtpConfig,
  logSmtpStatus,
  createSmtpTransport,
  toAddress,
  addressList,
};
