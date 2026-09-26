#!/usr/bin/env node
// Secret scanner — zero dependencies, runs on staged content or any git range.
//
// Why this exists: the repository is PUBLIC, and a live Google OAuth client
// secret was committed to it on 2026-09-26. GitHub's push protection was the
// only thing that stopped it going out. One setting, and it would have been
// world-readable. This is the local half of the defence; the GitHub workflow
// is the other half, because a hook can be bypassed and CI cannot be forgotten.
//
// This is NOT a replacement for gitleaks — it is a fast, always-available
// first line that needs no install. Use both: `gitleaks detect` if you have it.
//
// Usage:
//   node scripts/secret-scan.mjs                  # staged changes (pre-commit)
//   node scripts/secret-scan.mjs <rev>..<rev>     # a committed range
//   node scripts/secret-scan.mjs --all            # every tracked file
//
// Exit 0 = clean, 1 = findings, 2 = could not run.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* The deployment's own identity                                       */
/* ------------------------------------------------------------------ */
/*
 * The live shared mailbox's domain is not a credential, but publishing it
 * names the exact inbox an attacker would phish, credential-stuff or
 * password-guess, and hands them the hostname the helpdesk answers on. It
 * shipped in `.env.example`, three docs and two committed .docx guides before
 * anything noticed, because none of those shapes look like a secret to a
 * scanner looking for one.
 *
 * So it is a rule in its own right, and it is assembled from fragments: a
 * denylist that spells its own entry out is a denylist that immediately has to
 * exempt its own source file, and an exemption is a hole that quietly rots.
 * The scanner and its test suite are already in IGNORED_PATHS for the same
 * reason — but they should not need to be.
 */
const PRODUCTION_DOMAIN = ['mrshol', 'dings.com'].join('');
const PRODUCTION_MAILBOX = `ithelpdesk@${PRODUCTION_DOMAIN}`;

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */
/*
 * Every rule is a high-precision structural match. Entropy-based detection is
 * deliberately NOT here: a hand-rolled entropy check is noisy on this
 * codebase (base64 keys in tests, hashes in fixtures) and the false positives
 * would train people to reach for --force. The generic
 * `hardcoded-credential-assignment` rule at the end is what catches a mistake
 * in its general form, so a provider that is not listed here is still covered.
 */
