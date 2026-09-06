/* Pure view-model for the Microsoft 365 admin page — no React, no DOM, so the
   m365-check.mjs harness can exercise every rule the page renders. The server
   payload never contains secrets; these helpers only re-shape what is shown. */

export const STATE_VIEWS = {
  not_configured: {
    tone: 'info',
    title: 'Not configured',
    body: 'The Microsoft 365 environment values are not set. The application runs normally — Microsoft 365 ingestion is simply off, and IMAP ingestion and every other feature are unaffected.',
  },
  disabled: {
    tone: 'info',
    title: 'Configured but disabled',
    body: 'The Entra app values are present, but GRAPH_ENABLED=false is switching the integration off. Set GRAPH_ENABLED=true and restart the server to activate it.',
  },
  enabled: {
    tone: 'ok',
    title: 'Enabled',
    body: 'Microsoft 365 mail flows into the shared ticket pipeline — parsing, keyword rules, threading, deduplication and attachments are all shared with IMAP.',
  },
  error: {
    tone: 'warn',
    title: 'Enabled — integration error',
    body: 'The integration is on, but its most recent background operation failed. Polling retries by itself and a success clears this state; the error is shown under Runtime.',
  },
};

/**
 * The state the page should present. An "enabled" integration that has errored
 * more recently than its last success is shown as an integration error, so a
 * stale failure from long ago never cries wolf over a healthy pipeline.
 */
export function displayState(payload) {
  if (!payload || typeof payload !== 'object') return 'not_configured';
  if (payload.state === 'enabled') {
    const runtime = payload.runtime || {};
    const errAt = runtime.lastError ? Date.parse(runtime.lastError.at || '') : null;
    const okAt =
      runtime.lastSuccessfulProcessing && runtime.lastSuccessfulProcessing.at
        ? Date.parse(runtime.lastSuccessfulProcessing.at)
        : null;
    if (errAt != null && !Number.isNaN(errAt) && !(okAt != null && !Number.isNaN(okAt) && okAt > errAt)) {
      return 'error';
    }
    return 'enabled';
  }
  return payload.state || 'not_configured';
}

export function stateView(payload) {
  return STATE_VIEWS[displayState(payload)] || STATE_VIEWS.not_configured;
}

/** Required environment values, annotated with validation findings. */
export function checklistRows(payload) {
  if (!payload) return [];
  const invalid = new Map(
    ((payload.validation && payload.validation.invalid) || []).map((i) => [i.variable, i.reason])
  );
  return (payload.requiredConfiguration || []).map((item) => ({
    variable: item.variable,
    label: item.label,
    secret: Boolean(item.secret),
    present: Boolean(item.present),
    // Secrets render as "set (hidden)" — the value never reaches the client.
    displayValue: item.secret ? (item.present ? 'set (hidden)' : 'not set') : item.present ? 'set' : 'not set',
    problem: invalid.get(item.variable) || null,
  }));
}

export function missingCount(payload) {
  return (payload && payload.validation && payload.validation.missing.length) || 0;
}

function yesNo(v) {
  return v ? 'Yes' : 'No';
}

/** Effective configuration as label/value rows for the page. */
export function configRows(payload) {
  const c = (payload && payload.configuration) || {};
  const guard = c.ingestGuard || {};
  const webhook = c.webhook || {};
  return [
    { label: 'Tenant ID', value: c.tenantId || '—' },
    { label: 'Client ID', value: c.clientId || '—' },
    { label: 'Shared mailbox', value: c.mailbox || '—' },
    { label: 'Poll interval', value: c.pollIntervalSeconds ? `every ${c.pollIntervalSeconds}s` : '—' },
    { label: 'Batch size', value: c.pollBatchSize != null ? String(c.pollBatchSize) : '—' },
    { label: 'Dry run', value: c.dryRun ? 'ON — no tickets will be created' : 'Off' },
    {
      label: 'Ingest guard',
      value: guard.since
        ? `mail since ${guard.since}`
        : guard.maxAgeHours
          ? `mail newer than ${guard.maxAgeHours}h`
          : 'No age limit',
    },
    { label: 'Broadcast distribution list', value: c.broadcastDlSet ? 'Set' : 'Not set (broadcasts skipped)' },
    { label: 'Webhook notifications', value: webhook.enabled ? webhook.notificationUrl || 'Enabled' : 'Off — polling is the ingestion path' },
  ];
}

const SUBSCRIPTION_LABELS = {
  active: 'Active',
  expired: 'Expired',
  'not-subscribed': 'Not subscribed',
  disabled: 'Webhook mode disabled',
  unknown: 'Unknown',
};

export function subscriptionRows(payload) {
  const s = (payload && payload.runtime && payload.runtime.subscription) || {};
  return [
    { label: 'Status', value: SUBSCRIPTION_LABELS[s.status] || s.status || '—' },
    { label: 'Expires', value: s.expirationDateTime ? fmtWhen(s.expirationDateTime) : '—' },
    { label: 'Notification URL', value: s.notificationUrl || '—' },
    { label: 'Last renewed', value: s.lastRenewedAt ? fmtWhen(s.lastRenewedAt) : '—' },
  ];
}

export function runtimeRows(payload) {
  const r = (payload && payload.runtime) || {};
  const polling = r.polling || {};
  const webhook = r.webhook || {};
  const success = r.lastSuccessfulProcessing;
  return [
    { label: 'Polling', value: polling.running ? `Running (every ${polling.intervalSeconds}s)` : 'Not running' },
    { label: 'Last poll', value: polling.lastPollAt ? fmtWhen(polling.lastPollAt) : 'Never' },
    {
      label: 'Last successful message',
      value: success ? `${fmtWhen(success.at)} (${success.outcome || 'processed'})` : 'None yet',
    },
    { label: 'Webhook notifications', value: `${webhook.notificationsReceived || 0} received · ${webhook.messagesProcessed || 0} processed` },
    { label: 'Last error', value: r.lastError ? `${r.lastError.message} (${fmtWhen(r.lastError.at)})` : 'None' },
  ];
}

/** The verify card's call to action, or why it is unavailable. */
export function verifyAvailability(payload) {
  if (!payload || !payload.configured) {
    return { enabled: false, reason: 'Set the required environment values first — there are no credentials to validate yet.' };
  }
  return { enabled: true, reason: null };
}

/** Renders the POST /verify result. Never shows a token — the API sends none. */
export function verifyResultView(connection) {
  if (!connection) return null;
  if (connection.ok) {
    return {
      ok: true,
      text: `Credentials work — authenticated as the shared mailbox ${connection.mailbox && connection.mailbox.mail ? connection.mailbox.mail : ''} at ${fmtWhen(connection.checkedAt)}.`,
    };
  }
  return { ok: false, text: `Validation failed at ${fmtWhen(connection.checkedAt)}: ${connection.error || 'unknown error'}` };
}

function fmtWhen(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
