import assert from 'node:assert/strict';
import { resolutionSuggestions } from './src/resolutionView.js';

for (const category of ['Password Reset', 'Software', 'Hardware', 'Inquiry / Help']) {
  const notes = resolutionSuggestions(category);
  assert.equal(notes.length, 3);
  assert.equal(new Set(notes).size, notes.length);
  for (const note of notes) {
    assert.ok(note.endsWith('.'));
    assert.ok(!/please|kindly|confirm|\[|\]/i.test(note), 'Notes describe outcomes without requests or placeholders');
  }
  notes.pop();
  assert.equal(resolutionSuggestions(category).length, 3);
}
assert.deepEqual(resolutionSuggestions('Unknown'), []);
assert.deepEqual(resolutionSuggestions(), []);
console.log('Resolution suggestion checks passed');
