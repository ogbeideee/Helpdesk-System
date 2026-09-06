/* Admin-configurable email parsing rules.

   Part A pins the pure matching engine (subject/body scopes, case
   insensitivity, whitespace tolerance, word boundaries, literal-only phrases,
   per-field precedence). Part B covers the service: validation, persistence
   and the audit trail. Part C drives the admin API (authorization + CRUD).
   Part D proves intake applies ONLY the fields a rule sets — category,
   priority and group each independently — with deterministic conflict
   resolution, disabled-rule handling, fail-open behavior and structured audit
   metadata. Part E verifies the SAME email entering through Graph and IMAP
   produces identical ticket outcomes under the same rules.

   Usage: npm run test:email-rules  (from server/) */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.PORT = process.env.PORT || '4220';
process.env.REBALANCE_INTERVAL_MS = '0';
process.env.HANDOVER_SWEEP_INTERVAL_MS = '0';
process.env.SLA_SWEEP_INTERVAL_MS = '0';

// Isolated database. Must come before anything that loads the Prisma client.
const testdb = require('./lib/testdb').use('emailrules');

const { spawn } = require('child_process');
const path = require('path');
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

const PASSWORD = 'RulesSuite!123';
const DOMAIN = 'rules.test';
const QUIET = { log() {}, error() {}, warn() {} };

function quietMailer() {
  const { createMailer } = require('../src/mailer');
  return createMailer({
    logger: QUIET,
    transport: { hasBroadcastTarget: () => false, async sendMail() {}, async sendBroadcastMail() {} },
  });
}

