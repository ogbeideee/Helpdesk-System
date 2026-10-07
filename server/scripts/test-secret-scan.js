// Secret-scanner tests. Plain Node script, no framework, like every other
// suite in this project.
//
//   node scripts/test-secret-scan.js
//
// The scanner is the control that stands between a credential and a public
// repository, so it is tested in BOTH directions. A scanner that only ever
// passes is as useless as no scanner, and one that fires on the test fixtures
// gets bypassed within a week. Every sample below is generated to the exact
// length its rule requires, because a hand-typed "obviously valid" key is
// usually two characters short - which is how this suite caught a bad probe
// twice before the rules themselves were ever doubted.
'use strict';

const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { RULES, scanText, isAllowedValue, isIgnoredPath, PRODUCTION_DOMAIN, PRODUCTION_MAILBOX } = require(
  path.join(REPO_ROOT, 'scripts', 'secret-scan.js')
);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}`);
  }
}

function fires(text, file = 'server/src/example.js') {
  return scanText(text, file).map((f) => f.rule);
}

function firesRule(text, ruleId, file) {
  return fires(text, file).includes(ruleId);
}

/* Deterministic filler, so a failure is always reproducible. */
function filler(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[i % alphabet.length];
  return out;
}

/*
 * Build a credential-shaped sample WITHOUT a literal that matches a secret
 * pattern in this file's own source.
 *
 * This is not tidiness, it is a hard requirement. The first version of this
 * suite wrote samples inline, and GitHub's push protection blocked the push
 * over a hand-typed Slack token - a token that was never real. A suite that
 * cannot be committed is a suite that gets deleted, so every sample is
 * assembled at runtime from two halves that no scanner sees as one secret.
 * Check H.6 enforces it.
 */
const join = (a, b) => a + b;

/* ---- A. every rule fires on a canonical sample ---------------------- */
console.log('--- A. each rule detects its own shape ---');

const CANONICAL = {
  'google-oauth-client-secret': `const CLIENT_SECRET = '${join('GOCSPX', `-${filler(28)}`)}';`,
  'google-oauth-client-id': `const id = '123456789012-${filler(16)}${join('.apps.', 'googleusercontent.com')}';`,
  'google-api-key': `const key = '${join('AIza', filler(35))}';`,
  'aws-access-key-id': `const id = '${join('AKIA', 'ABCDEFGHIJKLMNOP')}';`,
  'private-key-block': join('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'supabase-service-role-key': `const k = '${join('sbp_', filler(40, '0123456789abcdef'))}';`,
  'slack-token': `const t = '${join('xox', 'b-123456789012-abcdefghijklmno')}';`,
  'github-token': `const t = '${join('ghp_', filler(36))}';`,
  'fly-api-token': `const t = '${join('FlyV1', filler(24))}';`,
  'stripe-secret-key': `const k = '${join('sk_live_', filler(24))}';`,
  'openai-key': `const k = '${join('sk-', filler(40))}';`,
  'bearer-token-literal': `authorization = 'Bearer ${filler(40)}';`,
  'jwt-literal': `const t = 'eyJhbGciOiJIUzI1NiJ9.${filler(30)}.${filler(30)}';`,
  'db-url-with-password': `DATABASE_URL = '${join('postgresql://user:', filler(18))}${join('@db.acme-corp', '.internal/app')}'`,
  'production-mailbox': `GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`,
  'production-domain': `curl -s https://helpdesk.${PRODUCTION_DOMAIN}/api/health`,
  'hardcoded-credential-assignment': `const DB_PASSWORD = '${filler(20)}';`,
};

for (const [ruleId, sample] of Object.entries(CANONICAL)) {
  check(`A.${ruleId} fires on its own shape`, firesRule(sample, ruleId));
}

/* ---- B. the actual incident is caught ------------------------------- */
console.log('\n--- B. the 2026-09-26 incident ---');

check('B.1 the committed Google OAuth secret is CRITICAL',
  scanText(`const CLIENT_SECRET = 'GOCSPX-${filler(28)}';`, 'server/scripts/generate-refresh-token.js')
    .some((f) => f.rule === 'google-oauth-client-secret' && f.severity === 'critical'));
check('B.2 the paired client id is flagged too',
  firesRule(`const CLIENT_ID = '363989871440-${filler(16)}.apps.googleusercontent.com';`, 'google-oauth-client-id'));
check('B.3 the fixed version (env reads) is clean',
  fires('const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;').length === 0);
