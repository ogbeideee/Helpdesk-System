/* The Phase-1 classifier seam (no AI provider — the seam only).
 *
 * Proves that:
 *   A. the default classifier reproduces the existing classify() behavior
 *      exactly: same category, same default priority, same routing;
 *   B. an injected mock classifier can supply the category, and a classifier
 *      that returns nothing usable falls back to the keyword classifier;
 *   C. cleanBody reaches the classifier — directly through the intake
 *      payload, through toIntakePayload's mapping, and end-to-end through
 *      the real parser (quoted history and signatures stripped, full body
 *      still intact);
 *   D. email parsing-rule precedence is unchanged (rule fields win per
 *      field, over any classifier);
 *   E. routing behavior is unchanged (routing rules still match on text and
 *      decide the group; parsing-rule teamKey still forces the group);
 *   F. the emailIngestion path (what Graph/IMAP call) and direct intake
 *      produce identical outcomes for the same message.
 *
 * Usage: npm run test:classifier-seam  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('classifierseam');

const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { ensureTeams } = require('../src/teams');
const { ensureDefaultRoutingRules } = require('../src/services/defaultRoutingRules');

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

const PASSWORD = 'SeamSuite!123';
const DOMAIN = 'seam.test';
const QUIET = { log() {}, error() {}, warn() {} };

function quietMailer() {
  const { createMailer } = require('../src/mailer');
  return createMailer({
    logger: QUIET,
    transport: { hasBroadcastTarget: () => false, async sendMail() {}, async sendBroadcastMail() {} },
  });
}

async function main() {
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });

  const teams = Object.fromEntries(
    (await prisma.team.findMany()).map((t) => [t.key, t]),
  );
  const mkAgent = (name, email, teamId) => prisma.agent.create({
    data: {
      name, email, role: 'agent', isActive: true, isAvailable: true, skillLevel: 2,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), ...(teamId ? { teamId } : {}),
    },
  });
  await mkAgent('Default Agent', `default@${DOMAIN}`, teams.service_desk.id);
  await mkAgent('Network Agent', `network@${DOMAIN}`, teams.network.id);
  await mkAgent('Hardware Agent', `hardware@${DOMAIN}`, teams.hardware.id);

  const { intakeEmailMessage } = require('../src/services/ticketIntake');
  const { classify } = require('../src/graph/categoryRules');
  const mailer = quietMailer();

  let n = 0;
  const intake = (payload, options = {}) => {
    n += 1;
    return intakeEmailMessage(
      { messageId: `seam-${n}-${Date.now()}`, from: `rita@${DOMAIN}`, name: 'Rita', ...payload },
      { logger: QUIET, mailer, channel: 'imap', ...options },
    );
  };

  /* ---- A. default classifier == the existing classify() ------------------- */
  console.log('\n--- A. default classifier equivalence ---');
  const cases = [
    ['Forgot my password', 'I am locked out of my account', 'Password Reset'],
    ['Excel crashes on open', 'I get an error message every time', 'Software'],
    ['My laptop is dead', "it won't turn on at all", 'Hardware'],
    ['Canteen menu this week', 'asking for a friend', 'Inquiry / Help'],
  ];
  for (const [subject, body, expected] of cases) {
    const r = await intake({ subject, body });
    eq(`A "${subject}" keeps the classified category`, r.ticket.category, expected);
    eq(`A "${subject}" matches classify() directly`,
      r.ticket.category, classify(`${subject}\n${body}`).category);
    eq(`A "${subject}" keeps the default priority`, r.ticket.priority, 'moderate');
    eq(`A "${subject}" stays an email ticket`, r.ticket.source, 'email');
  }
  // Routing with the default classifier: the vpn text hits the category-
  // agnostic "Network Issues" rule and lands in the network group.
  const vpnDefault = await intake({ subject: 'vpn drops constantly', body: 'since this morning.' });
  eq('A vpn text still routes to the network group', vpnDefault.ticket.teamId, teams.network.id);
  eq('A vpn text still classifies as Software', vpnDefault.ticket.category, 'Software');

  /* ---- B. injected mock classifier ---------------------------------------- */
  console.log('\n--- B. injected mock classifier ---');
  const seen = [];
  const mock = async (input) => { seen.push(input); return { category: 'Hardware', confidence: 0.92 }; };
  const mocked = await intake(
    { subject: 'wifi password question', body: 'what is the guest wifi password?' },
    { classifier: mock },
  );
  eq('B1 the mock classifier decides the category', mocked.ticket.category, 'Hardware');
  eq('B2 the mock classifier is the only one consulted', seen.length, 1);
  eq('B3 priority stays with the intake default', mocked.ticket.priority, 'moderate');

  const garbage = await intake(
    { subject: 'printer jams', body: 'paper stuck' },
    { classifier: async () => ({ category: '  ' }) },
  );
  eq('B4 an empty category falls back to the keyword classifier', garbage.ticket.category, 'Hardware');
  const nothing = await intake(
    { subject: 'office directions please', body: 'where is the IT desk' },
    { classifier: async () => undefined },
  );
  eq('B5 a missing result falls back to the keyword classifier', nothing.ticket.category, 'Inquiry / Help');

  /* ---- C. cleanBody reaches the classifier -------------------------------- */
  console.log('\n--- C. cleanBody reaches the classifier ---');
  const captured = [];
  await intake(
    {
      subject: 'install photoshop',
      body: 'full body with quoted junk',
      cleanBody: 'install photoshop please',
    },
    { classifier: async (input) => { captured.push(input); return { category: 'Software' }; } },
  );
  eq('C1 the classifier sees the cleanBody', captured[0].cleanBody, 'install photoshop please');
  eq('C2 the classifier sees the subject', captured[0].subject, 'install photoshop');
  eq('C3 the classifier sees the full body too', captured[0].body, 'full body with quoted junk');
  eq('C4 the classifier sees the pre-joined text', captured[0].text, 'install photoshop\nfull body with quoted junk');

  const { toIntakePayload, ingestRawEmail } = require('../src/services/emailIngestion');
  const { parseEmail } = require('../src/email/emailParser');
  const normalized = parseEmail({
    id: 'seam-map-1',
    from: `rita@${DOMAIN}`,
    subject: 'mapping check',
    body: 'Body text.',
  });
  eq('C5 toIntakePayload carries cleanBody through',
    toIntakePayload(normalized).cleanBody, 'Body text.');

  // End-to-end: real parser + emailIngestion. The signature quotes 'wifi' so a
  // keyword classifier reading the full body would be misled; the classifier
  // must receive the sender's own words only.
  const e2eSeen = [];
  const e2e = await ingestRawEmail({
    id: `seam-e2e-${Date.now()}`,
    from: `rita@${DOMAIN}`,
    subject: 'Outlook help',
    body: 'My outlook is frozen.\n\n--\nRita Sizes\nwifi router vpn firewall',
  }, {
    logger: QUIET,
    classifier: async (input) => {
      e2eSeen.push(input);
      return { category: 'Software' };
    },
  });
  eq('C6 the end-to-end ticket uses the injected classifier', e2e.result.ticket.category, 'Software');
  eq('C7 the classifier received the quote-stripped cleanBody',
    e2eSeen[0].cleanBody, 'My outlook is frozen.');
  check('C8 the quoted signature never reaches the classifier',
    !e2eSeen[0].cleanBody.includes('wifi'));
  check('C9 the full body is still intact for storage', e2eSeen[0].body.includes('wifi router'));
  const e2eRow = await prisma.ticket.findUnique({ where: { id: e2e.result.ticket.id } });
  eq('C10 the stored body is untouched by the seam', e2eRow.body.includes('wifi router'), true);

  /* ---- D. parsing-rule precedence unchanged -------------------------------- */
  console.log('\n--- D. parsing-rule precedence ---');
  const { evaluateRules } = require('../src/email/parsingRules');
  const evaluator = (rules) => async ({ subject, body }) => evaluateRules({ subject, body, rules });
  const ruleSet = [
    { id: 1, name: 'Network category', keywords: JSON.stringify(['vpn']), scope: 'both', category: 'Network', priority: null, teamKey: null, enabled: true },
  ];
  const ruled = await intake(
    { subject: 'vpn keeps dropping', body: 'since the update.' },
    { ruleEvaluator: evaluator(ruleSet), classifier: async () => ({ category: 'Hardware' }) },
  );
  eq('D1 a parsing rule outranks even an injected classifier', ruled.ticket.category, 'Network');
  eq('D2 fields the rule does not set stay default', ruled.ticket.priority, 'moderate');

  const priRule = [
    { id: 1, name: 'Urgent vpn', keywords: JSON.stringify(['vpn']), scope: 'both', category: null, priority: 'critical', teamKey: null, enabled: true },
  ];
  const priOnly = await intake(
    { subject: 'vpn emergency', body: '' },
    { ruleEvaluator: evaluator(priRule) },
  );
  eq('D3 a priority-only rule leaves the classified category', priOnly.ticket.category, 'Software');
  eq('D4 the rule priority applies', priOnly.ticket.priority, 'critical');

  /* ---- E. routing behavior unchanged --------------------------------------- */
  console.log('\n--- E. routing behavior ---');
  // Routing rules match on TEXT, not on the classifier's category: the same
  // vpn text must land in the network group no matter what the classifier
  // says.
  const vpnMocked = await intake(
    { subject: 'vpn drops constantly', body: 'since this morning.' },
    { classifier: async () => ({ category: 'Hardware' }) },
  );
  eq('E1 the classifier cannot move a rule-matched group',
    vpnMocked.ticket.teamId, vpnDefault.ticket.teamId);
  eq('E2 the network rule still wins the group', vpnMocked.ticket.teamId, teams.network.id);

  // A parsing rule that names a group still forces it, bypassing routing
  // rules, exactly as before.
  await prisma.team.create({ data: { key: 'forced-group', name: 'Forced Group' } });
  const forced = await prisma.team.findUnique({ where: { key: 'forced-group' } });
  await mkAgent('Forced Agent', `forced@${DOMAIN}`, forced.id);
  const forceRule = [
    { id: 1, name: 'Force it', keywords: JSON.stringify(['password reset']), scope: 'both', category: null, priority: null, teamKey: 'forced-group', enabled: true },
  ];
  const forcedTicket = await intake(
    { subject: 'Password reset please', body: 'locked out.' },
    { ruleEvaluator: evaluator(forceRule), classifier: async () => ({ category: 'Hardware' }) },
  );
  eq('E3 a parsing-rule group still bypasses routing rules', forcedTicket.ticket.teamId, forced.id);
  // The rule sets only the group — the category still comes from the
  // classifier (here the mock), exactly as with the default classifier.
  eq('E4 the group-only rule leaves the classifier category', forcedTicket.ticket.category, 'Hardware');

  /* ---- F. emailIngestion path == direct intake ------------------------------ */
  console.log('\n--- F. Graph/IMAP ingestion path unchanged ---');
  const stamp = Date.now();
  const shared = {
    internetMessageId: `same-${stamp}@${DOMAIN}`,
    conversationId: `conv-${stamp}`,
    inReplyTo: [],
    references: [],
    senderEmail: `rita@${DOMAIN}`,
    senderName: 'Rita',
    subject: 'URGENT: vpn will not connect',
    body: 'The vpn client fails every morning.',
    attachments: [],
  };
  const viaIngestion = await (require('../src/services/emailIngestion').ingestNormalizedEmail)({
    ...shared,
    messageId: `ing-${stamp}`,
    cleanBody: shared.body,
  }, { logger: QUIET, channel: 'graph' });
  const viaDirect = await intake({
    messageId: `dir-${stamp}`,
    internetMessageId: `direct-${stamp}@${DOMAIN}`,
    conversationId: shared.conversationId,
    subject: shared.subject,
    body: shared.body,
  }, { channel: 'imap' });
  eq('F1 identical category through both paths',
    viaIngestion.ticket.category, viaDirect.ticket.category);
  eq('F2 identical priority through both paths',
    viaIngestion.ticket.priority, viaDirect.ticket.priority);
  eq('F3 identical assignment group through both paths',
    viaIngestion.ticket.teamId, viaDirect.ticket.teamId);
  eq('F4 the vpn text routed through the ingestion path too',
    viaIngestion.ticket.teamId, teams.network.id);
  eq('F5 the ingestion path created its ticket', viaIngestion.status, 'created');
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
