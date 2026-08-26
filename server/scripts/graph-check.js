/* Microsoft Graph connectivity check — SAFE TEST MODE.

   Authenticates, confirms the shared mailbox resolves, reads a small number of
   unread messages, runs them through the real parser, and prints safe
   metadata.

   It NEVER creates tickets, NEVER marks anything as read, and NEVER prints a
   token, secret or complete email body.

   Usage (from server/):
     npm run graph:check
     npm run graph:check -- --limit 3
     npm run graph:check -- --since 2026-08-01T00:00:00Z
     npm run graph:check -- --all          (ignore the age cutoff)

   This is a command rather than an HTTP route on purpose: mailbox contents are
   never exposed through an API endpoint. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { graphConfig, logGraphStatus, ingestCutoff, describeCutoff } = require('../src/graph/config');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function mask(value) {
  if (!value) return '(not set)';
  const s = String(value);
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

function line(char = '─', n = 66) {
  return char.repeat(n);
}

async function main() {
  console.log(line('='));
  console.log(' Microsoft Graph connectivity check (read-only, no tickets)');
  console.log(line('='));

  // ---- configuration ------------------------------------------------
  console.log('\nConfiguration');
  console.log(`  tenant id      : ${mask(graphConfig.tenantId)}`);
  console.log(`  client id      : ${mask(graphConfig.clientId)}`);
  console.log(`  client secret  : ${graphConfig.clientSecret ? '(set, not shown)' : '(not set)'}`);
  console.log(`  shared mailbox : ${graphConfig.sharedMailbox || '(not set)'}`);
  console.log(`  broadcast DL   : ${graphConfig.broadcastDl || '(not set)'}`);
  console.log(`  ingest guard   : ${describeCutoff()}`);

  if (!graphConfig.enabled) {
    console.log('');
    logGraphStatus((l) => console.log(`  ${l}`));
    console.log('\nNothing to check until the Graph variables are set in server/.env.');
    console.log('The API, dashboard and simulated email endpoints keep working without them.');
    process.exitCode = 1;
    return;
  }

  const limit = Math.min(Number(arg('limit', 5)) || 5, 25);
  const since = arg('all') ? null : arg('since') ? new Date(String(arg('since'))) : ingestCutoff();

  const { createMailService } = require('../src/graph/mailService');
  const svc = createMailService({ logger: console });

  // ---- 1. authenticate + resolve the mailbox -------------------------
  console.log(`\n${line()}`);
  console.log(' 1. Authenticating and resolving the shared mailbox');
  console.log(line());

  let report;
  try {
    report = await svc.inspectMailbox({ limit, since });
  } catch (err) {
    console.error('\n  FAILED to reach the shared mailbox.');
    console.error(`  ${err.message}`);
    if (err.statusCode === 401 || /InvalidAuthenticationToken|unauthorized/i.test(err.message)) {
      console.error('\n  Hint: check GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET.');
    } else if (err.statusCode === 403 || /Access.?Denied|Forbidden/i.test(err.message)) {
      console.error(
        '\n  Hint: the app registration needs APPLICATION permissions ' +
          'Mail.ReadWrite and Mail.Send, with admin consent granted.'
      );
    } else if (err.statusCode === 404 || /ResourceNotFound/i.test(err.message)) {
      console.error(`\n  Hint: ${graphConfig.sharedMailbox} was not found in this tenant.`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n  mailbox id      : ${report.profile.id || '(none)'}`);
  console.log(`  display name    : ${report.profile.displayName || '(none)'}`);
  console.log(`  address         : ${report.profile.mail || '(none)'}`);

  const expected = String(graphConfig.sharedMailbox || '').toLowerCase();
  const actual = String(report.profile.mail || '').toLowerCase();
  console.log(
    `  matches config  : ${actual && expected && actual === expected ? 'YES' : 'check this'}`
  );

  // ---- 2. read + parse a few messages --------------------------------
  console.log(`\n${line()}`);
  console.log(` 2. Unread messages (showing up to ${limit})`);
  console.log(line());
  console.log(`  window          : ${since ? `since ${since.toISOString()}` : 'no age limit'}`);
  console.log(`  unread found    : ${report.unreadCount}`);

  if (!report.previews.length) {
    console.log('\n  Nothing unread in this window. Send a test email to the mailbox and re-run.');
  }

  report.previews.forEach((p, i) => {
    console.log(`\n  [${i + 1}] ${p.error ? `PARSE ERROR: ${p.error}` : ''}`);
    if (p.error) return;
    console.log(`      messageId     : ${p.messageId}`);
    console.log(`      conversationId: ${p.conversationId || '(none)'}`);
    console.log(`      from          : ${p.senderName ? `${p.senderName} <${p.senderEmail}>` : p.senderEmail}`);
    console.log(`      subject       : ${p.subject || '(no subject)'}`);
    console.log(`      received      : ${p.receivedAt}`);
    console.log(`      body          : ${p.isHtml ? 'html -> text' : 'plain text'}, ${p.bodyLength} chars`);
    console.log(`      excerpt       : ${JSON.stringify(p.bodyExcerpt)}${p.bodyLength > 120 ? ' …' : ''}`);
    if (p.attachments.length) {
      console.log(`      attachments   : ${p.attachments.length}`);
      p.attachments.forEach((a) =>
        console.log(`         - ${a.filename} (${a.contentType || 'unknown'}, ${a.size} bytes, id ${a.attachmentId})`)
      );
    } else {
      console.log('      attachments   : none');
    }
  });

  console.log(`\n${line('=')}`);
  console.log(' Read-only check complete. No tickets created, nothing marked read.');
  console.log(line('='));
}

main()
  .catch((err) => {
    // Never print the stack of an auth error - it can carry request detail.
    console.error(`\nUnexpected failure: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await require('../src/lib/prisma').$disconnect().catch(() => {});
  });
