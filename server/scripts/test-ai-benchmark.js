/* Focused suite for the AI classification benchmark (provider selection).
 *
 * Everything here runs against mocked providers and captured fetch
 * implementations — no network request is ever made, no database is needed,
 * and the real benchmark CLI is not invoked. The suite proves:
 *
 *   A. the case set is frozen and lives in the app's real value space;
 *   B. both adapters receive the identical shared instructions and enforce
 *      the identical 5-field schema in their native formats;
 *   C. JSON extraction copes with fences/prose and rejects garbage;
 *   D. schema validation (domains, confidence, signals, coercion rules);
 *   E. scoring against expected results, including trap/adversarial logic;
 *   F. the runner: same cases for every provider, latency measurement,
 *      per-case failure isolation (one error never aborts the run);
 *   G. adapters: request shape, timeout, HTTP errors, and that credentials
 *      never leak into error text or reports;
 *   H. the keyword baseline is a real comparator (it fails the cases the
 *      benchmark is designed to expose);
 *   I. report generation: the required summary lines and mismatch details.
 *
 * Usage: npm run test:ai-benchmark  (from server/) */

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { CATEGORIES, PRIORITIES } = require('../src/states');
const { CASES } = require('./lib/ai-benchmark/cases');
const {
  SYSTEM_INSTRUCTIONS,
  RESPONSE_FIELDS,
  buildUserPrompt,
} = require('./lib/ai-benchmark/prompt');
const {
  extractJson,
  validateStructured,
  scoreCase,
  tallyResults,
} = require('./lib/ai-benchmark/scoring');
const {
  makeGeminiProvider,
  makeGroqProvider,
  makeKeywordBaselineProvider,
  makeMockProvider,
} = require('./lib/ai-benchmark/providers');
const { runBenchmark } = require('./lib/ai-benchmark/runner');
const { formatReport } = require('./lib/ai-benchmark/report');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = Object.fromEntries(CASES.map((c) => [c.id, c]));

/* A provider that echoes the expected result as model-shaped JSON. */
function oracleProvider(label = 'Oracle') {
  return {
    id: 'oracle',
    label,
    model: 'oracle-1',
    remote: false,
    async classify({ testCase }) {
      return {
        text: JSON.stringify({
          category: testCase.expected.category,
          priority: testCase.expected.priority || 'moderate',
          confidence: 0.91,
          reason: `oracle echo for ${testCase.id}`,
          signals: [`case ${testCase.id}`],
        }),
      };
    },
  };
}

/* A provider with a scripted mix: wrong category (trap fall) on N, invalid
 * JSON on M, a thrown error on L, wrong priority on T, correct everywhere
 * else. */
function mixedProvider() {
  return {
    id: 'mixed',
    label: 'Mixed',
    model: 'mixed-1',
    remote: false,
    async classify({ testCase }) {
      if (testCase.id === 'L') throw new Error('boom: connection reset');
      if (testCase.id === 'M') return { text: 'Sure! Here you go: {not valid json' };
      const value = {
        category: testCase.id === 'N' ? 'Software' : testCase.expected.category,
        priority: testCase.id === 'T' ? 'moderate' : testCase.expected.priority || 'moderate',
        confidence: 0.7,
        reason: `mixed echo for ${testCase.id}`,
        signals: [],
      };
      if (testCase.id === 'F') await sleep(30); // a measurable latency for F
      return { text: JSON.stringify(value) };
    },
  };
}

/* Fetch recorder: canned JSON responses for adapter-shape assertions. */
function capturedFetch(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder(url, options, calls.length);
  };
  return { calls, impl };
}

const jsonResponse = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

