/* Benchmark runner: every provider x every case, with per-case isolation.
 *
 * One failed call (timeout, HTTP error, malformed output) fails that single
 * case for that provider — the benchmark itself never aborts. Nothing is
 * persisted: prompts, bodies and responses live in memory for the duration
 * of the run and leave through the terminal report only. */
const { SYSTEM_INSTRUCTIONS, buildUserPrompt } = require('./prompt');
const { extractJson, validateStructured, scoreCase, tallyResults } = require('./scoring');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Rate limits (HTTP 429) and transient 5xxs are benchmarking artifacts, not
 * model quality — retry them with backoff instead of recording a failure.
 * The wait honors the provider's own "try again in Xms/s" hint when present,
 * capped at 30 s. Latency stays the full wall-clock time including retries,
 * so a provider that needed retries cannot hide that fact. */
const RETRYABLE_ERROR = /\bHTTP 429\b|\bHTTP 5\d\d\b/;
const RETRY_HINT = /try again in ([\d.]+)\s*(ms|s)/i;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;

async function classifyWithRetry(provider, context) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await provider.classify(context);
    } catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      if (attempt === MAX_ATTEMPTS || !RETRYABLE_ERROR.test(msg)) throw err;
      const hint = RETRY_HINT.exec(msg);
      const waitMs = hint
        ? Math.ceil(parseFloat(hint[1]) * (hint[2] === 's' ? 1000 : 1)) + 250
        : attempt * 2000;
      await sleep(Math.min(waitMs, MAX_BACKOFF_MS));
    }
  }
  throw lastErr;
}

/**
 * Run all cases against all providers sequentially.
 *
 * @param {object} opts
 *   cases     the frozen case list (same array for every provider)
 *   providers [{ id, label, model, remote, classify(ctx) }]
 *   paceMs    pause between calls for remote providers (rate-limit
 *             courtesy); local providers are never delayed
 *   onCase    optional progress callback (providerId, caseId, latencyMs)
 * @returns per-provider results + tallies, ready for formatReport
 */
async function runBenchmark({ cases, providers, paceMs = 0, onCase = null }) {
  const perProvider = [];
  for (const provider of providers) {
    const results = [];
    for (const testCase of cases) {
      const context = {
        system: SYSTEM_INSTRUCTIONS,
        user: buildUserPrompt(testCase),
        subject: testCase.subject,
        cleanBody: testCase.cleanBody,
        testCase,
      };
      const outcome = { valid: false, value: null, error: null, problems: [] };
      const startedAt = Date.now();
      try {
        const raw = await classifyWithRetry(provider, context);
        if (raw && raw.value) {
          // Pre-normalized provider (keyword baseline): no JSON stage. The
          // value still has to sit in the app's value space to count.
          const v = raw.value;
          outcome.valid =
            typeof v.category === 'string' && typeof v.priority === 'string';
          outcome.value = v;
        } else {
          const parsed = extractJson(raw && raw.text);
          if (parsed === null) {
            outcome.problems = ['response contained no parseable JSON object'];
          } else {
            const checked = validateStructured(parsed);
            outcome.problems = checked.problems;
            if (checked.ok) {
              outcome.valid = true;
              outcome.value = checked.value;
            }
          }
        }
      } catch (err) {
        // Transport/timeout/HTTP failure: this case fails, the run continues.
        outcome.error = err.message || String(err);
      }
      const latencyMs = Date.now() - startedAt;
      const score = scoreCase(testCase, outcome);
      results.push({ case: testCase, outcome, score, latencyMs });
      if (onCase) onCase(provider.id, testCase.id, latencyMs, outcome);
      if (provider.remote && paceMs > 0) await sleep(paceMs);
    }
    perProvider.push({
      id: provider.id,
      label: provider.label,
      model: provider.model,
      remote: provider.remote,
      results,
      tally: tallyResults(results),
    });
  }
  return { ranAt: new Date().toISOString(), providers: perProvider };
}

module.exports = { runBenchmark };
