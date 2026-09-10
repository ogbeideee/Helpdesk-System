# AI classification benchmark (provider selection)

Compares candidate AI classifiers for ticket triage **before** any provider is
wired into production. Phase 1's `classifier` seam stays untouched; this
benchmark exists only to choose between:

- Google **Gemini 2.5 Flash-Lite**
- **Groq + Qwen**

...against the same frozen cases (scenarios A–T, including adversarial ones the
current keyword classifier fails), with identical instructions and output schema for both.
The local keyword baseline (`src/graph/categoryRules.js`) is always included as the
score to beat.

## Run

```bash
cd server

# Real API calls — explicit developer action only:
GEMINI_API_KEY=... node scripts/ai-benchmark.js --provider gemini
GROQ_API_KEY=...   node scripts/ai-benchmark.js --provider groq
node scripts/ai-benchmark.js            # every provider that has a key

# No network, no keys (parses/validates/scores/reports the same pipeline):
node scripts/ai-benchmark.js --mock

# Inspect the case list:
node scripts/ai-benchmark.js --list-cases
```

Keys come **only** from environment variables (a real environment wins over
`server/.env`). They travel solely in request headers, are never logged, and
never appear in reports.

## Charts

`--json` exports a run (metrics + per-case outcomes; never prompts or email
bodies) and `--chart` renders the comparison page in one step — a
self-contained HTML file with inline SVG, no external scripts:

```bash
# Both providers in one page:
node scripts/ai-benchmark.js --provider all --json runs.json --chart report.html

# Or merge separately-saved runs afterwards:
node scripts/ai-benchmark.js --provider gemini --json gemini.json
node scripts/ai-benchmark.js --provider groq   --json groq.json
node scripts/visualize-ai-benchmark.js gemini.json groq.json -o report.html
# (same as: npm run bench:ai:viz -- gemini.json groq.json -o report.html)
```

The page compares category/priority accuracy, valid-response rate, adversarial
pass rate, average and per-case latency, confidence (informational only), and
a per-case outcome matrix. Mock-run providers are tagged so mock numbers can
never be mistaken for real API results.

## Environment

| Variable | Required | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | for Gemini runs | — |
| `GROQ_API_KEY` | for Groq runs | — |
| `GEMINI_MODEL` | no | `gemini-2.5-flash-lite` |
| `GROQ_MODEL` | no | `qwen/qwen3.8-27b` |
| `AI_BENCH_TIMEOUT_MS` | no | `30000` |
| `AI_BENCH_DELAY_MS` | no | `400` |

## Layout

- `cases.js` — the shared test cases (frozen; same array for every provider)
- `prompt.js` — the one instruction/schema contract handed to every provider
- `scoring.js` — JSON extraction, schema validation, per-case scoring, tallies
- `providers.js` — adapter factories (Gemini, Groq, keyword baseline, mock)
- `runner.js` — the per-case isolated execution loop
- `report.js` — terminal report formatting
- `serialize.js` — JSON export for the chart generator (no prompts/bodies)
- `visualize.js` — the self-contained HTML comparison page (inline SVG)

Adding a provider = one factory returning `{ id, label, model, remote,
classify(ctx) }`; nothing else changes. A failed call (timeout, HTTP error,
malformed output) fails that single case, never the run. Nothing is stored in
any database — prompts, bodies and responses exist only in process memory.

The focused suite `npm run test:ai-benchmark` (also part of `npm test`)
exercises validation, scoring, latency measurement, failure isolation and
report generation entirely with mocked providers — it never makes a network
request.
