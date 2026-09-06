// Load the app through React's SSR for real.
//
// The production bundle inlines its own copy of React, so node cannot drive
// its hooks (renderToString from node_modules/react-dom sets the dispatcher
// on a different React instance). The app is therefore built a second time as
// an SSR entry — Vite externalizes the react packages there — and rendered
// with the same React the app itself uses.
//
// What is exercised:
//   1. the whole app module graph imports and SSRs (App renders its boot
//      screen; auth state is internal to App, so SSR stops there),
//   2. the SLA KPI row's loaded state: the real KpiCard rendering the card
//      models the real slaKpiCards display model produces for a populated
//      dashboard `sla` block. (The Dashboard's own data state is fetch-fed
//      and unreachable in server render — effects do not run — so the cards
//      are rendered directly, exactly as the Dashboard renders them.)
//
// Run: node live-check.mjs  (from client/, after npm install)
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

// --- 1. Build the SSR entry ---------------------------------------------- */
// The entry re-exports the pieces the renders below need next to the app.
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

// --- 2. Browser-ish globals the app's render paths expect ---------------- */
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

// --- 3. Render ------------------------------------------------------------ */
const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const ssr = await import(pathToFileURL(path.join(outDir, 'ssr-check-entry.js')));const { default: App, Dashboard, KpiCard, slaKpiCards } = ssr;

// 1 — the app boots: its module graph SSRs without crashing.
const bootHtml = renderToString(React.createElement(App));
check('app renders its boot screen', bootHtml.includes('boot-screen'), bootHtml.slice(0, 120));

// 2 — the Dashboard while its data is loading: the SLA row shows skeletons.
const loadingHtml = renderToString(
  React.createElement(Dashboard, { onOpen: () => {}, me: { id: 1, name: 'Check Agent' } })
);
check('loading dashboard shows skeletons', loadingHtml.includes('is-loading'));

// 3 — the SLA cards in their loaded state. The figures mirror what the
// dashboard API computes from the SLA cycle table.
const slaBlock = {
  compliance: { met: 18, total: 20, rate: 90 },
  breaches: { response: 3, resolution: 2, responseApplicable: 25, resolutionApplicable: 25 },
  approachingTickets: 4,
  avgFirstResponseMs: 22 * 60000,
  firstResponseCount: 22,
  avgResolutionMs: 5 * 3600000 + 30 * 60000,
  resolutionCount: 20,
  avgResolutionTargetMs: 24 * 3600000,
  responseTargetMs: 3600000,
};
const cards = slaKpiCards(slaBlock, 9);
check('six SLA cards for a populated block', cards.length === 6);
const rowHtml = renderToString(
  React.createElement('div', { className: 'kpi-row kpi-row-sla' }, cards.map((k) => React.createElement(KpiCard, { key: k.label, ...k })))
);
check('all six SLA cards render', ['SLA Compliance', 'Response Breaches', 'Resolution Breaches', 'Approaching Breach', 'Avg First Response', 'Avg Resolution'].every((label) => rowHtml.includes(label)));
check('compliance rate renders', rowHtml.includes('>90%<'));
check('breach and approaching counts render', rowHtml.includes('>3<') && rowHtml.includes('>2<') && rowHtml.includes('>4<'));
check('averages render as working time', rowHtml.includes('>22m<') && rowHtml.includes('>5h 30m<'));
check('compliance note counts the cycles', rowHtml.includes('18 of 20 completed cycles met'));
check('missed segment is marked for the meter', rowHtml.includes('kpi-seg-missed'));

// 4 — a second render must behave identically (hook-order stability).
const rowHtml2 = renderToString(
  React.createElement('div', { className: 'kpi-row kpi-row-sla' }, cards.map((k) => React.createElement(KpiCard, { key: k.label, ...k })))
);
check('second render is stable', rowHtml2 === rowHtml);

cleanup();
if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nlive-check: ALL PASS');
