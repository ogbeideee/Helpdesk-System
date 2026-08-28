// Remove the demo/sample dataset from a database that is going into real use.
//
//   npm run db:purge-demo            -> report what WOULD be removed (dry run)
//   npm run db:purge-demo -- --apply -> actually remove it
//
// Deliberately narrow. Nothing is matched by "looks generated"; every rule
// below names a specific, known generator:
//
//   * scripts/seed-demo.js  — accounts at @noctincan.com ending in `.demo`,
//                             tickets with @demo.example requesters and
//                             `demo-` message ids
//   * scripts/init-db.js    — the sample admin and four sample agents at the
//                             fictional @noctincan.com domain
//
// Anything else is left alone and listed under "left untouched" so a human can
// decide. There is no blanket delete here and no `deleteMany` without a
// filter: a row is only removed when it matches one of the rules above.
const prisma = require('../src/lib/prisma');
const { ensureTeams, FALLBACK_TEAM_KEY } = require('../src/teams');

const APPLY = process.argv.includes('--apply');

/** The fictional company used by both seed scripts. Never a real address. */
const DEMO_ACCOUNT_DOMAIN = 'noctincan.com';
/** Requester domain used by every seeded demo ticket. */
const DEMO_REQUESTER_DOMAIN = 'demo.example';
/** Message-id prefix stamped on every seeded demo ticket. */
const DEMO_MESSAGE_PREFIX = 'demo-';

/** The real administrator is protected explicitly, whatever else matches. */
const PROTECTED_EMAILS = new Set(
  [process.env.INITIAL_ADMIN_EMAIL, ...(process.argv.find((a) => a.startsWith('--keep='))?.slice(7).split(',') || [])]
    .filter(Boolean)
    .map((e) => e.trim().toLowerCase())
);

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

