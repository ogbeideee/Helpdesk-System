import assert from 'node:assert/strict';
import { outcomeLabel, deliveryLabel, operationTime, decisionExplanation, decisionSender, decisionMessageId } from './src/operationsView.js';
assert.equal(outcomeLabel('skipped_automated'), 'Screened out');
assert.equal(deliveryLabel('failed'), 'Failed');
assert.equal(deliveryLabel('expired'), 'Retry expired');
assert.equal(operationTime(null), '—');
assert.equal(decisionExplanation({ metadata: { reason: 'Copied by internal account', greeting: { reason: 'Unavailable' } } }), 'Copied by internal account · Greeting: Unavailable');
// The ledger names the outcome in the queue's own vocabulary: a threaded reply
// is "Reply added", not the raw status.
assert.equal(outcomeLabel('comment_added'), 'Reply added');
// Who wrote in — without it a row cannot be matched to the mail it is about.
assert.equal(decisionSender({ metadata: { sender: 'someone@example.com' } }), 'someone@example.com');
assert.equal(decisionSender({ metadata: {} }), '—');
assert.equal(decisionSender({}), '—');
assert.equal(decisionMessageId({ metadata: { messageId: 'abc@example.com' } }), 'abc@example.com');
assert.equal(decisionMessageId({}), '');
console.log('Operations view checks passed');
