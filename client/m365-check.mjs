/* Microsoft 365 admin page — pure view-model checks (no React, no DOM).
   The page's every rendered decision (state banner, checklist, rows, verify
   availability) comes from m365View.js; these checks pin that logic. */
import {
  STATE_VIEWS, displayState, stateView, checklistRows, missingCount,
  configRows, subscriptionRows, runtimeRows, verifyAvailability, verifyResultView,
} from './src/m365View.js';

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* --- state derivation ---------------------------------------------------- */
eq('S1 a missing payload reads as not configured', displayState(null), 'not_configured');
eq('S2 an unknown state falls back to not configured', displayState({}), 'not_configured');
eq('S3 a disabled integration stays disabled', displayState({ state: 'disabled' }), 'disabled');
eq('S4 an enabled integration without errors reads enabled', displayState({ state: 'enabled', runtime: {} }), 'enabled');

const errored = {
  state: 'enabled',
  runtime: { lastError: { at: '2026-09-06T12:00:00Z', message: 'boom' } },
};
eq('S5 an enabled integration with an error reads as an integration error', displayState(errored), 'error');

const recovered = {
  state: 'enabled',
  runtime: {
    lastError: { at: '2026-09-06T12:00:00Z' },
    lastSuccessfulProcessing: { at: '2026-09-06T13:00:00Z' },
  },
};
eq('S6 a success after the error clears the error state', displayState(recovered), 'enabled');

const staleError = {
  state: 'enabled',
  runtime: {
    lastError: { at: '2026-09-06T12:00:00Z' },
    lastSuccessfulProcessing: { at: '2026-09-06T11:00:00Z' },
  },
};
eq('S7 an error newer than the last success still shows', displayState(staleError), 'error');

/* --- banner views --------------------------------------------------------- */
eq('V1 the not-configured banner is informational', stateView({ state: 'not_configured' }).tone, 'info');
eq('V2 the disabled banner is informational', stateView({ state: 'disabled' }).tone, 'info');
eq('V3 the enabled banner is positive', stateView({ state: 'enabled', runtime: {} }).tone, 'ok');
eq('V4 the error banner warns', stateView(errored).tone, 'warn');
check('V5 the disabled banner names the GRAPH_ENABLED switch',
  stateView({ state: 'disabled' }).body.includes('GRAPH_ENABLED'));
check('V6 the not-configured banner does not promise ingestion',
  /off/.test(STATE_VIEWS.not_configured.body));
eq('V7 every state has a banner', Object.keys(STATE_VIEWS).length, 4);

/* --- required-configuration checklist ------------------------------------- */
const payload = {
  state: 'enabled',
  configured: true,
  enabled: true,
  explicitlyDisabled: false,
  configuration: {
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    mailbox: 'helpdesk@example.test',
    broadcastDlSet: false,
    pollIntervalSeconds: 120,
    pollBatchSize: 25,
    dryRun: false,
    ingestGuard: { since: null, maxAgeHours: 24 },
    webhook: { enabled: false, notificationUrl: null, clientStateSet: false, renewIntervalSeconds: 1800 },
  },
  requiredConfiguration: [
    { variable: 'GRAPH_TENANT_ID', label: 'Tenant ID (Entra directory)', secret: false, present: true },
    { variable: 'GRAPH_CLIENT_ID', label: 'Application (client) ID', secret: false, present: true },
    { variable: 'GRAPH_CLIENT_SECRET', label: 'Client secret', secret: true, present: true },
    { variable: 'GRAPH_SHARED_MAILBOX', label: 'Shared mailbox address', secret: false, present: true },
  ],
  validation: {
    valid: false,
    missing: [],
    invalid: [{ variable: 'GRAPH_CLIENT_ID', reason: 'must be the application (client) GUID' }],
    warnings: [],
  },
  runtime: {},
};

