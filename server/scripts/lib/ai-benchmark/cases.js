/* Shared benchmark cases for AI-assisted ticket classification.
 *
 * Provider selection only (pre-Phase-2): the same frozen set of 20 cases runs
 * against every provider, so scores are comparable. Nothing here touches the
 * production pipeline — the runner is the only consumer.
 *
 * Case shape:
 *   id              'A'..'T' — matches the requested scenario list
 *   name            short scenario title (shown in the report)
 *   subject         the email subject the classifier receives
 *   cleanBody       the sender's own words, as emailIngestion would hand them
 *                   to the classifier (quoted history/signature already
 *                   stripped — except in the cases that deliberately keep
 *                   them, because real-world stripping is imperfect)
 *   expected        { category, priority } — category is always one of
 *                   src/states.js CATEGORIES; priority is null when not
 *                   reasonably determinable (the case is then excluded from
 *                   the priority score instead of guessing)
 *   why             one sentence justifying the expectation
 *   adversarial     true when a simple keyword classifier is likely to fail
 *   trap            for adversarial cases: { category, detail } — the wrong
 *                   category incidental keywords would push towards
 *
 * The category expectations follow the application's own taxonomy: there is
 * no separate "Network" category, so connectivity/VPN/Wi-Fi problems belong
 * to Software (vpn is a Software keyword in graph/categoryRules.js) and only
 * physical-equipment issues are Hardware.
 */
const { CATEGORIES, PRIORITIES } = require('../../../src/states');

