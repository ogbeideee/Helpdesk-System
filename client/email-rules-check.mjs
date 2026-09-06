/* Email parsing rules admin UI — pure view-model checks (no React, no DOM). */
import {
  PRIORITIES, SCOPES, EMPTY_FORM, ruleToForm, ruleRows, parseKeywordsText,
  validateForm, formsDiffer,
} from './src/emailRulesView.js';

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* --- keyword parsing ---------------------------------------------------- */
eq('P1 empty textarea yields no keywords', parseKeywordsText('').length, 0);
eq('P2 null input is safe', parseKeywordsText(null).length, 0);
eq('P3 one phrase per line', parseKeywordsText('vpn\nremote access').join('|'), 'vpn|remote access');
eq('P4 commas and semicolons split too', parseKeywordsText('vpn, office 365; printer').length, 3);
eq('P5 whitespace is trimmed', parseKeywordsText('  vpn  \n printer\t').join('|'), 'vpn|printer');
eq('P6 duplicates collapse case-insensitively', parseKeywordsText('VPN\nvpn\nVpn').length, 1);
eq('P7 empty tokens are dropped', parseKeywordsText('vpn\n\n  \nprinter').length, 2);
eq('P8 the list is capped deterministically', parseKeywordsText(Array.from({ length: 40 }, (_, i) => `k${i}`).join('\n')).length, 25);
check('P9 odd characters survive verbatim (no regex interpretation)',
  parseKeywordsText('a.*b (weird) [x]').join('|'), 'a.*b (weird) [x]');

/* --- form validation ----------------------------------------------------- */
const valid = validateForm({ ...EMPTY_FORM, name: 'VPN rule', keywordsText: 'vpn\nconnection drops', precedence: '10' });
eq('V1 a keywords+name form validates', valid.errors.length, 0);
eq('V2 the payload carries the keyword array', JSON.stringify(valid.payload.keywords), JSON.stringify(['vpn', 'connection drops']));
eq('V3 unset fields are explicit nulls', valid.payload.category === null && valid.payload.priority === null && valid.payload.teamKey === null, true);
eq('V4 scope defaults to both', valid.payload.scope, 'both');
eq('V5 precedence is a number', valid.payload.precedence, 10);

eq('V6 missing name is rejected', validateForm({ ...EMPTY_FORM, keywordsText: 'vpn' }).errors.length >= 1, true);
eq('V7 missing keywords is rejected', validateForm({ ...EMPTY_FORM, name: 'x' }).errors.length >= 1, true);
eq('V8 keyword-less payload is never produced', validateForm({ ...EMPTY_FORM, name: 'x' }).payload, null);
check('V9 an invalid priority is caught',
  validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', priority: 'urgent' }).errors.some((e) => e.includes('Priority')));
check('V10 an unknown group is caught',
  validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', teamKey: 'nope' }, { groups: [{ key: 'service_desk' }] }).errors.some((e) => e.includes('group')));
eq('V11 a known group passes', validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', teamKey: 'service_desk' }, { groups: [{ key: 'service_desk' }] }).errors.length, 0);
check('V12 a non-integer precedence is caught',
  validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', precedence: '1.5' }).errors.length >= 1);
check('V13 a negative precedence is caught',
  validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', precedence: '-2' }).errors.length >= 1);
eq('V14 unknown scope values fall back to both',
  validateForm({ ...EMPTY_FORM, name: 'x', keywordsText: 'a', scope: 'everywhere' }).payload.scope, 'both');

/* --- form round-trip ------------------------------------------------------ */
const stored = {
  id: 3, name: 'Hardware', keywords: ['printer', 'laptop'], scope: 'subject',
  category: 'Hardware', priority: 'high', teamKey: 'service_desk',
  precedence: 5, enabled: false, updatedAt: '2026-09-01T00:00:00Z',
};
const back = ruleToForm(stored);
eq('F1 keywords round-trip one per line', back.keywordsText, 'printer\nlaptop');
eq('F2 null fields round-trip as empty strings', ruleToForm({ ...stored, category: null, priority: null, teamKey: null }).category, '');
eq('F3 precedence round-trips as text', back.precedence, '5');
eq('F4 disabled round-trips', back.enabled, false);
eq('F5 missing rule yields the empty form', JSON.stringify(ruleToForm(null)), JSON.stringify(EMPTY_FORM));

/* --- rows ------------------------------------------------------------------ */
const rows = ruleRows([
  { id: 2, name: 'B', keywords: ['x'], scope: 'body', precedence: 10, enabled: true, category: null, priority: null, teamKey: null },
  { id: 1, name: 'A', keywords: ['y'], scope: 'both', precedence: 10, enabled: false, category: 'Software', priority: 'high', teamKey: 'network' },
]);
eq('R1 rows order by precedence then id', rows.map((r) => r.name).join(','), 'A,B');
eq('R2 the sets column joins the overridden fields', rows[0].setsLabel, 'Software · high · network');
eq('R3 a match-only rule says so', rows[1].setsLabel, null);
eq('R4 scope labels resolve', rows[0].scopeLabel, 'Subject + body');
eq('R5 disabled state is preserved', rows[0].enabled, false);
eq('R6 null input yields no rows', ruleRows(null).length, 0);

/* --- change detection -------------------------------------------------------- */
const formA = ruleToForm(stored);
eq('D1 identical forms do not differ', formsDiffer(formA, formA), false);
eq('D2 an edited keyword list differs', formsDiffer(formA, { ...formA, keywordsText: 'printer\nlaptop\nmouse' }), true);
eq('D3 an edited enable flag differs', formsDiffer(formA, { ...formA, enabled: true }), true);

/* --- constants ------------------------------------------------------------------ */
check('C1 priorities mirror the API states', JSON.stringify(PRIORITIES) === JSON.stringify(['low', 'moderate', 'high', 'critical']));
check('C2 the three scopes exist', SCOPES.map((s) => s.value).sort().join(',') === 'body,both,subject');

console.log(failures === 0 ? `\nemail-rules-check: ALL PASS (${passes} checks)` : `\nemail-rules-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
