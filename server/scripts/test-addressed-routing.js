/* Addressing by name: "Dear Dare," means the ticket is Dare's.

   The rule under test is a two-part contract:

     A. READING the greeting (services/addressedRecipient.js) — pure, and
        deliberately hard to fool: only the first block of the sender's own
        words, only a known greeting opener, never a sign-off, never a
        non-person, never ambiguous.
     B. APPLYING it (services/assignmentEngine.js) — the named agent is offered
        the ticket ahead of the routing rule's preferred agent, but only
        through the engine's existing eligibility gate, and never by changing
        the ticket's assignment group.
     C. The nicknames the organisation actually writes — a short form ("Bash"
        for Bashir), a trailing syllable ("Yemi" for Ibiyemi), an ordinary name
        — and the administrator's alias list for the ones the derived match
        cannot separate.

   Both fail OPEN. A greeting that cannot be trusted produces ordinary routing,
   never a wrong assignment and never a dropped ticket.

   Usage: node scripts/test-addressed-routing.js  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database: this suite never touches the application's database.
// Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('addressed-routing');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const addressedRecipient = require('../src/services/addressedRecipient');
const assignmentEngine = require('../src/services/assignmentEngine');
const { resolveAddressed } = require('../src/services/ticketIntake');
const { parseEmail } = require('../src/email/emailParser');

const DOMAIN = 'addressed.example';
const PASSWORD = 'AddressedTest!123';
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

const quiet = { log() {}, warn() {}, error() {} };

let seq = 0;
async function mkAgent(name, over = {}) {
  seq += 1;
  return prisma.agent.create({
    data: {
      name,
      email: `ad${seq}.${name.replace(/[^a-z0-9]+/gi, '').toLowerCase()}@${DOMAIN}`,
      passwordHash: hash,
      role: 'agent',
      isActive: true,
      isAvailable: true,
      skillLevel: 2,
      ...over,
    },
  });
}

/** The addressee the module read, or null. */
function addressedOf(body) {
  const found = addressedRecipient.extractAddressee(body);
  return found ? found.addressee : null;
}

/** Resolve a greeting against a plain list — the pure half, no database. */
function resolveAgainst(body, agents, options) {
  return addressedRecipient.resolveAddressee(
    addressedRecipient.extractAddressee(body),
    agents,
    options,
  );
}

