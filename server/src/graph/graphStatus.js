// In-memory operational status for the Microsoft Graph integration.
//
// Purely observational: nothing here influences ingestion behaviour. Both the
// poller and the webhook record into the same counters so administrators can
// tell which mechanism is actually delivering mail.
//
// Never holds secrets — no tokens, no client secret, no clientState.

const status = {
  pollingRunning: false,
  lastPollAt: null,
  lastPollSummary: null,
  lastWebhookNotificationAt: null,
  webhookNotificationsReceived: 0,
  webhookMessagesProcessed: 0,
  // "successful" = a message reached a definitive intake outcome.
  lastSuccessAt: null,
  lastSuccessSource: null,
  lastSuccessMessageId: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function recordPollingStarted() {
  status.pollingRunning = true;
}

function recordPollingStopped() {
  status.pollingRunning = false;
}

function recordPollCycle(summary) {
  status.lastPollAt = nowIso();
  status.lastPollSummary = summary || null;
}

function recordWebhookNotification(count = 1) {
  status.lastWebhookNotificationAt = nowIso();
  status.webhookNotificationsReceived += count;
}

/** A message was carried all the way to a definitive outcome. */
function recordProcessingSuccess({ source, messageId, outcome }) {
  status.lastSuccessAt = nowIso();
  status.lastSuccessSource = source || null;
  status.lastSuccessMessageId = messageId || null;
  status.lastSuccessOutcome = outcome || null;
  if (source === 'webhook') status.webhookMessagesProcessed += 1;
}

function recordError(source, err) {
  status.lastError = {
    at: nowIso(),
    source: source || 'graph',
    message: err && err.message ? String(err.message) : String(err),
  };
}

function snapshot() {
  return { ...status };
}

/* ---- test hook ------------------------------------------------------ */
function _reset() {
  status.pollingRunning = false;
  status.lastPollAt = null;
  status.lastPollSummary = null;
  status.lastWebhookNotificationAt = null;
  status.webhookNotificationsReceived = 0;
  status.webhookMessagesProcessed = 0;
  status.lastSuccessAt = null;
  status.lastSuccessSource = null;
  status.lastSuccessMessageId = null;
  status.lastSuccessOutcome = null;
  status.lastError = null;
}

module.exports = {
  recordPollingStarted,
  recordPollingStopped,
  recordPollCycle,
  recordWebhookNotification,
  recordProcessingSuccess,
  recordError,
  snapshot,
  _reset,
};
