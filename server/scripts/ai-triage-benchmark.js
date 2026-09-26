/* Cloud email-relevance benchmark.
 *
 * Runs the real Groq provider against a labeled JSON file, or a small synthetic
 * smoke set with --mock. It reports aggregate metrics and per-case outcomes,
 * never email bodies or raw model responses.
 *
 * Usage from server/:
 *   GROQ_API_KEY=... node scripts/ai-triage-benchmark.js --mock
 *   GROQ_API_KEY=... node scripts/ai-triage-benchmark.js --file labels.json
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { CASES } = require('./lib/ai-triage-benchmark/cases');
const triage = require('../src/services/emailTriageService');
const { canAutoSkip, SAFE_SKIP_REASON_CODES } = require('../src/services/emailTriagePolicy');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function usage() {
  console.log([
    'Usage: node scripts/ai-triage-benchmark.js [--file labels.json] [--mock] [--json report.json]',
    '',
    'Label file: JSON array of { id, subject, cleanBody, from, expected: "ticket"|"skip"|"review" }.',
    'Use redacted/synthetic labels for a hosted provider. No bodies are written to the report.',
  ].join('\n'));
}

function loadCases(file) {
  if (!file) return CASES;
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) throw new Error('Label file must be an array or an object with a cases array');
  return cases.map((item, index) => ({
    id: String(item.id || `case-${index + 1}`),
    subject: String(item.subject || ''),
    cleanBody: String(item.cleanBody || item.body || ''),
    from: String(item.from || item.senderEmail || ''),
    expected: String(item.expected || '').toLowerCase(),
  }));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function score(results) {
  const matrix = {
    ticket: { ticket: 0, skip: 0, review: 0 },
    skip: { ticket: 0, skip: 0, review: 0 },
    review: { ticket: 0, skip: 0, review: 0 },
  };
  for (const result of results) {
    if (matrix[result.expected] && matrix[result.expected][result.disposition] !== undefined) {
      matrix[result.expected][result.disposition] += 1;
    }
  }
  const expectedTickets = matrix.ticket.ticket + matrix.ticket.skip + matrix.ticket.review;
  const predictedSkips = matrix.ticket.skip + matrix.skip.skip + matrix.review.skip;
  return {
    total: results.length,
    valid: results.filter((r) => r.disposition && !r.errorCode).length,
    errors: results.filter((r) => r.errorCode).length,
    ticketRecall: expectedTickets ? matrix.ticket.ticket / expectedTickets : null,
    skipPrecision: predictedSkips ? matrix.skip.skip / predictedSkips : null,
    matrix,
    p95LatencyMs: percentile(results.map((r) => r.latencyMs).filter(Number.isFinite), 0.95),
  };
}

async function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return 0;
  }
  const mock = process.argv.includes('--mock');
  const cases = loadCases(arg('--file'));
  const config = triage.getRuntimeConfig();
  if (!mock && !config.apiKey) {
    console.error('GROQ_API_KEY is not set. Use --mock for the offline smoke set.');
    return 1;
  }
  const results = [];
  for (const item of cases) {
    const started = Date.now();
    if (mock) {
      results.push({
        id: item.id,
        expected: item.expected,
        disposition: item.expected,
        confidence: 0.99,
        latencyMs: Date.now() - started,
        policyAllowed: item.expected === 'skip',
      });
      continue;
    }
    try {
      const result = await triage.requestGroq({
        subject: item.subject,
        body: item.cleanBody,
        config,
      });
      const policy = canAutoSkip({
        disposition: result.value.disposition,
        confidence: result.value.confidence,
        reasonCode: result.value.reasonCode,
        senderEmail: item.from,
        subject: item.subject,
        body: item.cleanBody,
        requireApprovedSender: false,
        allowedReasonCodes: SAFE_SKIP_REASON_CODES,
        threshold: 95,
      });
      results.push({
        id: item.id,
        expected: item.expected,
        disposition: result.value.disposition,
        confidence: result.value.confidence,
        reasonCode: result.value.reasonCode,
        latencyMs: result.latencyMs,
        policyAllowed: policy.allowed,
      });
    } catch (err) {
      results.push({
        id: item.id,
        expected: item.expected,
        disposition: null,
        confidence: null,
        latencyMs: Date.now() - started,
        errorCode: err && err.code ? err.code : 'provider_error',
      });
    }
  }
  const report = { ranAt: new Date().toISOString(), provider: config.model, mock, metrics: score(results), results };
  console.log(JSON.stringify(report, null, 2));
  const output = arg('--json');
  if (output) {
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[triage-bench] report written to ${output}`);
  }
  return report.metrics.errors ? 1 : 0;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[triage-bench] aborted: ${err.message}`);
    process.exit(1);
  });
