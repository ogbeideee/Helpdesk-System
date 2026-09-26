/**
 * Generates a new OAuth2 refresh token for Gmail IMAP.
 *
 * Usage:
 *   1. GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set
 *      (in server/.env, or in the environment for this one run). They are
 *      NEVER stored in this file — a client secret committed to a repository
 *      is a published secret, and GitHub's push protection blocks the push.
 *   2. node scripts/generate-refresh-token.js
 *   3. Open the printed URL in a browser, signed in as the mailbox account
 *   4. Authorize the https://mail.google.com/ scope
 *   5. You'll be redirected to localhost:3000?code=...
 *   6. Copy that full redirect URL back into this terminal
 *   7. The new refresh token is printed
 */
const readline = require('readline');
const { URL } = require('url');
const http = require('http');

// Loaded after dotenv so a .env works for a local run. The client ID is not a
// secret, but both come from the environment so neither is ever in git.
require('dotenv').config();

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const MAILBOX_ACCOUNT = process.env.IMAP_USERNAME || 'the mailbox account';
const SCOPES = 'https://mail.google.com/';
const REDIRECT_URI = 'http://localhost:3000';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\nMissing GOOGLE_OAUTH_CLIENT_ID and/or GOOGLE_OAUTH_CLIENT_SECRET.\n' +
      'Set them in server/.env (see .env.example) or in the environment for this run.\n'
  );
  process.exit(1);
}

const AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  `client_id=${encodeURIComponent(CLIENT_ID)}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log(`\nOpen this URL in your browser (signed in as ${MAILBOX_ACCOUNT}):\n`);
console.log(AUTH_URL);
console.log('\nAfter authorizing, you will be redirected to localhost:3000?code=...');
console.log('Paste the full redirect URL below:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('> ', async (redirectUrl) => {
  rl.close();
  try {
    const parsed = new URL(redirectUrl.trim());
    const code = parsed.searchParams.get('code');
    if (!code) {
      console.error('No "code" parameter found in the URL. Make sure you paste the full redirect URL.');
      process.exit(1);
    }

    const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const res = await fetch(TOKEN_URL, { method: 'POST', body });
    const data = await res.json();

    if (data.error) {
      console.error('Error exchanging code for token:', data.error, data.error_description || '');
      process.exit(1);
    }

    console.log('\n=== New Refresh Token ===\n');
    console.log(data.refresh_token);
    console.log('\nSet it with:\n');
    console.log(`fly secrets set IMAP_OAUTH2_REFRESH_TOKEN="${data.refresh_token}"`);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
});