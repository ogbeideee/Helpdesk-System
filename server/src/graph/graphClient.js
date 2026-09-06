const { Client } = require('@microsoft/microsoft-graph-client');
const { graphConfig } = require('./config');
const { getAccessToken } = require('./msalToken');

let client = null;
let clientFactory = null; // test hook — inject a fake SDK client

function getClient() {
  if (!client) {
    if (clientFactory) {
      client = clientFactory();
    } else {
      client = Client.init({
        defaultVersion: 'v1.0',
        authProvider: (done) => {
          getAccessToken()
            .then((token) => done(null, token))
            .catch((err) => done(err, null));
        },
      });
    }
  }
  return client;
}

/* ---- resilience ------------------------------------------------------- */
//
// One wrapper around every Graph call:
//   401            -> refresh the access token once, replay the request
//   429/502/503/504 -> transient; wait (Retry-After when Graph says so, an
//                     exponential backoff otherwise) and retry a bounded
//                     number of times
// A 429 means Graph rejected the request before processing it, and a gateway
// 502/503/504 that the request was not carried out — replaying is safe for
// reads AND for sends, so throttling never turns into a lost or duplicated
// message. Anything else (4xx, 500, network shape errors) surfaces to the
// caller, where the poller/webhook/pipeline decide what it means.

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const MAX_TRANSIENT_ATTEMPTS = 4;
const TRANSIENT_BASE_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 60000;

