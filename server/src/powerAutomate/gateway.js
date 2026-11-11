const { readConfig } = require('./config');
// The flow URL may contain a signature. Never log it or provider response text.
function createGateway({ config = readConfig(), fetchImpl = fetch } = {}) {
  return async function call(operation, payload) {
    let url;
    try { url = new URL(config.flowUrl); } catch { throw new Error('Power Automate gateway is not configured'); }
    if (url.protocol !== 'https:' || url.username || url.password || config.flowKey.length < 32) {
      throw new Error('Power Automate gateway configuration is invalid');
    }
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', 'x-ticketdesk-key': config.flowKey },
        body: JSON.stringify({ operation, ...payload }),
      });
    } catch { throw new Error('Power Automate gateway request failed'); }
    // A trigger's immediate 202 means accepted, NOT sent. Require a Response
    // action after the actual Outlook action, with an explicit success body.
    if (response.status !== 200) throw new Error('Power Automate gateway did not confirm completion');
    let result;
    try {
      const limit = 36 * 1024 * 1024;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Response too large');
        chunks.push(Buffer.from(chunk));
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Power Automate gateway response is invalid'); }
    if (result.ok !== true || result.operation !== operation) throw new Error('Power Automate gateway reported failure');
    return result;
  };
}
function createTransport(options = {}) {
  const config = options.config || readConfig();
  const call = options.call || createGateway({ ...options, config });
  const sendMail = mail => {
    const { addressList } = require('../smtp/config');
    const to = addressList(mail.toRecipients).map(item => item.address).join(';');
    const cc = addressList(mail.ccRecipients).map(item => item.address).join(';');
    if (!to && !cc) throw new Error('Power Automate mail has no recipient');
    return call('sendMail', { mail: {
      to, cc, subject: String(mail.subject || ''), body: String(mail.body || ''),
      html: mail.html ? String(mail.html) : `<pre>${require('../email/outbound').htmlEscape(String(mail.body || ''))}</pre>`,
    } });
  };
  return {
    name: 'power_automate', sendMail,
    hasBroadcastTarget: () => Boolean(config.broadcastDl),
    broadcastTarget: () => config.broadcastDl || null,
    sendBroadcastMail(mail) {
      if (!config.broadcastDl) throw new Error('Power Automate broadcast target is not configured');
      return sendMail({ ...mail, toRecipients: [{ emailAddress: { address: config.broadcastDl } }], ccRecipients: [] });
    },
  };
}
function createSourceFetcher(options = {}) {
  const call = options.call || createGateway(options);
  return async ({ attachment }) => {
    const result = await call('exportEmail', { messageId: attachment.messageId });
    const { attachments } = await require('./mime').parseExport({ messageId: attachment.messageId, mimeBase64: result.mimeBase64 });
    // The common fetch service checks sanitized filename and exact byte size.
    return attachments;
  };
}
module.exports = { createGateway, createTransport, createSourceFetcher };
