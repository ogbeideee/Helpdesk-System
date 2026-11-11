// Fixed 40ms mock transport: measures cache-induced waits, not browser rendering.
import { performance } from 'node:perf_hooks';
const values = new Map([['td_token', 'benchmark-session']]);
globalThis.localStorage = { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
globalThis.window = new EventTarget();
window.location = { reload() {} };
globalThis.CustomEvent = class extends Event { constructor(name, options = {}) { super(name); this.detail = options.detail; } };
let requests = 0;
globalThis.fetch = async () => { requests++; await new Promise(r => setTimeout(r,40)); return { status:200, ok:true, json:async()=>({}) }; };
const { api } = await import('./src/api.js');
const result = {};
for (const [name, write] of [
  ['afterMarkRead', () => api.markConversationRead(1, new Date().toISOString())],
  ['afterTicketEdit', () => api.updateTicket(1, { priority:'high' })],
]) {
  await Promise.all([api.dashboard(), api.groups(), api.getTicket(2)]);
  await write();
  requests = 0;
  const start = performance.now();
  await Promise.all([api.dashboard(), api.groups(), api.getTicket(2)]);
  result[name] = { networkReads: requests, elapsedMs: +(performance.now()-start).toFixed(1) };
}
console.log('MEASUREMENT ' + JSON.stringify(result));
