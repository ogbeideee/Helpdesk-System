/* Focused email relevance triage tests. No network and no application DB. */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const policy = require('../src/services/emailTriagePolicy');
const triage = require('../src/services/emailTriageService');
const settingsService = require('../src/services/settingsService');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name} :: ${err.message}`);
  }
}

const quiet = { log() {}, warn() {}, error() {} };
const baseMessage = {
  messageId: 'triage-test-1',
  internetMessageId: 'triage-test-1@example',
  requesterEmail: 'hr-announcements@example.com',
  subject: 'Annual HR policy update',
  body: 'The annual policy update is attached for information. No action is required.',
  cleanBody: 'The annual policy update is attached for information. No action is required.',
};

const autoSettings = {
  mode: 'auto_skip',
  threshold: 95,
  requireApprovedSender: true,
  approvedSenders: ['hr-announcements@example.com'],
  skipReasonCodes: [...policy.SAFE_SKIP_REASON_CODES],
};

function providerResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }),
  };
}

function fakeClient() {
  const rows = [];
  return {
    rows,
    emailTriageDecision: {
      async findUnique({ where }) {
        return rows.find((row) => row.messageKey === where.messageKey) || null;
      },
      async create({ data }) {
        const row = { ...data, id: rows.length + 1, createdAt: new Date() };
        rows.push(row);
        return row;
      },
    },
  };
}

async function main() {
  triage._resetCircuit();
  await check('safe informational message may be skipped', () => {
    const result = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: baseMessage.requesterEmail,
      subject: baseMessage.subject,
      body: baseMessage.body,
      approvedSenders: autoSettings.approvedSenders,
      requireApprovedSender: true,
      allowedReasonCodes: autoSettings.skipReasonCodes,
      threshold: 95,
    });
    assert.deepStrictEqual(result, { allowed: true, policyCode: 'safe_skip' });
  });

  await check('explicit request always vetoes a skip', () => {
    const result = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: baseMessage.requesterEmail,
      subject: 'Policy update',
      body: 'Please send me the latest onboarding checklist.',
      approvedSenders: autoSettings.approvedSenders,
      requireApprovedSender: true,
      allowedReasonCodes: autoSettings.skipReasonCodes,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.policyCode, 'action_signal');
  });

  await check('negated no-request wording does not veto a safe skip', () => {
    const result = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: baseMessage.requesterEmail,
      subject: 'Informational announcement',
      body: 'This is for information only; no request is made.',
      approvedSenders: autoSettings.approvedSenders,
      requireApprovedSender: true,
      allowedReasonCodes: autoSettings.skipReasonCodes,
    });
    assert.strictEqual(result.allowed, true);
  });

  await check('any attachment vetoes auto-skip', () => {
    const result = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'informational_announcement',
      senderEmail: baseMessage.requesterEmail,
      subject: 'Informational notice',
      body: 'No request is made.',
      approvedSenders: autoSettings.approvedSenders,
      requireApprovedSender: true,
      allowedReasonCodes: autoSettings.skipReasonCodes,
      hasAttachments: true,
    });
    assert.strictEqual(result.policyCode, 'attachment_present');
  });

  await check('unapproved sender cannot be auto-skipped', () => {
    const result = policy.canAutoSkip({
      disposition: 'skip',
      confidence: 0.99,
      reasonCode: 'newsletter',
      senderEmail: 'unknown@example.com',
      subject: 'Newsletter',
      body: 'Informational newsletter with no request.',
      approvedSenders: autoSettings.approvedSenders,
      requireApprovedSender: true,
      allowedReasonCodes: autoSettings.skipReasonCodes,
    });
    assert.strictEqual(result.policyCode, 'sender_not_allowlisted');
  });

  await check('response schema rejects malformed output', () => {
    const result = policy.validateTriageResponse({
      disposition: 'skip',
      confidence: 'high',
      reasonCode: '',
      reason: '',
      evidence: 'not-an-array',
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.problems.length >= 3);
  });

  await check('settings validate conservative triage controls', () => {
    assert.deepStrictEqual(settingsService.parseValue('intakeRelevanceMode', 'auto_skip'), {
      ok: true,
      value: 'auto_skip',
    });
    assert.strictEqual(settingsService.parseValue('intakeRelevanceMode', 'unsafe').ok, false);
    assert.strictEqual(settingsService.parseValue('intakeRelevanceSkipThreshold', 94).ok, false);
    assert.strictEqual(settingsService.parseValue('intakeRelevanceSkipReasonCodes', 'made_up_code').ok, false);
    assert.strictEqual(settingsService.parseValue('intakeRelevanceApprovedSenders', 'bad entry').ok, false);
  });

  await check('disabled mode makes no provider call', async () => {
    const client = fakeClient();
    let called = false;
    const result = await triage.screenMessage(baseMessage, {
      client,
      settings: { ...autoSettings, mode: 'disabled' },
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => {
        called = true;
        throw new Error('must not call');
      },
      logger: quiet,
    });
    assert.strictEqual(called, false);
    assert.strictEqual(result.action, 'ticket_candidate');
    assert.strictEqual(client.rows.length, 0);
  });

  await check('high-confidence approved skip is persisted without body', async () => {
    const client = fakeClient();
    let requestOptions;
    const result = await triage.screenMessage(baseMessage, {
      client,
      settings: autoSettings,
      config: {
        ...triage.getRuntimeConfig(),
        apiKey: 'test-key',
        model: 'test-model',
        timeoutMs: 1000,
      },
      fetchImpl: async (_url, options) => {
        requestOptions = options;
        return providerResponse({
          disposition: 'skip',
          confidence: 0.98,
          reasonCode: 'informational_announcement',
          reason: 'Informational policy update with no request.',
          evidence: ['No action is required'],
        });
      },
      logger: quiet,
      channel: 'imap',
    });
    assert.strictEqual(result.action, 'skipped_non_ticket');
    assert.strictEqual(client.rows.length, 1);
    assert.strictEqual(client.rows[0].action, 'skipped_non_ticket');
    assert.strictEqual(client.rows[0].channel, 'imap');
    assert.ok(requestOptions.headers.authorization === 'Bearer test-key');
    assert.ok(!JSON.stringify(client.rows[0]).includes(baseMessage.body));
    assert.ok(!JSON.stringify(client.rows[0]).includes(baseMessage.subject));
  });

  await check('transient provider failures retry once', async () => {
    triage._resetCircuit();
    const client = fakeClient();
    let calls = 0;
    const result = await triage.screenMessage({ ...baseMessage, messageId: 'triage-retry', internetMessageId: 'triage-retry@example' }, {
      client,
      settings: autoSettings,
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
        return providerResponse({
          disposition: 'skip', confidence: 0.99, reasonCode: 'newsletter', reason: 'No action.', evidence: [],
        });
      },
      logger: quiet,
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.action, 'skipped_non_ticket');
  });

  await check('provider failure fails open and records a sanitized code', async () => {
    const client = fakeClient();
    const result = await triage.screenMessage({ ...baseMessage, messageId: 'triage-error', internetMessageId: 'triage-error@example' }, {
      client,
      settings: autoSettings,
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => { throw new Error('secret provider response'); },
      logger: quiet,
    });
    assert.strictEqual(result.action, 'ticket_candidate');
    assert.strictEqual(result.errorCode, 'network_error');
    assert.strictEqual(client.rows[0].errorCode, 'network_error');
    assert.ok(!JSON.stringify(client.rows[0]).includes('secret provider response'));
  });

  await check('decision-log failure cannot suppress a ticket', async () => {
    const client = fakeClient();
    client.emailTriageDecision.create = async () => { throw new Error('database unavailable'); };
    const result = await triage.screenMessage({ ...baseMessage, messageId: 'triage-log-failure', internetMessageId: 'triage-log-failure@example' }, {
      client,
      settings: autoSettings,
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => providerResponse({
        disposition: 'skip', confidence: 0.99, reasonCode: 'newsletter', reason: 'No action.', evidence: [],
      }),
      logger: quiet,
    });
    assert.strictEqual(result.action, 'ticket_candidate');
    assert.strictEqual(result.policyCode, 'decision_log_failed');
  });

  await check('shadow mode never honors a prior auto-skip decision', async () => {
    triage._resetCircuit();
    const client = fakeClient();
    client.rows.push({
      messageKey: baseMessage.internetMessageId,
      provider: 'groq', model: 'test-model', promptVersion: 'v1',
      disposition: 'skip', action: 'skipped_non_ticket', confidence: 0.99,
      reasonCode: 'newsletter', policyCode: 'safe_skip', latencyMs: 10,
    });
    const result = await triage.screenMessage(baseMessage, {
      client,
      settings: { ...autoSettings, mode: 'shadow' },
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => { throw new Error('must not call'); },
      logger: quiet,
    });
    assert.strictEqual(result.action, 'ticket_candidate');
    assert.strictEqual(result.errorCode, 'shadow_mode');
  });

  await check('an existing decision prevents a second provider call', async () => {
    const client = fakeClient();
    client.rows.push({
      messageKey: baseMessage.internetMessageId,
      provider: 'groq', model: 'test-model', promptVersion: 'v1',
      disposition: 'skip', action: 'skipped_non_ticket', confidence: 0.99,
      reasonCode: 'newsletter', policyCode: 'safe_skip', latencyMs: 10,
    });
    let called = false;
    const result = await triage.screenMessage(baseMessage, {
      client,
      settings: autoSettings,
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key' },
      fetchImpl: async () => { called = true; throw new Error('must not call'); },
      logger: quiet,
    });
    assert.strictEqual(called, false);
    assert.strictEqual(result.action, 'skipped_non_ticket');
  });

  await check('environment kill switch blocks provider checks too', async () => {
    let called = false;
    const result = await triage.testProvider({
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key', hardKillSwitch: true },
      fetchImpl: async () => { called = true; throw new Error('must not call'); },
    });
    assert.strictEqual(called, false);
    assert.strictEqual(result.errorCode, 'hard_kill_switch');
  });

  await check('synthetic provider test never needs real email data', async () => {
    const result = await triage.testProvider({
      config: { ...triage.getRuntimeConfig(), apiKey: 'test-key', timeoutMs: 1000 },
      fetchImpl: async (_url, options) => {
        assert.ok(!JSON.stringify(options.body).includes(baseMessage.body));
        return providerResponse({
          disposition: 'skip', confidence: 0.99, reasonCode: 'no_action_required', reason: 'Synthetic check.', evidence: [],
        });
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.disposition, 'skip');
  });

  if (failures) {
    console.error(`\n${failures} email triage test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll email triage tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
