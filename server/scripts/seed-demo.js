// Generates the development demo dataset so the dashboard/tables have
// meaningful data. All demo rows use @demo.example requesters.
//
//   npm run seed:demo             -> demo accounts + fixture tickets + ~120 bulk tickets
//   npm run seed:demo -- --clear  -> remove previously seeded demo data
//
// LOCAL/DEVELOPMENT ONLY, AND EXPLICITLY OPT-IN.
//
// This script writes fictional accounts and tickets. On a real installation
// that is data corruption, so it will not run unless you say so twice: pass
// --confirm (or set ALLOW_DEMO_SEED=1) as well as being outside production.
// It is never invoked from application startup or from db:init.
//
// Demo passwords live here in the backend seed only — never in frontend
// source, never in the README and never in production configuration.
//
// Every part of this seed is idempotent: accounts are upserted by email and
// fixture tickets are keyed by a stable graphMessageId, so re-running never
// creates duplicates.
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { classify } = require('../src/graph/categoryRules');
const { nextTicketNumber } = require('../src/ticketNumbers');
const { computeDueAt } = require('../src/sla');
const assignmentEngine = require('../src/services/assignmentEngine');
const { ensureTeams } = require('../src/teams');

// Fallback author for demo activity when no agent is assigned. Points at the
// demo domain rather than a seeded application account, so the demo dataset
// never depends on staff that a real installation will not have.
const DEMO_FALLBACK_AUTHOR = { name: 'Service Desk', email: 'service.desk@demo.example' };

const NAMES = [
  ['John Doe', 'john.doe'], ['Priya Nair', 'priya.nair'], ['Marcus Webb', 'marcus.webb'],
  ['Sofia Marino', 'sofia.marino'], ['Chen Wei', 'chen.wei'], ['Hannah Berg', 'hannah.berg'],
  ['Tomas Ruiz', 'tomas.ruiz'], ['Aisha Khan', 'aisha.khan'], ['Peter Novak', 'peter.novak'],
  ['Grace Odum', 'grace.odum'], ['Liam Carter', 'liam.carter'], ['Yuki Tanaka', 'yuki.tanaka'],
];

const SUBJECTS = {
  'Password Reset': [
    'Forgot my password after holiday', 'Account locked - need unlock', 'MFA reset requested',
    'Cannot log into VPN portal', 'Password expired on legacy system',
  ],
  Software: [
    'Outlook crashes when opening shared calendar', 'Excel freezes on large pivot tables',
    'Teams notifications not working', 'License error on Project install',
    'OneDrive sync stuck for hours', 'Browser keeps redirecting homepage',
  ],
  Hardware: [
    'Laptop battery drains in under an hour', 'Monitor flickering on docking station',
    'Office printer jams constantly', 'Keyboard keys sticking',
    'Webcam not detected in meetings', 'Cracked screen after drop',
  ],
  'Inquiry / Help': [
    'How to request software access?', 'New starter setup checklist',
    'Where do I find the IT knowledge base?', 'Question about guest WiFi access',
    'Advice on external monitor compatibility',
  ],
};

