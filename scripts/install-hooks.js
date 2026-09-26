#!/usr/bin/env node
// Installs the secret-scan pre-commit hook.
//
//   node scripts/install-hooks.js
//
// A hook in .git/hooks is per-clone and is NOT committed, so every developer
// (and CI) has to install it once. This script writes it idempotently and
// never clobbers an existing hook that is not ours — if one is there, it says
// so and leaves it alone rather than silently replacing someone's work.
//
// The hook is deliberately a thin shim: it runs the scanner and exits non-zero
// on a finding, so the pre-commit and CI paths run exactly the same code.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.git', 'hooks');
const HOOK_PATH = path.join(HOOKS_DIR, 'pre-commit');
const MARKER = '# secret-scan (see scripts/install-hooks.js)';

const HOOK = `#!/bin/sh
${MARKER}
# Blocks a commit that contains a credential. The repository is public, so a
# committed secret is a published secret. Install with:
#   node scripts/install-hooks.js
set -e
repo_root=$(git rev-parse --show-toplevel)
exec node "$repo_root/scripts/secret-scan.js" --staged
`;

function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    console.error('install-hooks: not a git repository (no .git directory)');
    process.exit(1);
  }
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  if (fs.existsSync(HOOK_PATH)) {
    const current = fs.readFileSync(HOOK_PATH, 'utf8');
    if (!current.includes(MARKER)) {
      console.error(
        'install-hooks: a pre-commit hook already exists and is not ours.\n' +
          '  Refusing to overwrite it. Merge scripts/secret-scan.js into it by hand:\n' +
          '    node scripts/secret-scan.js --staged\n'
      );
      process.exit(1);
    }
    if (current === HOOK) {
      console.log('install-hooks: pre-commit hook already installed and up to date');
      return;
    }
  }

  fs.writeFileSync(HOOK_PATH, HOOK, { mode: 0o755 });
  // Windows ignores the mode bits, and git for Windows runs `sh` regardless, so
  // this is belt-and-braces rather than the mechanism.
  try {
    fs.chmodSync(HOOK_PATH, 0o755);
  } catch {
    /* best effort */
  }

  console.log('install-hooks: pre-commit hook installed (.git/hooks/pre-commit)');
  console.log('  It runs scripts/secret-scan.js on every commit.');
  console.log('  To bypass deliberately: git commit --no-verify');
  console.log('  (CI runs the same scan, so bypassing locally only defers it.)');
}

main();
