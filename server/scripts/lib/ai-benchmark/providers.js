/* Provider adapters for the classification benchmark.
 *
 * The adapter contract (so a new provider never rewrites the benchmark):
 *
 *   provider.id       machine id ('gemini', 'groq', 'keyword', 'mock')
 *   provider.label    human label for the report
 *   provider.model    model identifier actually used (for reproducibility)
 *   provider.remote   true when real network calls happen (drives pacing)
 *   provider.classify(context) -> { text } | { value }
 *     context = { system, user, subject, cleanBody, testCase }
 *     - { text }  raw model output; the runner extracts/validates JSON
 *     - { value } a pre-normalized outcome (the local keyword baseline),
 *                 skipping the JSON stage — it is not a language model
 *     Rejects on transport/timeout/HTTP error; the runner fails that one
 *     case and continues.
 *
 * Security: keys arrive only through the factory arguments (the CLI reads
 * them from environment variables) and travel solely in request headers.
 * Error messages carry the HTTP status and a truncated response body —
 * never the key, never request headers, never the Authorization value.
 * Node 18+ global fetch is used; no SDK is added. */
const { CATEGORIES, PRIORITIES } = require('../../../src/states');
const { classify } = require('../../../src/graph/categoryRules');
const { RESPONSE_FIELDS } = require('./prompt');

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_BENCH_TIMEOUT_MS || 30_000);
const ERROR_BODY_SNIPPET = 300;

function truncate(text, n = ERROR_BODY_SNIPPET) {
  const s = String(text == null ? '' : text);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/* fetch with a hard per-request timeout. `fetchImpl` is injectable so the
 * focused test exercises adapters without any network. */
async function fetchWithTimeout(url, options, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs} ms`);
    }
    throw new Error(`network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorMessage(res, providerLabel) {
  let detail = '';
  try {
    const body = await res.text();
    detail = truncate(body);
  } catch {
    detail = '(unreadable body)';
  }
  return new Error(`${providerLabel} HTTP ${res.status}: ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Google Gemini (2.5 Flash-Lite by default)                           */
/* ------------------------------------------------------------------ */

function makeGeminiProvider({
  apiKey,
  model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
} = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set — export it before running the benchmark');
  // The key goes in the x-goog-api-key header, never in the URL, so a logged
  // URL can never leak it.
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: [...CATEGORIES] },
      priority: { type: 'STRING', enum: [...PRIORITIES] },
      confidence: { type: 'NUMBER' },
      reason: { type: 'STRING' },
      signals: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: [...RESPONSE_FIELDS],
    propertyOrdering: [...RESPONSE_FIELDS],
  };

  return {
    id: 'gemini',
    label: 'Gemini',
    model,
    remote: true,
    async classify({ system, user }) {
      const res = await fetchWithTimeout(
        `${baseUrl}/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema },
          }),
        },
        { fetchImpl, timeoutMs },
      );
      if (!res.ok) throw await readErrorMessage(res, 'Gemini');
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (!text) {
        // Blocked/empty finish — surface the reason Gemini reports.
        const why = candidate?.finishReason || data?.promptFeedback?.blockReason || 'no content returned';
        throw new Error(`Gemini returned no content (${why})`);
      }
      return { text };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Groq + Qwen (OpenAI-compatible chat completions)                    */
/* ------------------------------------------------------------------ */

function makeGroqProvider({
  apiKey,
  model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = 'https://api.groq.com/openai/v1',
} = {}) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set — export it before running the benchmark');
  return {
    id: 'groq',
    label: 'Groq/Qwen',
    model,
    remote: true,
    async classify({ system, user }) {
      const res = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' }, // JSON mode; schema is in the shared instructions
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        },
        { fetchImpl, timeoutMs },
      );
      if (!res.ok) throw await readErrorMessage(res, 'Groq');
      const data = await res.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('Groq returned no content');
      return { text };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local keyword baseline (production classifier, zero cost)           */
/* ------------------------------------------------------------------ */

/* The current production classifier on the same inputs. Not an LLM: it
 * returns a pre-normalized value instead of model text, so the runner skips
 * the JSON stage. Its score is the yardstick any paid provider must beat. */
function makeKeywordBaselineProvider() {
  return {
    id: 'keyword',
    label: 'Keyword baseline (graph/categoryRules.js)',
    model: 'category-rules',
    remote: false,
    async classify({ subject, cleanBody }) {
      const { category, priority } = classify(`${subject}\n${cleanBody}`);
      return {
        value: {
          category,
          priority,
          confidence: null, // rule matching has no confidence to report
          reason: 'keyword rule match (first matching category wins)',
          signals: [],
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Mock provider — exercised by `--mock` and the focused test          */
/* ------------------------------------------------------------------ */

/* Deterministic stand-in so the full pipeline (parse -> validate -> score
 * -> report) runs with zero network. It fabricates a realistic MIXED
 * outcome on purpose: correct for most cases, one trap failure, one
 * invalid-JSON response, one transport error, one priority miss — the
 * report's failure section renders only when such cases exist. */
const MOCK_SCRIPT = {
  C: { shiftCategoryTo: 'Software' }, // falls for a hardware keyword
  T: { shiftPriorityTo: 'moderate' }, // priority miss only
  M: { raw: 'Sure! Here is my classification: {invalid json' },
  L: { error: 'simulated timeout' },
};

function makeMockProvider() {
  return {
    id: 'mock',
    label: 'Mock (no network)',
    model: 'scripted',
    remote: false,
    async classify({ testCase }) {
      const script = MOCK_SCRIPT[testCase.id] || {};
      if (script.error) throw new Error(script.error);
      if (script.raw) return { text: script.raw };
      const value = {
        category: script.shiftCategoryTo || testCase.expected.category,
        priority: script.shiftPriorityTo || testCase.expected.priority || 'moderate',
        confidence: 0.86,
        reason: `mock classification for scenario ${testCase.id}`,
        signals: ['mock'],
      };
      return { text: JSON.stringify(value) };
    },
  };
}

module.exports = {
  makeGeminiProvider,
  makeGroqProvider,
  makeKeywordBaselineProvider,
  makeMockProvider,
  fetchWithTimeout,
  DEFAULT_TIMEOUT_MS,
};
