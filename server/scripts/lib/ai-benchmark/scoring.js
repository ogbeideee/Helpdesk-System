/* Parsing, validation and scoring for the classification benchmark.
 *
 * Pure functions, no I/O — this is the part the focused test exercises with
 * mocked provider output. A response passes through three stages:
 *
 *   extractJson        raw model text -> a JS value (or null)
 *   validateStructured value -> { ok, value } against the shared schema
 *   scoreCase          validated outcome vs. the case's expected result
 *
 * Judgement is always against the EXPECTED result, never against the model's
 * self-reported confidence. Confidence is recorded and reported, nothing
 * more. */
const { CATEGORIES, PRIORITIES } = require('../../../src/states');

/* ------------------------------------------------------------------ */
/* JSON extraction                                                     */
/* ------------------------------------------------------------------ */

/**
 * Pull a JSON object out of raw model text. Tolerates the two shapes real
 * models produce despite "JSON only" instructions: markdown fences and a
 * prose preamble/epilogue around the object. Returns the parsed value or
 * null when nothing parseable is there.
 */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let candidate = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Schema validation                                                   */
/* ------------------------------------------------------------------ */

/** Canonical value for `v` within `list` (exact, then case-insensitive). */
function canonicalValue(v, list) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (list.includes(trimmed)) return trimmed;
  const hit = list.find((x) => x.toLowerCase() === trimmed.toLowerCase());
  return hit || null;
}

/**
 * Validate a parsed response against the shared schema. All five logical
 * fields must be present and well-typed; category/priority must be one of
 * the application's values (an invented value is a schema violation, and
 * also scores as a wrong answer downstream). Unknown extra keys are
 * tolerated — harmless additions should not zero the valid-JSON metric.
 *
 * @returns {{ ok: boolean, problems: string[], value: {
 *   category: string, priority: string, confidence: number|null,
 *   reason: string, signals: string[] } | null }}
 */
function validateStructured(parsed, { categories = CATEGORIES, priorities = PRIORITIES } = {}) {
  const fail = (problems) => ({ ok: false, problems, value: null });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(['response is not a JSON object']);
  }
  const problems = [];

  const category = canonicalValue(parsed.category, categories);
  if (!category) problems.push(`category: expected one of [${categories.join(', ')}], got ${JSON.stringify(parsed.category)}`);

  const priority = canonicalValue(parsed.priority, priorities);
  if (!priority) problems.push(`priority: expected one of [${priorities.join(', ')}], got ${JSON.stringify(parsed.priority)}`);

  // Models occasionally stringify the number; accept only clean numerics.
  const rawConf = parsed.confidence;
  const confNum = typeof rawConf === 'number' ? rawConf : typeof rawConf === 'string' && rawConf.trim() !== '' && !Number.isNaN(Number(rawConf)) ? Number(rawConf) : null;
  const confidence = confNum !== null && confNum >= 0 && confNum <= 1 ? confNum : null;
  if (confidence === null) problems.push(`confidence: expected a number 0.0-1.0, got ${JSON.stringify(rawConf)}`);

  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  if (!reason) problems.push(`reason: expected a non-empty string, got ${JSON.stringify(parsed.reason)}`);

  const signalsOk = Array.isArray(parsed.signals) && parsed.signals.every((s) => typeof s === 'string');
  if (!signalsOk) problems.push(`signals: expected an array of strings, got ${JSON.stringify(parsed.signals)}`);
  const signals = signalsOk ? parsed.signals.map((s) => s.trim()).filter(Boolean) : [];

  if (problems.length) return fail(problems);
  return { ok: true, problems: [], value: { category, priority, confidence, reason, signals } };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * Score one provider outcome against one benchmark case.
 *
 * @param {object} testCase  a CASES entry
 * @param {object} outcome   { valid, value, error } — as produced by the
 *                           runner (value is the normalized response when
 *                           valid)
 * @returns {{ categoryOk: boolean, priorityOk: boolean|null,
 *             trapIgnored: boolean|null, fellForTrap: boolean }}
 */
function scoreCase(testCase, outcome) {
  const value = outcome.valid ? outcome.value : null;
  const categoryOk = Boolean(value && value.category === testCase.expected.category);
  const priorityApplicable = testCase.expected.priority !== null;
  const priorityOk = priorityApplicable
    ? Boolean(value && value.priority === testCase.expected.priority)
    : null;
  // Adversarial cases pass only when the trap keyword did not win.
  const trapIgnored = testCase.trap ? categoryOk : null;
  const fellForTrap = Boolean(
    testCase.trap && value && !categoryOk && value.category === testCase.trap.category,
  );
  return { categoryOk, priorityOk, trapIgnored, fellForTrap };
}

/** Aggregate one provider's per-case results into the report tallies. */
function tallyResults(results) {
  const t = {
    total: results.length,
    categoryCorrect: 0,
    priorityTotal: 0,
    priorityCorrect: 0,
    combinedCorrect: 0,
    valid: 0,
    invalid: 0,
    errors: 0,
    adversarialTotal: 0,
    adversarialPassed: 0,
    fellForTrap: 0,
  };
  const confOnCorrect = [];
  const confOnIncorrect = [];
  for (const r of results) {
    if (r.outcome.error) t.errors += 1;
    if (r.outcome.valid) t.valid += 1;
    else if (!r.outcome.error) t.invalid += 1;
    if (r.score.categoryOk) t.categoryCorrect += 1;
    if (r.score.priorityOk !== null) {
      t.priorityTotal += 1;
      if (r.score.priorityOk) t.priorityCorrect += 1;
    }
    // Combined = category AND priority both right; cases without a
    // determinable expected priority pass on category alone.
    const combinedOk = r.score.categoryOk && r.score.priorityOk !== false;
    if (combinedOk) t.combinedCorrect += 1;
    // Confidence is recorded, never treated as proof of correctness: the
    // split only exposes whether the model is calibrated, not better.
    if (r.outcome.valid && typeof r.outcome.value.confidence === 'number') {
      (combinedOk ? confOnCorrect : confOnIncorrect).push(r.outcome.value.confidence);
    }
    if (r.score.trapIgnored !== null) {
      t.adversarialTotal += 1;
      if (r.score.trapIgnored) t.adversarialPassed += 1;
    }
    if (r.score.fellForTrap) t.fellForTrap += 1;
  }
  const avg = (list) =>
    list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : null;
  const latencies = results.map((r) => r.latencyMs).filter((n) => Number.isFinite(n) && n >= 0);
  const confidences = results
    .map((r) => (r.outcome.valid ? r.outcome.value.confidence : null))
    .filter((n) => typeof n === 'number');
  t.avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const sorted = [...latencies].sort((a, b) => a - b);
  t.medianLatencyMs = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  t.avgConfidence = avg(confidences);
  t.avgConfidenceOnCorrect = avg(confOnCorrect);
  t.avgConfidenceOnIncorrect = avg(confOnIncorrect);
  return t;
}

module.exports = { extractJson, canonicalValue, validateStructured, scoreCase, tallyResults };