const NOTE_SNIPPETS = [
  'Confirmed issue reproduces on our side.',
  'Waiting on user callback for screen-share session.',
  'Escalated internally, vendor case opened.',
  'Temporary workaround provided to unblock the user.',
  'Parts ordered, ETA two business days.',
];
const PUBLIC_SNIPPETS = [
  'Thanks for your patience — we are investigating now.',
  'We applied a temporary workaround; permanent fix is scheduled.',
  'Could you confirm whether this happens on the company network as well?',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function daysAgo(days, hourOffset = 0) {
  return new Date(Date.now() - days * 86400000 - hourOffset * 3600000);
}

/* ==================================================================== */
/* Development demo accounts                                            */
/* ==================================================================== */
// Assignment groups are the four routing teams defined in src/teams.js.
// The requested group names map onto the existing ones:
//   "General IT Support"  -> service_desk (Service Desk, the default group)
//   "Password Reset Team" -> accounts     (Accounts & Access, owns Password Reset)
// skillLevel scale (assignment.config.json): 1 = junior, 2 = standard, 3 = senior.
const DEMO_ACCOUNTS = [
  {
    name: 'Demo Admin',
    email: 'admin.demo@noctincan.com',
    password: 'DemoAdmin!123',
    role: 'admin',
    teamKey: null,
    skillLevel: 3,
  },
  {
    name: 'Demo Senior Agent',
    email: 'senior.demo@noctincan.com',
    password: 'DemoSenior!123',
    role: 'agent',
    teamKey: 'service_desk',
    skillLevel: 3,
  },
  {
    name: 'Demo Junior Agent',
    email: 'junior.demo@noctincan.com',
    password: 'DemoJunior!123',
    role: 'agent',
    teamKey: 'accounts',
    skillLevel: 1,
  },
];

const DEMO_ACCOUNT_EMAILS = DEMO_ACCOUNTS.map((a) => a.email);

/**
 * Upsert the demo logins. The update branch re-applies role/team/skill and the
 * password hash so the documented credentials always work, while the unique
 * email keeps re-runs from creating duplicates.
 */
async function seedDemoAccounts() {
  const teams = await prisma.team.findMany();
  const teamByKey = Object.fromEntries(teams.map((t) => [t.key, t]));
  const results = [];

  for (const acct of DEMO_ACCOUNTS) {
    const teamId = acct.teamKey ? teamByKey[acct.teamKey].id : null;
    const passwordHash = bcrypt.hashSync(acct.password, 10);
    const before = await prisma.agent.findUnique({ where: { email: acct.email } });
    const agent = await prisma.agent.upsert({
      where: { email: acct.email },
      create: {
        name: acct.name,
        email: acct.email,
        role: acct.role,
        teamId,
        skillLevel: acct.skillLevel,
        isActive: true,
        passwordHash,
      },
      update: {
        name: acct.name,
        role: acct.role,
        teamId,
        skillLevel: acct.skillLevel,
        isActive: true,
        passwordHash,
      },
    });
    results.push({ ...acct, id: agent.id, teamId, existed: Boolean(before) });
  }
  return results;
}

/* ==================================================================== */
/* Deterministic fixture tickets                                        */
/* ==================================================================== */
// Keyed by `key` -> graphMessageId "demo-fixture-<key>", which is unique in the
// schema. Re-running the seed skips any fixture that already exists, so the
// operation is idempotent. Between them these cover every state, every
// priority, every category, and both assigned and unassigned tickets.
const DEMO_FIXTURES = [
  {
    key: 'hw-new-high',
    subject: 'Laptop will not power on after update',
    body: 'My laptop shuts down during the firmware update and now shows no lights at all. I have a client demo tomorrow morning.',
    category: 'Hardware',
    priority: 'high',
    state: 'NEW',
    requester: ['Ada Fenwick', 'ada.fenwick@demo.example'],
    assignTo: null,
    teamKey: 'hardware',
    createdDaysAgo: 0,
    comments: [],
  },
  {
    key: 'pwd-new-moderate',
    subject: 'Locked out of my account after too many attempts',
    body: 'I mistyped my password three times and the account is now locked. Please unlock it so I can submit timesheets.',
    category: 'Password Reset',
    priority: 'moderate',
    state: 'NEW',
    requester: ['Bruno Salt', 'bruno.salt@demo.example'],
    assignTo: 'junior.demo@noctincan.com',
    teamKey: 'accounts',
    createdDaysAgo: 1,
    comments: [
      { author: 'requester', body: 'Adding that I can still log into Teams on my phone, just not the laptop.' },
    ],
  },
  {
    key: 'sw-inprogress-high',
    subject: 'Outlook crashes when opening the shared mailbox',
    body: 'Outlook closes immediately whenever I open the shared finance mailbox. Restarting and repairing the profile did not help.',
    category: 'Software',
    priority: 'high',
    state: 'IN_PROGRESS',
    requester: ['Clara Nunes', 'clara.nunes@demo.example'],
    assignTo: 'senior.demo@noctincan.com',
    teamKey: 'service_desk',
    createdDaysAgo: 3,
    comments: [
      { author: 'agent', internal: true, body: 'Reproduced on the user machine. Crash dump points at a stale OST file.' },
      { author: 'agent', internal: false, body: 'Thanks for the details - we are rebuilding your mail cache now, this takes about 20 minutes.' },
      { author: 'requester', body: 'Understood, I will stay logged out until you confirm.' },
    ],
  },
  {
    key: 'inq-inprogress-low',
    subject: 'How do I request access to the design software licence?',
    body: 'I need design tool access for the new brand project. What is the approval process?',
    category: 'Inquiry / Help',
    priority: 'low',
    state: 'IN_PROGRESS',
    requester: ['Dmitri Vale', 'dmitri.vale@demo.example'],
    assignTo: 'senior.demo@noctincan.com',
    teamKey: 'service_desk',
    createdDaysAgo: 2,
    comments: [
      { author: 'agent', internal: false, body: 'Your manager needs to approve the licence request first - I have forwarded the form to them.' },
    ],
  },
  {
    key: 'pwd-resolved-moderate',
    subject: 'MFA device replaced, need re-enrolment',
    body: 'I replaced my phone and can no longer approve sign-in requests. Please reset my MFA registration.',
    category: 'Password Reset',
    priority: 'moderate',
    state: 'RESOLVED',
    requester: ['Elena Marsh', 'elena.marsh@demo.example'],
    assignTo: 'junior.demo@noctincan.com',
    teamKey: 'accounts',
    createdDaysAgo: 5,
    resolution: 'Cleared the old MFA registration and walked the user through re-enrolling the Authenticator app. Sign-in verified.',
    comments: [
      { author: 'agent', internal: true, body: 'Identity confirmed over the phone using the employee ID and manager name.' },
      { author: 'agent', internal: false, body: 'Your MFA has been reset - please re-register the Authenticator app and confirm you can sign in.' },
      { author: 'requester', body: 'Works now, thank you!' },
    ],
  },
  {
    key: 'hw-resolved-low',
    subject: 'Docking station only drives one monitor',
    body: 'The second external screen stays black when docked, though it works over HDMI directly.',
    category: 'Hardware',
    priority: 'low',
    state: 'RESOLVED',
    requester: ['Farid Osman', 'farid.osman@demo.example'],
    assignTo: null,
    teamKey: 'hardware',
    createdDaysAgo: 8,
    resolution: 'Docking station firmware updated to 1.4.2, which restored dual-monitor output. Verified with the user.',
    comments: [
      { author: 'agent', internal: false, body: 'Firmware update applied - could you confirm both screens now come up when docked?' },
    ],
  },
  {
    key: 'sw-closed-moderate',
    subject: 'OneDrive sync stuck while processing changes',
    body: 'Sync has been stuck for two days and my project folder is out of date on the laptop.',
    category: 'Software',
    priority: 'moderate',
    state: 'CLOSED',
    requester: ['Greta Lindqvist', 'greta.lindqvist@demo.example'],
    assignTo: 'senior.demo@noctincan.com',
    teamKey: 'service_desk',
    createdDaysAgo: 14,
    resolution: 'Reset the OneDrive client and re-linked the account. Sync completed and the user confirmed files are current.',
    comments: [
      { author: 'agent', internal: true, body: 'Sync database was corrupt; a full reset was the fastest route.' },
      { author: 'agent', internal: false, body: 'Sync is healthy again and your project folder is up to date. Closing this one - reply any time to reopen.' },
    ],
  },
  {
    key: 'inq-closed-low',
    subject: 'Guest WiFi details for a visiting auditor',
    body: 'We have an external auditor on site on Thursday who needs guest network access for the day.',
    category: 'Inquiry / Help',
    priority: 'low',
    state: 'CLOSED',
    requester: ['Hiroshi Tan', 'hiroshi.tan@demo.example'],
    assignTo: 'junior.demo@noctincan.com',
    teamKey: 'accounts',
    createdDaysAgo: 20,
    resolution: 'Issued a one-day guest WiFi voucher and emailed the credentials to the requester.',
    comments: [],
  },
  {
    key: 'hw-new-critical',
    subject: 'Meeting room projector dead before board meeting',
    body: 'The projector in the boardroom shows no signal from any input. The quarterly board meeting starts at 14:00.',
    category: 'Hardware',
    priority: 'critical',
    state: 'NEW',
    requester: ['Ingrid Bauer', 'ingrid.bauer@demo.example'],
    assignTo: null,
    teamKey: 'hardware',
    createdDaysAgo: 0,
    comments: [],
  },
  {
    key: 'sw-inprogress-moderate',
    subject: 'Excel freezes on the monthly forecast workbook',
    body: 'The forecast workbook hangs for minutes whenever I refresh the pivot tables. It was fine last month.',
    category: 'Software',
    priority: 'moderate',
    state: 'IN_PROGRESS',
    requester: ['Jonas Alvi', 'jonas.alvi@demo.example'],
    assignTo: 'senior.demo@noctincan.com',
    teamKey: 'service_desk',
    createdDaysAgo: 4,
    comments: [
      { author: 'requester', body: 'It seems worse when I am connected to the VPN, if that helps.' },
      { author: 'agent', internal: true, body: 'Workbook pulls from a linked source over the WAN - investigating a local cache instead.' },
    ],
  },
];

/**
 * Insert the fixture tickets that are not present yet. Existing fixtures are
 * left untouched, which is what makes re-running safe.
 */
async function seedDemoFixtures(accounts) {
  const teams = await prisma.team.findMany();
  const teamByKey = Object.fromEntries(teams.map((t) => [t.key, t]));
  const agentByEmail = Object.fromEntries(accounts.map((a) => [a.email, a]));

  let created = 0;
  let skipped = 0;

  for (const f of DEMO_FIXTURES) {
    const graphMessageId = `demo-fixture-${f.key}`;
    const existing = await prisma.ticket.findUnique({ where: { graphMessageId } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const agent = f.assignTo ? agentByEmail[f.assignTo] : null;
    const team = teamByKey[f.teamKey] || null;
    const createdAt = daysAgo(f.createdDaysAgo, 6);
    const isDone = f.state === 'RESOLVED' || f.state === 'CLOSED';
    const resolvedAt = isDone ? daysAgo(Math.max(0, f.createdDaysAgo - 1), 2) : null;
    const closedAt = f.state === 'CLOSED' ? daysAgo(Math.max(0, f.createdDaysAgo - 2), 1) : null;

    // The same state machine the workflow uses, expressed as history.
    const transitions = [];
    if (f.state !== 'NEW') transitions.push(['NEW', 'IN_PROGRESS']);
    if (isDone) transitions.push(['IN_PROGRESS', 'RESOLVED']);
    if (f.state === 'CLOSED') transitions.push(['RESOLVED', 'CLOSED']);

    const ticketNumber = await nextTicketNumber(prisma);
    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber,
        shortDescription: f.subject.slice(0, 160),
        body: f.body,
        category: f.category,
        priority: f.priority,
        state: f.state,
        source: 'email',
        requesterName: f.requester[0],
        requesterEmail: f.requester[1],
        graphMessageId,
        graphConversationId: `demo-fixture-conv-${f.key}`,
        teamId: team ? team.id : null,
        assignedAgentId: agent ? agent.id : null,
        dueAt: computeDueAt(f.priority, createdAt),
        createdAt,
        updatedAt: resolvedAt || createdAt,
        resolvedAt,
        closedAt,
        resolution: f.resolution || null,
        auditLogs: {
          create: [
            {
              fromState: null,
              toState: 'NEW',
              actor: 'system',
              note: agent
                ? `Auto-routed to ${team ? team.name : 'triage'}, assigned to ${agent.name}`
                : `Routed to ${team ? team.name : 'triage'} - awaiting assignment`,
              createdAt,
            },
            ...transitions.map(([from, to], idx) => ({
              fromState: from,
              toState: to,
              actor: agent ? agent.email : 'system',
              note:
                to === 'RESOLVED'
                  ? 'Resolution recorded'
                  : to === 'CLOSED'
                    ? 'Closed after requester confirmation'
                    : 'Work started',
              createdAt: daysAgo(Math.max(0, f.createdDaysAgo - idx - 1), 4),
            })),
          ],
        },
      },
    });

    // Ticket activity so the detail/timeline page has something to show.
    for (let i = 0; i < (f.comments || []).length; i++) {
      const c = f.comments[i];
      const fromRequester = c.author === 'requester';
      await prisma.comment.create({
        data: {
          ticketId: ticket.id,
          authorAgentId: fromRequester ? null : agent ? agent.id : null,
          authorName: fromRequester ? f.requester[0] : agent ? agent.name : DEMO_FALLBACK_AUTHOR.name,
          authorEmail: fromRequester
            ? f.requester[1]
            : agent
              ? agent.email
              : DEMO_FALLBACK_AUTHOR.email,
          isRequester: fromRequester,
          isInternal: Boolean(c.internal),
          viaEmail: fromRequester,
          // Stable id keeps the reply-idempotency guarantee true for demo rows.
          graphMessageId: fromRequester ? `demo-fixture-${f.key}-c${i}` : null,
          body: c.body,
          createdAt: daysAgo(Math.max(0, f.createdDaysAgo - 1), Math.max(1, 6 - i)),
        },
      });
    }
    created += 1;
  }

  return { created, skipped };
}

