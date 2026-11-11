import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startPageRefresh } from './src/refreshScheduler.js';
const window = new EventTarget(), document = new EventTarget();
document.hidden = false;
let clock = 0, count = 0, timer, removed = false;
const stop = startPageRefresh({ window, document, now: () => clock,
  refresh: () => count++, setInterval: (fn, ms) => { assert.equal(ms, 30000); timer = fn; return 1; }, clearInterval: () => { removed = true; } });
window.dispatchEvent(new Event('focus'));
document.dispatchEvent(new Event('visibilitychange'));
assert.equal(count, 1, 'focus/visibility burst refreshes once');
document.hidden = true; clock = 30000; timer();
assert.equal(count, 1, 'hidden page does not refresh');
document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
assert.equal(count, 2, 'returning to the tab refreshes immediately');
count = 0;
for (let i = 1; i <= 20; i++) { clock += 30000; timer(); }
assert.equal(count, 20, 'one page refresh each 30 seconds');
stop(); clock += 30000; window.dispatchEvent(new Event('focus'));
assert.equal(count, 20); assert(removed);
for (const file of ['TicketDetail', 'HandoversPage', 'Microsoft365Page']) {
  assert(!fs.readFileSync(new URL(`./src/components/${file}.jsx`, import.meta.url), 'utf8').includes('setInterval('), `${file} shares shell refresh`);
}
console.log('Refresh passed: burst coalescing, hidden-tab pause, resume, cleanup and single page timer.');
// Execute the prior shell (30s) + ticket (60s) timer schedules on a virtual
// clock. Counts are load invocations, not HTTP requests (the cache can dedupe).
let previousLoads = 0;
const previousTimers = [{ every:30000, run:() => previousLoads++ }, { every:60000, run:() => previousLoads++ }];
for (let elapsed = 30000; elapsed <= 600000; elapsed += 30000) {
  for (const entry of previousTimers) if (elapsed % entry.every === 0) entry.run();
}
let previousBurst = 0;
const previousFocus = () => previousBurst++;
previousFocus(); previousFocus();
console.log('MEASUREMENT ' + JSON.stringify({ visibleTicketLoadInvocationsOver10Minutes: { before:previousLoads, after:count }, focusVisibilityBurst:{ before:previousBurst, after:1 } }));
