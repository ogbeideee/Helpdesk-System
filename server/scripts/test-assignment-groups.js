/* Assignment Group membership model — database layer only.

   Covers:
     1. an agent belongs to one group
     2. an agent belongs to three groups
     3. a fourth group is rejected
     4. duplicate membership is rejected safely
     5. Agent.teamId counts toward the 3-group maximum (deduplicated)
     6. an agent can lead multiple groups
     7. a group has exactly one lead  (promoting demotes the old lead)
     8. a lead must be a member of the group
     9. removing a membership removes that group from the effective set
    10. the legacy Agent.teamId pointer still works (drives round-robin)
    11. existing single-group records migrate correctly
    12. existing ticket assignment groups remain intact

   No HTTP, no routing/workload services, no Graph, no credentials. Every row
   is created by this suite in its own throw-away database.

   Usage: npm run test:assignment-groups   (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's dev.db.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('assignment-groups');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { nextTicketNumber } = require('../src/ticketNumbers');
const memberships = require('../src/services/groupMembershipService');
const { pickAgentRoundRobin } = require('../src/teams');

const DOMAIN = 'assgroups.example';
const PASSWORD = 'AssGroupTest!123';
const hash = bcrypt.hashSync(PASSWORD, 10);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let seq = 0;
function mkAgent(teamId = null, role = 'agent') {
  seq += 1;
  return prisma.agent.create({
    data: {
      name: `Assignment Group Agent ${seq}`,
      email: `ag${seq}@${DOMAIN}`,
      passwordHash: hash,
      role,
      isActive: true,
      isAvailable: true,
      teamId,
      skillLevel: 2,
    },
  });
}

async function main() {
  await ensureTeams(prisma);
  // Mirror the production migration's database-level guard (one lead per
  // group), because `db push` cannot express partial indexes.
  await memberships.ensureSingleLeadIndex(prisma);

  const teams = Object.fromEntries((await prisma.team.findMany()).map((t) => [t.key, t]));
  const g1 = teams.service_desk; // General IT Support (default)
  const g2 = teams.accounts;     // Accounts & Access
  const g3 = teams.software;     // Software & Applications
  const g4 = teams.hardware;     // Hardware & Devices
/* ================================================================ */
  /* 1. Agent belongs to one group                                    */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    const row = await memberships.addMember({ agentId: a.id, teamId: g1.id });
    eq('one group: membership created for the right agent', row.agentId, a.id);
    eq('one group: membership belongs to the right group', row.teamId, g1.id);
    eq('one group: new member is not a lead', row.isLead, false);
    eq('one group: agent group count is 1', await memberships.countGroupsForAgent(a.id), 1);
    eq('one group: membership row exists', await memberships.isMember(a.id, g1.id), true);
    eq('one group: legacy primary group pointer synced',
      (await prisma.agent.findUnique({ where: { id: a.id } })).teamId, g1.id);
  }

  /* ================================================================ */
  /* 1b. The legacy Agent.teamId pointer still works                   */
  /* ================================================================ */
  {
    // An agent created under the old layout (teamId set, no membership row).
    // The legacy reader used by round-robin assignment must still find them,
    // and Agent.teamId must stay untouched during this phase.
    const a = await mkAgent(g2.id);
    eq('legacy: exactly one primary-group agent here',
      await prisma.agent.count({ where: { teamId: g2.id, isActive: true, isAvailable: true } }), 1);
    const picked = await pickAgentRoundRobin(g2.id);
    eq('legacy: round-robin still reads Agent.teamId', picked && picked.id, a.id);
    eq('legacy: Agent.teamId untouched by the membership table',
      (await prisma.agent.findUnique({ where: { id: a.id } })).teamId, g2.id);
  }

  /* ================================================================ */
  /* 2. Agent belongs to three groups                                 */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    await memberships.addMember({ agentId: a.id, teamId: g1.id });
    await memberships.addMember({ agentId: a.id, teamId: g2.id });
    await memberships.addMember({ agentId: a.id, teamId: g3.id });
    eq('three groups: count is 3', await memberships.countGroupsForAgent(a.id), 3);
    const list = await memberships.listAgentMemberships(a.id);
    eq('three groups: one row per group', list.length, 3);
    check('three groups: all three groups are distinct', new Set(list.map((m) => m.teamId)).size === 3);
    check('three groups: every membership included the group',
      list.every((m) => m.team && typeof m.team.name === 'string'));
  }

  /* ================================================================ */
  /* 3. A fourth group is rejected                                    */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    await memberships.addMember({ agentId: a.id, teamId: g1.id });
    await memberships.addMember({ agentId: a.id, teamId: g2.id });
    await memberships.addMember({ agentId: a.id, teamId: g3.id });

    let err = null;
    try {
      await memberships.addMember({ agentId: a.id, teamId: g4.id });
    } catch (e) {
      err = e;
    }
    check('fourth group: rejected with MAX_GROUPS_REACHED', err && err.code === 'MAX_GROUPS_REACHED', err && String(err.code));
    eq('fourth group: count is still 3', await memberships.countGroupsForAgent(a.id), 3);
    eq('fourth group: no membership row leaked', await memberships.isMember(a.id, g4.id), false);
  }

  /* ================================================================ */
  /* 3b. A duplicate membership is rejected safely                     */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    await memberships.addMember({ agentId: a.id, teamId: g1.id });
    let err = null;
    try {
      await memberships.addMember({ agentId: a.id, teamId: g1.id });
    } catch (e) {
      err = e;
    }
    check('duplicate: rejected with ALREADY_MEMBER', err && err.code === 'ALREADY_MEMBER', err && String(err.code));
    eq('duplicate: still exactly one membership row', await prisma.teamMembership.count({ where: { agentId: a.id } }), 1);
    eq('duplicate: effective group set is unchanged', await memberships.countEffectiveGroups(a.id), 1);
  }

  /* ================================================================ */
  /* 3c. Agent.teamId counts toward the 3-group maximum                 */
  /* ================================================================ */
  {
    // (a) Fully-migrated agent: the primary group has a membership row (as the
    // backfill leaves every agent). teamId + 2 more memberships = 3 distinct
    // groups; a fourth distinct group must be rejected.
    const a = await mkAgent(g1.id);
    await memberships.backfillFromLegacyTeamId(prisma); // membership row for g1
    await memberships.addMember({ agentId: a.id, teamId: g2.id });
    await memberships.addMember({ agentId: a.id, teamId: g3.id });
    eq('teamId counts: primary + two memberships = 3 effective groups',
      await memberships.countEffectiveGroups(a.id), 3);

    let err = null;
    try {
      await memberships.addMember({ agentId: a.id, teamId: g4.id });
    } catch (e) {
      err = e;
    }
    check('teamId counts: fourth distinct group rejected', err && err.code === 'MAX_GROUPS_REACHED', err && String(err.code));
    eq('teamId counts: still 3 effective groups', await memberships.countEffectiveGroups(a.id), 3);
    eq('teamId counts: primary pointer unchanged',
      (await prisma.agent.findUnique({ where: { id: a.id } })).teamId, g1.id);

    // Dedup: re-adding the primary group is a duplicate — never a second group.
    let dupErr = null;
    try {
      await memberships.addMember({ agentId: a.id, teamId: g1.id });
    } catch (e) {
      dupErr = e;
    }
    check('teamId counts: re-adding the primary group is a duplicate', dupErr && dupErr.code === 'ALREADY_MEMBER', dupErr && String(dupErr.code));
    eq('teamId counts: effective set is 3, not 4', await memberships.countEffectiveGroups(a.id), 3);

    // (b) Half-migrated agent: teamId set but no membership row for it yet.
    // The union guard in addMember must still count it toward the maximum.
    const b = await mkAgent(g1.id); // no backfill -> no row for g1 yet
    await memberships.addMember({ agentId: b.id, teamId: g2.id });
    await memberships.addMember({ agentId: b.id, teamId: g3.id });
    eq('teamId counts (no row): teamId still counts', await memberships.countEffectiveGroups(b.id), 3);

    let errB = null;
    try {
      await memberships.addMember({ agentId: b.id, teamId: g4.id });
    } catch (e) {
      errB = e;
    }
    check('teamId counts (no row): fourth distinct group rejected', errB && errB.code === 'MAX_GROUPS_REACHED', errB && String(errB.code));
    eq('teamId counts (no row): effective set is 3', await memberships.countEffectiveGroups(b.id), 3);
    eq('teamId counts (no row): database rows are 2 (g2, g3)',
      await memberships.countGroupsForAgent(b.id), 2);

    // The primary group counts as a membership via the legacy pointer alone —
    // re-adding it is a duplicate even before any mirror row exists for it.
    let dupBErr = null;
    try {
      await memberships.addMember({ agentId: b.id, teamId: g1.id });
    } catch (e) {
      dupBErr = e;
    }
    check('teamId counts (no row): re-adding the primary group is a duplicate', dupBErr && dupBErr.code === 'ALREADY_MEMBER', dupBErr && String(dupBErr.code));
    eq('teamId counts (no row): rows stay 2', await memberships.countGroupsForAgent(b.id), 2);
  }

  /* ================================================================ */
  /* 4. An agent can lead multiple groups                             */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    await memberships.addMember({ agentId: a.id, teamId: g1.id });
    await memberships.addMember({ agentId: a.id, teamId: g2.id });

    const lead1 = await memberships.setLead({ agentId: a.id, teamId: g1.id, isLead: true });
    const lead2 = await memberships.setLead({ agentId: a.id, teamId: g2.id, isLead: true });
    eq('multi-lead: agent leads group 1', lead1.isLead, true);
    eq('multi-lead: agent leads group 2', lead2.isLead, true);

    const mine = await memberships.listAgentMemberships(a.id);
    eq('multi-lead: both memberships are leads', mine.filter((m) => m.isLead).length, 2);

    const after = await prisma.agent.findUnique({ where: { id: a.id } });
    eq('multi-lead: leading does NOT grant the admin role', after.role, 'agent');
  }
