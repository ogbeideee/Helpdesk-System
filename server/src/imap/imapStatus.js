// In-memory operational status for the IMAP integration — the counterpart of
// graph/graphStatus.js. Purely observational; never holds credentials.
const status = {
  pollingRunning: false,
  lastPollAt: null,
  lastPollSummary: null,
  lastSuccessAt: null,
  lastSuccessMessageId: null,
  lastSuccessOutcome: null,
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

/** A message reached a definitive intake outcome. */
function recordProcessingSuccess({ messageId, outcome }) {
  status.lastSuccessAt = nowIso();
  status.lastSuccessMessageId = messageId || null;
  status.lastSuccessOutcome = outcome || null;
}

function recordError(source, err) {
  status.lastError = {
    at: nowIso(),
    source: source || 'imap',
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
  status.lastSuccessAt = null;
  status.lastSuccessMessageId = null;
  status.lastSuccessOutcome = null;
  status.lastError = null;
}

module.exports = {
  recordPollingStarted,
  recordPollingStopped,
  recordPollCycle,
  recordProcessingSuccess,
  recordError,
  snapshot,
  _reset,
};
