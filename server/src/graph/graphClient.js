const { Client } = require('@microsoft/microsoft-graph-client');
const { graphConfig } = require('./config');
const { getAccessToken } = require('./msalToken');

let client = null;

function getClient() {
  if (!client) {
    client = Client.init({
      defaultVersion: 'v1.0',
      authProvider: (done) => {
        getAccessToken()
          .then((token) => done(null, token))
          .catch((err) => done(err, null));
      },
    });
  }
  return client;
}

async function withTokenRetry(requestFn) {
  try {
    return await requestFn();
  } catch (err) {
    if (err && (err.statusCode === 401 || err.code === 'InvalidAuthenticationToken')) {
      await getAccessToken({ forceRefresh: true });
      return requestFn();
    }
    throw err;
  }
}

function mailboxPath(suffix = '') {
  return `/users/${encodeURIComponent(graphConfig.sharedMailbox)}${suffix}`;
}

const MESSAGE_FIELDS =
  'id,subject,bodyPreview,body,from,conversationId,receivedDateTime,isRead,webLink,hasAttachments';

async function getMessage(messageId) {
  return withTokenRetry(() =>
    getClient()
      .api(mailboxPath(`/messages/${encodeURIComponent(messageId)}`))
      .select(MESSAGE_FIELDS)
      .get()
  );
}

/**
 * Unread inbox messages, newest first.
 *
 * `since` is applied server-side so an old backlog is never even fetched —
 * the development-safety guard against turning hundreds of existing mails
 * into tickets.
 *
 * @param {number} top   maximum messages to return
 * @param {{ since?: Date|string|null }} [options]
 */
async function listUnreadMessages(top = 25, options = {}) {
  const filters = ['isRead eq false'];
  if (options.since) {
    const since =
      options.since instanceof Date ? options.since : new Date(options.since);
    if (!Number.isNaN(since.getTime())) {
      filters.push(`receivedDateTime ge ${since.toISOString()}`);
    }
  }

  const res = await withTokenRetry(() =>
    getClient()
      .api(mailboxPath("/mailFolders('inbox')/messages"))
      .filter(filters.join(' and '))
      .orderby('receivedDateTime desc')
      .top(top)
      .select(MESSAGE_FIELDS)
      .get()
  );
  return res.value || [];
}

/**
 * Attachment metadata for one message.
 * Only the metadata fields are selected — content bytes are never requested,
 * because attachment storage is a separate, later decision.
 */
async function listAttachments(messageId) {
  const res = await withTokenRetry(() =>
    getClient()
      .api(mailboxPath(`/messages/${encodeURIComponent(messageId)}/attachments`))
      .select('id,name,contentType,size,isInline')
      .get()
  );
  return res.value || [];
}

/**
 * Confirm the shared mailbox is reachable with the current credentials.
 * Returns identifying detail only — never a token or secret.
 */
async function getMailboxProfile() {
  const res = await withTokenRetry(() =>
    getClient().api(mailboxPath()).select('id,displayName,mail,userPrincipalName').get()
  );
  return {
    id: res.id || null,
    displayName: res.displayName || null,
    mail: res.mail || res.userPrincipalName || null,
  };
}

async function markAsRead(messageId) {
  return withTokenRetry(() =>
    getClient()
      .api(mailboxPath(`/messages/${encodeURIComponent(messageId)}`))
      .patch({ isRead: true })
  );
}

async function sendBroadcastMail({ subject, body }) {
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: graphConfig.broadcastDl } }],
  };
  return withTokenRetry(() =>
    getClient().api(mailboxPath('/sendMail')).post({
      message,
      saveToSentItems: true,
    })
  );
}

// Generic send-as-shared-mailbox (requester acks, assignments, status updates).
async function sendMail({ subject, body, toRecipients, ccRecipients }) {
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients,
    ...(ccRecipients ? { ccRecipients } : {}),
  };
  return withTokenRetry(() =>
    getClient().api(mailboxPath('/sendMail')).post({
      message,
      saveToSentItems: true,
    })
  );
}

const MAX_SUBSCRIPTION_MINUTES = 4230;

async function createSubscription({ notificationUrl, clientState }) {
  return withTokenRetry(() =>
    getClient().api('/subscriptions').post({
      changeType: 'created',
      notificationUrl,
      lifecycleNotificationUrl: notificationUrl,
      resource: mailboxPath("/mailFolders('inbox')/messages"),
      expirationDateTime: new Date(
        Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000
      ).toISOString(),
      clientState,
    })
  );
}

async function renewSubscription(subscriptionId, expirationDateTime) {
  return withTokenRetry(() =>
    getClient()
      .api(`/subscriptions/${subscriptionId}`)
      .patch({ expirationDateTime })
  );
}

async function deleteSubscription(subscriptionId) {
  return withTokenRetry(() =>
    getClient().api(`/subscriptions/${subscriptionId}`).delete()
  );
}

const graphOps = {
  getMessage,
  listUnreadMessages,
  listAttachments,
  getMailboxProfile,
  markAsRead,
  sendMail,
  sendBroadcastMail,
  hasBroadcastTarget: () => Boolean(graphConfig.broadcastDl),
  createSubscription,
  renewSubscription,
  deleteSubscription,
};

module.exports = { graphOps, getClient };