const rows = checklistRows(payload);
eq('C1 the checklist mirrors the four required values', rows.length, 4);
eq('C2 a set secret reads as hidden, never as a value', rows[2].displayValue, 'set (hidden)');
eq('C3 a set non-secret reads as set', rows[0].displayValue, 'set');
eq('C4 a validation problem is attached to its variable', rows[1].problem, 'must be the application (client) GUID');
check('C5 rows never carry a secret value field', rows.every((r) => !('value' in r)));
eq('C6 no missing values are counted here', missingCount(payload), 0);
eq('C7 missing values are counted for the notice', missingCount({ validation: { missing: ['a', 'b'] } }), 2);
eq('C8 a payload without validation is safe', missingCount({}), 0);

/* --- configuration rows ---------------------------------------------------- */
const cfg = configRows(payload);
eq('F1 the tenant id row is shown', cfg[0].value, '11111111-1111-1111-1111-111111111111');
eq('F2 the poll interval is humanized', cfg[3].value, 'every 120s');
eq('F3 the ingest guard reads as a rolling window', cfg[6].value, 'mail newer than 24h');
check('F4 webhook-off explains the polling fallback', cfg[8].value.includes('polling'));
check('F5 dry-run mode is unmistakable', configRows({ ...payload, configuration: { ...payload.configuration, dryRun: true } })[5].value.includes('ON'));
check('F6 an absolute cutoff wins over the window',
  configRows({ ...payload, configuration: { ...payload.configuration, ingestGuard: { since: '2026-09-01T00:00:00Z', maxAgeHours: 24 } } })[6].value.includes('since'));
check('F7 an empty payload produces placeholder rows',
  configRows(null).every((r) => r.value === '—' || typeof r.value === 'string'));

/* --- subscription + runtime rows ------------------------------------------- */
const sub = subscriptionRows({ runtime: { subscription: { status: 'not-subscribed' } } });
eq('U1 an absent subscription is labeled for humans', sub[0].value, 'Not subscribed');
eq('U2 webhook-off reads as disabled', subscriptionRows({ runtime: { subscription: { status: 'disabled' } } })[0].value, 'Webhook mode disabled');
eq('U3 missing expiry is a placeholder', sub[1].value, '—');

const rt = runtimeRows({
  runtime: {
    polling: { running: true, intervalSeconds: 120, lastPollAt: '2026-09-06T10:00:00Z' },
    webhook: { notificationsReceived: 3, messagesProcessed: 2 },
    lastSuccessfulProcessing: { at: '2026-09-06T10:01:00Z', outcome: 'created' },
    lastError: { at: '2026-09-06T09:00:00Z', message: '503 upstream' },
  },
});
check('R1 running polling shows its cadence', rt[0].value.includes('Running') && rt[0].value.includes('120s'));
check('R2 the last success shows its outcome', rt[2].value.includes('created'));
check('R3 webhook counters are summarized', rt[3].value.includes('3') && rt[3].value.includes('2'));
check('R4 the last error is carried with its time', rt[4].value.includes('503 upstream'));
check('R5 a quiet runtime reads honestly', runtimeRows({ runtime: {} })[0].value === 'Not running');

/* --- verify availability + result ------------------------------------------- */
eq('A1 verify is blocked while unconfigured', verifyAvailability({ state: 'not_configured', configured: false }).enabled, false);
check('A2 the block explains itself', verifyAvailability({ configured: false }).reason.length > 0);
eq('A3 verify is available once configured', verifyAvailability({ configured: true }).enabled, true);
eq('A4 no result yet renders nothing', verifyResultView(null), null);

const okResult = verifyResultView({ ok: true, checkedAt: '2026-09-06T12:00:00Z', mailbox: { mail: 'ithelpdesk@example.test' } });
check('A5 a successful verification names the mailbox', okResult.ok && okResult.text.includes('ithelpdesk@example.test'));
const badResult = verifyResultView({ ok: false, checkedAt: '2026-09-06T12:00:00Z', error: 'AADSTS denied' });
check('A6 a failed verification carries the error', !badResult.ok && badResult.text.includes('AADSTS denied'));
check('A7 a result never contains a token field', !JSON.stringify(okResult).includes('accessToken'));

console.log(passes === 0 || failures > 0 ? `\n${failures} FAILURE(S)` : `\nALL PASS (${passes} checks)`);
process.exit(failures === 0 ? 0 : 1);
