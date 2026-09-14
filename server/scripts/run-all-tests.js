/* Run the whole server test suite — every suite, every time.

   The old `npm test` was one long `&&` chain: the first failing suite
   stopped the run and everything behind it silently never executed.
   This runner executes every suite in the same fixed order, streams each
   suite's output live, and ends with a per-suite summary and a non-zero
   exit code when anything failed.

   Optional arguments are substring filters, e.g.
     node scripts/run-all-tests.js imap email-sources
   runs only the suites whose name matches any filter.

   Usage: npm test  (from server/) — delegates here
          node scripts/run-all-tests.js [filter ...] */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Same order as the chain this replaced.
const SUITES = [
  'test-email-parser',
  'test-email-ingest',
  'test-graph-mailbox',
  'test-graph',
  'test-webhook',
  'test-api',
  'test-lifecycle',
  'test-users',
  'test-routing',
  'test-workload',
  'test-handover',
  'test-email-integration',
  'test-email-sources',
  'test-imap',
  'test-imap-oauth',
  'test-email-rules',
  'test-classifier-seam',
  'test-ai-benchmark',
  'test-attachments',
  'test-m365',
  'test-assignment-pool',
  'test-availability-history',
  'test-remote-access',
  'test-audit',
  'test-reports',
  'test-scheduled-reports',
  'test-sla',
  'test-sla-dashboard',
  'test-sla-settings',
  'test-sla-backfill',
  'test-sla-report',
  'test-sla-sweeper',
  'test-sla-notify',
  'test-assignment-groups',
  'test-e2e',
];

const filters = process.argv.slice(2);
const suites = filters.length
  ? SUITES.filter((suite) => filters.some((f) => suite.includes(f)))
  : SUITES;
if (suites.length === 0) {
  console.error(`No suite matches filter(s): ${filters.join(', ')}`);
  process.exit(2);
}

const results = [];
for (const suite of suites) {
  const file = path.join(__dirname, `${suite}.js`);
  if (!fs.existsSync(file)) {
    console.error(`\n!!!!! ${suite}: script not found at ${file} — suite list has drifted`);
    results.push({ suite, ok: false, status: null });
    continue;
  }
  console.log(`\n===== ${suite} =====`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const ok = r.status === 0;
  results.push({ suite, ok, status: r.status });
  console.log(`\n----- ${suite}: ${ok ? 'PASS' : `FAIL (exit ${r.status})`} -----`);
}

console.log('\n================ TEST SUMMARY ================');
for (const { suite, ok } of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} suite(s) passed` +
    (failed.length ? ` — failed: ${failed.map((r) => r.suite).join(', ')}` : '')
);
process.exit(failed.length === 0 ? 0 : 1);