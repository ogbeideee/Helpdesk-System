// Load the production build of the client and run it through React's SSR
// twice. The second render simulates the moment when the auth `me` state
// resolves from `undefined` to a real user (the canonical "Rendered more
// hooks" trigger for this codebase).

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const vm = require('vm');

const clientDir = 'C:/Users/dogbeide/TICKETING SYSTEM/client';
const distDir = path.join(clientDir, 'dist', 'assets');

// Mock browser globals inside a sandbox.
const sandbox = {
  window: {},
  document: { documentElement: {}, body: {}, createElement() { return {}; } },
  navigator: { userAgent: 'node' },
  localStorage: {
    _store: {},
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = String(v); },
    removeItem(k) { delete this._store[k]; },
  },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  fetch: () => Promise.reject(new Error('no fetch in SSR')),
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: clearTimeout,
  React: require('react'),
  ReactDOM: require('react-dom'),
  ReactDOMServer: require('react-dom/server'),
  process: { env: { NODE_ENV: 'production' } },
};
sandbox.global = sandbox;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.location = { hash: '' };
sandbox.window.addEventListener = () => {};
sandbox.window.removeEventListener = () => {};
sandbox.window.matchMedia = sandbox.matchMedia;

vm.createContext(sandbox);

const jsFile = fs.readdirSync(distDir).find((f) => f.endsWith('.js') && f.startsWith('index-'));
console.log('Bundle:', jsFile);
const code = fs.readFileSync(path.join(distDir, jsFile), 'utf8');
console.log('Bundle size:', code.length, 'bytes');

try {
  vm.runInContext(code, sandbox, { filename: jsFile });
} catch (e) {
  console.error('Bundle eval failed:', e.message);
  process.exit(2);
}

const { React, ReactDOMServer } = sandbox;
// The bundle exposes a default export. Find it on the sandbox.
const keys = Object.keys(sandbox).filter((k) => !k.startsWith('_') && !['window','document','navigator','localStorage','console','setTimeout','clearTimeout','setInterval','clearInterval','matchMedia','ResizeObserver','MutationObserver','fetch','requestAnimationFrame','cancelAnimationFrame','React','ReactDOM','ReactDOMServer','process','global'].includes(k));
console.log('Bundle exports:', keys);

let App = sandbox.default;
if (!App) {
  // Find anything that looks like a React component (capitalized function or object with $$typeof)
  for (const k of keys) {
    const v = sandbox[k];
    if (typeof v === 'function' && /^[A-Z]/.test(k)) { App = v; console.log('Using export:', k); break; }
  }
}
if (!App) { console.error('No App component found'); process.exit(2); }

let ok = true;
for (let i = 1; i <= 3; i++) {
  try {
    const el = React.createElement(App);
    const html = ReactDOMServer.renderToString(el);
    console.log(`SSR render #${i}: OK, html length ${html.length}`);
  } catch (e) {
    ok = false;
    console.error(`SSR render #${i} THREW:`);
    console.error(e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 20).join('\n'));
  }
}
process.exit(ok ? 0 : 1);
