// Remove tickets that were opened by automated mail before intake screening
// existed (Google security alerts, quarantine digests, noreply notifications,
// bounces, ...).
//
//   npm run db:purge-automated            -> report what WOULD be removed (dry run)
//   npm run db:purge-automated -- --apply -> actually remove it
//
// Matching reuses the screening sender list exactly as the intake gate applies
// it: the intakeIgnoredSenders setting (Setting table override, else the env
// default, else the built-in list). Only tickets that arrived by EMAIL match —
// a portal ticket can never be touched, whatever the requester address says.
//
// Deletion relies on the schema's cascades (comments, ticket audit log,
// attachments metadata, handovers, remote-access sessions, SLA cycles and
// events all carry onDelete: Cascade from Ticket). Notifications are deleted
// explicitly (SetNull would orphan them); AuditEvent rows survive with a null
// ticketId by design — they are the record that these tickets once existed.
// Attachment binaries are removed from object storage best-effort first.
const prisma = require('../src/lib/prisma');
const settingsService = require('../src/services/settingsService');
const {
  matchIgnoredSender,
  parseSenderEntries,
  DEFAULT_IGNORED_SENDERS,
} = require('../src/services/intakeScreening');
const { getAttachmentStorage } = require('../src/services/attachmentStorage');

const APPLY = process.argv.includes('--apply');

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

/** The sender list exactly as the intake gate resolves it (fail-open). */
async function effectiveSenderEntries() {
  try {
    return parseSenderEntries(await settingsService.get('intakeIgnoredSenders'));
  } catch {
    return DEFAULT_IGNORED_SENDERS;
  }
}

async function main() {
  console.log(
    APPLY
      ? 'PURGING tickets opened by automated mail'
      : 'DRY RUN — nothing will be deleted (pass --apply to remove)'
  );

  const entries = await effectiveSenderEntries();
  console.log(`Ignored-sender entries: ${entries.join(', ') || '(none)'}`);

  // Email-origin tickets only; sender matching is the screening rule itself.
  const emailTickets = await prisma.ticket.findMany({
    where: { source: 'email' },
    select: {
      id: true,
      ticketNumber: true,
      shortDescription: true,
      requesterEmail: true,
      state: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
  });
  const matched = emailTickets
    .map((t) => ({ ...t, matchedEntry: matchIgnoredSender(t.requesterEmail, entries) }))
    .filter((t) => t.matchedEntry);
  const ids = matched.map((t) => t.id);

  heading(`Tickets opened by automated mail (${matched.length} of ${emailTickets.length} email tickets)`);
  for (const t of matched) {
    console.log(
      `  ${t.ticketNumber}  [${t.state.padEnd(11)}] <${t.requesterEmail}> via "${t.matchedEntry}"  ${t.shortDescription.slice(0, 60)}`
    );
  }
  if (!matched.length) console.log('  none — nothing to do');

  // Transparency: a matched ticket an agent has already worked on is still
  // junk mail, but the human deserves to see that it had activity.
  const agentComments = ids.length
    ? await prisma.comment.groupBy({
        by: ['ticketId'],
        where: { ticketId: { in: ids }, authorAgentId: { not: null } },
        _count: { _all: true },
      })
    : [];
  const activeTickets = new Set(agentComments.map((r) => r.ticketId));
  if (activeTickets.size) {
    heading(`NOTE: ${activeTickets.size} matched ticket(s) contain agent comments`);
    for (const t of matched.filter((t) => activeTickets.has(t.id))) {
      console.log(`  ${t.ticketNumber}  [${t.state}]  <${t.requesterEmail}>`);
    }
  }

  if (ids.length) {
    const [comments, attachments, notifications, handovers] = await Promise.all([
      prisma.comment.count({ where: { ticketId: { in: ids } } }),
      prisma.attachment.count({ where: { ticketId: { in: ids } } }),
      prisma.notification.count({ where: { ticketId: { in: ids } } }),
      prisma.handoverRequest.count({ where: { ticketId: { in: ids } } }),
    ]);
    heading('Related rows that go with them');
    console.log(`  comments: ${comments} (cascade)`);
    console.log(`  attachments: ${attachments} (rows cascade; binaries removed best-effort)`);
    console.log(`  notifications: ${notifications} (deleted explicitly)`);
    console.log(`  handovers: ${handovers} (cascade)`);
  }

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to delete the above.');
    return;
  }
  if (!ids.length) {
    console.log('\nNothing to delete.');
    return;
  }

  /* ---- apply --------------------------------------------------------- */
  // Attachment binaries are not in the database — remove them first,
  // best-effort, before the rows that carry their keys cascade away.
  const attachmentRows = await prisma.attachment.findMany({
    where: { ticketId: { in: ids } },
    select: { storageKey: true },
  });
  if (attachmentRows.length) {
    const storage = getAttachmentStorage();
    for (const row of attachmentRows) {
      await storage.delete(row.storageKey).catch(() => {});
    }
  }

  await prisma.notification.deleteMany({ where: { ticketId: { in: ids } } });
  const removed = await prisma.ticket.deleteMany({ where: { id: { in: ids } } });

  heading('Done');
  console.log(`  tickets removed:    ${removed.count}`);
  console.log(`  attachment objects: ${attachmentRows.length} (best-effort)`);
  console.log('  AuditEvent history survives with a null ticket link, by design.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
