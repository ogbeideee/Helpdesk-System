import assert from 'node:assert/strict';
import { installChunkRecovery, isChunkLoadError } from './src/chunkRecovery.js';
const store = new Map();
let listener;
let reloads = 0;
let prevented = 0;
let clock = 100000;
const browser = {
  sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) },
  location: { href: 'https://example.com/#/handovers', reload: () => reloads++ },
  addEventListener: (_, handler) => { listener = handler; },
  removeEventListener: (_, handler) => { if (listener === handler) listener = null; },
};
const dispose = installChunkRecovery(browser, () => clock);
const error = new TypeError('Failed to fetch dynamically imported module: https://example.com/assets/old.js');
const event = { payload: error, preventDefault: () => prevented++ };
listener({ ...event, payload: Error('Ordinary render error') });
assert.equal(reloads, 0);
listener(event);
assert.equal(reloads, 1);
assert.equal(prevented, 1);
assert.equal(browser.location.href, 'https://example.com/#/handovers');
// A second installation represents the refreshed document in the same session.
dispose();
installChunkRecovery(browser, () => clock);
listener(event);
assert.equal(reloads, 1, 'a persistent network failure must not cause a reload loop');
clock += 60001;
listener(event);
assert.equal(reloads, 2, 'a later deployment may recover again');
browser.sessionStorage.getItem = () => { throw Error('Storage unavailable'); };
clock += 60001;
listener(event);
assert.equal(reloads, 2);
assert(isChunkLoadError(Error('Importing a module script failed.')));
assert(!isChunkLoadError(Error('Cannot read properties of undefined')));
console.log('Chunk recovery passed: stale imports refresh current route, repeated failures stay bounded, unavailable storage fails safely.');