const CASES = [
  {
    id: 'A',
    name: 'Direct Wi-Fi/network failure',
    subject: 'No Wi-Fi connection on my work laptop',
    cleanBody:
      'Hi,\n\n' +
      'My laptop will not connect to the office Wi-Fi at all today — it sees the network but the connection fails with "can\'t connect to this network". I have rebooted twice and forgotten/re-added the network. I am currently on a hotspot to send this, but that eats my data plan and internal systems are unreachable over it.\n\n' +
      'Regards,\nSofia',
    expected: { category: 'Software', priority: 'high' },
    why: 'A connectivity failure with the machine effectively offline is a Software (connectivity) issue; the sender is fully blocked, so high.',
  },
  {
    id: 'B',
    name: 'VPN connection failure',
    subject: 'VPN drops every few minutes',
    cleanBody:
      'Hi,\n\n' +
      'Since this morning my VPN connection drops every few minutes. I get kicked out of my remote desktop session each time and have to reconnect. Rebooting did not help. I am fully remote today and cannot reach any internal system while it is down.\n\n' +
      'Thanks,\nRita',
    expected: { category: 'Software', priority: 'high' },
    why: 'Connectivity clients sit in Software in this app\'s taxonomy (vpn is a Software keyword); a fully-blocked remote worker is high.',
  },
  {
    id: 'C',
    name: 'Printer not printing',
    subject: 'Printer in bay 3 refuses to print',
    cleanBody:
      'The printer next to bay 3 takes the job, shows "processing" on its display, then nothing comes out. The queue on my machine just piles up with stuck jobs. Other people in the bay say the same thing is happening to them. Toner was replaced last week so it should not be that.',
    expected: { category: 'Hardware', priority: 'moderate' },
    why: 'A physical printer failing for several people — Hardware; work is impaired but people can print elsewhere, so moderate.',
  },
  {
    id: 'D',
    name: 'Monitor/display hardware failure',
    subject: 'External monitor flickers then goes black',
    cleanBody:
      'Hello, my external monitor started flickering yesterday and now it goes black after a few minutes, though the power LED stays on. Plugging the cable into my colleague\'s dock shows the same behaviour, and my laptop screen itself is fine. I can work off the laptop screen but it is cramped.',
    expected: { category: 'Hardware', priority: 'moderate' },
    why: 'A physically failing display (fault follows the monitor, laptop screen fine) — Hardware, impaired but working, so moderate.',
  },
  {
    id: 'E',
    name: 'Laptop will not power on',
    subject: 'Laptop completely dead since last night',
    cleanBody:
      'My work laptop will not turn on at all since last night. No lights, no fan, nothing, even on the original charger and a different wall socket. I have a client presentation at 2pm today that is on that machine and I have no spare device.',
    expected: { category: 'Hardware', priority: 'high' },
    why: 'A dead machine is Hardware; the person is fully blocked with a deadline and no spare, so high.',
  },
  {
    id: 'F',
    name: 'Password/account access problem',
    subject: 'Locked out of my account',
    cleanBody:
      'I entered the wrong password too many times this morning and now the portal says my account is locked. The OTP code also never arrives on my phone. Please reset my access so I can log in again.',
    expected: { category: 'Password Reset', priority: 'high' },
    why: 'Locked-out account with failed OTP — Password Reset; the app\'s own rules rate password resets high.',
  },
  {
    id: 'G',
    name: 'Request for access to a company folder/application',
    subject: 'Access to the marketing shared drive',
    cleanBody:
      'Hello, I have moved to the campaigns team and I can see the marketing shared drive in my file explorer but every folder inside says "access denied". Could someone grant me the same access my new teammates have? Nothing is broken as far as I know, I just do not have the rights yet.',
    expected: { category: 'Inquiry / Help', priority: 'low' },
    why: 'A request to be granted new permissions — not a lockout or a broken system — so the Inquiry / Help fallback at low urgency.',
  },
  {
    id: 'H',
    name: 'Outlook/email application problem',
    subject: 'Outlook stuck on "trying to connect"',
    cleanBody:
      'Since yesterday afternoon Outlook sits at "Trying to connect" in the bottom bar and my inbox has not synced new mail on the desktop app. Webmail in the browser works normally with the same account, so the mailbox itself is fine. I already restarted Outlook and repaired the profile once.',
    expected: { category: 'Software', priority: 'moderate' },
    why: 'The desktop email client misbehaving while webmail works is a Software problem; mail is still reachable, so moderate.',
  },
  {
    id: 'I',
    name: 'Excel/application crash',
    subject: 'Excel crashes when I open the quarterly workbook',
    cleanBody:
      'Every time I open the Q3 consolidation workbook Excel crashes after a few seconds. Other files open fine. I tried repairing Office and rebooting, no change. I can keep working on other documents, but that one file is needed for Friday\'s report.',
    expected: { category: 'Software', priority: 'moderate' },
    why: 'Application crash, single file, workaround exists — Software at moderate.',
  },
  {
    id: 'J',
    name: 'Software installation request',
    subject: 'Please install Project Plan 365 on my machine',
    cleanBody:
      'Hi team, I have been approved for a Project Plan 365 licence (approval ref APP-2231 attached). Could you install it on my desktop before Monday? I have never had it on this machine, so it needs a fresh installation, and I am not a local admin so I cannot do it myself.',
    expected: { category: 'Software', priority: 'moderate' },
    why: 'A software installation request concerns an application rather than equipment or access — Software; it has a soft deadline (Monday), so moderate.',
  },
  {
    id: 'K',
    name: 'Network keyword mentioned incidentally, real issue is software',
    subject: 'Excel keeps crashing since this morning',
    cleanBody:
      'Excel crashes whenever I open any spreadsheet since about 10am. At first I assumed it was the network switch outside our bay playing up again, but the network is fine — web pages load instantly and shared drives open — and it is only Excel that dies. I already repaired Office and rebooted, no change.',
    expected: { category: 'Software', priority: 'moderate' },
    why: 'The sender tested and dismissed the network theory; the actual failing thing is the Excel application — Software at moderate.',
    adversarial: true,
    trap: {
      category: 'Hardware',
      detail: '"network switch" is an incidental Hardware-flavoured mention that the sender explicitly ruled out; the failure is the application.',
    },
  },
  {
    id: 'L',
    name: 'Password keyword mentioned incidentally, real issue is networking',
    subject: 'Cannot get onto the VPN from home',
    cleanBody:
      'The VPN client fails at the authentication step every time this morning with error 809, while our apartment internet is working normally. I did reset my password last week, but that was days ago and everything else with the new password works fine — webmail, intranet, all of it. It is only the VPN tunnel that will not come up. I am supposed to join the 11am client call from home.',
    expected: { category: 'Software', priority: 'high' },
    why: 'The password change is old, working everywhere and explicitly dismissed; the failing thing is the VPN connectivity client — Software, and a blocked remote worker is high.',
    adversarial: true,
    trap: {
      category: 'Password Reset',
      detail: '"reset my password" is incidental history (password is a first-match Password Reset keyword); the sender confirms the new password works everywhere else.',
    },
  },
  {
    id: 'M',
    name: 'Printer mentioned incidentally, real issue is account access',
    subject: 'Signed in this morning and now locked',
    cleanBody:
      'I logged a print job on the third-floor printer on my way in, but the actual problem is my account: after lunch the portal started saying "account locked" and no password attempt or OTP code works. I am the only one on my team affected. The printer itself printed my job fine, that was unrelated.',
    expected: { category: 'Password Reset', priority: 'high' },
    why: 'The printer mention is a working, unrelated aside; the current problem is a locked account with failed OTP — Password Reset at high.',
    adversarial: true,
    trap: {
      category: 'Hardware',
      detail: '"third-floor printer" and "print job" are incidental Hardware keywords for a device the sender says worked fine.',
    },
  },
  {
    id: 'N',
    name: 'Multiple IT keywords, one clear primary problem',
    subject: 'Battery barely lasts since last week',
    cleanBody:
      'Quick sanity check before I raise this: Teams calls work, Outlook is fine, the VPN connects, the internet is fine. The only problem is my laptop battery — it dies after ten minutes even when fully charged, so I have to stay plugged in everywhere.',
    expected: { category: 'Hardware', priority: 'moderate' },
    why: 'Every software-named system is explicitly working; the single broken thing is the battery (Hardware).',
    adversarial: true,
    trap: {
      category: 'Software',
      detail: 'Teams/Outlook/VPN keywords all appear, but only as systems confirmed to be working.',
    },
  },
  {
    id: 'O',
    name: 'Ambiguous request that should become General IT Support',
    subject: 'Something is off',
    cleanBody:
      'Hi, something is off with my computer since the weekend. It just feels slow and weird sometimes. Not sure what is wrong exactly — maybe you can take a look?',
    expected: { category: 'Inquiry / Help', priority: null },
    why: 'No identifiable broken system, application or access problem — the triage fallback; priority is not reasonably determinable.',
  },
  {
    id: 'P',
    name: 'Very short request',
    subject: 'VPN isn\'t working',
    cleanBody: 'VPN isn\'t working',
    expected: { category: 'Software', priority: null },
    why: 'Minimal signal, but the failing thing is identifiable — the VPN connectivity client (Software); with no impact information the priority is not determinable.',
  },
  {
    id: 'Q',
    name: 'Poor spelling and grammar',
    subject: 'labtop keybord mest up',
    cleanBody:
      'helo, my labtop keybord is mest up, sum keys dont work at al and othrs type twise when i press them. plz fix asap i can hardly type anythin. regrds, ada',
    expected: { category: 'Hardware', priority: 'moderate' },
    why: 'Misspelled ("labtop", "keybord") broken keyboard — Hardware at moderate; substring keyword matching cannot see the misspellings.',
    adversarial: true,
    trap: {
      category: 'Inquiry / Help',
      detail: 'The keyword classifier misses every misspelled keyword and falls through to the default Inquiry / Help instead of Hardware.',
    },
  },
  {
    id: 'R',
    name: 'Long email with quoted previous correspondence',
    subject: 'RE: Ticket follow-up — VPN still not working',
    cleanBody:
      'The VPN is STILL not connecting this morning — the same "tunnel timeout" error as last week, now every single time. This is the actual blocker for me today; everything below is just history.\n\n' +
      '---- history, copied from the earlier thread ----\n\n' +
      'Hi, quick summary of the earlier ticket so the new agent has context: two weeks ago the desk printer at my bay was jamming every day. An engineer came, replaced the rollers, and it has printed fine since.\n\n' +
      'A month before that I got locked out after a password expiry and the service desk reset my password over the phone in ten minutes — that was handled well.\n\n' +
      'Around the same time my old docking station was replaced because the external monitors flickered, and the loaner keyboard I used for a day had a sticky space bar.\n\n' +
      'None of that is the problem now. Today it is only the VPN: it says "tunnel timeout", my colleague on the same floor connects fine, and rebooting changed nothing.\n\n' +
      'Thanks for picking this up,\nRita Adewale\nFinance Operations, 3rd floor',
    expected: { category: 'Software', priority: 'moderate' },
    why: 'The current problem (VPN tunnel timeout) is stated first and restated last; everything in between is closed history.',
    adversarial: true,
    trap: {
      category: 'Password Reset',
      detail: 'Printer, docking station and keyboard history are resolved items, and the resolved password-reset history is a first-match Password Reset keyword.',
    },
  },
  {
    id: 'S',
    name: 'Signature containing unrelated IT keywords',
    subject: 'Meeting room 4 air conditioning',
    cleanBody:
      'The air conditioning in meeting room 4 is blowing warm air and the room is unusable all afternoon. Could you log this with facilities or tell me who to contact? Nothing IT-related is needed from me.\n\n' +
      'Tunde Bakare | Workplace Services | ext. 4123\n' +
      'For IT matters (Windows updates, Office 365, VPN access, printer drivers) please use the IT service desk portal.',
    expected: { category: 'Inquiry / Help', priority: 'low' },
    why: 'The request is facilities-related routed via the helpdesk — the Inquiry / Help fallback; the signature\'s IT words are noise.',
    adversarial: true,
    trap: {
      category: 'Software',
      detail: 'The signature tagline lists Windows, Office 365 and VPN (Software keywords) and printer drivers (Hardware) — none are the request.',
    },
  },
  {
    id: 'T',
    name: 'Urgent, high-impact issue (priority above normal)',
    subject: 'URGENT: payroll application down for all of finance',
    cleanBody:
      'The payroll application will not load for anyone in the finance department since 9am. Month-end close is due today and we cannot process salaries. The whole team is blocked. Please treat this with the highest urgency.',
    expected: { category: 'Software', priority: 'critical' },
    why: 'A business application outage blocking an entire department on a deadline — Software at critical.',
  },
];

/* Guard: expectations must live in the application's real value space, so a
 * future category/priority rename breaks this loudly instead of silently
 * benchmarking against invented values. */
for (const c of CASES) {
  if (!CATEGORIES.includes(c.expected.category)) {
    throw new Error(`benchmark case ${c.id}: unknown category ${JSON.stringify(c.expected.category)}`);
  }
  if (c.expected.priority !== null && !PRIORITIES.includes(c.expected.priority)) {
    throw new Error(`benchmark case ${c.id}: unknown priority ${JSON.stringify(c.expected.priority)}`);
  }
  if (c.adversarial && (!c.trap || !CATEGORIES.includes(c.trap.category))) {
    throw new Error(`benchmark case ${c.id}: adversarial case needs a trap with a valid category`);
  }
}

module.exports = { CASES };
