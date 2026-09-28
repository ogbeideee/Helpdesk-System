// Correct the Software skill policy on a database that was seeded BEFORE the
// policy changed.
//
//   npm run db:relevel-software            -> report what WOULD change
//   npm run db:relevel-software -- --apply -> write it
//
// Seeding (src/services/defaultRoutingRules.js) only ever runs against an
// empty rule table, on purpose — an administrator's edits are never
// overwritten. That is exactly why this script exists: an installation seeded
// with a blanket MID bar on the Software category keeps levelling ordinary
// software requests at L2 until somebody changes the rows explicitly, through
// an audited path.
//
// Two changes, both narrow:
//   1. a Software rule with NO keywords speaks for the whole category, so it
//      is lowered to JUNIOR (L1) when it asks for more;
//   2. the 'Software (Advanced)' rule is created from the seed when it is
//      missing, so genuinely hard work still asks for L2 — but only when the
//      sender's own words say so.
// Every other Software rule — anything an administrator wrote with keywords —
// is reported and left untouched.
//
// NO ticket row is modified. A ticket's requirement is derived from the rules
// on read (assignmentEngine.requiredSkill), so correcting the rules corrects
// every ticket they govern, past and present. The report shows the before and
// after counts, so the effect is visible before it is applied.
const prisma = require('../src/lib/prisma');
const routingService = require('../src/services/routingService');
const { DEFAULT_RULES } = require('../src/services/defaultRoutingRules');

const APPLY = process.argv.includes('--apply');
const ADVANCED_NAME = 'Software (Advanced)';
const CATCH_ALL_NAME = 'Software & Applications';
const ADVANCED = DEFAULT_RULES.find((r) => r.name === ADVANCED_NAME);
const CATCH_ALL = DEFAULT_RULES.find((r) => r.name === CATCH_ALL_NAME);
const MAX_SKILL = 3;
const MAX_TICKETS = 1000;
const BOOST_BY = { low: 0, moderate: 0, high: 1, critical: 2 };

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

/** A seeded definition, in the shape the routing service matches against. */
function asRuleRow(def, teamId) {
  return {
    id: -1,
    name: def.name,
    keywords: routingService.serialiseKeywords(def.keywords || []),
    category: def.category ?? null,
    teamId,
    minimumSkillLevel: def.minimumSkillLevel ? routingService.skillValue(def.minimumSkillLevel) : null,
    priority: def.priority,
    isActive: true,
  };
}

/**
 * Which rule governs a ticket, using the routing service's own matching and
 * precedence — never a second implementation of it.
 */
function winnerFor(rules, { category, text, subject }) {
  const haystackNorm = routingService.normalise(text);
  const haystackCompact = routingService.compact(text);
  const subjectNorm = routingService.normalise(subject);
  const subjectCompact = routingService.compact(subject);
  const matches = [];
  for (const rule of rules) {
    const result = routingService.evaluateRule(rule, {
      category, subjectNorm, subjectCompact, haystackNorm, haystackCompact,
    });
    if (result.matched) {
      matches.push({ rule, keywords: result.keywords, subjectKeywords: result.subjectKeywords, longest: result.longest });
    }
  }
  matches.sort((a, b) => routingService.compareMatches(a, b, category));
  return matches.length ? matches[0].rule : null;
}

/** The bar a ticket ends up with under a given set of rules. */
function requirementUnder(rules, ticket, boost) {
  const scoped = rules.filter((r) => (ticket.teamId === null ? true : r.teamId === ticket.teamId));
  const winner = winnerFor(scoped, {
    category: ticket.category,
    text: `${ticket.shortDescription}\n${ticket.body || ''}`,
    subject: ticket.shortDescription,
  });
  const base = winner && Number.isInteger(winner.minimumSkillLevel) ? winner.minimumSkillLevel : 1;
  return { level: Math.max(1, Math.min(MAX_SKILL, base + boost)), ruleName: winner ? winner.name : null };
}

