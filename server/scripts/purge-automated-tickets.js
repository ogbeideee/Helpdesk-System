// Remove tickets that were opened by automated or standing mail the intake gate
// now screens out (Google security alerts, quarantine digests, noreply
// notifications, bounces, recalled messages, holiday/announcement notices, ...).
//
//   npm run db:purge-automated                      -> report what WOULD be removed (dry run)
//   npm run db:purge-automated -- --apply           -> actually remove it
//   npm run db:purge-automated -- --subject "text"  -> one-shot subject match (repeatable)
//   npm run db:purge-automated -- --ticket INC-001815 --ticket INC-001817
//                                                   -> scope to exactly these tickets
//
// With --ticket the rule matching is skipped entirely and the scope is exactly
// the named EMAIL tickets — the precise way to remove a handful of known junk
// tickets without also sweeping whatever the current settings happen to match.
//
// Matching reuses the screening rules exactly as the intake gate applies them:
// the ignored-sender and ignored-subject settings (Setting table override, else
// the env default, else the built-in list), plus the built-in recall marker.
// --subject adds a subject phrase for a one-off cleanup without persisting a
// setting. Only tickets that arrived by EMAIL match — a portal ticket can never
// be touched, whatever the requester address says.
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
  matchIgnoredSubject,
  isRecallSubject,
  parseSenderEntries,
  parseSubjectEntries,
  DEFAULT_IGNORED_SENDERS,
  DEFAULT_IGNORED_SUBJECTS,
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

/** The ignored-subject list exactly as the intake gate resolves it (fail-open). */
async function effectiveSubjectEntries() {
  try {
    return parseSubjectEntries(await settingsService.get('intakeIgnoredSubjects'));
  } catch {
    return DEFAULT_IGNORED_SUBJECTS;
  }
}

/**
 * One-shot subject filters from the command line, repeatable:
 *   npm run db:purge-automated -- --subject "independence day" --subject "holiday"
 * Matched the same way as the setting (case- and spacing-insensitive substring),
 * for a cleanup that should not leave a persisted setting behind.
 */
function cliSubjectTerms() {
  const argv = process.argv.slice(2);
  const terms = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--subject') {
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        terms.push(value);
        i += 1;
      }
    } else if (arg.startsWith('--subject=')) {
      terms.push(arg.slice('--subject='.length));
    }
  }
  return parseSubjectEntries(terms.join(','));
}

/**
 * Explicit ticket numbers, repeatable:
 *   npm run db:purge-automated -- --ticket INC-001815 --ticket INC-001817
 * When any are given they define the whole scope (still restricted to EMAIL
 * tickets) and the rule matching is skipped, so a targeted cleanup cannot touch
 * an unrelated ticket the current settings happen to match.
 */
function cliTicketNumbers() {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ticket') {
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        out.push(value.trim());
        i += 1;
      }
    } else if (arg.startsWith('--ticket=')) {
      out.push(arg.slice('--ticket='.length).trim());
    }
  }
  return [...new Set(out.filter(Boolean))];
}

async function main() {
  console.log(
    APPLY
      ? 'PURGING tickets opened by automated mail'
      : 'DRY RUN — nothing will be deleted (pass --apply to remove)'
  );

  const entries = await effectiveSenderEntries();
  const subjectEntries = await effectiveSubjectEntries();
  const cliTerms = cliSubjectTerms();
  console.log(`Ignored-sender entries: ${entries.join(', ') || '(none)'}`);
  console.log(`Ignored-subject entries: ${subjectEntries.join(', ') || '(none)'}`);
  if (cliTerms.length) console.log(`--subject filters: ${cliTerms.join(', ')}`);

  // Email-origin tickets only; matching is the screening rule itself.
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
  const subjectList = [...subjectEntries, ...cliTerms];
  const ticketFilter = cliTicketNumbers();
  let matched;
  if (ticketFilter.length) {
    // Explicit scope: exactly these email tickets, no rule matching.
    const wanted = new Set(ticketFilter.map((n) => n.toLowerCase()));
    matched = emailTickets
      .filter((t) => wanted.has(String(t.ticketNumber).toLowerCase()))
      .map((t) => ({ ...t, matchedBy: 'explicit --ticket' }));
    const seen = new Set(matched.map((t) => String(t.ticketNumber).toLowerCase()));
    const missing = ticketFilter.filter((n) => !seen.has(n.toLowerCase()));
    if (missing.length) console.log(`WARNING: no email ticket found for: ${missing.join(', ')}`);
  } else {
    matched = emailTickets
      .map((t) => {
        const senderHit = matchIgnoredSender(t.requesterEmail, entries);
        if (senderHit) return { ...t, matchedBy: `sender "${senderHit}"` };
        if (isRecallSubject(t.shortDescription)) return { ...t, matchedBy: 'recall subject (built-in)' };
        const subjectHit = matchIgnoredSubject(t.shortDescription, subjectList);
        if (subjectHit) return { ...t, matchedBy: `subject "${subjectHit}"` };
        return { ...t, matchedBy: null };
      })
      .filter((t) => t.matchedBy);
  }
  const ids = matched.map((t) => t.id);

  heading(`Tickets opened by automated mail (${matched.length} of ${emailTickets.length} email tickets)`);
  for (const t of matched) {
    console.log(
      `  ${t.ticketNumber}  [${t.state.padEnd(11)}] <${t.requesterEmail}> via ${t.matchedBy}  ${t.shortDescription.slice(0, 60)}`
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