async function main() {
  /* ================================================================ */
  /* A. Case-set integrity                                             */
  /* ================================================================ */
  console.log('--- A. case set ---');
  eq('A twenty cases', CASES.length, 20);
  eq('A ids are A..T in order', CASES.map((c) => c.id).join(''), 'ABCDEFGHIJKLMNOPQRST');
  check('A every case has subject/cleanBody/why', CASES.every((c) => c.subject && c.cleanBody && c.why));
  check('A expected categories are app categories', CASES.every((c) => CATEGORIES.includes(c.expected.category)));
  check('A expected priorities are app priorities or null', CASES.every((c) => c.expected.priority === null || PRIORITIES.includes(c.expected.priority)));
  const adversarial = CASES.filter((c) => c.adversarial);
  check('A adversarial cases exist and all carry traps', adversarial.length >= 5 && adversarial.every((c) => c.trap && CATEGORIES.includes(c.trap.category)));
  check('A ambiguous case O has no expected priority', byId.O.expected.priority === null);
  check('A very short case P has no expected priority', byId.P.expected.priority === null);
  eq('A adversarial case count', adversarial.length, 7);

  /* ================================================================ */
  /* B. Shared prompt parity                                           */
  /* ================================================================ */
  console.log('--- B. prompt parity ---');
  check('B instructions name every app category', CATEGORIES.every((c) => SYSTEM_INSTRUCTIONS.includes(c)));
  check('B instructions name every app priority', PRIORITIES.every((p) => SYSTEM_INSTRUCTIONS.includes(`"${p}"`)));
  check('B instructions name every response field', RESPONSE_FIELDS.every((f) => SYSTEM_INSTRUCTIONS.includes(f)));
  check('B instructions demand JSON output', /JSON object/.test(SYSTEM_INSTRUCTIONS));
  check(
    'B schema line lists the app priorities cleanly (no doubled quotes)',
    SYSTEM_INSTRUCTIONS.includes('"priority": "low" | "moderate" | "high" | "critical"'),
  );
  eq(
    'B user prompt carries subject and cleanBody verbatim',
    buildUserPrompt({ subject: 's1', cleanBody: 'b1' }),
    'Subject: s1\n\nBody:\nb1',
  );

  /* ================================================================ */
  /* C. extractJson                                                    */
  /* ================================================================ */
  console.log('--- C. extractJson ---');
  const valid = '{"category":"Software","priority":"moderate","confidence":0.8,"reason":"r","signals":["vpn"]}';
  eq('C plain object', extractJson(valid).category, 'Software');
  eq('C fenced object', extractJson('```json\n' + valid + '\n```').priority, 'moderate');
  eq('C prose-wrapped object', extractJson('Here you go:\n' + valid + '\nHope that helps!').confidence, 0.8);
  eq('C no braces is null', extractJson('no json here'), null);
  eq('C broken json is null', extractJson('{"category": '), null);
  eq('C empty is null', extractJson(''), null);
  eq('C non-string is null', extractJson(null), null);

  /* ================================================================ */
  /* D. validateStructured                                             */
  /* ================================================================ */
  console.log('--- D. validateStructured ---');
  const base = { category: 'Software', priority: 'moderate', confidence: 0.8, reason: 'vpn client issue', signals: ['vpn drops'] };
  const okFull = validateStructured(base);
  check('D full valid object passes', okFull.ok && okFull.value.category === 'Software' && okFull.value.confidence === 0.8);
  check('D extra keys are tolerated', validateStructured({ ...base, model_note: 'x' }).ok);
  check('D category is case-normalized', validateStructured({ ...base, category: 'software' }).value.category === 'Software');
  check('D invented category rejected', !validateStructured({ ...base, category: 'Networking' }).ok);
  check('D invented priority rejected', !validateStructured({ ...base, priority: 'urgent' }).ok);
  check('D numeric-string confidence coerced', validateStructured({ ...base, confidence: '0.8' }).value.confidence === 0.8);
  check('D word confidence rejected', !validateStructured({ ...base, confidence: 'high' }).ok);
  check('D out-of-range confidence rejected', !validateStructured({ ...base, confidence: 1.4 }).ok);
  check('D missing signals rejected', !validateStructured({ ...base, signals: undefined }).ok);
  check('D non-string signals rejected', !validateStructured({ ...base, signals: ['a', 3] }).ok);
  check('D empty reason rejected', !validateStructured({ ...base, reason: '   ' }).ok);
  check('D null/array parsed values rejected', !validateStructured(null).ok && !validateStructured([base]).ok);
  check('D problems explain the first failure', (validateStructured({ ...base, priority: 'urgent' }).problems.join(' ') || '').includes('priority'));

  /* ================================================================ */
  /* E. scoreCase                                                      */
  /* ================================================================ */
  console.log('--- E. scoreCase ---');
  const outcomeFor = (v) => ({ valid: Boolean(v), value: v, error: null });
  const eOk = scoreCase(byId.M, outcomeFor({ category: 'Password Reset', priority: 'high', confidence: 0.7, reason: '', signals: [] }));
  check('E correct category scores ok', eOk.categoryOk && eOk.priorityOk === true);
  check('E correct category means trap ignored', eOk.trapIgnored === true && eOk.fellForTrap === false);
  const eTrap = scoreCase(byId.N, outcomeFor({ category: 'Software', priority: 'moderate', confidence: 0.9, reason: '', signals: [] }));
  check('E trap category is a miss despite high confidence', !eTrap.categoryOk && eTrap.trapIgnored === false && eTrap.fellForTrap === true);
  const o = scoreCase(byId.O, outcomeFor({ category: 'Inquiry / Help', priority: 'low', confidence: 0.5, reason: '', signals: [] }));
  check('E O has no determinable priority (excluded, not failed)', o.priorityOk === null && o.categoryOk);
  check('E invalid outcome can never score ok', !scoreCase(byId.A, { valid: false, value: null, error: null }).categoryOk);
  check('E non-adversarial case has no trap score', scoreCase(byId.A, outcomeFor({ category: 'Software', priority: 'high', confidence: 1, reason: '', signals: [] })).trapIgnored === null);
  check('E combined correctness tolerates an unscoreable priority', scoreCase(byId.O, outcomeFor({ category: 'Inquiry / Help', priority: 'low', confidence: 1, reason: '', signals: [] })).priorityOk === null);

  /* ================================================================ */
  /* F. Runner                                                         */
  /* ================================================================ */
  console.log('--- F. runner ---');
  const seen = { oracle: [], mixed: [] };
  const capture = (id) => ({ id, label: id, model: id, remote: false, async classify(ctx) { seen[id].push(ctx); return oracleProvider().classify(ctx); } });
  const run = await runBenchmark({ cases: CASES, providers: [capture('oracle'), capture('mixed')] });
  eq('F every provider ran every case', run.providers.map((p) => p.results.length).join(','), '20,20');
  check('F identical context handed to both providers', seen.oracle.every((c, i) => c.user === seen.mixed[i].user && c.system === seen.mixed[i].system));
  const oracle = run.providers[0];
  eq('F oracle category 20/20', oracle.tally.categoryCorrect, 20);
  eq('F oracle valid 20/20', oracle.tally.valid, 20);
  eq('F oracle priority denominator excludes O and P', oracle.tally.priorityTotal, 18);
  eq('F oracle priority 18/18', oracle.tally.priorityCorrect, 18);
  eq('F oracle combined 20/20', oracle.tally.combinedCorrect, 20);

  const mixedRun = await runBenchmark({ cases: CASES, providers: [mixedProvider()] });
  const m = mixedRun.providers[0];
  eq('F mixed: run completed despite a thrown case', m.results.length, 20);
  eq('F mixed: errors counted', m.tally.errors, 1);
  eq('F mixed: invalid JSON counted separately', m.tally.invalid, 1);
  eq('F mixed: valid structured responses', m.tally.valid, 18);
  eq('F mixed: category accuracy (error and invalid rows count as misses)', m.tally.categoryCorrect, 17);
  eq('F mixed: priority accuracy', m.tally.priorityCorrect, 15);
  eq('F mixed: combined accuracy', m.tally.combinedCorrect, 16);
  eq('F mixed: adversarial pass count', m.tally.adversarialPassed, 4);
  eq('F mixed: trap falls counted', m.tally.fellForTrap, 1);
  eq('F mixed: median latency computed', typeof m.tally.medianLatencyMs, 'number');
  check('F mixed: confidence split recorded', m.tally.avgConfidenceOnCorrect === 0.7 && m.tally.avgConfidenceOnIncorrect === 0.7);
  const failed = m.results.find((r) => r.case.id === 'L');
  check('F mixed: error message preserved on the case', failed.outcome.error && failed.outcome.error.includes('boom'));
  const slow = m.results.find((r) => r.case.id === 'F');
  check('F latency measured per case (>=20ms for the sleeping case)', slow.latencyMs >= 20);
  check('F all latencies non-negative numbers', m.results.every((r) => Number.isFinite(r.latencyMs) && r.latencyMs >= 0));
  check('F avg latency computed', typeof m.tally.avgLatencyMs === 'number' && m.tally.avgLatencyMs >= 0);

  const baseRun = await runBenchmark({ cases: CASES, providers: [makeKeywordBaselineProvider()] });
  const b = baseRun.providers[0];
  check('F value-returning provider skips the JSON stage and stays valid', b.tally.valid === 20 && b.results.every((r) => r.outcome.valid));
  check('F baseline confidence is null (none invented)', b.tally.avgConfidence === null);

  // Rate-limit (429) responses are retried with backoff, not recorded as
  // failures; non-retryable HTTP errors fail the case on the first attempt.
  let flakyCalls = 0;
  const flakyRun = await runBenchmark({
    cases: CASES.slice(0, 1),
    providers: [{
      id: 'flaky', label: 'Flaky', model: 'flaky', remote: false,
      async classify(ctx) {
        flakyCalls += 1;
        if (flakyCalls <= 2) throw new Error('Groq HTTP 429: rate limited — please try again in 20ms.');
        return {
          text: JSON.stringify({ category: ctx.testCase.expected.category, priority: ctx.testCase.expected.priority || 'moderate', confidence: 0.5, reason: 'ok', signals: [] }),
        };
      },
    }],
  });
  eq('F 429s are retried until success, never failed', flakyRun.providers[0].tally.errors, 0);
  eq('F retried case consumed all three attempts', flakyCalls, 3);
  let refusedCalls = 0;
  const refusedRun = await runBenchmark({
    cases: CASES.slice(0, 1),
    providers: [{
      id: 'refused', label: 'Refused', model: 'refused', remote: false,
      async classify() { refusedCalls += 1; throw new Error('Gemini HTTP 401: bad key'); },
    }],
  });
  eq('F non-retryable HTTP errors fail immediately', refusedRun.providers[0].tally.errors, 1);
  eq('F non-retryable HTTP errors are attempted once', refusedCalls, 1);

  /* ================================================================ */
  /* G. Adapters (captured fetch — no network)                        */
  /* ================================================================ */
  console.log('--- G. adapters ---');
  const geminiOk = jsonResponse(200, { candidates: [{ content: { parts: [{ text: valid }] } }] });
  const gCap = capturedFetch(() => geminiOk);
  const gemini = makeGeminiProvider({ apiKey: 'SECRET-GEMINI-KEY', fetchImpl: gCap.impl, baseUrl: 'http://bench.test', timeoutMs: 5000 });
  const geminiOut = await gemini.classify({ system: SYSTEM_INSTRUCTIONS, user: 'u', subject: 's', cleanBody: 'b', testCase: byId.A });
  eq('G gemini returns raw text for the JSON stage', JSON.parse(geminiOut.text).category, 'Software');
  const gReq = gCap.calls[0];
  check('G gemini URL is the generateContent endpoint with the model', gReq.url === 'http://bench.test/models/gemini-2.5-flash-lite:generateContent');
  eq('G gemini key rides in the x-goog-api-key header only', gReq.options.headers['x-goog-api-key'], 'SECRET-GEMINI-KEY');
  check('G gemini key never in URL or body', !gReq.url.includes('SECRET') && !gReq.options.body.includes('SECRET'));
  eq('G gemini gets the shared instructions verbatim', gReq.body.systemInstruction.parts[0].text, SYSTEM_INSTRUCTIONS);
  eq('G gemini forces JSON mime type', gReq.body.generationConfig.responseMimeType, 'application/json');
  check('G gemini schema requires exactly the five fields', gReq.body.generationConfig.responseSchema.required.join(',') === 'category,priority,confidence,reason,signals');
  check('G gemini schema enums are the app values', JSON.stringify(gReq.body.generationConfig.responseSchema.properties.category.enum) === JSON.stringify(CATEGORIES));
  eq('G gemini temperature pinned to 0', gReq.body.generationConfig.temperature, 0);

  const groqOk = jsonResponse(200, { choices: [{ message: { content: valid } }] });
  const qCap = capturedFetch(() => groqOk);
  const groq = makeGroqProvider({ apiKey: 'SECRET-GROQ-KEY', fetchImpl: qCap.impl, baseUrl: 'http://bench.test', timeoutMs: 5000 });
  await groq.classify({ system: SYSTEM_INSTRUCTIONS, user: 'u', subject: 's', cleanBody: 'b', testCase: byId.A });
  const qReq = qCap.calls[0];
  check('G groq URL is the chat completions endpoint', qReq.url === 'http://bench.test/chat/completions');
  eq('G groq key rides in the bearer header only', qReq.options.headers.authorization, 'Bearer SECRET-GROQ-KEY');
  eq('G groq gets the identical shared instructions', qReq.body.messages[0].content, SYSTEM_INSTRUCTIONS);
  eq('G groq JSON mode on', qReq.body.response_format.type, 'json_object');
  check('G groq model default is a qwen model', qReq.body.model.startsWith('qwen/'));
  eq('G groq temperature pinned to 0', qReq.body.temperature, 0);

  const errCap = capturedFetch(() => jsonResponse(429, { error: { message: 'rate limited' } }));
  const errProvider = makeGroqProvider({ apiKey: 'SECRET-GROQ-KEY', fetchImpl: errCap.impl, baseUrl: 'http://bench.test', timeoutMs: 5000 });
  let httpErr = null;
  try { await errProvider.classify({ system: 's', user: 'u' }); } catch (e) { httpErr = e; }
  check('G HTTP failure surfaces status in the error', httpErr && httpErr.message.includes('HTTP 429') && httpErr.message.includes('rate limited'));
  check('G credentials never appear in error text', httpErr && !httpErr.message.includes('SECRET'));

  // Signal-aware hanging fetch: the adapter's own AbortController cuts it off.
  const hanging = (url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const hungProvider = makeGeminiProvider({ apiKey: 'k', fetchImpl: hanging, baseUrl: 'http://bench.test', timeoutMs: 70 });
  const t0 = Date.now();
  let timeoutErr = null;
  try { await hungProvider.classify({ system: 's', user: 'u' }); } catch (e) { timeoutErr = e; }
  check('G timeout rejects with a timeout error', timeoutErr && /timed out after 70 ms/.test(timeoutErr.message));
  check('G timeout fires near the configured bound', Date.now() - t0 >= 60 && Date.now() - t0 < 2000);

  let missingKey = null;
  try { makeGeminiProvider({}); } catch (e) { missingKey = e; }
  check('G gemini factory refuses a missing key', missingKey && missingKey.message.includes('GEMINI_API_KEY'));
  let missingGroq = null;
  try { makeGroqProvider({}); } catch (e) { missingGroq = e; }
  check('G groq factory refuses a missing key', missingGroq && missingGroq.message.includes('GROQ_API_KEY'));

  // A provider that always fails must not abort the run.
  const deadRun = await runBenchmark({
    cases: CASES,
    providers: [{ id: 'dead', label: 'Dead', model: 'dead', remote: false, async classify() { throw new Error('unreachable'); } }],
  });
  eq('G a fully failing provider yields 20 errors, no abort', deadRun.providers[0].tally.errors, 20);

  /* ================================================================ */
  /* H. Keyword baseline is a real comparator                         */
  /* ================================================================ */
  console.log('--- H. keyword baseline ---');
  const baseline = makeKeywordBaselineProvider();
  const qOut = await baseline.classify({ subject: byId.Q.subject, cleanBody: byId.Q.cleanBody, testCase: byId.Q });
  eq('H baseline misses the misspelled keyboard (falls to default)', qOut.value.category, 'Inquiry / Help');
  const fOut = await baseline.classify({ subject: byId.F.subject, cleanBody: byId.F.cleanBody, testCase: byId.F });
  eq('H baseline still nails the password lockout', fOut.value.category, 'Password Reset');
  const lOut = await baseline.classify({ subject: byId.L.subject, cleanBody: byId.L.cleanBody, testCase: byId.L });
  eq('H baseline falls for the incidental password keyword on L', lOut.value.category, 'Password Reset');
  const nOut = await baseline.classify({ subject: byId.N.subject, cleanBody: byId.N.cleanBody, testCase: byId.N });
  eq('H baseline falls for the working-system keywords on N', nOut.value.category, 'Software');
  const sOut = await baseline.classify({ subject: byId.S.subject, cleanBody: byId.S.cleanBody, testCase: byId.S });
  eq('H baseline falls for the signature tagline on S', sOut.value.category, 'Software');
  const cOut = await baseline.classify({ subject: byId.C.subject, cleanBody: byId.C.cleanBody, testCase: byId.C });
  eq('H baseline nails the plain printer breakdown', cOut.value.category, 'Hardware');

  const mock = makeMockProvider();
  const mockOk = await mock.classify({ testCase: byId.F });
  check('H mock provider returns parseable JSON for F', JSON.parse(mockOk.text).category === 'Password Reset');
  const mockMiss = await mock.classify({ testCase: byId.C });
  check('H mock provider scripts a category miss on C', JSON.parse(mockMiss.text).category === 'Software');
  let mockErr = null;
  try { await mock.classify({ testCase: byId.L }); } catch (e) { mockErr = e; }
  check('H mock provider simulates a transport failure on L', mockErr && /timeout/.test(mockErr.message));

  /* ================================================================ */
  /* I. Report generation                                             */
  /* ================================================================ */
  console.log('--- I. report ---');
  const report = formatReport(mixedRun);
  const lines = report.split('\n');
  check('I provider block present', lines.some((l) => l.startsWith('Provider: Mixed')));
  check('I category accuracy line', report.includes('Category accuracy: 17/20'));
  check('I priority accuracy line with denominator', report.includes('Priority accuracy: 15/18'));
  check('I combined accuracy line', report.includes('Combined (category AND priority): 16/20'));
  check('I valid JSON line', report.includes('Valid JSON: 18/20'));
  check('I avg latency line', /Avg latency: \d+ ms/.test(report));
  check('I median latency line', /Median latency: \d+ ms/.test(report));
  check('I avg confidence line with correct/incorrect split', /Avg confidence: 0\.70\s+\(on correct: 0\.70, on incorrect: 0\.70\)/.test(report));
  check('I misleading-keyword line', report.includes('Misleading-keyword cases (incidental keywords ignored): 4/7'));
  check('I error count line', report.includes('Errors (timeout/transport/HTTP): 1'));
  check('I mismatch section exists', report.includes('Mismatched / failed cases'));
  const nBlock = report.split('[Mixed] N.')[1] || '';
  check('I mismatch shows expected and actual', nBlock.includes('expected: Hardware') && nBlock.includes('actual:   Software'));
  check('I mismatch shows confidence and latency', /confidence 0\.70/.test(nBlock) && /\d+ ms/.test(nBlock));
  check('I mismatch explains the trap', nBlock.includes('trap:') && nBlock.includes('Teams/Outlook/VPN'));
  const lBlock = report.split('[Mixed] L.')[1] || '';
  check('I transport failure rendered as ERROR', lBlock.includes('ERROR') && lBlock.includes('boom'));
  const mBlock = report.split('[Mixed] M.')[1] || '';
  check('I invalid JSON rendered with the problem', mBlock.includes('INVALID RESPONSE') && mBlock.includes('no parseable JSON'));
  check('I per-case table has expected/actual columns', /\bF\s+\d+ ms\s+conf 0\.70\s+exp Password Reset\/high/.test(report));
  check('I per-case PASS and FAIL marks present', report.includes('-> Password Reset/high  PASS') && report.includes('-> Software/moderate  FAIL'));
  check('I failure reason shown under the per-case row', /reason: mixed echo for N/.test(report));
  check('I final comparison section present', report.includes('FINAL COMPARISON'));
  check('I comparison carries the provider numbers', report.includes('- Category: 17/20') && report.includes('- Priority: 15/18') && report.includes('- Combined: 16/20') && report.includes('- Valid JSON: 18/20') && report.includes('- Misleading-keyword accuracy: 4/7'));
  check('I comparison carries failures line', report.includes('- Failures: 2 (1 API error(s), 1 invalid response(s))'));
  check('I report leaks no credential material', !report.includes('SECRET') && !report.toLowerCase().includes('authorization'));

  /* ================================================================ */
  /* J. JSON export + comparison charts                                */
  /* ================================================================ */
  console.log('--- J. json export + comparison charts ---');
  const { runToJson } = require('./lib/ai-benchmark/serialize');
  const { buildComparisonHtml } = require('./lib/ai-benchmark/visualize');

  const mixedJson = runToJson(mixedRun, 'mock');
  eq('J export schema marker', mixedJson.schema, 1);
  eq('J export records the mode', mixedJson.mode, 'mock');
  eq('J export carries the provider label', mixedJson.providers[0].label, 'Mixed');
  eq('J export carries all twenty case rows', mixedJson.providers[0].cases.length, 20);
  eq('J export carries the tally verbatim', mixedJson.providers[0].tally.categoryCorrect, m.tally.categoryCorrect);
  const jStr = JSON.stringify(mixedJson);
  check('J export carries no case subjects', !jStr.includes(byId.B.subject));
  check('J export carries no case bodies', !jStr.includes('consolidation workbook'));
  check('J export carries no credential material', !jStr.includes('SECRET') && !jStr.toLowerCase().includes('authorization'));
  const jN = mixedJson.providers[0].cases.find((c) => c.id === 'N');
  eq('J N row keeps the wrong actual category', jN.actual.category, 'Software');
  check('J N row flags the trap fall', jN.fellForTrap === true && jN.categoryOk === false);
  const jL = mixedJson.providers[0].cases.find((c) => c.id === 'L');
  check('J L row carries the error, not a value', jL.valid === false && /boom: connection reset/.test(jL.error) && jL.actual === null);
  const jM = mixedJson.providers[0].cases.find((c) => c.id === 'M');
  check('J M row carries the validation problems', jM.valid === false && jM.problems.length >= 1);

  const html = buildComparisonHtml([mixedJson, runToJson(baseRun, 'live')]);
  check('J page names both providers', html.includes('Mixed') && html.includes('Keyword baseline'));
  check('J page badges mock and live sources', html.includes('MOCK') && html.includes('LIVE'));
  check('J page carries the mock-data banner', html.includes('Mock data present'));
  check('J page shows mixed category accuracy 85%', html.includes('85%'));
  check('J page shows baseline category accuracy 65%', html.includes('65%'));
  check('J page renders every case row', CASES.every((c) => new RegExp(`>${c.id}\\. `, 'i').test(html)));
  check('J page renders svg charts', (html.match(/<svg/g) || []).length >= 4);
  check('J page marks confidence informational', /confidence[^<]*informational/i.test(html));
  check('J page renders no NaN or undefined coordinates', !/\bNaN\b/.test(html) && !/>undefined</.test(html));
  check('J page leaks no case bodies or subjects', !html.includes('consolidation workbook') && !html.includes(byId.A.subject));
  check('J page leaks no credential material', !html.includes('SECRET') && !html.toLowerCase().includes('authorization'));
  check('J mock provider is tagged in the metrics table', html.includes('Mixed <em class="tag-mock">mock</em>'));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`suite crashed: ${err.stack || err.message}`);
  process.exit(1);
});
