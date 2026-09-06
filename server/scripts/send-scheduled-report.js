/* Manual execution path for scheduled reports.

   Generates (and by default delivers) the weekly or monthly operational
   report without waiting for the scheduler. Uses the same service, settings,
   dedupe and audit trail as the scheduled path — a manually sent period is
   marked sent exactly like a scheduled one, and re-running is a no-op.

   Usage:
     npm run reports:send -- --kind=weekly           (generate + deliver)
     npm run reports:send -- --kind=monthly --dry-run (report what would be sent)
     node scripts/send-scheduled-report.js --kind=weekly --dry-run

   Exit codes: 0 = sent | already_sent | dry_run, 1 = anything else. */
const kindArg = process.argv.find((a) => a.startsWith('--kind='));
const kind = kindArg ? kindArg.split('=')[1] : null;
const dryRun = process.argv.includes('--dry-run');

if (kind !== 'weekly' && kind !== 'monthly') {
  console.error('Usage: node scripts/send-scheduled-report.js --kind=weekly|monthly [--dry-run]');
  process.exit(1);
}

const prisma = require('../src/lib/prisma');
const scheduler = require('../src/reportScheduler');

(async () => {
  const outcome = await scheduler.sendScheduledReport({ kind, dryRun });
  if (outcome.status === 'dry_run') {
    console.log(`[reports] dry run — ${kind} report for ${outcome.label}`);
    console.log(`[reports] would send to: ${outcome.recipients.join(', ')}`);
    console.log(`[reports] subject: ${outcome.subject}`);
    console.log('');
    console.log(outcome.body);
  } else {
    console.log(`[reports] ${kind}: ${outcome.status}${outcome.period ? ` (${outcome.period})` : ''}`);
  }
  await prisma.$disconnect().catch(() => {});
  process.exit(['sent', 'already_sent', 'dry_run'].includes(outcome.status) ? 0 : 1);
})().catch((err) => {
  console.error(`[reports] run failed: ${err.message}`);
  process.exit(1);
});