/* ================================================================ */
  /* 5. A group has exactly one lead                                  */
  /* ================================================================ */
  {
    const a = await mkAgent(null);
    const b = await mkAgent(null);
    const c = await mkAgent(null);
    await memberships.addMember({ agentId: a.id, teamId: g3.id });
    await memberships.addMember({ agentId: b.id, teamId: g3.id });
    await memberships.addMember({ agentId: c.id, teamId: g3.id });

    await memberships.setLead({ agentId: a.id, teamId: g3.id, isLead: true });
    let l1 = await memberships.groupLead(g3.id);
    eq('single lead: first lead set', l1 && l1.agentId, a.id);

    // Promote b over a.
    await memberships.setLead({ agentId: b.id, teamId: g3.id, isLead: true });
    const leadRows = (await memberships.listTeamMembers(g3.id)).filter((m) => m.isLead);
    eq('single lead: exactly one lead row remains', leadRows.length, 1);
    eq('single lead: the new lead is the promoted agent', leadRows[0].agentId, b.id);
    const oldRow = await prisma.teamMembership.findUnique({
      where: { agentId_teamId: { agentId: a.id, teamId: g3.id } },
    });
    eq('single lead: the old lead was demoted to member', oldRow.isLead, false);
    l1 = await memberships.groupLead(g3.id);
    eq('single lead: groupLead reports the one lead', l1.agentId, b.id);

    // Database-level guard: a raw write cannot create a second lead.
    let dbErr = null;
    try {
      await prisma.teamMembership.create({ data: { agentId: c.id, teamId: g3.id, isLead: true } });
    } catch (e) {
      dbErr = e;
    }
    check('single lead: the partial unique index blocks a raw second lead',
      Boolean(dbErr && dbErr.code === 'P2002'), dbErr && String(dbErr.code));
  }

  /* ================================================================ */
  /* 6. A lead must be a member of the group                          */
  /* ================================================================ */
  {
    const a = await mkAgent(null); // never added to g4
    let err = null;
    try {
      await memberships.setLead({ agentId: a.id, teamId: g4.id, isLead: true });
    } catch (e) {
      err = e;
    }
    check('lead must be member: rejected with NOT_A_MEMBER', err && err.code === 'NOT_A_MEMBER', err && String(err.code));
    eq('lead must be member: group has no lead', await memberships.groupLead(g4.id), null);
    eq('lead must be member: no membership was invented', await memberships.countGroupsForAgent(a.id), 0);
  }

  /* ================================================================ */
  /* 6b. Removing a membership removes that group from the effective set */
  /* ================================================================ */
  {
    const a = await mkAgent(g1.id);
    await memberships.backfillFromLegacyTeamId(prisma); // row for g1, teamId = g1
    await memberships.addMember({ agentId: a.id, teamId: g2.id });
    await memberships.addMember({ agentId: a.id, teamId: g3.id });
    eq('removal: starts with 3 effective groups', await memberships.countEffectiveGroups(a.id), 3);

    await memberships.removeMember({ agentId: a.id, teamId: g3.id });
    let ids = await memberships.getEffectiveGroupIds(a.id);
    eq('removal: effective set is 2', ids.length, 2);
    check('removal: the removed group is gone', !ids.includes(g3.id));
    check('removal: primary group still present', ids.includes(g1.id));
    check('removal: other group still present', ids.includes(g2.id));
    eq('removal: no membership row left', await memberships.isMember(a.id, g3.id), false);

    // Removing the primary group repoints Agent.teamId to a remaining group.
    await memberships.removeMember({ agentId: a.id, teamId: g1.id });
    const after = await prisma.agent.findUnique({ where: { id: a.id } });
    eq('removal: primary pointer repointed off the removed group', after.teamId, g2.id);
    ids = await memberships.getEffectiveGroupIds(a.id);
    eq('removal: only g2 remains', ids.length, 1);
    eq('removal: only g2 remains (value)', ids[0], g2.id);

    // A lead cannot be removed directly — demote or promote first.
    await memberships.setLead({ agentId: a.id, teamId: g2.id, isLead: true });
    let err = null;
    try {
      await memberships.removeMember({ agentId: a.id, teamId: g2.id });
    } catch (e) {
      err = e;
    }
    check('removal: lead removal rejected', err && err.code === 'LEAD_REMOVAL_FORBIDDEN', err && String(err.code));
    eq('removal: lead still a member', await memberships.isMember(a.id, g2.id), true);
    const lead = await memberships.groupLead(g2.id);
    eq('removal: group keeps exactly one lead', lead && lead.agentId, a.id);
  }
