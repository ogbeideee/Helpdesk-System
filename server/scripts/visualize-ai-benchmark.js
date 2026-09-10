/* Turn one or more benchmark JSON exports into a comparison-chart page.
 *
 * Each input is a file produced by:
 *   node scripts/ai-benchmark.js --provider gemini --json gemini.json
 *   node scripts/ai-benchmark.js --provider groq   --json groq.json
 * (the keyword baseline travels inside every export). Providers are matched
 * by id across files, so separate per-provider runs merge into one page.
 *
 * Usage:
 *   node scripts/visualize-ai-benchmark.js gemini.json groq.json -o report.html
 * Or in one step, straight from a benchmark run:
 *   node scripts/ai-benchmark.js --provider all --json runs.json --chart report.html
 */
const fs = require('fs');
const path = require('path');
const { buildComparisonHtml } = require('./lib/ai-benchmark/visualize');

const args = process.argv.slice(2);
const outIdx = args.findIndex((a) => a === '-o' || a === '--out');
const outFile = outIdx !== -1 ? args.splice(outIdx, 2)[1] : 'bench-report.html';
const inputs = args.filter((a) => !a.startsWith('-'));

function usage() {
  console.log(
    [
      'Usage: node scripts/visualize-ai-benchmark.js <run1.json> [run2.json ...] [-o out.html]',
      '',
      'Inputs are --json exports from scripts/ai-benchmark.js; the output is a',
      'self-contained HTML page (inline SVG, no network, no external scripts).',
    ].join('\n'),
  );
}

function main() {
  if (inputs.length === 0) {
    usage();
    process.exit(1);
  }
  const runs = inputs.map((f) => {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.providers)) {
      throw new Error(`${f} is not a benchmark JSON export (expected schema 1 from ai-benchmark.js --json)`);
    }
    return parsed;
  });
  const html = buildComparisonHtml(runs);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, html);
  console.log(`[viz] wrote ${outFile} (${(html.length / 1024).toFixed(1)} kB, ${runs.length} source run(s))`);
}

try {
  main();
} catch (err) {
  console.error(`[viz] ${err.message}`);
  process.exit(1);
}