async function clear() {
  // Comments/audit rows cascade with the ticket (onDelete: Cascade).
  const res = await prisma.ticket.deleteMany({
    where: { requesterEmail: { endsWith: '@demo.example' } },
  });
  console.log(`Removed ${res.count} demo ticket(s).`);

  // Demo logins are only removed when explicitly asked for, so a --clear of the
  // ticket data does not lock you out of the app mid-session.
  if (process.argv.includes('--accounts')) {
    const del = await prisma.agent.deleteMany({
      where: { email: { in: DEMO_ACCOUNT_EMAILS } },
    });
    console.log(`Removed ${del.count} demo account(s).`);
  }
}

async function seed(count) {
  await ensureTeams(prisma);
  const categories = Object.keys(SUBJECTS);

  for (let i = 0; i < count; i++) {
    const category = pick(categories);
    const subject = pick(SUBJECTS[category]);
    const [name, handle] = pick(NAMES);
    const createdDaysAgo = randInt(0, 29);
    const createdAt = daysAgo(createdDaysAgo, randInt(0, 8));
    // Classification uses the same production keyword rules.
    const { category: classifiedCategory } = classify(`${subject} ${category}`);
    const priority = pick(['low', 'low', 'moderate', 'moderate', 'moderate', 'high', 'critical']);
    const roll = Math.random();
    const state =
      roll < 0.30 ? 'NEW' : roll < 0.55 ? 'IN_PROGRESS' : roll < 0.80 ? 'RESOLVED' : 'CLOSED';
    const wantsAssignment = !(state === 'NEW' && Math.random() < 0.45); // some unassigned NEW

    let assignment = null;
    if (wantsAssignment) {
      assignment = await assignmentEngine.assign(
        { category: classifiedCategory, priority, text: subject },
        prisma,
        { warn: () => {}, log: () => {} }
      );
    }
    const team = assignment?.groupKey
      ? await prisma.team.findUnique({ where: { key: assignment.groupKey } })
      : null;

    const seq = await nextTicketNumber(prisma);
    // Overdue: ~35% of open tickets have slipped past their SLA target.
    const open = state === 'NEW' || state === 'IN_PROGRESS';
    const overdue = open && Math.random() < 0.35;
    const dueBase = computeDueAt(priority, createdAt);
    const dueAt = overdue ? daysAgo(randInt(0, Math.max(1, createdDaysAgo - 1))) : dueBase;

    const transitions = [];
    if (state !== 'NEW') transitions.push(['NEW', 'IN_PROGRESS']);
    if (state === 'RESOLVED' || state === 'CLOSED') transitions.push(['IN_PROGRESS', 'RESOLVED']);
    if (state === 'CLOSED') transitions.push(['RESOLVED', 'CLOSED']);

    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber: seq,
        shortDescription: subject.slice(0, 160),
        body:
          `Reported by ${name}. ${subject}. ` +
          'This has been affecting day-to-day work — details shared over the phone. ' +
          `Reference case #${randInt(1000, 9999)}.`,
        category: classifiedCategory,
        priority,
        state,
        source: Math.random() < 0.75 ? 'email' : 'portal',
        requesterName: name,
        requesterEmail: `${handle}@demo.example`,
        graphMessageId: `demo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        graphConversationId: `demo-conv-${randInt(10000, 99999)}`,
        teamId: team ? team.id : null,
        assignedAgentId: assignment?.agent ? assignment.agent.id : null,
        dueAt,
        createdAt,
        updatedAt: createdAt,
        resolvedAt: ['RESOLVED', 'CLOSED'].includes(state) ? daysAgo(Math.max(0, createdDaysAgo - 1)) : null,
        closedAt: state === 'CLOSED' ? daysAgo(Math.max(0, createdDaysAgo - 1)) : null,
        resolution: ['RESOLVED', 'CLOSED'].includes(state)
          ? pick([
              'Replaced faulty hardware and verified with the user.',
              'Reinstalled the application; confirmed stable operation.',
              'Credentials reset and MFA re-enrolled successfully.',
              'Configuration corrected and user confirmed resolution.',
            ])
          : null,
        auditLogs: {
          create: [
            {
              fromState: null,
              toState: 'NEW',
              actor: 'system',
              note: assignment?.agent
                ? `Auto-routed to ${team.name}, assigned to ${assignment.agent.name}`
                : 'Routed to triage — awaiting assignment',
              createdAt,
            },
            ...transitions.map(([from, to], idx) => ({
              fromState: from,
              toState: to,
              actor: assignment?.agent ? assignment.agent.email : 'system',
              note: idx === transitions.length - 1 && to === 'RESOLVED' ? null : undefined,
              createdAt: daysAgo(Math.max(0, createdDaysAgo - idx)),
            })),
          ].flat(),
        },
      },
    });

    const commentCount = randInt(0, 2);
    for (let c = 0; c < commentCount; c++) {
      const isInternal = Math.random() < 0.5;
      await prisma.comment.create({
        data: {
          ticketId: ticket.id,
          authorAgentId: assignment?.agent ? assignment.agent.id : null,
          authorName: assignment?.agent ? assignment.agent.name : DEMO_FALLBACK_AUTHOR.name,
          authorEmail: assignment?.agent ? assignment.agent.email : DEMO_FALLBACK_AUTHOR.email,
          isRequester: false,
          isInternal,
          body: isInternal ? pick(NOTE_SNIPPETS) : pick(PUBLIC_SNIPPETS),
          createdAt: daysAgo(Math.max(0, createdDaysAgo - randInt(0, 1)), randInt(1, 6)),
        },
      });
    }

    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${count}`);
  }
}

