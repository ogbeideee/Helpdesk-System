// Email notifications. Uses Microsoft Graph when configured, otherwise logs
// to the console so the system runs end-to-end without Azure credentials.
//
// Division of labour: THIS MODULE owns transport selection, the safe-send
// wrapper and the per-notification entry points; src/email/outbound.js owns
// what the emails say and who may receive them. All builders delegate there,
// so the wording lives in exactly one place.
//
// All builders go through a small factory so callers (and tests) can inject
// an alternative transport.
const { graphConfig } = require('./graph/config');
const { smtpConfig, createSmtpTransport } = require('./smtp/config');
const { decorateMail } = require('./email/notificationLayout');
const {
  recipientsOf,
  newTicketBroadcastMail,
  ticketAcknowledgementMail,
  assignmentMail,
  statusUpdateMail,
  agentReplyMail,
} = require('./email/outbound');
// Resolving asks the requester to confirm; the mail carries the signed
// confirmation link when a portal base URL is configured.
const { confirmUrl } = require('./email/statusLink');

function consoleTransport(logger = console) {
  return {
    // Development mode always renders the DL alert so the flow is observable
    // without Azure credentials — nothing is actually sent.
    hasBroadcastTarget: () => true,
    async markAsRead() {},
    async sendBroadcastMail(mail) {
      logger.log(
        renderDevNotification({
          kind: 'NEW TICKET NOTIFICATION',
          to: graphConfig.broadcastDl || 'IT Helpdesk DL (GRAPH_BROADCAST_DL not set)',
          mail,
        })
      );
    },
    async sendMail(mail) {
      logger.log(
        renderDevNotification({
          kind: 'EMAIL NOTIFICATION',
          to: recipientsOf(mail),
          mail,
        })
      );
    },
  };
}

// Development-mode rendering of a notification that WOULD have been sent.
// Microsoft Graph replaces this transport later — nothing else changes.
function renderDevNotification({ kind, to, mail }) {
  const lines = [
    '='.repeat(60),
    kind,
    `To: ${to}`,
    '',
    'Subject:',
    mail.subject,
    '',
    '[Email content omitted from logs]',
    '='.repeat(60),
  ];
  return lines.join('\n');
}

/**
 * Transport selection: explicit Power Automate opt-in, Graph, SMTP, console.
 * Only one is ever live, and every one of them speaks the same small
 * interface, so no caller (and no test) changes when the choice changes.
 */
function getDefaultTransport() {
  if (require('./powerAutomate/config').readConfig().outbound) {
    return require('./powerAutomate/gateway').createTransport();
  }
  if (graphConfig.enabled) {
    // Lazy require so the Graph SDK/MSAL never loads when integration is off.
    const { graphOps } = require('./graph/graphClient');
    return graphOps;
  }
  if (smtpConfig.enabled) return createSmtpTransport(smtpConfig);
  return consoleTransport();
}

/**
 * Create a mailer bound to a specific transport + broadcast-target policy.
 * Called with no arguments it selects the configured transport automatically.
 */
function createMailer(options = {}) {
  const logger = options.logger || console;
  const transport = options.transport || getDefaultTransport();
  const durable = options.durable ?? (!options.transport && (require('./powerAutomate/config').readConfig().outbound || graphConfig.enabled || smtpConfig.enabled));
  const delivery = () => require('./services/emailDeliveryService');
  const deliveryClient = options.client;
  let retryTimer = null;
  let retryBusy = false;
  const retryPending = () => durable ? delivery().retryDue((payload, channel) => channel === 'broadcast'
    ? transport.sendBroadcastMail(payload) : transport.sendMail(payload), deliveryClient) : Promise.resolve();
  async function sendTracked(mail, kind = 'direct') {
    const rendered = decorateMail(mail);
    const send = (payload, channel) => channel === 'broadcast'
      ? transport.sendBroadcastMail(payload) : transport.sendMail(payload);
    if (!durable) { await send(rendered, kind); return true; }
    const row = await delivery().enqueue(rendered, kind, deliveryClient);
    return delivery().deliver(row, send, deliveryClient);
  }

  async function sendMailSafe(mail) {
    try {
      return await sendTracked(mail);
    } catch (err) {
      logger.error('[mailer] notification delivery failed; inspect administrator delivery status');
      return false;
    }
  }

  /** New-ticket broadcast to the IT team distribution list. */
  async function notifyNewTicketToDl(ticket) {
    const wantsBroadcast =
      typeof transport.hasBroadcastTarget === 'function'
        ? transport.hasBroadcastTarget()
        : Boolean(graphConfig.broadcastDl);
    if (!wantsBroadcast) {
      logger.log('[mailer] no broadcast target (GRAPH_BROADCAST_DL unset) — skipping team alert');
      return false;
    }
    try {
      return await sendTracked(newTicketBroadcastMail(ticket), 'broadcast');
    } catch (err) {
      logger.error('[mailer] broadcast delivery failed; inspect administrator delivery status');
      return false;
    }
  }

  /** Confirmation to the requester when their ticket is created. */
  async function notifyRequesterAck(ticket) {
    const mail = ticketAcknowledgementMail(ticket);
    if (!mail) return false;
    return sendMailSafe(mail);
  }

  /** Assignment notice to the assigned agent. */
  async function notifyAssignment(ticket, agent) {
    const mail = assignmentMail(ticket, agent);
    if (!mail) return false;
    return sendMailSafe(mail);
  }

  /**
   * Status change updates to the requester (includes resolution notes). On a
   * resolve it carries the signed confirmation link — the one link any
   * outbound email carries — so the requester can close the ticket themselves.
   */
  async function notifyStatusChanged(ticket, context = {}) {
    const mail = statusUpdateMail(ticket, {
      previousState: context.previousState,
      // Only a RESOLVED mail carries it; the builder ignores it otherwise.
      confirmUrl: ticket.state === 'RESOLVED' ? confirmUrl(ticket) : null,
    });
    if (!mail) return false;
    return sendMailSafe(mail);
  }

  /**
   * REQUESTER — a public agent reply on the ticket. Internal notes never
   * reach this entry point (the notes route gates on isInternal); it sends
   * only to ticket.requesterEmail.
   */
  async function notifyAgentReply(ticket, context = {}) {
    const mail = agentReplyMail({ ticket, agentName: context.agentName, body: context.body });
    if (!mail) return false;
    return sendMailSafe(mail);
  }

  // Retired entry point retained for older integrations. Never enqueue or send
  // duplicate reply/reopen alerts, including the former DL fallback.
  async function notifyReplyReceived() { return false; }

  return {
    transport,
    retryPending,
    startDeliveryRetries() {
      if (!durable || retryTimer) return;
      retryTimer = setInterval(async () => {
        if (retryBusy) return;
        retryBusy = true;
        try { await retryPending(); } catch { logger.error('[mailer] delivery retry failed'); }
        finally { retryBusy = false; }
      }, 30000);
      retryTimer.unref();
    },
    stopDeliveryRetries() { if (retryTimer) clearInterval(retryTimer); retryTimer = null; },
    sendMailSafe,
    notifyNewTicketToDl,
    notifyRequesterAck,
    notifyAssignment,
    notifyStatusChanged,
    notifyAgentReply,
    notifyReplyReceived,
  };
}

// Default instance bound to Graph/console for API-route usage.
const mailer = createMailer();

module.exports = { createMailer, ...mailer };
