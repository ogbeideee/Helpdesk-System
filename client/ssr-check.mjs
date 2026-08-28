import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

globalThis.window = globalThis;
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
};
globalThis.document = { addEventListener() {}, removeEventListener() {} };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch {}

const clientDir = 'C:/Users/dogbeide/TICKETING SYSTEM/client';
const distDir = path.join(clientDir, 'dist', 'assets');

// Find the production JS bundle and load it.
const fs = require('fs');
const jsFile = fs.readdirSync(distDir).find((f) => f.endsWith('.js') && f.startsWith('index-'));
if (!jsFile) { console.error('No bundle found in', distDir); process.exit(2); }
const code = fs.readFileSync(path.join(distDir, jsFile), 'utf8');

// Evaluate the bundle in a sandboxed VM. The bundle exports a default App
// component as the only thing it needs.
const vm = require('vm');
const sandbox = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, localStorage: globalThis.localStorage, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error('no fetch in SSR')), React: require('react'), ReactDOMServer: require('react-dom/server'), process: { env: { NODE_ENV: 'production' } } };
sandbox.global = sandbox;
vm.createContext(sandbox);
let bundle;
try {
  vm.runInContext(code, sandbox, { filename: jsFile });
  // The bundle inlines modules and registers a global `App` via the IIFE.
  // In Vite's output, exports are on `sandbox`. Try common places.
  bundle = sandbox.default || sandbox.App || sandbox.app || sandbox;
} catch (e) {
  console.error('Bundle evaluation failed:', e.message);
  process.exit(2);
}

const React = require('react');
const ReactDOMServer = require('react-dom/server');
const App = bundle.default || bundle.App || (typeof bundle === 'function' ? bundle : null);
if (!App || typeof App !== 'function') {
  console.error('Could not find a component to render. Sandbox keys:', Object.keys(sandbox).filter(k => !k.startsWith('_')).slice(0, 30));
  process.exit(2);
}
console.log('Found component:', App.name || '(anonymous)');

let ok = true;
for (let i = 1; i <= 3; i++) {
  try {
    const html = ReactDOMServer.renderToString(React.createElement(App));
    console.log(`Render #${i}: OK, length ${html.length}`);
  } catch (e) {
    ok = false;
    console.error(`Render #${i} THREW:`);
    console.error(e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 18).join('\n'));
  }
}
process.exit(ok ? 0 : 1);