async function main() {
  // Development-only guard: demo credentials must never be seeded into a
  // production database.
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    console.error(
      'Refusing to seed demo accounts/data with NODE_ENV=production.\n' +
        'This dataset is for local development only. Use --force to override.'
    );
    process.exitCode = 1;
    return;
  }

  // Opt-in guard: seeding fictional data into a database that is in real use
  // is destructive, so it takes a deliberate flag even in development.
  // --clear is exempt: removing demo data is always safe.
  const optedIn =
    process.argv.includes('--confirm') ||
    process.argv.includes('--force') ||
    process.env.ALLOW_DEMO_SEED === '1';
  if (!process.argv.includes('--clear') && !optedIn) {
    console.error(
      'Refusing to seed demo data without an explicit opt-in.\n' +
        '\n' +
        '  This writes fictional accounts and ~130 fake tickets. If this database\n' +
        '  is in real use, that is data you will have to clean up again.\n' +
        '\n' +
        '  To seed anyway:   npm run seed:demo -- --confirm\n' +
        '  To remove it:     npm run seed:demo -- --clear\n'
    );
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--clear')) {
    await clear();
    return;
  }

  await ensureTeams(prisma);

  // 1) Demo logins — upserted, so re-running never duplicates them.
  console.log('Seeding development demo accounts…');
  const accounts = await seedDemoAccounts();
  for (const a of accounts) {
    console.log(`  ${a.existed ? 'updated' : 'created'}  ${a.email}  (${a.role}${a.teamKey ? `, ${a.teamKey}` : ''})`);
  }

  // 2) Deterministic fixture tickets — skipped when already present.
  console.log('Seeding demo fixture tickets…');
  const fixtures = await seedDemoFixtures(accounts);
  console.log(`  created ${fixtures.created}, already present ${fixtures.skipped}`);

  // 3) Bulk volume for the dashboard — only when there is none yet.
  const bulkExisting = await prisma.ticket.count({
    where: {
      requesterEmail: { endsWith: '@demo.example' },
      graphMessageId: { startsWith: 'demo-' },
      NOT: { graphMessageId: { startsWith: 'demo-fixture-' } },
    },
  });
  if (bulkExisting > 0) {
    console.log(`Bulk demo tickets already present (${bulkExisting}) — skipping.`);
  } else {
    console.log('Seeding bulk demo tickets…');
    await seed(120);
  }

  const total = await prisma.ticket.count();
  console.log(`\nDone — ${total} tickets in database.`);
  console.log('\nDevelopment demo logins:');
  for (const a of DEMO_ACCOUNTS) {
    console.log(`  ${a.role.padEnd(5)}  ${a.email.padEnd(28)}  ${a.password}`);
  }
  console.log('\nLocal/development use only — do not seed this into production.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
