// Load the production app through React's SSR twice.
//
// The production bundle inlines its own copy of React, so node cannot drive
// its hooks (renderToString from node_modules/react-dom sets the dispatcher
// on a different React instance). The app is therefore built a second time as
// an SSR entry — Vite externalizes the react packages there — and rendered
// with the same React the app itself uses.
//
// The two renders simulate the canonical "Rendered more hooks" trigger for
// this codebase: a full app boot, then the authed shell's pages. The Dashboard
// KPI row is additionally rendered in its no-data state — a fresh system has
// no SLA cycles at all, and the cards must show clean dashes rather than
// invented figures.
//
// Run: node ssr-check.mjs  (from client/, after npm install)
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(clientDir, '.ssr-check');
const entryFile = path.join(clientDir, 'ssr-check-entry.mjs');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

function cleanup() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(entryFile, { force: true });
}

// --- Build the SSR entry -------------------------------------------------- */
fs.writeFileSync(
  entryFile,
  [
    "import App from './src/App.jsx';",
    "export { default as Dashboard, KpiCard } from './src/components/Dashboard.jsx';",
    "export { slaKpiCards } from './src/slaKpis.js';",
    'export default App;',
    '',
  ].join('\n')
);
fs.rmSync(outDir, { recursive: true, force: true });
try {
  const { build } = await import('vite');
  await build({
    root: clientDir,
    logLevel: 'error',
    build: { ssr: entryFile, outDir, emptyOutDir: true },
  });
} catch (e) {
  console.error('SSR build failed:', e.message);
  cleanup();
  process.exit(2);
}

// --- Browser-ish globals the app's render paths expect -------------------- */
globalThis.window = globalThis;
globalThis.location = { hash: '' };
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
};
globalThis.matchMedia = () => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
});
globalThis.document = { addEventListener() {}, removeEventListener() {} };

// --- Render ---------------------------------------------------------------- */
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const ssr = await import(pathToFileURL(path.join(outDir, 'ssr-check-entry.js')));
const { default: App, Dashboard, KpiCard, slaKpiCards } = ssr;

// Render #1 — a full app boot.
const bootHtml = renderToString(React.createElement(App));
check('app boot renders', bootHtml.includes('boot-screen'), bootHtml.slice(0, 120));

// Render #2 — the authed shell's landing page in its loading state.
const dashHtml = renderToString(
  React.createElement(Dashboard, { onOpen: () => {}, me: { id: 1, name: 'Check Agent' } })
);
check('second render (dashboard shell) works', dashHtml.includes('is-loading'));

// No-data states: a system without SLA cycles shows dashes and honest notes,
// never invented percentages.
const emptyBlock = {
  compliance: { met: 0, total: 0, rate: null },
  breaches: { response: 0, resolution: 0, responseApplicable: 0, resolutionApplicable: 0 },
  approachingTickets: 0,
  avgFirstResponseMs: null,
  firstResponseCount: 0,
  avgResolutionMs: null,
  resolutionCount: 0,
  avgResolutionTargetMs: null,
  responseTargetMs: 3600000,
};
const emptyCards = slaKpiCards(emptyBlock, 0);
const emptyHtml = renderToString(
  React.createElement('div', { className: 'kpi-row kpi-row-sla' }, emptyCards.map((k) => React.createElement(KpiCard, { key: k.label, ...k })))
);
check('no-data compliance shows a dash', emptyHtml.includes('>—<'));
check('no-data notes render', ['No completed cycles yet', 'No SLA cycles yet', 'No responses recorded yet', 'No resolutions recorded yet'].every((note) => emptyHtml.includes(note)));
check('no-data meters stay empty', (emptyHtml.match(/is-empty/g) || []).length >= 4);
check('approaching figure is a real zero', emptyHtml.includes('>0<'));

cleanup();
if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nssr-check: ALL PASS');
