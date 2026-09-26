// Groq-backed email relevance triage.
//
// This service is deliberately separate from the category classifier. It only
// decides whether a new inbound message is safe to suppress from ticket
// creation. Category, priority, routing, assignment, SLA and notifications stay
// in the existing deterministic pipeline.
//
// Failure policy: every provider, validation, configuration or persistence
// failure returns TICKET_CANDIDATE. A bad model call may create an extra ticket;
// it may never silently remove one.

const prisma = require('../lib/prisma');
const settingsService = require('./settingsService');
const {
  TRIAGE_MODES,
  DEFAULT_SKIP_REASON_CODES,
  DEFAULT_SKIP_THRESHOLD,
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserPrompt,
  canAutoSkip,
  extractJson,
  normalizeThreshold,
  parseSenderEntries,
  parseSkipReasonCodes,
  validateTriageResponse,
} = require('./emailTriagePolicy');

const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BODY_CHARS = 12000;
const DEFAULT_MAX_OUTPUT_TOKENS = 260;
const MAX_REASON_CODE_LENGTH = 80;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const PROVIDER_RETRY_DELAY_MS = 250;

const circuit = {
  consecutiveFailures: 0,
  openUntil: 0,
  lastFailureAt: null,
  lastErrorCode: null,
};

class TriageProviderError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TriageProviderError';
    this.code = code;
  }
}

function envInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function envBool(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function getRuntimeConfig() {
  return {
    apiKey: String(process.env.GROQ_API_KEY || '').trim(),
    model: String(process.env.GROQ_TRIAGE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    baseUrl: String(process.env.GROQ_TRIAGE_BASE_URL || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    timeoutMs: envInt('GROQ_TRIAGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 15000),
    maxBodyChars: envInt('GROQ_TRIAGE_MAX_BODY_CHARS', DEFAULT_MAX_BODY_CHARS, 1000, 50000),
    maxOutputTokens: envInt('GROQ_TRIAGE_MAX_OUTPUT_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS, 100, 1000),
    promptVersion: String(process.env.GROQ_TRIAGE_PROMPT_VERSION || PROMPT_VERSION).trim() || PROMPT_VERSION,
    // This is an environment-level emergency stop. The admin setting can be
    // changed at runtime, but this flag cannot be overridden by the UI.
    hardKillSwitch: envBool('INTAKE_TRIAGE_KILL_SWITCH', false),
  };
}

function messageKey(message = {}) {
  return String(message.internetMessageId || message.messageId || '').trim();
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return TRIAGE_MODES.includes(mode) ? mode : 'disabled';
}

async function getSettings(client = prisma) {
  const values = await settingsService.getAll(client, 'intake');
  const requestedCodes = parseSkipReasonCodes(values.intakeRelevanceSkipReasonCodes);
  return {
    mode: normalizeMode(values.intakeRelevanceMode),
    threshold: normalizeThreshold(values.intakeRelevanceSkipThreshold || DEFAULT_SKIP_THRESHOLD),
    requireApprovedSender: Number(values.intakeRelevanceRequireApprovedSender) === 1,
    approvedSenders: parseSenderEntries(values.intakeRelevanceApprovedSenders),
    skipReasonCodes: requestedCodes.length ? requestedCodes : [...DEFAULT_SKIP_REASON_CODES],
  };
}

function decisionAction(action) {
  return action === 'skipped_non_ticket' ? 'skipped_non_ticket' : 'ticket_candidate';
}

function safeReasonCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return code && code.length <= MAX_REASON_CODE_LENGTH && /^[a-z0-9_-]+$/.test(code) ? code : null;
}

function sanitizeConfig(config) {
  return {
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxBodyChars: config.maxBodyChars,
    maxOutputTokens: config.maxOutputTokens,
    promptVersion: config.promptVersion,
    keyConfigured: Boolean(config.apiKey),
    hardKillSwitch: config.hardKillSwitch,
  };
}

function circuitSnapshot() {
  return {
    open: Date.now() < circuit.openUntil,
    consecutiveFailures: circuit.consecutiveFailures,
    openUntil: circuit.openUntil ? new Date(circuit.openUntil).toISOString() : null,
    lastFailureAt: circuit.lastFailureAt,
    lastErrorCode: circuit.lastErrorCode,
  };
}

function recordCircuitFailure(code) {
  circuit.consecutiveFailures += 1;
  circuit.lastFailureAt = new Date().toISOString();
  circuit.lastErrorCode = code || 'provider_error';
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

function recordCircuitSuccess() {
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
}

function isTransientProviderCode(code) {
  return ['timeout', 'rate_limited', 'provider_5xx', 'network_error'].includes(code);
}

async function callProviderWithRetry(args) {
  if (Date.now() < circuit.openUntil) throw new TriageProviderError('circuit_open');
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await requestGroq(args);
      recordCircuitSuccess();
      return result;
    } catch (err) {
      const code = err instanceof TriageProviderError ? err.code : 'provider_error';
      lastError = err;
      recordCircuitFailure(code);
      if (attempt === 1 || !isTransientProviderCode(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

async function requestGroq({ subject, body, config, fetchImpl = fetch }) {
  if (!config.apiKey) throw new TriageProviderError('missing_api_key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt({ subject, body, maxBodyChars: config.maxBodyChars }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) throw new TriageProviderError('rate_limited', `HTTP ${response.status}`);
      if (response.status >= 500) throw new TriageProviderError('provider_5xx', `HTTP ${response.status}`);
      throw new TriageProviderError('provider_http_error', `HTTP ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TriageProviderError('invalid_provider_json');
    }
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new TriageProviderError('empty_provider_response');
    const parsed = extractJson(text);
    if (!parsed) throw new TriageProviderError('invalid_triage_json');
    const checked = validateTriageResponse(parsed);
    if (!checked.ok) throw new TriageProviderError('invalid_triage_schema');
    return { value: checked.value, latencyMs: Date.now() - started };
  } catch (err) {
    if (controller.signal.aborted) throw new TriageProviderError('timeout');
    if (err instanceof TriageProviderError) throw err;
    // Never return or log provider exception text: it may contain a response
    // body or other data that the decision log is not allowed to retain.
    throw new TriageProviderError('network_error');
  } finally {
    clearTimeout(timer);
  }
}

async function findDecision(key, client) {
  if (!key || !client.emailTriageDecision || typeof client.emailTriageDecision.findUnique !== 'function') return null;
  return client.emailTriageDecision.findUnique({ where: { messageKey: key } });
}

async function persistDecision(data, client, logger = console) {
  if (!client.emailTriageDecision || typeof client.emailTriageDecision.create !== 'function') {
    logger.warn('[triage] decision table unavailable — failing open');
    return null;
  }
  try {
    return await client.emailTriageDecision.create({ data });
  } catch (err) {
    // A replay can race the first write. The unique message identity makes the
    // existing row authoritative and avoids a second provider call.
    if (err && err.code === 'P2002') {
      try {
        return await client.emailTriageDecision.findUnique({ where: { messageKey: data.messageKey } });
      } catch {
        return null;
      }
    }
    logger.warn('[triage] decision could not be persisted — failing open');
    return null;
  }
}

function rowToResult(row) {
  if (!row) return null;
  return {
    action: decisionAction(row.action),
    disposition: row.disposition || 'error',
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    reasonCode: row.reasonCode || row.errorCode || null,
    policyCode: row.policyCode || null,
    latencyMs: typeof row.latencyMs === 'number' ? row.latencyMs : null,
    provider: row.provider || null,
    model: row.model || null,
    promptVersion: row.promptVersion || null,
    errorCode: row.errorCode || null,
    persisted: true,
  };
}

/**
 * Make one relevance decision for a normalized, new-ticket candidate.
 * `action` is the only value intake uses: skipped_non_ticket or
 * ticket_candidate. The model disposition is retained for audit/monitoring.
 */
async function screenMessage(message, options = {}) {
  const client = options.client || prisma;
  const logger = options.logger || console;
  const config = options.config || getRuntimeConfig();
  const key = messageKey(message);
  const base = {
    action: 'ticket_candidate',
    disposition: null,
    confidence: null,
    reasonCode: null,
    policyCode: null,
    latencyMs: null,
    provider: 'groq',
    model: config.model,
    promptVersion: config.promptVersion,
    errorCode: null,
    persisted: false,
  };

  if (!key) return { ...base, errorCode: 'missing_message_identity' };
  if (config.hardKillSwitch) return { ...base, errorCode: 'hard_kill_switch' };

  let settings;
  try {
    settings = options.settings || await getSettings(client);
  } catch {
    logger.warn('[triage] settings unavailable — failing open');
    return { ...base, errorCode: 'settings_unavailable' };
  }
  if (settings.mode !== 'auto_skip') {
    return { ...base, errorCode: settings.mode === 'shadow' ? 'shadow_mode' : 'disabled' };
  }

  let existing;
  try {
    existing = await findDecision(key, client);
  } catch {
    logger.warn('[triage] existing decision lookup failed — failing open');
    return { ...base, errorCode: 'decision_read_failed' };
  }
  if (existing) return rowToResult(existing) || { ...base, errorCode: 'decision_read_failed' };

  if (!config.apiKey) {
    const result = {
      ...base,
      disposition: 'error',
      errorCode: 'missing_api_key',
      policyCode: 'provider_unavailable',
    };
    const saved = await persistDecision(
      {
        messageKey: key,
        channel: options.channel || null,
        provider: 'groq',
        model: config.model,
        promptVersion: config.promptVersion,
        disposition: 'error',
        action: 'ticket_candidate',
        confidence: null,
        reasonCode: null,
        policyCode: 'provider_unavailable',
        latencyMs: 0,
        errorCode: 'missing_api_key',
      },
      client,
      logger,
    );
    return saved ? rowToResult(saved) : result;
  }

  const started = Date.now();
  let providerResult;
  try {
    providerResult = await callProviderWithRetry({
      subject: message.subject,
      body: message.cleanBody || message.body || '',
      config,
      fetchImpl: options.fetchImpl || fetch,
    });
  } catch (err) {
    const errorCode = err instanceof TriageProviderError ? err.code : 'provider_error';
    const result = {
      ...base,
      disposition: 'error',
      errorCode,
      policyCode: 'provider_failure',
      latencyMs: Date.now() - started,
    };
    const saved = await persistDecision(
      {
        messageKey: key,
        channel: options.channel || null,
        provider: 'groq',
        model: config.model,
        promptVersion: config.promptVersion,
        disposition: 'error',
        action: 'ticket_candidate',
        confidence: null,
        reasonCode: null,
        policyCode: 'provider_failure',
        latencyMs: result.latencyMs,
        errorCode,
      },
      client,
      logger,
    );
    return saved ? rowToResult(saved) : result;
  }

  const value = providerResult.value;
  const policy = settings.mode === 'auto_skip'
    ? canAutoSkip({
      disposition: value.disposition,
      confidence: value.confidence,
      reasonCode: value.reasonCode,
      senderEmail: message.requesterEmail,
      subject: message.subject,
      body: message.cleanBody || message.body || '',
      approvedSenders: settings.approvedSenders,
      requireApprovedSender: settings.requireApprovedSender,
      allowedReasonCodes: settings.skipReasonCodes,
      threshold: settings.threshold,
      hasAttachments: Boolean(options.hasAttachments),
    })
    : { allowed: false, policyCode: 'shadow_mode' };

  const action = settings.mode === 'auto_skip' && policy.allowed
    ? 'skipped_non_ticket'
    : 'ticket_candidate';
  const result = {
    ...base,
    action,
    disposition: value.disposition,
    confidence: value.confidence,
    reasonCode: safeReasonCode(value.reasonCode),
    policyCode: policy.policyCode,
    latencyMs: providerResult.latencyMs,
    persisted: false,
  };
  const saved = await persistDecision(
    {
      messageKey: key,
      channel: options.channel || null,
      provider: 'groq',
      model: config.model,
      promptVersion: config.promptVersion,
      disposition: value.disposition,
      action,
      confidence: value.confidence,
      reasonCode: safeReasonCode(value.reasonCode),
      policyCode: policy.policyCode,
      latencyMs: providerResult.latencyMs,
      errorCode: null,
    },
    client,
    logger,
  );

  if (!saved && action === 'skipped_non_ticket') {
    // A decision that cannot be audited must never suppress a ticket.
    return { ...result, action: 'ticket_candidate', policyCode: 'decision_log_failed' };
  }
  return saved ? { ...rowToResult(saved), policyCode: result.policyCode } : result;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarize(rows, now = Date.now()) {
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const recent = rows.filter((row) => new Date(row.createdAt).getTime() >= dayAgo.getTime());
  const latencies = rows.map((row) => row.latencyMs).filter((value) => Number.isFinite(value));
  const errors = rows.filter((row) => row.errorCode).length;
  const skipped = rows.filter((row) => row.action === 'skipped_non_ticket').length;
  const ticket = rows.filter((row) => row.action === 'ticket_candidate').length;
  const review = rows.filter((row) => row.disposition === 'review').length;
  return {
    total: rows.length,
    last24h: recent.length,
    skipped,
    ticketCandidates: ticket,
    reviews: review,
    errors,
    skipRate: rows.length ? Math.round((skipped / rows.length) * 1000) / 10 : 0,
    errorRate: rows.length ? Math.round((errors / rows.length) * 1000) / 10 : 0,
    averageLatencyMs: latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null,
    p95LatencyMs: percentile(latencies, 0.95),
    lastDecisionAt: rows[0]?.createdAt || null,
    lastErrorCode: rows.find((row) => row.errorCode)?.errorCode || null,
  };
}

async function getManagementSnapshot(client = prisma) {
  const config = getRuntimeConfig();
  const settings = await getSettings(client);
  const rows = client.emailTriageDecision && typeof client.emailTriageDecision.findMany === 'function'
    ? await client.emailTriageDecision.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        messageKey: true,
        channel: true,
        provider: true,
        model: true,
        promptVersion: true,
        disposition: true,
        action: true,
        confidence: true,
        reasonCode: true,
        policyCode: true,
        latencyMs: true,
        errorCode: true,
        createdAt: true,
      },
    })
    : [];

  return {
    settings: {
      mode: settings.mode,
      threshold: settings.threshold,
      requireApprovedSender: settings.requireApprovedSender,
      approvedSenders: settings.approvedSenders,
      skipReasonCodes: settings.skipReasonCodes,
    },
    runtime: { ...sanitizeConfig(config), circuit: circuitSnapshot() },
    metrics: summarize(rows),
    recentDecisions: rows.slice(0, 50),
  };
}

/** Safe synthetic provider check for the admin screen; never uses real mail. */
async function testProvider(options = {}) {
  const config = options.config || getRuntimeConfig();
  if (config.hardKillSwitch) return { ok: false, errorCode: 'hard_kill_switch', model: config.model };
  if (!config.apiKey) return { ok: false, errorCode: 'missing_api_key', model: config.model };
  const started = Date.now();
  try {
    const result = await callProviderWithRetry({
      subject: 'Synthetic provider check',
      body: 'This is a synthetic test message with no user data. It is informational and requests no action.',
      config,
      fetchImpl: options.fetchImpl || fetch,
    });
    return {
      ok: true,
      model: config.model,
      latencyMs: result.latencyMs || Date.now() - started,
      disposition: result.value.disposition,
      confidence: result.value.confidence,
    };
  } catch (err) {
    return {
      ok: false,
      model: config.model,
      latencyMs: Date.now() - started,
      errorCode: err instanceof TriageProviderError ? err.code : 'provider_error',
    };
  }
}

module.exports = {
  TriageProviderError,
  getRuntimeConfig,
  getSettings,
  messageKey,
  requestGroq,
  screenMessage,
  getManagementSnapshot,
  testProvider,
  summarize,
  // Exported for focused no-network tests.
  normalizeMode,
  rowToResult,
  _resetCircuit() {
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
    circuit.lastFailureAt = null;
    circuit.lastErrorCode = null;
  },
};