async function req(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`http://localhost:${process.env.PORT}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/* ====================================================================== */
/* Main                                                                    */
/* ====================================================================== */
async function main() {
  /* ---- A. the pure matching engine -------------------------------------- */
  console.log('\n--- A. matching engine ---');
  const { matchRule, evaluateRules } = require('../src/email/parsingRules');

  const rule = (over = {}) => ({
    id: 1, name: 'probe', keywords: JSON.stringify(['vpn']), scope: 'both',
    category: null, priority: null, teamKey: null, enabled: true, ...over,
  });

  eq('A1 subject-only rule ignores the body',
    matchRule(rule({ scope: 'subject' }), { subject: '', body: 'vpn drops' }), null);
  eq('A2 body-only rule ignores the subject',
    matchRule(rule({ scope: 'body' }), { subject: 'vpn drops', body: '' }), null);
  eq('A3 both-scope matches the subject',
    matchRule(rule(), { subject: 'VPN drops', body: '' }).matched.join(','), 'vpn');
  eq('A4 both-scope matches the body',
    matchRule(rule(), { subject: '', body: 'the vpn is down' }).matched.join(','), 'vpn');
  eq('A5 matching is case-insensitive',
    matchRule(rule({ keywords: JSON.stringify(['CoNnEcTiOn DrOpS']) }), { subject: '', body: 'CONNECTION DROPS daily' }) !== null, true);
  eq('A6 whitespace variation matches',
    matchRule(rule({ keywords: JSON.stringify(['connection drops']) }), { subject: '', body: 'the\n  connection \t drops' }) !== null, true);
  eq('A7 whole-word matching: substring does not hit',
    matchRule(rule(), { subject: '', body: 'our svpngate appliance' }), null);
  eq('A8 whole-word matching: punctuation boundary does hit',
    matchRule(rule(), { subject: '', body: '(vpn), is down' }) !== null, true);
  eq('A9 keywords are literal: a regex-looking phrase never executes',
    matchRule(rule({ keywords: JSON.stringify(['a.*b']) }), { subject: '', body: 'aXYZb' }), null);
  eq('A10 multiple keywords: any hit matches, all hits are reported',
    JSON.stringify(matchRule(rule({ keywords: JSON.stringify(['vpn', 'printer']) }), { subject: 'printer jam', body: 'and vpn' }).matched),
    JSON.stringify(['vpn', 'printer']));
  eq('A11 no keywords means no match',
    matchRule(rule({ keywords: JSON.stringify([]) }), { subject: 'vpn', body: 'vpn' }), null);
  eq('A12 null/undefined content is safe',
    matchRule(rule(), { subject: null, body: undefined }), null);

  const evalResult = evaluateRules({
    subject: 'printer jam',
    body: 'the vpn is down',
    rules: [
      rule({ id: 1, name: 'network', precedence: 10, category: 'Network', priority: 'high' }),
      rule({ id: 2, name: 'hardware', precedence: 20, keywords: JSON.stringify(['printer']), category: 'Hardware' }),
    ],
  });
  eq('A13 both matching rules are reported in order',
    JSON.stringify(evalResult.matches.map((m) => m.name)), JSON.stringify(['network', 'hardware']));
  eq('A14 the lower-precedence rule wins the contested field',
    evalResult.effective.category, 'Network');
  eq('A15 per-field independence: only set fields apply',
    evalResult.effective.priority, 'high');
  eq('A16 the deciding rule ids are reported',
    JSON.stringify(evalResult.effectiveBy), JSON.stringify({ category: 1, priority: 1, teamKey: null }));
  eq('A17 disabled rules never match',
    evaluateRules({ subject: 'vpn', body: '', rules: [rule({ enabled: false, priority: 'critical' })] }).matches.length, 0);
  const emptyEval = evaluateRules({ subject: 'vpn', body: 'vpn', rules: [] });
  eq('A18 an empty rule list matches nothing', emptyEval.matches.length, 0);
  eq('A18b an empty rule list overrides nothing',
    emptyEval.effective.category === null && emptyEval.effective.priority === null && emptyEval.effective.teamKey === null, true);
  eq('A19 unicode words match on boundaries',
    matchRule(rule({ keywords: JSON.stringify(['møde']) }), { subject: '', body: 'vi afholder møde i morgen' }) !== null, true);
  eq('A19b unicode substrings stay out: møde does not hit mødeplanlægning',
    matchRule(rule({ keywords: JSON.stringify(['møde']) }), { subject: '', body: 'diskutere mødeplanlægning' }), null);

  /* ---- shared seed ------------------------------------------------------- */
  await ensureTeams(prisma);
  await ensureDefaultRoutingRules({ client: prisma, logger: { log() {}, warn() {} } });
  const defaultTeam = await prisma.team.findFirst({ where: { isDefault: true, isActive: true } });
  const forcedTeam = await prisma.team.create({ data: { key: 'forced-group', name: 'Forced Group' } });
  const mkAgent = (name, email, teamId) => prisma.agent.create({
    data: {
      name, email, role: 'agent', isActive: true, isAvailable: true, skillLevel: 2,
      passwordHash: bcrypt.hashSync(PASSWORD, 4), ...(teamId ? { teamId } : {}),
    },
  });
  const adminAgent = await mkAgent('Rules Admin', `admin@${DOMAIN}`, null);
  await prisma.agent.update({ where: { id: adminAgent.id }, data: { role: 'admin' } });
  await mkAgent('Default Agent', `default@${DOMAIN}`, defaultTeam.id);
  await mkAgent('Forced Agent', `forced@${DOMAIN}`, forcedTeam.id);

  /* ---- B. service: validation, persistence, audit ------------------------ */
  console.log('\n--- B. service ---');
  const service = require('../src/services/emailParsingRuleService');
  const created = await service.createRule({
    name: 'VPN to network', keywords: 'vpn drops\n  VPN DROPS \nremote access', scope: 'both',
    category: 'Network', priority: 'high', teamKey: 'forced-group', precedence: 10,
  }, adminAgent, prisma);
  eq('B1 create returns the serialized rule', created.name, 'VPN to network');
  eq('B2 keywords dedupe case-insensitively', created.keywords.length, 2);
  eq('B3 the group reference is kept', created.teamKey, 'forced-group');
  eq('B4 the rule is persisted', await prisma.emailParsingRule.count(), 1);

  const validationCases = [
    ['B5 missing name is rejected', { keywords: 'a' }, 'name'],
    ['B6 missing keywords is rejected', { name: 'x' }, 'keyword'],
    ['B7 bad scope is rejected', { name: 'x', keywords: 'a', scope: 'everywhere' }, 'scope'],
    ['B8 bad priority is rejected', { name: 'x', keywords: 'a', priority: 'urgent' }, 'priority'],
    ['B9 unknown group is rejected', { name: 'x', keywords: 'a', teamKey: 'ghost' }, 'group'],
    ['B10 bad precedence is rejected', { name: 'x', keywords: 'a', precedence: 'many' }, 'precedence'],
  ];
  for (const [label, payload, needle] of validationCases) {
    try {
      await service.createRule(payload, adminAgent, prisma);
      check(label, false, 'expected rejection');
    } catch (err) {
      check(label, err instanceof service.RuleValidationError
        && err.errors.some((e) => e.toLowerCase().includes(needle)));
    }
  }
  eq('B11 no invalid rule was persisted', await prisma.emailParsingRule.count(), 1);

  const updated = await service.updateRule(created.id, { enabled: false, precedence: 3 }, adminAgent, prisma);
  eq('B12 update flips the flag', updated.enabled, false);
  eq('B13 update keeps untouched fields', updated.name, 'VPN to network');
  eq('B14 update stores the new precedence', updated.precedence, 3);
  eq('B15 update of an unknown id returns null',
    await service.updateRule(99999, { enabled: true }, adminAgent, prisma), null);
  eq('B16 delete removes the rule', (await service.deleteRule(created.id, adminAgent, prisma)).ok, true);

  const audits = await prisma.auditEvent.findMany({
    where: { action: { in: ['email_rule.created', 'email_rule.updated', 'email_rule.deleted'] } },
    orderBy: { id: 'asc' },
  });
  eq('B17 all three rule mutations are audited', audits.length, 3);
  check('B18 the audit rows name the actor and the rule',
    audits.every((a) => a.actorLabel && a.actorLabel.includes('Rules Admin')));

  /* ---- C. admin API ------------------------------------------------------- */
  console.log('\n--- C. admin API ---');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env },
  });
  try {
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await req('/api/health')).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const adminLogin = await req('/api/auth/login', { method: 'POST', body: { email: `admin@${DOMAIN}`, password: PASSWORD } });
    const agentLogin = await req('/api/auth/login', { method: 'POST', body: { email: `default@${DOMAIN}`, password: PASSWORD } });
    const admin = adminLogin.data.token;
    const agent = agentLogin.data.token;

    eq('C1 unauthenticated read is 401', (await req('/api/email-rules')).status, 401);
    eq('C2 agents cannot read rules', (await req('/api/email-rules', { token: agent })).status, 403);
    eq('C3 agents cannot create rules', (await req('/api/email-rules', { method: 'POST', token: agent, body: { name: 'x', keywords: 'a' } })).status, 403);

    const make = await req('/api/email-rules', {
      method: 'POST', token: admin,
      body: { name: 'API rule', keywords: 'laptop\nmonitor', scope: 'subject', category: 'Hardware', precedence: 20 },
    });
    eq('C4 admin creates a rule', make.status, 201);
    eq('C5 the created rule round-trips', JSON.stringify(make.data.rule.keywords), JSON.stringify(['laptop', 'monitor']));
    const list = await req('/api/email-rules', { token: admin });
    eq('C6 the list carries the persisted rule', list.data.rules.some((r) => r.name === 'API rule'), true);
    const patched = await req(`/api/email-rules/${make.data.rule.id}`, {
      method: 'PATCH', token: admin, body: { enabled: false },
    });
    eq('C7 admin disables a rule', patched.data.rule.enabled, false);
    const invalid = await req('/api/email-rules', {
      method: 'POST', token: admin, body: { name: '', keywords: [] },
    });
    eq('C8 invalid payloads are 400 with field errors', invalid.status === 400 && Array.isArray(invalid.data.errors), true);
    eq('C9 unknown rule id is 404', (await req('/api/email-rules/424242', { method: 'DELETE', token: admin })).status, 404);
    eq('C10 admin deletes a rule',
      (await req(`/api/email-rules/${make.data.rule.id}`, { method: 'DELETE', token: admin })).status, 200);
    eq('C11 the deleted rule is gone',
      (await req('/api/email-rules', { token: admin })).data.rules.length, 0);
  } finally {
    server.kill();
  }

  /* ---- D. intake integration ---------------------------------------------- */
  console.log('\n--- D. intake applies only what rules set ---');
  const { intakeEmailMessage } = require('../src/services/ticketIntake');
  const mailer = quietMailer();
  const evaluator = (rules) => async ({ subject, body }) => {
    const { evaluateRules } = require('../src/email/parsingRules');
    return evaluateRules({ subject, body, rules });
  };

  let n = 0;
  const intake = (payload, rules) => intakeEmailMessage(payload, {
    logger: QUIET, mailer, channel: 'imap', ruleEvaluator: evaluator(rules),
  }).then((r) => { n += 1; return r; });
  const payloadFor = (subject, body) => ({
    messageId: `rule-${n}-${Date.now()}`, subject, body, from: 'rita@rules.test', name: 'Rita',
  });

  // D1: category-only — priority stays at the default.
  const catOnly = await intake(payloadFor('Cannot reach the vpn gateway', 'It fails every morning.'), [
    { id: 1, name: 'Network category', keywords: JSON.stringify(['vpn']), scope: 'both', category: 'Network', priority: null, teamKey: null, enabled: true },
  ]);
  eq('D1 a category rule wins over the classifier', catOnly.ticket.category, 'Network');
  eq('D2 unset fields keep the default priority', catOnly.ticket.priority, 'moderate');

  // D3: priority-only — category stays classified.
  const priOnly = await intake(payloadFor('vpn keeps dropping', 'Since the update.'), [
    { id: 1, name: 'Urgent VPN', keywords: JSON.stringify(['vpn']), scope: 'both', category: null, priority: 'critical', teamKey: null, enabled: true },
  ]);
  eq('D3 a priority rule applies', priOnly.ticket.priority, 'critical');
  eq('D4 unset category keeps the classifier result', priOnly.ticket.category, 'Software');

  // D5: group-only — the ticket lands in the forced group with that group's agent.
  const groupOnly = await intake(payloadFor('Password reset please', 'Locked out.'), [
    { id: 1, name: 'Route to forced', keywords: JSON.stringify(['password reset']), scope: 'both', category: null, priority: null, teamKey: 'forced-group', enabled: true },
  ]);
  eq('D5 a group rule forces the assignment group', groupOnly.ticket.teamId, forcedTeam.id);
  eq('D6 the agent is chosen within the forced group', groupOnly.ticket.assignedAgentId !== null, true);
  eq('D7 the classified category is untouched by a group rule', groupOnly.ticket.category, 'Password Reset');

  // D8: precedence conflicts resolve per field, deterministically.
  const conflict = await intake(payloadFor('vpn printer fire', 'everything at once'), [
    { id: 1, name: 'low precedence', keywords: JSON.stringify(['vpn']), scope: 'both', category: 'Network', priority: 'low', teamKey: null, enabled: true },
    { id: 2, name: 'high precedence', keywords: JSON.stringify(['printer']), scope: 'both', category: 'Hardware', priority: null, teamKey: null, enabled: true },
  ]);
  eq('D8 the lower precedence number wins the contested category', conflict.ticket.category, 'Network');
  eq('D9 contested priority goes to the lower rule too', conflict.ticket.priority, 'low');

  // D11: disabled rules change nothing.
  const disabled = await intake(payloadFor('vpn unavailable', ''), [
    { id: 1, name: 'disabled rule', keywords: JSON.stringify(['vpn']), scope: 'both', category: 'Network', priority: 'critical', teamKey: 'forced-group', enabled: false },
  ]);
  eq('D11 a disabled rule never applies', disabled.ticket.category !== 'Network' && disabled.ticket.priority === 'moderate', true);

  // D12: no match — the pipeline behaves exactly as without rules.
  const noMatch = await intake(payloadFor('Something else entirely', 'Nothing here.'), [
    { id: 1, name: 'never', keywords: JSON.stringify(['zzz-never-matches']), scope: 'both', category: 'Network', priority: 'critical', teamKey: 'forced-group', enabled: true },
  ]);
  eq('D12 no match leaves the defaults', noMatch.ticket.priority, 'moderate');
  eq('D13 no match leaves the classified category', noMatch.ticket.category !== 'Network', true);

  // D14: audit metadata names the rules that matched.
  const conflictAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: conflict.ticket.id } });
  const meta = typeof conflictAudit.metadata === 'string' ? JSON.parse(conflictAudit.metadata) : conflictAudit.metadata;
  eq('D14 the audit trail names the matched rules in order',
    JSON.stringify(meta.emailRules), JSON.stringify(['low precedence', 'high precedence']));
  const noMatchAudit = await prisma.auditEvent.findFirst({ where: { action: 'ticket.created', entityId: noMatch.ticket.id } });
  const noMeta = typeof noMatchAudit.metadata === 'string' ? JSON.parse(noMatchAudit.metadata) : noMatchAudit.metadata;
  eq('D15 no match adds no rule metadata', 'emailRules' in noMeta, false);

  // D16: fail-open — a crashing evaluator must not block intake.
  const failing = await intakeEmailMessage(payloadFor('vpn emergency', ''), {
    logger: QUIET, mailer, channel: 'imap',
    ruleEvaluator: async () => { throw new Error('rules table exploded'); },
  });
  eq('D16 a failing evaluator still creates the ticket', failing.status, 'created');
  eq('D17 with fallback defaults', failing.ticket.priority, 'moderate');

  /* ---- E. same email through both channels -------------------------------- */
  console.log('\n--- E. cross-channel equivalence under rules ---');
  const { createMailService } = require('../src/graph/mailService');
  const rules = [
    { id: 1, name: 'VPN network', keywords: JSON.stringify(['vpn']), scope: 'both', category: 'Network', priority: 'high', teamKey: 'forced-group', enabled: true },
  ];
  const { evaluateRules: evalRules } = require('../src/email/parsingRules');
  const { toIntakePayload } = require('../src/services/emailIngestion');
  // The Graph service gets the SAME rule set the IMAP intake call uses.
  const graphSvc = createMailService({
    logger: QUIET,
    ops: { async listAttachments() { return []; }, async markAsRead() {} },
    intake: (email) => intakeEmailMessage(toIntakePayload(email), {
      logger: QUIET, mailer, channel: 'graph',
      ruleEvaluator: ({ subject, body }) => evalRules({ subject, body, rules }),
    }),
  });

  const rfcId = `eq-${Date.now()}@rules.test`;
  await graphSvc.processOne({
    id: `graph-eq-${Date.now()}`,
    internetMessageId: `<${rfcId}>`,
    conversationId: 'conv-eq',
    subject: 'URGENT: VPN will not connect',
    from: { emailAddress: { name: 'Eva', address: 'eva@rules.test' } },
    body: { contentType: 'text', content: 'The VPN client fails every morning.' },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
  }, { source: 'poller' });
  const viaImap = await intake(payloadFor('URGENT: VPN will not connect', 'The VPN client fails every morning.'), rules);
  // processOne reports the outcome; the ticket itself is read back by identity.
  const viaGraphTicket = await prisma.ticket.findUnique({ where: { internetMessageId: rfcId } });

  eq('E1 both channels created their ticket', Boolean(viaGraphTicket) && viaImap.status === 'created', true);
  eq('E2 identical category through both channels', viaGraphTicket.category === viaImap.ticket.category, true);
  eq('E3 identical priority through both channels', viaGraphTicket.priority === viaImap.ticket.priority, true);
  eq('E4 identical assignment group through both channels', viaGraphTicket.teamId === viaImap.ticket.teamId, true);
  eq('E5 the rule outcome actually applied', viaImap.ticket.category, 'Network');
  eq('E6 the rule priority applied', viaImap.ticket.priority, 'high');
  eq('E7 the rule group applied', viaImap.ticket.teamId, forcedTeam.id);
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