// Injectable so tests never actually wait.
let sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(err) {
  const headers = err && err.headers;
  if (!headers) return null;
  let raw = null;
  if (typeof headers.get === 'function') raw = headers.get('retry-after');
  else if (headers instanceof Map) raw = headers.get('retry-after');
  else if (typeof headers === 'object') raw = headers['retry-after'] !== undefined ? headers['retry-after'] : headers['Retry-After'];
  if (raw == null) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

async function withResilience(requestFn) {
  let refreshed = false;
  let attempt = 0;
  for (;;) {
    try {
      return await requestFn();
    } catch (err) {
      if (!refreshed && err && (err.statusCode === 401 || err.code === 'InvalidAuthenticationToken')) {
        refreshed = true;
        await getAccessToken({ forceRefresh: true });
        continue;
      }
      if (!err || !TRANSIENT_STATUS.has(err.statusCode)) throw err;
      attempt += 1;
      if (attempt >= MAX_TRANSIENT_ATTEMPTS) throw err;
      const fromHeader = retryAfterMs(err);
      const delay = fromHeader != null ? fromHeader : TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleepFn(delay);
    }
  }
}

function mailboxPath(suffix = '') {
  return `/users/${encodeURIComponent(graphConfig.sharedMailbox)}${suffix}`;
}

const MESSAGE_FIELDS =
  'id,subject,bodyPreview,body,from,conversationId,receivedDateTime,isRead,webLink,hasAttachments';

async function getMessage(messageId) {
  return withResilience(() =>
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
 * Graph pages large result sets: a response carries an @odata.nextLink when
 * more pages match the query. Pages are followed until the caller's budget
 * (`top`) is met, the result set ends, or a bounded page cap is hit — a huge
 * backlog can never turn one poll into an unbounded loop.
 *
 * @param {number} top   maximum messages to return
 * @param {{ since?: Date|string|null }} [options]
 */
const PAGE_SIZE_CAP = 50;
const MAX_PAGES = 10;

async function listUnreadMessages(top = 25, options = {}) {
  const budget = Math.max(1, Number(top) || 25);
  const pageSize = Math.min(budget, PAGE_SIZE_CAP);

  const filters = ['isRead eq false'];
  if (options.since) {
    const since =
      options.since instanceof Date ? options.since : new Date(options.since);
    if (!Number.isNaN(since.getTime())) {
      filters.push(`receivedDateTime ge ${since.toISOString()}`);
    }
  }

  const collected = [];
  let request = getClient()
    .api(mailboxPath("/mailFolders('inbox')/messages"))
    .filter(filters.join(' and '))
    .orderby('receivedDateTime desc')
    .top(pageSize)
    .select(MESSAGE_FIELDS);

  for (let page = 0; page < MAX_PAGES && collected.length < budget; page += 1) {
    const res = await withResilience(() => request.get());
    const value = Array.isArray(res && res.value) ? res.value : [];
    collected.push(...value);
    const nextLink = res && res['@odata.nextLink'];
    if (!nextLink) break;
    // The nextLink URL already encodes filter, order and page size — fetched
    // verbatim, without re-applying query options.
    request = getClient().api(nextLink);
  }
  return collected.slice(0, budget);
}

/**
 * Attachment metadata for one message.
 * Only the metadata fields are selected — content bytes are never requested,
 * because attachment storage is a separate, later decision.
 */
async function listAttachments(messageId) {
  const res = await withResilience(() =>
    getClient()
      .api(mailboxPath(`/messages/${encodeURIComponent(messageId)}/attachments`))
      .select('id,name,contentType,size,isInline')
      .get()
  );
  return res.value || [];
}

/**
 * Fetch ONE attachment's binary content (a fileAttachment's contentBytes,
 * base64-decoded). Attachments too large for inline content come back from
 * Graph as a reference, not bytes — callers treat the thrown
 * CONTENT_UNAVAILABLE as a safe per-attachment rejection, never as a mailbox
 * failure.
 */
async function getAttachmentContent(messageId, attachmentId) {
  const res = await withResilience(() =>
    getClient()
      .api(
        mailboxPath(
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
        )
      )
      .get()
  );
  if (res && typeof res.contentBytes === 'string' && res.contentBytes) {
    return Buffer.from(res.contentBytes, 'base64');
  }
  const err = new Error('attachment content unavailable (not a file attachment or too large for inline content)');
  err.code = 'CONTENT_UNAVAILABLE';
  throw err;
}

/**
 * Confirm the shared mailbox is reachable with the current credentials.
 * Returns identifying detail only — never a token or secret.
 */
async function getMailboxProfile() {
  const res = await withResilience(() =>
    getClient().api(mailboxPath()).select('id,displayName,mail,userPrincipalName').get()
  );
  return {
    id: res.id || null,
    displayName: res.displayName || null,
    mail: res.mail || res.userPrincipalName || null,
  };
}

async function markAsRead(messageId) {
  return withResilience(() =>
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
  return withResilience(() =>
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
  return withResilience(() =>
    getClient().api(mailboxPath('/sendMail')).post({
      message,
      saveToSentItems: true,
    })
  );
}

const MAX_SUBSCRIPTION_MINUTES = 4230;

async function createSubscription({ notificationUrl, clientState }) {
  return withResilience(() =>
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
  return withResilience(() =>
    getClient()
      .api(`/subscriptions/${subscriptionId}`)
      .patch({ expirationDateTime })
  );
}

async function deleteSubscription(subscriptionId) {
  return withResilience(() =>
    getClient().api(`/subscriptions/${subscriptionId}`).delete()
  );
}

const graphOps = {
  getMessage,
  listUnreadMessages,
  listAttachments,
  getAttachmentContent,
  getMailboxProfile,
  markAsRead,
  sendMail,
  sendBroadcastMail,
  hasBroadcastTarget: () => Boolean(graphConfig.broadcastDl),
  createSubscription,
  renewSubscription,
  deleteSubscription,
};

module.exports = {
  graphOps,
  getClient,
  // test hooks
  _injectClientFactory,
  _injectSleep,
  _resetForTests,
};

/* ---- test hooks (not used in production paths) ----------------------- */
function _injectClientFactory(factory) {
  clientFactory = factory;
  client = null;
}
function _injectSleep(fn) {
  sleepFn = fn;
}
function _resetForTests() {
  client = null;
  clientFactory = null;
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}