async function main() {
  console.log(APPLY ? 'PURGING demo data' : 'DRY RUN — nothing will be deleted (pass --apply to remove)');
  if (PROTECTED_EMAILS.size) {
    console.log(`Protected: ${[...PROTECTED_EMAILS].join(', ')}`);
  }

  /* ---- 1. demo accounts -------------------------------------------- */
  const demoAgents = (
    await prisma.agent.findMany({
      where: { email: { endsWith: `@${DEMO_ACCOUNT_DOMAIN}` } },
      orderBy: { id: 'asc' },
    })
  ).filter((a) => !PROTECTED_EMAILS.has(a.email));
  const demoAgentIds = demoAgents.map((a) => a.id);
  const demoActors = new Set(demoAgents.map((a) => `${a.name} <${a.email}>`));

  heading(`Demo accounts (${demoAgents.length})`);
  demoAgents.forEach((a) => console.log(`  ${a.role.padEnd(6)} ${a.email}`));

  /* ---- 2. demo tickets --------------------------------------------- */
  const demoTickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { requesterEmail: { endsWith: `@${DEMO_REQUESTER_DOMAIN}` } },
        { graphMessageId: { startsWith: DEMO_MESSAGE_PREFIX } },
      ],
    },
    select: { id: true, ticketNumber: true },
  });
  const demoTicketIds = demoTickets.map((t) => t.id);
  heading(`Demo tickets (${demoTickets.length})`);
  console.log(`  ${demoTickets.slice(0, 5).map((t) => t.ticketNumber).join(', ')}${demoTickets.length > 5 ? ', …' : ''}`);

  const [comments, ticketAudit, ticketNotifs, ticketHandovers] = await Promise.all([
    prisma.comment.count({ where: { ticketId: { in: demoTicketIds } } }),
    prisma.ticketAuditLog.count({ where: { ticketId: { in: demoTicketIds } } }),
    prisma.notification.count({ where: { ticketId: { in: demoTicketIds } } }),
    prisma.handoverRequest.count({ where: { ticketId: { in: demoTicketIds } } }),
  ]);
  console.log(`  attached: ${comments} comments, ${ticketAudit} audit entries, ` +
    `${ticketNotifs} notifications, ${ticketHandovers} handovers`);

  /* ---- 3. records belonging to the demo accounts -------------------- */
  const [agentNotifs, agentAudit, agentHandovers] = await Promise.all([
    prisma.notification.count({ where: { agentId: { in: demoAgentIds } } }),
    prisma.userAuditLog.count({ where: { agentId: { in: demoAgentIds } } }),
    prisma.handoverRequest.count({
      where: { OR: [{ requestedById: { in: demoAgentIds } }, { targetAgentId: { in: demoAgentIds } }] },
    }),
  ]);
  heading('Records belonging to demo accounts');
  console.log(`  ${agentNotifs} notifications, ${agentAudit} user-audit entries, ${agentHandovers} handovers`);

  /* ---- 4. audit written BY a demo account onto a kept account ------- */
  // Test runs drove the API as the sample admin, leaving availability churn on
  // real accounts. Matched by actor, so genuine entries are untouched.
  const strayAudit = await prisma.userAuditLog.findMany({
    where: { agentId: { notIn: demoAgentIds }, actor: { in: [...demoActors] } },
    select: { id: true, agentId: true, action: true },
  });
  heading(`Audit entries on kept accounts written by a demo account (${strayAudit.length})`);
  const strayByAction = {};
  strayAudit.forEach((r) => { strayByAction[r.action] = (strayByAction[r.action] || 0) + 1; });
  Object.entries(strayByAction).forEach(([k, v]) => console.log(`  ${v} × ${k}`));

  /* ---- 5. what is deliberately NOT touched -------------------------- */
  const keptTickets = await prisma.ticket.findMany({
    where: { id: { notIn: demoTicketIds } },
    select: { id: true, ticketNumber: true, shortDescription: true, requesterEmail: true, source: true },
  });
  const keptAgents = await prisma.agent.findMany({
    where: { id: { notIn: demoAgentIds } },
    select: { email: true, role: true },
  });
  heading('Left untouched — review these yourself');
  console.log(`  ${keptAgents.length} account(s): ${keptAgents.map((a) => `${a.email} (${a.role})`).join(', ') || 'none'}`);
  keptTickets.forEach((t) =>
    console.log(`  ${t.ticketNumber}  ${t.shortDescription.slice(0, 44)}  <${t.requesterEmail}> via ${t.source}`)
  );
  if (!keptTickets.length) console.log('  no tickets remain');

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to delete the above.');
    return;
  }

  /* ---- apply -------------------------------------------------------- */
  // Order matters: children before parents, and handovers before agents
  // because HandoverRequest references Agent without a cascade.
  await prisma.handoverRequest.deleteMany({
    where: {
      OR: [
        { ticketId: { in: demoTicketIds } },
        { requestedById: { in: demoAgentIds } },
        { targetAgentId: { in: demoAgentIds } },
      ],
    },
  });
  await prisma.notification.deleteMany({ where: { ticketId: { in: demoTicketIds } } });
  await prisma.comment.deleteMany({ where: { ticketId: { in: demoTicketIds } } });
  await prisma.ticketAuditLog.deleteMany({ where: { ticketId: { in: demoTicketIds } } });
  const removedTickets = await prisma.ticket.deleteMany({ where: { id: { in: demoTicketIds } } });

  await prisma.userAuditLog.deleteMany({ where: { id: { in: strayAudit.map((r) => r.id) } } });

  // A demo agent may be named as a routing rule's preferred agent; the rule
  // itself is real configuration and stays, minus the dangling reference.
  await prisma.routingRule.updateMany({
    where: { preferredAgentId: { in: demoAgentIds } },
    data: { preferredAgentId: null },
  });
  // Notifications and user-audit rows cascade with the agent; handovers were
  // cleared above.
  const removedAgents = await prisma.agent.deleteMany({ where: { id: { in: demoAgentIds } } });

  // The default fallback assignment group must exist for routing to work.
  await ensureTeams(prisma);
  const fallback = await prisma.team.findUnique({ where: { key: FALLBACK_TEAM_KEY } });

  heading('Done');
  console.log(`  accounts removed: ${removedAgents.count}`);
  console.log(`  tickets removed:  ${removedTickets.count}`);
  console.log(`  stray audit rows: ${strayAudit.length}`);
  console.log(`  default group:    ${fallback.name} (active=${fallback.isActive}, default=${fallback.isDefault})`);
  console.log(`  active admins:    ${await prisma.agent.count({ where: { role: 'admin', isActive: true } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