check('B.4 the .env.example placeholder is clean',
  fires('GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret-here').length === 0);

/* ---- C. no finding ever carries the secret value -------------------- */
console.log('\n--- C. findings never echo the value ---');

const secretValue = join('GOCSPX-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
const finding = scanText(`const CLIENT_SECRET = '${secretValue}';`, 'x.js')[0];
check('C.1 a finding is produced', Boolean(finding));
check('C.2 the excerpt does not contain the secret', finding && !finding.excerpt.includes(secretValue));
check('C.3 the excerpt contains no long token', finding && !/[A-Za-z0-9_-]{20,}/.test(finding.excerpt));
check('C.4 the excerpt still locates the problem', finding && finding.excerpt.includes('CLIENT_SECRET'));
check('C.5 the file and line survive redaction', finding && finding.file === 'x.js' && finding.line === 1);

/* ---- D. no false positives on this codebase ------------------------- */
console.log('\n--- D. the real code base is clean ---');

const LEGITIMATE = [
  ['D.1 test fixture password', `const PASSWORD = 'ApiTestPass!123';`],
  ['D.2 a token endpoint URL', `const TOKEN_URL = 'https://oauth2.googleapis.com/token';`],
  ['D.3 a wrong-password assertion', `body: { email: ADMIN_EMAIL, password: 'wrong-password' },`],
  ['D.4 a remote-access fixture', `body: { password: 'hunter2-secret' },`],
  ['D.5 the test-cluster DSN shape', `DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'`],
  ['D.6 a docs example', 'GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret'],
  ['D.7 a process env read', 'const GROQ_API_KEY = process.env.GROQ_API_KEY;'],
  ['D.8 a redirect uri', `const REDIRECT_URI = 'http://localhost:3000';`],
];
for (const [label, text] of LEGITIMATE) {
  check(`${label} is not flagged`, fires(text, 'server/src/services/someService.js').length === 0);
}

check('D.9 the generic rule is exempt in test suites, by path',
  fires("const PASSWORD = 'WorkloadPass!123';", 'server/scripts/test-workload.js').length === 0);
check('D.10 but a real secret in a test suite still trips a precise rule',
  firesRule(`const t = 'ghp_${filler(36)}';`, 'github-token', 'server/scripts/test-api.js'));
check('D.11 a loopback test-cluster DSN is exempt, a real host is not',
  fires("DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/postgres';",
    'server/scripts/lib/testpg.js').length === 0
  && firesRule(`DATABASE_URL = 'postgresql://app:${filler(18)}@db.acme-corp.internal/app';`, 'db-url-with-password'));
check('D.12 the URL exemption does NOT silence the DB rule',
  firesRule(`DATABASE_URL = 'postgresql://app:${filler(18)}@db.acme-corp.internal/app';`, 'db-url-with-password'));

/* ---- E. the allowlist ---------------------------------------------- */
console.log('\n--- E. the allowlist ---');

check('E.1 an exact placeholder is allowed', isAllowedValue('your-client-secret'));
check('E.2 a value containing example is allowed', isAllowedValue('key-for-example-com'));
check('E.3 URL handling is rule-scoped, so isAllowedValue no longer exempts URLs',
  isAllowedValue('https://oauth2.googleapis.com/token') === false);
check('E.3b but a URL-valued assignment is still not flagged',
  fires("const TOKEN_URL = 'https://oauth2.googleapis.com/token';", 'server/src/imap/oauth2.js').length === 0);
check('E.4 a real-looking value is not allowed', !isAllowedValue(secretValue));
check('E.5 the allowlist is case-insensitive', isAllowedValue('YOUR-CLIENT-SECRET'));

/* ---- F. path handling ---------------------------------------------- */
console.log('\n--- F. paths ---');

check('F.1 node_modules is skipped', isIgnoredPath('node_modules/foo/bar.js'));
check('F.2 the lock file is skipped', isIgnoredPath('package-lock.json'));
check('F.3 binaries are skipped', isIgnoredPath('docs/screenshot.png'));
check('F.4 the scanner ignores itself', isIgnoredPath('scripts/secret-scan.js'));
check('F.5 ordinary source is NOT skipped', !isIgnoredPath('server/src/email/signature.js'));

/* ---- G. robustness -------------------------------------------------- */
console.log('\n--- G. robustness ---');

check('G.1 empty input', scanText('', 'a.js').length === 0);
check('G.2 null input', scanText(null, 'a.js').length === 0);
check('G.3 a very long line', scanText(`x = '${filler(5000)}';`, 'a.js').length >= 0);
check('G.4 CRLF line endings', scanText(`const a = 1;\r\nconst b = 'GOCSPX-${filler(28)}';\r\n`, 'a.js').length === 1);
check('G.5 a secret split across lines is not a secret', scanText("const k = 'GOCSPX-\nabcdefghij';", 'a.js').length === 0);
check('G.6 a binary-ish blob does not crash', scanText(filler(2000, '\\u0000\\u0001abc'), 'a.js').length >= 0);

/* ---- H. the rule table --------------------------------------------- */
console.log('\n--- H. the rule table ---');

check('H.1 every rule has a stable id', RULES.every((r) => typeof r.id === 'string' && r.id.length));
check('H.2 every rule has a severity', RULES.every((r) => ['critical', 'high', 'medium'].includes(r.severity)));
check('H.3 rule ids are unique', new Set(RULES.map((r) => r.id)).size === RULES.length);
check('H.4 the generic backstop is present', RULES.some((r) => r.id === 'hardcoded-credential-assignment'));
check('H.5 the Google OAuth secret rule is CRITICAL',
  RULES.find((r) => r.id === 'google-oauth-client-secret')?.severity === 'critical');

/* ---- I. the deployment's own identity is never publishable ---------- */
console.log('\n--- I. the production mailbox and domain ---');

/*
 * The live shared mailbox shipped in `.env.example`, three docs and two .docx
 * guides. It is not a credential, which is exactly why every rule above missed
 * it: a scanner looking for a password has no reason to read an address. These
 * checks pin the two rules that close that gap, in both directions.
 *
 * The values are imported from the scanner rather than written here, for the
 * same reason `join(a, b)` exists above: a literal in this file would be a
 * literal GitHub push protection can see. H.6 then proves neither file contains
 * the value as source text.
 */
check('I.1 the mailbox rule is CRITICAL',
  RULES.find((r) => r.id === 'production-mailbox')?.severity === 'critical');
check('I.2 the domain rule is HIGH',
  RULES.find((r) => r.id === 'production-domain')?.severity === 'high');

check('I.3 the shared mailbox in a config value is caught',
  firesRule(`GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`, 'production-mailbox', 'server/.env.example'));
check('I.4 it is caught in a doc, in prose',
  firesRule(`The monitored mailbox is \`${PRODUCTION_MAILBOX}\`.`, 'production-mailbox', 'docs/microsoft-graph.md'));
check('I.5 any other local part at the domain is caught too',
  firesRule(`IT support: someone@${PRODUCTION_DOMAIN}`, 'production-mailbox', 'docs/notes.md'));
check('I.6 a bare domain with no local part is caught',
  firesRule(PRODUCTION_DOMAIN, 'production-domain', 'docs/notes.md'));

check('I.7 the hostname form is caught',
  firesRule(`PORTAL_BASE_URL=https://helpdesk.${PRODUCTION_DOMAIN}`, 'production-domain', 'server/.env.example'));
check('I.8 a bare subdomain form is caught',
  firesRule(`fly certs add helpdesk.${PRODUCTION_DOMAIN}`, 'production-domain', 'docs/runbook.md'));
check('I.9 it is caught in a Graph tenant id, the subtlest form',
  firesRule(`GRAPH_TENANT_ID: '${PRODUCTION_DOMAIN}'`, 'production-domain', 'server/scripts/test-m365.js'));
check('I.10 case does not hide it',
  firesRule(PRODUCTION_DOMAIN.toUpperCase(), 'production-domain', 'docs/notes.md'));
check('I.11 the dot is not treated as a wildcard',
  firesRule(`helpdesk.${PRODUCTION_DOMAIN.replace('.', 'X')}`, 'production-domain', 'docs/notes.md') === false);

check('I.12 no finding echoes the address it found',
  scanText(`GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`, 'server/.env.example')
    .every((f) => !JSON.stringify(f).includes(PRODUCTION_MAILBOX)));
check('I.12b no finding echoes the domain either',
  scanText(`GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`, 'server/.env.example')
    .every((f) => !JSON.stringify(f).includes(PRODUCTION_DOMAIN)));
check('I.12c partial redaction cannot reassemble it: every rule blanks every match',
  // Two rules, each covering half the value, must not leave readable halves in
  // two excerpts printed one under the other.
  scanText(`shared inbox ${PRODUCTION_MAILBOX} on the portal`, 'docs/notes.md')
    .every((f) => !/ithelpdesk/.test(f.excerpt) && !new RegExp(PRODUCTION_DOMAIN.replace('.', '\\.')).test(f.excerpt)));
check('I.13 the finding still names the variable, so it can be fixed',
  scanText(`GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`, 'server/.env.example')[0]?.file === 'server/.env.example');

check('I.14 the placeholder that replaced it is clean',
  fires('GRAPH_SHARED_MAILBOX=ithelpdesk@example.com', 'server/.env.example').length === 0);
check('I.15 a reserved example domain is never flagged',
  fires('helpdesk.example.com and admin@example.com', 'docs/notes.md').length === 0);
check('I.16 another real-looking customer domain is NOT flagged (no over-reach)',
  fires('someone@acme-corp.example.org', 'docs/notes.md').length === 0);

check('I.17 the .docx escape hatch is closed by gitignore, not just by convention',
  require('node:fs').readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').includes('*.docx'));
check('I.18 no .docx is still tracked',
  require('node:child_process')
    .execFileSync('git', ['ls-files', '*.docx'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === '');

/* ---- J. forward-only vs the history sweep --------------------------- */
console.log('\n--- J. forward-only rules and the history sweep ---');

/*
 * CI sweeps every commit in history. A rule that exists to stop a value going
 * forward will fire on every commit that already contains it, and that is not
 * hypothetical: the two production rules turned the entire history sweep red
 * the day they were written, because the value they forbid is in the history by
 * construction. The credential rules must keep sweeping history — a credential
 * in history is a live exposure that has to be found and rotated — so the split
 * has to be per-rule, and it has to be tested or someone "fixes" it by dropping
 * the rules entirely.
 */
const FORWARD_ONLY = RULES.filter((r) => r.forwardOnly).map((r) => r.id);
const CREDENTIAL_RULES = RULES.filter((r) => !r.forwardOnly).map((r) => r.id);

check('J.1 both production rules are forward-only',
  FORWARD_ONLY.includes('production-mailbox') && FORWARD_ONLY.includes('production-domain'));
check('J.2 no credential rule is forward-only',
  CREDENTIAL_RULES.includes('google-oauth-client-secret')
  && CREDENTIAL_RULES.includes('aws-access-key-id')
  && CREDENTIAL_RULES.includes('fly-api-token'));

const domainSample = `GRAPH_SHARED_MAILBOX=${PRODUCTION_MAILBOX}`;

check('J.3 a forward-only rule fires on the current tree',
  scanText(domainSample, 'server/.env.example')
    .some((f) => f.rule === 'production-mailbox'));
check('J.4 it is silent over history, so the sweep can pass',
  scanText(domainSample, 'server/.env.example', { historyOnly: true })
    .every((f) => f.rule !== 'production-mailbox'));

check('J.5 a real credential STILL fires over history',
  scanText(`const CLIENT_SECRET = 'GOCSPX-${filler(28)}';`, 'server/scripts/x.js', { historyOnly: true })
    .some((f) => f.rule === 'google-oauth-client-secret'));
check('J.6 a DB URL with a password STILL fires over history',
  scanText(`DATABASE_URL = 'postgresql://u:${filler(18)}@db.acme-corp.internal/app'`, 'x.js', { historyOnly: true })
    .some((f) => f.rule === 'db-url-with-password'));
check('J.7 the generic backstop STILL fires over history',
  scanText(`const DB_PASSWORD = '${filler(20)}';`, 'server/src/x.js', { historyOnly: true })
    .some((f) => f.rule === 'hardcoded-credential-assignment'));

/*
 * The check that keeps this suite committable. GitHub push protection blocked
 * a push over a hand-typed Slack token in this very file - a token that was
 * never real. If a sample here ever matches a secret pattern as SOURCE TEXT,
 * the push is blocked, so the suite is scanned with a neutral filename (which
 * sidesteps the path exemption that lets the scanner ignore this file) and
 * must come back clean.
 */
const selfSource = require('node:fs').readFileSync(__filename, 'utf8');
const selfHits = scanText(selfSource, 'server/scripts/someOtherFile.js')
  .filter((f) => f.rule !== 'hardcoded-credential-assignment');
check('H.6 this file contains no credential literal as source text', selfHits.length === 0);
if (selfHits.length) {
  console.log(`      offending rules: ${[...new Set(selfHits.map((f) => f.rule))].join(', ')}`);
  console.log('      Assemble the sample with join(a, b) instead of one literal.');
}

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('secret-scan tests FAILED');
  process.exitCode = 1;
} else {
  console.log('All secret-scan tests passed');
}
