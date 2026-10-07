import assert from 'node:assert/strict';
import { outcomeLabel, deliveryLabel, operationTime, decisionExplanation } from './src/operationsView.js';
assert.equal(outcomeLabel('skipped_automated'), 'Screened out');
assert.equal(deliveryLabel('failed'), 'Failed');
assert.equal(deliveryLabel('expired'), 'Retry expired');
assert.equal(operationTime(null), '—');
assert.equal(decisionExplanation({ metadata: { reason: 'Copied by internal account', greeting: { reason: 'Unavailable' } } }), 'Copied by internal account · Greeting: Unavailable');
console.log('Operations view checks passed');
