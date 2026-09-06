/* One-time historical SLA backfill — command-line entry point.
 *
 * Populates TicketSlaCycle/TicketSlaEvent rows for tickets that predate the
 * SLA foundation, reconstructing cycles from the ticket's audit trail and
 * comment history. See src/slaBackfill.js for exactly what is reconstructed,
 * what is deliberately left unknown, and the safety properties.
 *
 *   npm run sla:backfill              plan + write (additive, idempotent)
 *   npm run sla:backfill:dry          report what would be created; no writes
 *   node scripts/backfill-sla.js --ticket=42 [--dry-run] [--batch=50]
 *
 * Safety: tickets are processed one transaction each, in id-keyed batches.
 * Only tickets with zero SLA cycles are eligible, so re-running is a no-op.
 * Ticket rows, existing cycle rows, and settings are never modified, and no
 * SLA notification is ever sent. The script targets the configured
 * PostgreSQL DATABASE_URL only — there is no SQLite database to touch.
 */
const backfill = require('../src/slaBackfill');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : undefined;
};
const batchSize = flag('batch') || 50;
const ticketId = flag('ticket');

async function main() {
  console.log(
    `[sla-backfill] historical SLA backfill ${dryRun ? '(DRY RUN — nothing will be written)' : ''}`
  );
  const summary = await backfill.backfillSla({ dryRun, batchSize, ticketId, logger: console });
  console.log(
    `\n[sla-backfill] ${dryRun ? 'would create' : 'created'}: ` +
      `${summary.cyclesCreated} cycle(s) and ${summary.eventsCreated} event(s) on ` +
      `${summary.ticketsEligible} of ${summary.ticketsScanned} ticket(s) scanned ` +
      `(batch ${batchSize})`
  );
  console.log(
    '[sla-backfill] reconstructed responses: ' +
      `${summary.responsesReconstructed}; response breaches: ${summary.responseBreaches}; ` +
      `resolution breaches: ${summary.resolutionBreaches}; approaching events: ${summary.approachingEvents}`
  );
  console.log(
    '[sla-backfill] cycles left open (resolution end not recoverable): ' +
      `${summary.openEndedCycles}; ends approximated from reopen/close instants: ${summary.approximatedEnds}`
  );
  if (dryRun) console.log('[sla-backfill] dry run complete — run without --dry-run to apply.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sla-backfill] failed:', err);
    process.exit(1);
  });