async function main() {
  console.log(
    APPLY
      ? 'APPLYING the Software skill-level correction'
      : 'DRY RUN — nothing will be written (pass --apply to apply)'
  );

  const software = await prisma.team.findUnique({ where: { key: 'software' } });
  if (!software) {
    console.log('\nNo assignment group with key "software" exists — nothing to do.');
    return;
  }

  const rules = await prisma.routingRule.findMany({
    where: { category: 'Software' },
    include: { team: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  heading(`Software-category rules on this database (${rules.length})`);
  for (const r of rules) {
    const count = routingService.parseKeywords(r.keywords).length;
    console.log(
      `  #${r.id}  ${r.name}  -> ${r.team ? r.team.key : '(no group)'}` +
      `  bar=${r.minimumSkillLevel ?? 'none'}  priority=${r.priority}` +
      `  ${r.isActive ? 'active' : 'INACTIVE'}  keywords=${count}`
    );
  }
  if (!rules.length) console.log('  none');

  /* ---- 1. the category catch-all ----------------------------------- */
  const catchAlls = rules.filter((r) => !routingService.parseKeywords(r.keywords).length);
  const toLower = catchAlls.filter((r) => Number.isInteger(r.minimumSkillLevel) && r.minimumSkillLevel > 1);

  heading('Change 1 — a Software rule with no keywords speaks for the whole category');
  if (!catchAlls.length) {
    console.log('  no keyword-free Software rule: the bar is already set rule by rule');
  } else {
    console.log(`  catch-all rule(s): ${catchAlls.map((r) => `"${r.name}"`).join(', ')}`);
    if (!toLower.length) console.log('  already L1 (or no bar) — nothing to lower');
    for (const r of toLower) console.log(`  "${r.name}" (#${r.id}): L${r.minimumSkillLevel} -> L1 (JUNIOR)`);
  }

  /* ---- 2. the advanced rule ---------------------------------------- */
  const advanced = rules.find((r) => r.name === ADVANCED_NAME);
  heading(`Change 2 — the "${ADVANCED_NAME}" rule keeps advanced work at L2`);
  let createAdvanced = false;
  if (advanced) {
    console.log(
      `  already present (#${advanced.id}): bar=${advanced.minimumSkillLevel ?? 'none'}` +
      ` priority=${advanced.priority} ${advanced.isActive ? 'active' : 'inactive'} — left as the administrator left it`
    );
  } else if (!ADVANCED) {
    console.log('  the seed defines no such rule — nothing to create');
  } else {
    createAdvanced = true;
    console.log(`  missing — would be created: group=${software.key} bar=MID priority=${ADVANCED.priority} category=Software`);
    console.log(`  keywords: ${(ADVANCED.keywords || []).join(', ')}`);
  }

  /* ---- 3. what this does to the tickets already raised -------------- */
  const tickets = await prisma.ticket.findMany({
    where: { category: 'Software' },
    select: { id: true, ticketNumber: true, shortDescription: true, body: true, category: true, priority: true, teamId: true },
    orderBy: { id: 'desc' },
    take: MAX_TICKETS,
  });
  const afterRules = [
    ...rules.filter((r) => !toLower.includes(r)).map((r) => ({ ...r })),
    ...toLower.map((r) => ({ ...r, minimumSkillLevel: 1 })),
    ...(createAdvanced ? [asRuleRow(ADVANCED, software.id)] : []),
  ];

  let beforeAbove = 0;
  let afterAbove = 0;
  const stillAbove = [];
  for (const ticket of tickets) {
    const boost = BOOST_BY[ticket.priority] || 0;
    if (requirementUnder(rules, ticket, boost).level > 1) beforeAbove += 1;
    const after = requirementUnder(afterRules, ticket, boost);
    if (after.level > 1) {
      afterAbove += 1;
      stillAbove.push({ number: ticket.ticketNumber, level: after.level, rule: after.ruleName });
    }
  }

  heading(`Software tickets already raised (${tickets.length}${tickets.length === MAX_TICKETS ? '+ (capped)' : ''})`);
  console.log(`  requiring L2 or more BEFORE: ${beforeAbove}`);
  console.log(`  requiring L2 or more AFTER:  ${afterAbove}`);
  console.log('  (no ticket row is written: the requirement is derived from the rules on read)');
  for (const row of stillAbove.slice(0, 5)) {
    console.log(`    ${row.number} -> L${row.level} (${row.rule})`);
  }
  if (!stillAbove.length) console.log('    every Software ticket now asks for L1, or for the priority boost alone');

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write the rule changes.');
    return;
  }
  if (!toLower.length && !createAdvanced) {
    console.log('\nNothing to write.');
    return;
  }

  /* ---- apply -------------------------------------------------------- */
  heading('Applied');
  for (const r of toLower) {
    const updated = await prisma.routingRule.update({ where: { id: r.id }, data: { minimumSkillLevel: 1 } });
    await routingService.recordRuleAudit({
      rule: updated,
      action: 'updated',
      changes: { minimumSkillLevel: { from: r.minimumSkillLevel, to: 1 }, reason: 'software is first-line work' },
      actor: 'system (db:relevel-software)',
    });
    console.log(`  "${updated.name}" (#${updated.id}) -> L1`);
  }
  if (createAdvanced) {
    const created = await prisma.routingRule.create({
      data: {
        name: ADVANCED.name,
        keywords: routingService.serialiseKeywords(ADVANCED.keywords || []),
        category: ADVANCED.category,
        teamId: software.id,
        preferredAgentId: null,
        minimumSkillLevel: routingService.skillValue(ADVANCED.minimumSkillLevel),
        priority: ADVANCED.priority,
        isActive: true,
      },
    });
    await routingService.recordRuleAudit({
      rule: created,
      action: 'created',
      changes: { seeded: true, reason: 'advanced software wording keeps its L2 bar' },
      actor: 'system (db:relevel-software)',
    });
    console.log(`  "${created.name}" (#${created.id}) created (bar=MID, priority=${created.priority})`);
  }
  console.log(
    `\n  seeded catch-all for reference: ${CATCH_ALL_NAME} -> ${CATCH_ALL ? CATCH_ALL.minimumSkillLevel : 'n/a'}`
  );
  console.log('  Ticket rows untouched — reopen any ticket and "Skill required" reads the corrected rules.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