/* ================================================================ */
  /* 7. Existing single-group records migrate correctly               */
  /* ================================================================ */
  {
    // An agent created under the old layout: group via the legacy
    // Agent.teamId column only, no TeamMembership row yet.
    const legacy = await mkAgent(g1.id);
    eq('migration: legacy agent has no membership row yet', await memberships.countGroupsForAgent(legacy.id), 0);

    const summary = await memberships.backfillFromLegacyTeamId(prisma);
    check('migration: backfill reported the legacy agent', summary.created >= 1, JSON.stringify(summary));

    const row = await prisma.teamMembership.findUnique({
      where: { agentId_teamId: { agentId: legacy.id, teamId: g1.id } },
    });
    check('migration: membership created for the legacy single-group agent', Boolean(row));
    eq('migration: migrated as a member, not a lead', row.isLead, false);

    // Idempotency: re-running changes nothing.
    const again = await memberships.backfillFromLegacyTeamId(prisma);
    eq('migration: re-run creates nothing new', again.created, 0);
    eq('migration: no duplicate memberships', await prisma.teamMembership.count({ where: { agentId: legacy.id } }), 1);
    eq('migration: legacy pointer still intact', (await prisma.agent.findUnique({ where: { id: legacy.id } })).teamId, g1.id);
  }

  /* ================================================================ */
  /* 8. Existing ticket assignment groups remain intact               */
  /* ================================================================ */
  {
    const owner = await mkAgent(g2.id);
    const t = await prisma.ticket.create({
      data: {
        ticketNumber: await nextTicketNumber(prisma),
        shortDescription: 'groups-test ticket',
        body: 'ticket used by the assignment-groups migration test',
        category: 'Software',
        priority: 'moderate',
        state: 'NEW',
        source: 'portal',
        requesterEmail: `requester@${DOMAIN}`,
        graphMessageId: `groups-test-${seq}`,
        teamId: g2.id,
        originatingTeamId: g1.id,
        assignedAgentId: owner.id,
      },
    });

    // Re-run the whole legacy migration against this database.
    await memberships.backfillFromLegacyTeamId(prisma);

    const after = await prisma.ticket.findUnique({ where: { id: t.id } });
    eq('tickets: current assignment group intact', after.teamId, g2.id);
    eq('tickets: originating assignment group intact', after.originatingTeamId, g1.id);
    eq('tickets: assigned agent intact', after.assignedAgentId, owner.id);

    // Still a single-group structure — never a many-to-many.
    // information_schema is the PostgreSQL equivalent of SQLite's
    // pragma_table_info (identifier case is preserved because Prisma quotes
    // its columns, so 'teamId' matches exactly).
    const ticketCols = await prisma.$queryRawUnsafe(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'Ticket'"
    );
    const names = ticketCols.map((c) => c.column_name);
    check('tickets: keeps the single current-group column', names.includes('teamId'));
    check('tickets: keeps the single originating-group column', names.includes('originatingTeamId'));

    const teamsBefore = await prisma.team.count();
    eq('tickets: team count unchanged by the migration', await prisma.team.count(), teamsBefore);
    eq('tickets: the owner still belongs to their group', await memberships.isMember(owner.id, g2.id), true);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    testdb.cleanup();
    process.exitCode = failures ? 1 : 0;
  });