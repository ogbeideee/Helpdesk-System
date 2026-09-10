/* AI classification benchmark — CLI entry (provider selection only).
 *
 * Run this ONLY when you intend to make real provider API calls; it is not
 * part of the test suite. `npm run bench:ai -- --mock` runs the identical
 * pipeline against a scripted provider with zero network access.
 *
 * Environment (server/.env is honored, real environment wins):
 *   GEMINI_API_KEY        required for the Gemini provider
 *   GROQ_API_KEY          required for the Groq/Qwen provider
 *   GEMINI_MODEL          default gemini-2.5-flash-lite
 *   GROQ_MODEL            default qwen/qwen3.8-27b (the Qwen model this
 *                         Groq account exposes; override via env)
 *   AI_BENCH_TIMEOUT_MS   per-request timeout, default 30000
 *   AI_BENCH_DELAY_MS     pause between remote calls, default 400
 *
 * Usage:
 *   node scripts/ai-benchmark.js --provider gemini
 *   node scripts/ai-benchmark.js --provider groq
 *   node scripts/ai-benchmark.js                 (every provider with a key)
 *   node scripts/ai-benchmark.js --mock          (no network, no keys)
 *   node scripts/ai-benchmark.js --list-cases
 *   node scripts/ai-benchmark.js --provider all --json runs.json --chart report.html
 *
 * --json <path>  write the run as JSON (metrics + per-case outcomes; never
 *                prompts or email bodies) for visualize-ai-benchmark.js
 * --chart <path> also write the self-contained HTML comparison page
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const { CASES } = require('./lib/ai-benchmark/cases');
const { runBenchmark } = require('./lib/ai-benchmark/runner');
const { formatReport } = require('./lib/ai-benchmark/report');
const { runToJson } = require('./lib/ai-benchmark/serialize');
const { buildComparisonHtml } = require('./lib/ai-benchmark/visualize');
const {
  makeGeminiProvider,
  makeGroqProvider,
  makeKeywordBaselineProvider,
  makeMockProvider,
} = require('./lib/ai-benchmark/providers');

const args = process.argv.slice(2);
const wantHelp = args.includes('--help') || args.includes('-h');
const wantList = args.includes('--list-cases');
const wantMock = args.includes('--mock');
const providerArg = (() => {
  const i = args.indexOf('--provider');
  return i !== -1 ? args[i + 1] : 'auto';
})();
const valueArg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const jsonPath = valueArg('--json');
const chartPath = valueArg('--chart');

function usage() {
  console.log(
    [
      'Usage: node scripts/ai-benchmark.js [--provider gemini|groq|all] [--mock] [--list-cases]',
      '                               [--json runs.json] [--chart report.html]',
      '',
      'Env: GEMINI_API_KEY, GROQ_API_KEY (required per provider); optional',
      '     GEMINI_MODEL, GROQ_MODEL, AI_BENCH_TIMEOUT_MS, AI_BENCH_DELAY_MS',
    ].join('\n'),
  );
}

async function main() {
  if (wantHelp) {
    usage();
    return 0;
  }
  if (wantList) {
    for (const c of CASES) {
      console.log(`${c.id}. ${c.name}`);
      console.log(`   expected: ${c.expected.category} / ${c.expected.priority || '(not determinable)'}`);
      console.log(`   why: ${c.why}`);
      if (c.adversarial) console.log(`   adversarial — trap: ${c.trap.detail}`);
    }
    return 0;
  }

  const paceMs = Number(process.env.AI_BENCH_DELAY_MS || 400);

  // The local keyword baseline is always included — it is the score any
  // paid provider has to justify itself against.
  const providers = [makeKeywordBaselineProvider()];

  if (wantMock) {
    providers.push(makeMockProvider());
  } else {
    const selected = providerArg === 'auto' || providerArg === 'all' ? ['gemini', 'groq'] : [providerArg];
    const invalid = selected.filter((s) => !['gemini', 'groq'].includes(s));
    if (invalid.length) {
      console.error(`Unknown provider "${invalid[0]}" — expected gemini, groq or all.`);
      usage();
      return 1;
    }
    let requested = 0;
    let skipped = 0;
    if (selected.includes('gemini')) {
      requested += 1;
      if (process.env.GEMINI_API_KEY) providers.push(makeGeminiProvider({ apiKey: process.env.GEMINI_API_KEY }));
      else {
        skipped += 1;
        console.error('[bench] GEMINI_API_KEY not set — Gemini skipped');
      }
    }
    if (selected.includes('groq')) {
      requested += 1;
      if (process.env.GROQ_API_KEY) providers.push(makeGroqProvider({ apiKey: process.env.GROQ_API_KEY }));
      else {
        skipped += 1;
        console.error('[bench] GROQ_API_KEY not set — Groq skipped');
      }
    }
    if (requested > 0 && skipped === requested) {
      console.error('[bench] no provider credentials available — nothing to benchmark. Set GEMINI_API_KEY and/or GROQ_API_KEY, or use --mock.');
      return 1;
    }
  }

  const run = await runBenchmark({
    cases: CASES,
    providers,
    paceMs,
    onCase: (providerId, caseId, latencyMs, outcome) => {
      const flag = outcome.error ? 'error' : outcome.valid ? 'ok' : 'invalid';
      process.stderr.write(`  ${providerId} ${caseId} ${String(latencyMs).padStart(6)} ms  ${flag}\n`);
    },
  });

  console.log(formatReport(run));

  if (jsonPath || chartPath) {
    // Metrics and per-case outcomes only — never prompts or bodies.
    const json = runToJson(run, wantMock ? 'mock' : 'live');
    if (jsonPath) {
      fs.mkdirSync(require('path').dirname(require('path').resolve(jsonPath)), { recursive: true });
      fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
      console.log(`[bench] JSON written to ${jsonPath}`);
    }
    if (chartPath) {
      fs.mkdirSync(require('path').dirname(require('path').resolve(chartPath)), { recursive: true });
      fs.writeFileSync(chartPath, buildComparisonHtml([json]));
      console.log(`[bench] comparison charts written to ${chartPath}`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[bench] aborted: ${err.message}`);
    process.exit(1);
  });