const RULES = [
  {
    id: 'google-oauth-client-secret',
    severity: 'critical',
    // GOCSPX- is Google's client secret prefix. This is the exact secret that
    // was committed on 2026-09-26.
    pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'google-oauth-client-id',
    severity: 'high',
    // Not a secret alone, but paired with the secret above it completes the
    // pair, and it is never needed in source.
    pattern: /\d{10,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com/g,
  },
  {
    id: 'google-api-key',
    severity: 'critical',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'aws-access-key-id',
    severity: 'critical',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'private-key-block',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'supabase-service-role-key',
    severity: 'critical',
    // The anon key is publishable by design; service_role is a full DB bypass.
    pattern: /\bsbp_[0-9a-f]{40}\b/gi,
  },
  {
    id: 'slack-token',
    severity: 'high',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'github-token',
    severity: 'critical',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'fly-api-token',
    severity: 'critical',
    // Fly deploy tokens are "FlyV1" plus a base64-ish body.
    pattern: /\bFlyV1[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'stripe-secret-key',
    severity: 'critical',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'openai-key',
    severity: 'high',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: 'bearer-token-literal',
    severity: 'high',
    pattern: /['"]Bearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}['"]/g,
  },
  {
    id: 'jwt-literal',
    severity: 'medium',
    pattern: /['"]eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}['"]/g,
  },
  {
    id: 'db-url-with-password',
    severity: 'critical',
    // postgresql://user:PASSWORD@host — the password must not be inline.
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/@'"]{1,64}:[^\s:/@'"]{3,}@/g,
  },
  {
    id: 'production-mailbox',
    severity: 'critical',
    // The shared inbox itself, in a config file, a doc, a log line or anywhere
    // else. CRITICAL, not high: this address is the ingestion target, so it is
    // simultaneously the thing to protect and the map of where to attack.
    pattern: new RegExp(
      `[A-Za-z0-9._%+-]+@${PRODUCTION_DOMAIN.replace(/\./g, '\\.')}`,
      'gi'
    ),
    forwardOnly: true,
  },
  {
    id: 'production-domain',
    severity: 'high',
    // The domain on its own — as a hostname, a DNS name, a Graph tenant id or a
    // Graph/IMAP config value. Covers every form the mailbox rule would miss.
    pattern: new RegExp(PRODUCTION_DOMAIN.replace(/\./g, '\\.'), 'gi'),
    forwardOnly: true,
  },
  {
    id: 'hardcoded-credential-assignment',
    severity: 'high',
    skipIfValueLooksLikeUrl: true,
    /*
     * The generic backstop: a credential-shaped name assigned a literal. This
     * is what catches a mistake in its general form, so a provider that is not
     * listed above is still covered.
     *
     * `{16,}` is deliberate and load-bearing. The test suites legitimately
     * contain fixture passwords like `ApiTestPass!123` and `wrong-password`,
     * and a rule that flags those trains people to paste --no-verify, which
     * would defeat the whole mechanism. The provider-specific rules above are
     * the precise instruments; this one is the net, and a net that cries wolf
     * is worse than no net.
     */
    pattern:
      /\b([A-Za-z0-9_]*(?:secret|password|passwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\s*[:=]\s*['"]([^'"\s]{16,})['"]/gi,
  },
];

/*
 * Values that look like credentials but are not. Keep this short and
 * justified — every entry is a decision to allow a shape that could be real.
 */
const ALLOW_EXACT = new Set([
  'your-client-secret',
  'your-google-client-id',
  'your-secret-here',
  'changeme',
  'replace-me',
  'placeholder',
  'example',
  'test-token',
  'dummy-token',
  'not-a-real-secret',
  'todo',
  'null',
  'undefined',
]);

/* Substrings that make a value an obvious placeholder wherever they appear. */
const ALLOW_SUBSTRINGS = [
  'example',
  'placeholder',
  'your-',
  'your_',
  'xxxxx',
  'changeme',
  'change-me',
  'replace',
  'redacted',
  'not-a-real',
  'dummy',
  'fake',
  'sample',
  'todo',
  '<',
  '${',
];

const IGNORED_PATHS = [
  /node_modules/,
  /(^|\/)\.git\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /package-lock\.json$/,
  /\.log$/,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|docx?|xlsx?|zip|gz|woff2?|ttf)$/i,
  // The scanner's own rule definitions contain the prefixes they look for.
  /scripts\/secret-scan\.js$/,
  /*
   * The scanner's own test suite, for the same reason. It necessarily contains
   * a correctly-shaped sample of every rule (AKIA..., GOCSPX..., xoxb..., a PEM
   * header) because a test that does not could not prove the rule works. Those
   * are generated, non-functional strings, and the suite asserts them inert.
   * Flagging it would mean the suite could never be committed.
   */
  /scripts\/test-secret-scan\.js$/,
];

/*
 * The generic assignment rule is skipped in the test suites, which legitimately
 * contain fixture passwords (`UserTestPass!123`, `hunter2-secret`). This is a
 * deliberate trade-off, not an oversight: EVERY provider-specific rule above
 * still applies there, so a real AWS key, Google secret, GitHub token or Fly
 * token pasted into a test file is still caught. What is given up is only
 * "someone hardcoded a novel-format password inside a test fixture", which is
 * the least likely mistake of the lot and the one most likely to be harmless
 * test data.
 */
const GENERIC_RULE_ID = 'hardcoded-credential-assignment';
const GENERIC_RULE_EXEMPT = /(^|\/)scripts\/test-[^/]*\.(js|cjs|mjs)$/;

/* ------------------------------------------------------------------ */
/* git plumbing                                                        */
/* ------------------------------------------------------------------ */

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

function isIgnoredPath(file) {
  const norm = String(file).replace(/\\/g, '/');
  return IGNORED_PATHS.some((re) => re.test(norm));
}

/* ------------------------------------------------------------------ */
/* scanning                                                            */
/* ------------------------------------------------------------------ */

/*
 * A finding carries NO secret value. A scanner whose output leaks what it
 * found gets its output pasted into a chat, a CI log or an issue, which
 * undoes the entire mechanism. The excerpt is the line with every rule match
 * blanked out, so it is enough to locate the problem and useless to an
 * attacker reading over your shoulder.
 *
 * EVERY rule's pattern is applied, not just the one that fired. That is not
 * tidiness: two rules can each cover half of one value (an address rule
 * blanking the local part and a domain rule blanking the host leaves a
 * readable local part beside a readable host), and two excerpts of the same
 * line in the same output reassemble the whole thing. Partial redaction is
 * not redaction once the findings are listed one under another.
 */
function makeFinding(rule, file, lineNumber, lineText) {
  let redacted = lineText;
  for (const other of RULES) {
    const flags = other.pattern.flags.includes('g') ? other.pattern.flags : `${other.pattern.flags}g`;
    const re = new RegExp(other.pattern.source, flags);
    re.lastIndex = 0;
    redacted = redacted.replace(re, (match, ...rest) => {
      /*
       * For a rule with a capture group (the generic assignment rule) keep the
       * NAME so the reader knows which variable; for a rule with none, the first
       * rest element is the match offset, not a name, and must be ignored.
       */
      const first = rest[0];
      const named = typeof first === 'string' ? first : null;
      return named ? `${named} = <redacted>` : '<redacted>';
    });
  }
  const excerpt = redacted.replace(/\s+/g, ' ').trim().slice(0, 70);
  return { rule: rule.id, severity: rule.severity, file, line: lineNumber, excerpt };
}

function isAllowedValue(value) {
  const v = String(value).trim().toLowerCase();
  if (!v) return true;
  if (ALLOW_EXACT.has(v)) return true;
  if (v.startsWith('$') || v.includes('{{')) return true;
  return ALLOW_SUBSTRINGS.some((s) => v.includes(s));
}

/*
 * A rule may declare `skipIfValueLooksLikeUrl`. Only the generic assignment
 * rule does: `const TOKEN_URL = 'https://oauth2.googleapis.com/token'` is a
 * location, not a credential.
 *
 * This is deliberately NOT inside isAllowedValue. An earlier version exempted
 * any value containing "://" globally, which quietly disabled the
 * `db-url-with-password` rule entirely - its match is a URL by definition, so
 * it could never fire. A blanket exemption that is meant for one rule must not
 * be allowed to silence another.
 */
function looksLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value).trim());
}

/*
 * The one exemption the DB-URL rule carries: a loopback DSN belongs to the
 * disposable local test cluster (server/scripts/lib/testpg.js writes exactly
 * this into server/.env.test). A password on 127.0.0.1 is not an exposure;
 * the same rule stays fully armed for any real host.
 *
 * Checked against the LINE, not the match: the rule's match stops at the `@`,
 * so the host that identifies a loopback DSN is not part of it.
 */
const LOCAL_DSN_EXEMPT = /:\/\/[^:/@\s]*:[^:/@\s]*@(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

function isExempt(rule, value, file, line) {
  if (rule.id === GENERIC_RULE_ID && GENERIC_RULE_EXEMPT.test(file)) return true;
  if (rule.skipIfValueLooksLikeUrl && looksLikeUrl(value)) return true;
  if (rule.id === 'db-url-with-password' && LOCAL_DSN_EXEMPT.test(line)) return true;
  return false;
}

function scanText(text, file, options = {}) {
  const findings = [];
  const lines = String(text).split('\n');
  const normFile = String(file).replace(/\\/g, '/');
  /*
   * `forwardOnly` rules are skipped when a caller asks for history-only rules.
   *
   * CI sweeps every commit in history, and a rule that is trying to stop a
   * value going forward will fire on every commit that already contains it.
   * That is a real failure mode, not a hypothetical one: the production-domain
   * rules turned the whole history sweep red the moment they were written,
   * because the value they forbid is in the history by construction.
   *
   * So the two concerns are separated explicitly:
   *
   *   - the current tree (--all, and the pre-commit hook's staged content) is
   *     scanned with EVERY rule. That is what stops the value going forward,
   *     and it is the only place a new occurrence can appear.
   *   - the history sweep scans without the forward-only rules, because a
   *     value in history cannot be unpublished and the forward-only rules exist
   *     to keep it out of the next commit, not to condemn every commit that
   *     predates them.
   *
   * The credential rules are NOT forward-only. A credential in history is a
   * live exposure that has to be found and rotated, which is precisely what the
   * history sweep is for, so those rules still run over every commit.
   */
  const rules = options.historyOnly ? RULES.filter((r) => !r.forwardOnly) : RULES;
  for (const rule of rules) {
    if (rule.id === GENERIC_RULE_ID && GENERIC_RULE_EXEMPT.test(normFile)) continue;
    // A fresh regex per line: these patterns are global and shared, and
    // lastIndex state carried across lines or files is the classic way this
    // kind of scanner silently misses half its findings.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        // For the generic assignment rule the interesting part is the last
        // capture group (the value); for a rule with no groups it is the whole
        // match. `m.length > 1` distinguishes the two, because JS puts `index`
        // and `input` on the match object rather than in the array.
        const candidate = m.length > 1 ? m[m.length - 1] : m[0];
        if (isExempt(rule, candidate, normFile, line)) continue;
        if (isAllowedValue(candidate)) continue;
        findings.push(makeFinding(rule, file, i + 1, line));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return findings;
}

/* Files the commit is about to record: modified, added, copied, renamed. */
function stagedFiles() {
  const modified = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { allowFail: true });
  const added = git(['diff', '--cached', '--name-only', '--diff-filter=A'], { allowFail: true });
  return [...new Set(`${modified}\n${added}`.split('\n').map((s) => s.trim()).filter(Boolean))];
}

function contentFromIndex(file) {
  return git(['show', `:${file}`], { allowFail: true });
}

function rangeFiles(from, to) {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', from, to], { allowFail: true });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function committedContent(file, rev) {
  return git(['show', `${rev}:${file}`], { allowFail: true });
}

function allTrackedFiles() {
  return git(['ls-files'], { allowFail: true })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main(argv) {
  const args = argv.slice(2);
  const isRange = args.find((a) => a.includes('..'));
  const wantAll = args.includes('--all');

  let findings = [];
  let scope = '';

  if (isRange) {
    const [from, to] = isRange.split('..');
    scope = `range ${from}..${to}`;
    for (const file of rangeFiles(from, to)) {
      if (isIgnoredPath(file)) continue;
      findings = findings.concat(scanText(committedContent(file, to), file, { historyOnly: true }));
    }
  } else if (wantAll) {
    scope = 'every tracked file';
    for (const file of allTrackedFiles()) {
      if (isIgnoredPath(file)) continue;
      const abs = path.join(REPO_ROOT, file);
      if (!fs.existsSync(abs)) continue;
      findings = findings.concat(scanText(fs.readFileSync(abs, 'utf8'), file));
    }
  } else {
    scope = 'staged changes';
    for (const file of stagedFiles()) {
      if (isIgnoredPath(file)) continue;
      findings = findings.concat(scanText(contentFromIndex(file), file));
    }
  }

  const order = { critical: 0, high: 1, medium: 2 };
  findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line
  );

  if (!findings.length) {
    console.log(`secret-scan: clean (${scope})`);
    return 0;
  }

  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  console.error('');
  console.error('  SECRET SCAN FAILED — possible credentials in this commit');
  console.error(`  scope: ${scope}`);
  console.error(
    `  findings: ${counts.critical || 0} critical, ${counts.high || 0} high, ${counts.medium || 0} medium`
  );
  console.error('');
  for (const f of findings) {
    console.error(`  [${f.severity.toUpperCase()}] ${f.rule}`);
    console.error(`      ${f.file}:${f.line}  ${f.excerpt}`);
  }
  console.error('');
  console.error('  Do not commit this. This repository is PUBLIC.');
  console.error('  1. Remove the value from the file.');
  console.error('  2. Put it in server/.env (git-ignored) or a Fly secret.');
  console.error('  3. If the value is a real credential, ROTATE it — deleting it');
  console.error('     here does not un-publish what an earlier commit held, and');
  console.error('     does not help if it was baked into a deployed image.');
  console.error('');
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(`secret-scan: could not run: ${err.message}`);
    process.exit(2);
  }
}

module.exports = {
  RULES,
  scanText,
  isAllowedValue,
  isIgnoredPath,
  // Exported so the test suite can build a sample of the real shape without
  // either file containing the value literally.
  PRODUCTION_DOMAIN,
  PRODUCTION_MAILBOX,
};