async function main() {
  await ensureTeams(prisma);
  const teams = Object.fromEntries((await prisma.team.findMany()).map((t) => [t.key, t]));

  /* ================================================================ */
  /* A. Reading the greeting — the pure module                       */
  /* ================================================================ */
  {
    // The two cases from the request, plus the everyday variants.
    eq('A1 "Dear Yemi," yields Yemi', addressedOf('Dear Yemi,\n\nMy laptop will not boot.'), 'Yemi');
    eq('A2 "Dear Dare" yields Dare', addressedOf('Dear Dare\n\nThe printer is jammed.'), 'Dare');
    // Case never changes who is addressed — the addressee is reported as the
    // sender wrote it, and matched without regard to case.
    check('A3 case is irrelevant to who is addressed',
      resolveAgainst('DEAR DARE,', [{ id: 5, name: 'Dare Ojo' }]).agentId === 5,
      `got ${resolveAgainst('DEAR DARE,', [{ id: 5, name: 'Dare Ojo' }]).agentId}`);
    eq('A4 "Hello <name>," works', addressedOf('Hello Dare,'), 'Dare');
    eq('A5 "Hi <name>," works', addressedOf('Hi Dare'), 'Dare');
    eq('A6 "Dear Mr. Dare," drops the honorific', addressedOf('Dear Mr. Dare,'), 'Dare');
    eq('A7 "Good morning <name>" works', addressedOf('Good morning Dare,'), 'Dare');
    eq('A8 a full name survives', addressedOf('Dear Dare Ojo,'), 'Dare Ojo');

    // A salutation is not the only line that can carry a name.
    eq('A9 an unrecognised opener is not a greeting', addressedOf('Dare, please help.'), null);
    eq('A10 no body, no addressee', addressedOf(''), null);
    eq('A11 null body, no addressee', addressedOf(null), null);

    // THE sign-off trap. "Dear Yemi," at the end of a message is not a request
    // addressed to Yemi, and reading it would hand the ticket to the sender.
    eq('A12 a trailing sign-off is not read', addressedOf('Please help with the VPN.\n\nThanks,\n\nDear Yemi,'), null);
    eq('A13 a closing salutation is not read', addressedOf('Please help.\n\nKind regards,'), null);

    // Only the first block counts. A name in the second paragraph is the
    // requester's prose, not an addressee.
    eq('A14 a name in the body is not an addressee',
      addressedOf('Dear all,\n\nI told Dare about this yesterday.'), null);
  }

  {
    // "Dear all," is the most common opening in a helpdesk mailbox.
    for (const greeting of ['all', 'everyone', 'team', 'IT', 'Sir', 'Support', 'Colleagues', 'Boss']) {
      eq(`A15 "Dear ${greeting}," addresses nobody`, addressedOf(`Dear ${greeting},`), null);
    }
  }

  {
    // Quoted history is already out of cleanBody, but the module must not be
    // the thing that saves us: a quoted greeting line still reads as a greeting
    // if it is the first line, so the parser's clean view is what matters here.
    const parsed = parseEmail({
      messageId: 'addr-q1',
      from: `staff@${DOMAIN}`,
      subject: 'Re: printer',
      body: 'Dear Dare,\n\nAny progress on the printer?\n\n> Dear Ibiyemi,\n> the printer is jammed.',
    });
    check('A16 the parser keeps the real greeting in cleanBody',
      addressedRecipient.extractAddressee(parsed.cleanBody) !== null, 'cleanBody greeting missing');
    eq('A17 the parser drops the quoted greeting from cleanBody',
      (parsed.cleanBody.match(/Dear Ibiyemi/g) || []).length, 0);
  }

  /* ================================================================ */
  /* B. Resolving the name — exact, nickname, ambiguity               */
  /* ================================================================ */
  {
    // A realistic installation: one Ibiyemi, a different Dare, an unrelated
    // colleague. "Yemi" is a trailing syllable of exactly one of them.
    const agents = [
      { id: 1, name: 'Ibiyemi Dare' },
      { id: 2, name: 'Dare Ogunleye' },
      { id: 3, name: 'Chris Mensah' },
    ];

    // "Yemi" is inside "Ibiyemi" and nowhere else — the nickname case.
    const yemi = resolveAgainst('Dear Yemi,', agents);
    eq('B1 "Yemi" resolves to Ibiyemi', yemi.agentId, 1);
    eq('B2 and it is reported as a nickname match', yemi.matchType, 'nickname');
    eq('B3 the matched name is preserved for the audit trail', yemi.matchedName, 'Yemi');

    // "Dare" is a real name part on two of them. Exact matches beat
    // nicknames, but two exact matches are ambiguous — and must yield nobody.
    const dare = resolveAgainst('Dear Dare,', agents);
    eq('B4 an ambiguous name resolves to nobody', dare.agentId, null);
    check('B5 and the reason names both candidates',
      /agents/.test(dare.reason), dare.reason);

    // A unique exact match wins outright.
    const ibiyemi = resolveAgainst('Dear Ibiyemi,', agents);
    eq('B6 a unique full-name match resolves', ibiyemi.agentId, 1);
    eq('B7 reported as an exact match', ibiyemi.matchType, 'exact');

    // An exact match outranks a nickname match on somebody else: a colleague
    // genuinely called Yemi beats a fragment inside somebody else's name.
    const real = resolveAgainst('Dear Yemi,', [
      { id: 1, name: 'Ibiyemi Dare' },
      { id: 7, name: 'Yemi Adepoju' },
    ]);
    eq('B8 exact beats nickname', real.agentId, 7);
    eq('B9 and says so', real.matchType, 'exact');

    // A trailing syllable beats one buried mid-word: both contain "yemi", but
    // only one ENDS with it, which is what a nickname looks like.
    const ranked = resolveAgainst('Dear Yemi,', [
      { id: 1, name: 'Ibiyemi Dare' },
      { id: 2, name: 'Yemidapo Okoye' },
    ]);
    eq('B10 a trailing nickname beats an interior one', ranked.agentId, 1);

    // Two agents whose names both END in the fragment are genuinely ambiguous,
    // and must yield nobody rather than a coin toss.
    const both = resolveAgainst('Dear Yemi,', [
      { id: 1, name: 'Ibiyemi Dare' },
      { id: 2, name: 'Chris Adeyemi' },
    ]);
    eq('B11 two trailing matches stay ambiguous', both.agentId, null);

    // Nothing matching is not an error; it is just no hint.
    const nobody = resolveAgainst('Dear Wilhelmina,', agents);
    eq('B12 an unknown name yields nobody', nobody.agentId, null);
    eq('B13 with no match type', nobody.matchType, null);

    // Fragments too short to be a nickname must not match.
    eq('B14 a two-letter fragment is not a nickname',
      resolveAgainst('Dear Ye,', agents).agentId, null);
  }

  {
    // The single-candidate case the user described: one Dare on the books.
    const solo = [{ id: 9, name: 'Dare Ojo' }];
    eq('B15 a unique exact match resolves', resolveAgainst('Dear Dare,', solo).agentId, 9);
    eq('B16 reported as exact', resolveAgainst('Dear Dare,', solo).matchType, 'exact');
    eq('B17 a surname resolves', resolveAgainst('Dear Ojo,', solo).agentId, 9);
    eq('B18 a given+surname greeting resolves', resolveAgainst('Dear Dare Ojo,', solo).agentId, 9);
  }

  /* ================================================================ */
  /* C. Intake reads the hint — and only from a clean body            */
  /* ================================================================ */
  {
    const dare = await mkAgent('Dare Addressed');
    const parsed = parseEmail({
      messageId: 'addr-i1',
      from: `staff@${DOMAIN}`,
      subject: 'Printer is jammed',
      body: 'Dear Dare Addressed,\n\nThe printer is jammed again.',
    });
    const hint = await resolveAddressed({ cleanBody: parsed.cleanBody }, prisma);
    eq('C1 intake resolves the greeting to the right agent', hint.agentId, dare.id);

    // The portal and dev intake paths send no cleanBody. Scanning the raw body
    // there could match a greeting inside quoted history, so the feature stays
    // off rather than guessing.
    const noClean = await resolveAddressed({ body: 'Dear Dare Addressed, hi' }, prisma);
    eq('C2 no clean body means no hint', noClean.agentId, null);
    check('C3 and the reason says why', /clean body/i.test(noClean.reason), noClean.reason);

    // The admin switch turns the whole thing off.
    await prisma.setting.create({
      data: { key: 'intakeAddressedRouting', value: '0' },
    });
    const switched = await resolveAddressed({ cleanBody: parsed.cleanBody }, prisma);
    eq('C4 the admin switch disables addressing', switched.agentId, null);
    check('C5 and the reason says it was switched off', /switched off/i.test(switched.reason), switched.reason);
    await prisma.setting.deleteMany({ where: { key: 'intakeAddressedRouting' } });
  }

  /* ================================================================ */
  /* D. The engine applies its own gate to the hint                  */
  /* ================================================================ */
  {
    const inGroup = await mkAgent('Dare InGroup', { teamId: teams.service_desk.id, skillLevel: 3 });
    const other = await mkAgent('Dare InGroup Other', { teamId: teams.accounts.id });
    const base = { category: 'Hardware', priority: 'moderate', subject: 'Printer is jammed', text: 'printer jammed' };

    // The headline case: the greeting decides, and the engine agrees.
    const hit = await assignmentEngine.assign(
      { ...base, addressed: { agentId: other.id, matchedName: 'Dare' } },
      prisma,
      quiet,
    );
    eq('D1 the addressed agent gets the ticket', hit.agent && hit.agent.id, other.id);
    eq('D2 flagged as addressed', hit.addressedAgentUsed, true);
    eq('D3 the matched greeting is carried through', hit.addressedName, 'Dare');
    check('D4 the reason explains the decision', /addressed by name/i.test(hit.reason), hit.reason);
    // The group still belongs to the routing rule — a greeting never moves it.
    eq('D5 the group is unchanged by the greeting', hit.teamId, teams.service_desk.id);
    eq('D6 and the ticket is reported as cross-group', hit.crossTeam, true);
    check('D7 the reason says so', /across groups/i.test(hit.reason), hit.reason);

    // A high-priority ticket never leaves its group on a greeting. Same
    // gating as the cross-team fallback.
    const high = await assignmentEngine.assign(
      { ...base, priority: 'high', addressed: { agentId: other.id, matchedName: 'Dare' } },
      prisma,
      quiet,
    );
    check('D8 a high-priority ticket is not pulled across groups',
      !(high.agent && high.agent.id === other.id),
      `assigned ${high.agent && high.agent.id}`);

    // Same group, any priority: no gate at all.
    const sameGroup = await assignmentEngine.assign(
      { ...base, priority: 'critical', addressed: { agentId: inGroup.id, matchedName: 'Dare' } },
      prisma,
      quiet,
    );
    eq('D9 an in-group addressee takes a critical ticket', sameGroup.agent && sameGroup.agent.id, inGroup.id);
  }

  {
    // The engine's gate is not bypassed by a greeting. Each of these must fall
    // back to normal routing rather than hand the ticket to the named person.
    const cases = [
      ['unavailable', { isAvailable: false }],
      ['deactivated', { isActive: false }],
      ['not a staff account', { role: 'user' }],
      // The skill bar only bites once a routing rule sets one above 1 (or a
      // priority boost raises it), so this case asks for a critical ticket,
      // whose +2 boost puts the bar at 3 — above this agent's level 1.
      ['below the skill bar', { skillLevel: 1, priority: 'critical' }],
    ];
    for (const [label, over] of cases) {
      // `priority` shapes the TICKET, not the agent — take it out of the
      // fixture overrides before they reach agent.create().
      const { priority = 'moderate', ...agentOver } = over;
      const named = await mkAgent(`Dare Gate ${label}`, {
        teamId: teams.service_desk.id,
        ...agentOver,
      });
      const result = await assignmentEngine.assign(
        {
          category: 'Software',
          priority,
          subject: 'Excel crashes on open',
          text: 'excel crashes on open error code',
          addressed: { agentId: named.id, matchedName: 'Dare' },
        },
        prisma,
        quiet,
      );
      check(
        `D10 an addressee who is ${label} is not given the ticket`,
        !(result.agent && result.agent.id === named.id),
        `assigned ${result.agent && result.agent.id}`,
      );
      eq(`D11 and it is not flagged as addressed (${label})`, result.addressedAgentUsed, false);
    }
  }

  {
    // A deleted account must not break the pipeline either.
    const ghost = await mkAgent('Dare Vanished', { teamId: teams.service_desk.id });
    await prisma.agent.delete({ where: { id: ghost.id } });
    const result = await assignmentEngine.assign(
      {
        category: 'Hardware',
        priority: 'moderate',
        subject: 'Monitor flickers',
        text: 'monitor flickers',
        addressed: { agentId: ghost.id, matchedName: 'Dare' },
      },
      prisma,
      quiet,
    );
    check('D12 a vanished account falls back to normal routing', result.agent !== null, 'awaiting assignment');

    // An invalid hint is ignored, not thrown on.
    const junk = await assignmentEngine.assign(
      { category: 'Hardware', priority: 'moderate', subject: 'x', text: 'y', addressed: { agentId: 'nope' } },
      prisma,
      quiet,
    );
    check('D13 a malformed hint is ignored, not thrown', junk !== null);
  }

  /* ================================================================ */
  /* E. The greeting outranks the rule's preferred agent              */
  /* ================================================================ */
  {
    const { RoutingRule } = require('../src/lib/prisma');
    const preferred = await mkAgent('Preferred Rule Agent', { teamId: teams.service_desk.id });
    const greeted = await mkAgent('Dare Greeted', { teamId: teams.service_desk.id });
    const rule = await RoutingRule.create({
      data: {
        name: 'Addressed suite - printer rule',
        category: 'Hardware',
        keywords: 'printer',
        teamId: teams.service_desk.id,
        minimumSkillLevel: 1,
        priority: 1,
        isActive: true,
        preferredAgentId: preferred.id,
      },
    });
    try {
      const result = await assignmentEngine.assign(
        {
          category: 'Hardware',
          priority: 'moderate',
          subject: 'printer is jammed',
          text: 'printer is jammed',
          addressed: { agentId: greeted.id, matchedName: 'Dare' },
        },
        prisma,
        quiet,
      );
      eq('E1 the addressed agent wins over the rule preference', result.agent && result.agent.id, greeted.id);
      eq('E2 and the flag is set', result.addressedAgentUsed, true);
      eq('E3 the rule preference is reported as unused', result.preferredAgentUsed, false);

      // With no greeting, the rule's preferred agent behaves exactly as before.
      const plain = await assignmentEngine.assign(
        { category: 'Hardware', priority: 'moderate', subject: 'printer is jammed', text: 'printer is jammed' },
        prisma,
        quiet,
      );
      eq('E4 with no greeting the preferred agent is still used', plain.agent && plain.agent.id, preferred.id);
      eq('E5 and the addressed flag is false', plain.addressedAgentUsed, false);
    } finally {
      await RoutingRule.deleteMany({ where: { id: rule.id } });
    }
  }

  /* ================================================================ */
  /* F. Every path carries the flag, so no caller has to guess         */
  /* ================================================================ */
  {
    const result = await assignmentEngine.assign(
      { category: 'Hardware', priority: 'moderate', subject: 'dock is stuck', text: 'dock is stuck' },
      prisma,
      quiet,
    );
    eq('F1 addressedAgentUsed is present and false on the normal path', result.addressedAgentUsed, false);
    eq('F2 addressedName is present and null on the normal path', result.addressedName, null);
  }

  /* ================================================================ */
  /* G. The setting is a real, validated, admin-editable value        */
  /* ================================================================ */
  {
    const settingsService = require('../src/services/settingsService');
    const def = settingsService.DEFINITIONS.intakeAddressedRouting;
    check('G1 the setting is defined', Boolean(def));
    eq('G2 it belongs to the intake group', def.group, 'intake');
    eq('G3 it is on by default', String(settingsService.defaultFor('intakeAddressedRouting')), '1');
    check('G4 only 0/1 is accepted', !settingsService.parseValue('intakeAddressedRouting', '2').ok);
    check('G5 0 is accepted', settingsService.parseValue('intakeAddressedRouting', '0').ok);
  }

  /* ================================================================ */
  /* I. The nicknames the org actually writes, and pinning them       */
  /* ================================================================ */
  {
    // The greetings the helpdesk receives, against a roster of the shapes they
    // name. Every one of these arrived as a ticket assigned to somebody else:
    // a short form of a first name (Bash), a trailing syllable (Yemi), and
    // ordinary full names. The match must not need configuration to work.
    const roster = [
      { id: 1, name: 'Bashir Adeleke' },
      { id: 2, name: 'Ibiyemi Okonkwo' },
      { id: 3, name: 'Dare Ojo' },
      { id: 4, name: 'Ogbeide David' },
      { id: 5, name: 'Farook Balogun' },
    ];
    eq('I1 "Dear Bash" is the short form of Bashir',
      resolveAgainst('Dear Bash,\n\nKindly assist with the DL.', roster).agentId, 1);
    eq('I2 "Dear Yemi" is the trailing syllable of Ibiyemi',
      resolveAgainst('Dear Yemi,', roster).agentId, 2);
    eq('I3 "Dear Dare" is a name part',
      resolveAgainst('Dear Dare,', roster).agentId, 3);
    eq('I4 "Dear David" is a name part',
      resolveAgainst('Dear David,', roster).agentId, 4);
    eq('I5 "Dear Farook" is a name part',
      resolveAgainst('Dear Farook,', roster).agentId, 5);
    eq('I6 the short form is reported as a nickname',
      resolveAgainst('Dear Bash,', roster).matchType, 'nickname');
    eq('I7 and its tier is the leading fragment',
      resolveAgainst('Dear Bash,', roster).tier, 'prefix');
    eq('I8 the trailing syllable reports its own tier',
      resolveAgainst('Dear Yemi,', roster).tier, 'suffix');

    // Ranking, in both directions.
    eq('I9 an exact name still beats a leading fragment',
      resolveAgainst('Dear Bash,', [
        { id: 1, name: 'Bashir Adeleke' },
        { id: 6, name: 'Bash Kelvin' },
      ]).agentId, 6);
    eq('I10 two leading fragments are ambiguous',
      resolveAgainst('Dear Bash,', [
        { id: 1, name: 'Bashir Adeleke' },
        { id: 6, name: 'Bashorun Kelvin' },
      ]).agentId, null);
    eq('I11 a trailing syllable beats a leading one',
      resolveAgainst('Dear Bash,', [
        { id: 1, name: 'Bashir Adeleke' },
        { id: 6, name: 'Kelvin Bash' },
      ]).agentId, 6);
    eq('I12 a fragment must still be at least three characters',
      resolveAgainst('Dear Ba,', roster).agentId, null);
    const middle = [{ id: 1, name: 'Chris Adeyemi' }];
    eq('I13 a fragment from the middle is a loose one',
      resolveAgainst('Dear deyem,', middle).tier, 'interior');
    eq('I14 and it still resolves when it is the only match',
      resolveAgainst('Dear deyem,', middle).agentId, 1);

    // A colleague whose name also ends in the nickname is exactly the case an
    // administrator has to be able to settle once and for all.
    const colliding = roster.concat([{ id: 9, name: 'Chris Adeyemi' }]);
    eq('I15 two trailing syllables are ambiguous',
      resolveAgainst('Dear Yemi,', colliding).agentId, null);
    const pinned = resolveAgainst('Dear Yemi,', colliding, { aliases: 'yemi = Ibiyemi Okonkwo' });
    eq('I16 the alias settles it', pinned.agentId, 2);
    eq('I17 reported as an alias', pinned.tier, 'alias');

    // An alias is a statement about the MESSAGE, so it is matched against every
    // account — whether that person can take the work stays the engine's call.
    const away = resolveAgainst('Dear Bash,', [{ id: 1, name: 'Bashir Adeleke', isAvailable: false }], {
      aliases: 'bash = Bashir Adeleke',
    });
    eq('I18 an alias reaches somebody who is unavailable', away.agentId, 1);
    check('I19 and the reason says it was the alias', /alias for/i.test(away.reason), away.reason);

    // An alias that names nobody is not fatal: the derived match still runs.
    const misdirected = resolveAgainst('Dear Bash,', roster, { aliases: 'bash = Nobody Here' });
    eq('I20 a stale alias falls back to the derived match', misdirected.agentId, 1);
    check('I21 and the reason mentions the alias', /alias/i.test(misdirected.reason), misdirected.reason);

    // An alias naming several people is ambiguity, not a coin toss.
    const twins = resolveAgainst('Dear Bash,', [
      { id: 1, name: 'Bashir Adeleke' },
      { id: 2, name: 'Bashir Adeleke' },
    ], { aliases: 'bash = Bashir Adeleke' });
    eq('I22 an alias naming two accounts resolves to nobody', twins.agentId, null);

    // The list grammar: "nickname = agent", first entry for a nickname wins,
    // malformed entries are skipped rather than fatal.
    const parsed = addressedRecipient.parseAliases(
      'Bash = Bashir Adeleke, , nonsense, yemi = y.okonkwo@example.com; bash = Someone Else\nfarook=Farook Balogun',
    );
    eq('I23 malformed entries are dropped', parsed.length, 3);
    eq('I24 the first entry for a nickname wins', parsed[0].target, 'Bashir Adeleke');
    eq('I25 nicknames are case-folded', parsed[0].nickname, 'bash');
    eq('I26 a newline separates entries too', parsed[2].nickname, 'farook');
    eq('I27 an empty list is empty', addressedRecipient.parseAliases('').length, 0);
  }

  {
    // An agent the caller never described is still a candidate. Reading a
    // missing `role` as "not a staff account" emptied the list and made the
    // whole feature inert without a word — the intake query that selected only
    // id and name did exactly that.
    const silent = resolveAgainst('Dear Bash,', [{ id: 1, name: 'Bashir Adeleke' }]);
    eq('I28 an undescribed agent is not disqualified', silent.agentId, 1);
    eq('I29 a described unavailable one is', resolveAgainst('Dear Bash,', [
      { id: 1, name: 'Bashir Adeleke', isAvailable: false },
    ]).agentId, null);
    eq('I30 and so is a deactivated one', resolveAgainst('Dear Bash,', [
      { id: 1, name: 'Bashir Adeleke', isActive: false },
    ]).agentId, null);
    eq('I31 and one who is not a staff account', resolveAgainst('Dear Bash,', [
      { id: 1, name: 'Bashir Adeleke', role: 'user' },
    ]).agentId, null);
  }

  {
    const settingsService = require('../src/services/settingsService');
    // The whole read, through the database and the setting, exactly as intake
    // performs it: no injection, real query, real aliases.
    const bashir = await mkAgent('Bashir Pinned', { teamId: teams.service_desk.id });
    const body = parseEmail({
      messageId: 'addr-i32',
      from: `staff@${DOMAIN}`,
      subject: 'Group DL inclusion',
      body: 'Dear Bash,\n\nKindly assist to include Mr. O in the group DL.',
    });
    const derived = await resolveAddressed({ cleanBody: body.cleanBody }, prisma);
    eq('I32 intake resolves a short form from the database', derived.agentId, bashir.id);
    eq('I33 and reports the tier', derived.tier, 'prefix');

    const saved = await settingsService.update(
      { intakeAddressedAliases: `bash = ${bashir.email}` },
      'addressed-routing-test',
    );
    check('I34 the alias setting accepts an entry', saved.ok === true, JSON.stringify(saved.errors || []));
    const byAlias = await resolveAddressed({ cleanBody: body.cleanBody }, prisma);
    eq('I35 intake resolves it through the alias', byAlias.agentId, bashir.id);
    eq('I36 reported as an alias', byAlias.tier, 'alias');

    // The setting is validated like every other one: it must read as "name = agent".
    eq('I37 an entry without an = is rejected',
      settingsService.parseValue('intakeAddressedAliases', 'bash Bashir').ok, false);
    eq('I38 a duplicate nickname is rejected',
      settingsService.parseValue('intakeAddressedAliases', 'bash = A, bash = B').ok, false);
    eq('I39 the canonical stored form is lowercase and trimmed',
      settingsService.parseValue('intakeAddressedAliases', '  Bash  =  Bashir Adeleke ').value,
      'bash = Bashir Adeleke');
    eq('I40 an empty list is allowed',
      settingsService.parseValue('intakeAddressedAliases', '').ok, true);

    await prisma.setting.deleteMany({ where: { key: 'intakeAddressedAliases' } });
  }

  /* ================================================================ */
  /* H. A message with no greeting at all still routes normally       */
  /* ================================================================ */
  {
    const plain = parseEmail({
      messageId: 'addr-h1',
      from: `staff@${DOMAIN}`,
      subject: 'Where is the expense form',
      body: 'Could someone point me at the expense form?\n\nThanks.',
    });
    const hint = await resolveAddressed({ cleanBody: plain.cleanBody }, prisma);
    eq('H1 an ordinary message has no addressee', hint.agentId, null);

    const result = await assignmentEngine.assign(
      { category: 'Inquiry / Help', priority: 'moderate', subject: 'where is the form', text: 'where is the form' },
      prisma,
      quiet,
    );
    check('H2 and it still routes normally', result !== null);
  }

  /* ================================================================ */
  /* J. The whole pipeline, on the message the org actually received  */
  /* ================================================================ */
  {
    const settingsService = require('../src/services/settingsService');
    const { intakeEmailMessage } = require('../src/services/ticketIntake');
    const { RoutingRule } = require('../src/lib/prisma');
    const mailer = {
      notifyNewTicketToDl: async () => {},
      notifyRequesterAck: async () => {},
      notifyAssignment: async () => {},
      notifyReplyReceived: async () => {},
    };

    // A rule that prefers somebody else for this wording — which is exactly how
    // "Dear Bash" reached the wrong agent in production.
    const preferred = await mkAgent('Pipeline Preferred', { teamId: teams.service_desk.id });
    const bashir = await mkAgent('Bashir Pipeline', { teamId: teams.service_desk.id });
    await RoutingRule.create({
      data: {
        name: 'Addressed suite - DL inclusion rule',
        category: 'Inquiry / Help',
        keywords: 'group dl, inclusion',
        teamId: teams.service_desk.id,
        minimumSkillLevel: 1,
        preferredAgentId: preferred.id,
        isActive: true,
      },
    });

    const letter = (messageId) =>
      parseEmail({
        messageId,
        from: `staff@${DOMAIN}`,
        subject: 'FW: INCLUSION OF MY EMAIL IN ALL STAFF GROUP DL',
        body: [
          'Dear Bash,',
          '',
          'Kindly assist to include Mr. O in all relevant Group DLs.',
          '',
          'Thank you.',
          '',
          'Kind Regards,',
          '',
          'HR Advisor — Shared Services',
        ].join('\n'),
      });
    const intake = (message) =>
      intakeEmailMessage(
        {
          messageId: message.messageId,
          from: `staff@${DOMAIN}`,
          subject: message.subject,
          body: message.body,
          cleanBody: message.cleanBody,
        },
        { logger: quiet, mailer },
      );

    // The alias test above left a second "Bashir" on the books, so this greeting
    // is genuinely ambiguous now — and ambiguity must never be a guess. The
    // ticket still exists, and normal routing owns it.
    const ambiguous = await intake(letter('addr-j1'));
    eq('J1 an ambiguous greeting still creates the ticket', ambiguous.status, 'created');
    eq('J2 and the routing rule\'s preference takes it, not a coin toss',
      ambiguous.ticket.assignedAgentId, preferred.id);

    // The administrator settles the nickname once, and the message the org
    // actually receives reaches the person it names.
    const saved = await settingsService.update(
      { intakeAddressedAliases: `bash = ${bashir.email}` },
      'addressed-routing-test',
    );
    check('J3 the alias is saved', saved.ok === true, JSON.stringify(saved.errors || []));
    const addressed = await intake(letter('addr-j2'));
    eq('J4 "Dear Bash" now reaches Bashir', addressed.ticket.assignedAgentId, bashir.id);

    const created = await prisma.auditEvent.findFirst({
      where: { ticketId: addressed.ticket.id, action: 'ticket.created' },
      orderBy: { id: 'asc' },
    });
    const metadata = created && created.metadata ? JSON.parse(created.metadata) : {};
    eq('J5 the trail records the greeting that decided it', metadata.addressedByName, 'Bash');

    await prisma.setting.deleteMany({ where: { key: 'intakeAddressedAliases' } });
  }

  await prisma.setting.deleteMany({ where: { key: 'intakeAddressedRouting' } });

  console.log(failures ? `\n${failures} FAILED` : '\nAll addressed-routing tests passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('addressed-routing suite crashed:', err);
  process.exit(1);
});
