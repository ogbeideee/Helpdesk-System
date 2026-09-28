/* Outbound SMTP transport (src/smtp/config.js) and its place in the mailer.

   No database and no network: the transport is exercised through the injected
   `createTransport` seam, so the suite proves the configuration model, the
   addressing, the message composition and the mailer contract — never a real
   send, and never with a real credential.

     A. configuration — opt-in gating, defaults, and that a password is never
        echoed back or logged
     B. addressing — Graph recipient shape -> nodemailer shape
     C. composition — from/subject/text, cc, refusals, broadcast target
     D. mailer contract — the same interface, and a link-free requester mail */

const SMTP_ENV_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'SMTP_FROM_NAME', 'SMTP_BROADCAST_DL', 'SMTP_TLS_REJECT_UNAUTHORIZED',
];

// A developer's server/.env holds a real mailbox and, once SMTP is set up, a real
// App Password. Every SMTP_* variable is cleared after .env is loaded and before
// the module takes its snapshot, so these checks see only what the test sets.
const savedEnv = {};
for (const key of [...SMTP_ENV_KEYS, 'GRAPH_BROADCAST_DL']) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}

const smtp = require('../src/smtp/config');
const { createMailer } = require('../src/mailer');

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

/** Run fn() with a temporary environment; restores every key afterwards. */
function withEnv(env, fn) {
  const stash = {};
  for (const [k, v] of Object.entries(env)) {
    stash[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(stash)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const COMPLETE = {
  SMTP_HOST: 'smtp.mail.test',
  SMTP_PORT: '465',
  SMTP_USER: 'desk@mail.test',
  SMTP_PASS: 'fixture-app-password',
};


/* ====================================================================== */
console.log('--- A. configuration model ---');

eq('A1 disabled with no environment', smtp.readSmtpEnv().enabled, false);
withEnv({ ...COMPLETE, SMTP_PASS: undefined }, () =>
  eq('A2 a missing password does not enable it', smtp.readSmtpEnv().enabled, false));
withEnv({ ...COMPLETE, SMTP_HOST: undefined }, () =>
  eq('A3 a missing host does not enable it', smtp.readSmtpEnv().enabled, false));
withEnv({ ...COMPLETE, SMTP_USER: undefined }, () =>
  eq('A4 a missing user does not enable it', smtp.readSmtpEnv().enabled, false));
withEnv(COMPLETE, () => eq('A5 a complete set enables it', smtp.readSmtpEnv().enabled, true));

withEnv(COMPLETE, () => {
  const cfg = smtp.readSmtpEnv();
  eq('A6 SMTP_FROM defaults to the authenticated user', cfg.from, 'desk@mail.test');
  eq('A7 the secure default is implicit TLS on 465', `${cfg.secure}/${cfg.port}`, 'true/465');
  eq('A8 a default sender name is supplied', cfg.fromName, 'IT Helpdesk');
  eq('A9 TLS validation is on unless disabled', cfg.tlsRejectUnauthorized, true);
});
withEnv({ ...COMPLETE, SMTP_FROM: 'helpdesk@mail.test' }, () =>
  eq('A10 an explicit SMTP_FROM wins', smtp.readSmtpEnv().from, 'helpdesk@mail.test'));
withEnv({ ...COMPLETE, SMTP_SECURE: 'false', SMTP_PORT: '' }, () => {
  const cfg = smtp.readSmtpEnv();
  eq('A11 SMTP_SECURE=false selects STARTTLS on 587', `${cfg.secure}/${cfg.port}`, 'false/587');
});
withEnv({ ...COMPLETE, SMTP_BROADCAST_DL: 'team@mail.test' }, () =>
  eq('A12 the broadcast target is read', smtp.readSmtpEnv().broadcastDl, 'team@mail.test'));
withEnv({ ...COMPLETE, GRAPH_BROADCAST_DL: 'graph-dl@mail.test' }, () =>
  eq('A13 it falls back to the Graph DL name', smtp.readSmtpEnv().broadcastDl, 'graph-dl@mail.test'));
withEnv({ ...COMPLETE, SMTP_BROADCAST_DL: 'team@mail.test', GRAPH_BROADCAST_DL: 'graph-dl@mail.test' }, () =>
  eq('A14 SMTP_BROADCAST_DL wins over the Graph name',
    smtp.readSmtpEnv().broadcastDl, 'team@mail.test'));
withEnv({ ...COMPLETE, SMTP_TLS_REJECT_UNAUTHORIZED: 'false' }, () =>
  eq('A15 certificate validation can be turned off', smtp.readSmtpEnv().tlsRejectUnauthorized, false));

// The password is a secret: it must not be printable through the config object
// an admin route or the status log would ever hand out.
const secretCfg = withEnv(COMPLETE, () => smtp.readSmtpEnv());
const publicJson = JSON.stringify(withEnv(COMPLETE, () => smtp.publicSmtpConfig(secretCfg)));
check('A16 the printable config never carries the password',
  !publicJson.includes('fixture-app-password') && !('pass' in smtp.publicSmtpConfig(secretCfg)),
  publicJson);
check('A16b the printable config still reports the useful fields',
  publicJson.includes('smtp.mail.test') && publicJson.includes('"enabled":true'), publicJson);
const logLines = [];
withEnv(COMPLETE, () => smtp.logSmtpStatus((l) => logLines.push(l), smtp.readSmtpEnv()));
const logText = logLines.join('\n');
check('A17 the enabled log line never prints the password',
  logText.includes('smtp.mail.test:465') && !logText.includes('fixture-app-password'), logText);
const offLines = [];
smtp.logSmtpStatus((l) => offLines.push(l), smtp.readSmtpEnv());

/* ====================================================================== */
console.log('\n--- B. addressing ---');

eq('B1 a Graph recipient becomes an address',
  JSON.stringify(smtp.toAddress({ emailAddress: { address: 'a@b.test' } })),
  JSON.stringify({ address: 'a@b.test' }));
eq('B2 a display name is carried across',
  JSON.stringify(smtp.toAddress({ emailAddress: { address: 'a@b.test', name: 'Rita' } })),
  JSON.stringify({ address: 'a@b.test', name: 'Rita' }));
eq('B3 a plain string is accepted',
  JSON.stringify(smtp.toAddress('a@b.test')), JSON.stringify({ address: 'a@b.test' }));
eq('B4 an addressless recipient is dropped', smtp.toAddress({ emailAddress: {} }), null);
eq('B5 null is dropped', smtp.toAddress(null), null);
eq('B6 a list filters the unusable entries',
  JSON.stringify(smtp.addressList([{ emailAddress: { address: 'a@b.test' } }, null, { emailAddress: {} }])),
  JSON.stringify([{ address: 'a@b.test' }]));

/* ====================================================================== */
console.log('\n--- C. composition and sending ---');

/** A nodemailer stand-in that records what it was asked to send. */
function fakeClient() {
  const sent = [];
  const options = [];
  return {
    sent,
    options,
    createTransport(opts) {
      options.push(opts);
      return {
        async sendMail(message) {
          sent.push(message);
          return { messageId: 'fixture' };
        },
      };
    },
  };
}

/** Build a transport over `client` from a temporary environment. */
function transportFor(env, client) {
  return withEnv(env, () =>
    smtp.createSmtpTransport(smtp.readSmtpEnv(), { createTransport: client.createTransport }));
}

(async () => {
  {
    const client = fakeClient();
    const transport = transportFor(COMPLETE, client);
    await transport.sendMail({
      subject: '[TK-1] Hi',
      body: 'Body line',
      toRecipients: [{ emailAddress: { address: 'rita@requester.test' } }],
    });
    eq('C1 one call reaches the client', client.sent.length, 1);
    eq('C2 the subject is passed through', client.sent[0].subject, '[TK-1] Hi');
    eq('C3 the body is sent as plain text', client.sent[0].text, 'Body line');
    eq('C4 the recipient is addressed', JSON.stringify(client.sent[0].to),
      JSON.stringify([{ address: 'rita@requester.test' }]));
    check('C5 the sender is the configured identity',
      client.sent[0].from.address === 'desk@mail.test' && client.sent[0].from.name === 'IT Helpdesk');
    check('C6 cc is omitted when there is none', !('cc' in client.sent[0]));
    check('C7 the connection is opened with the resolved host and TLS',
      client.options[0].host === 'smtp.mail.test' && client.options[0].port === 465
      && client.options[0].secure === true);
    eq('C8 the transporter is created once and reused', client.options.length, 1);
    await transport.sendMail({
      subject: 'second', body: 'b',
      toRecipients: [{ emailAddress: { address: 'r@requester.test' } }],
    });
    eq('C9 a second mail reuses the same transporter', client.options.length, 1);
  }

  {
    const client = fakeClient();
    const transport = transportFor(
      { ...COMPLETE, SMTP_FROM: 'helpdesk@mail.test', SMTP_FROM_NAME: 'Helpdesk' }, client);
    await transport.sendMail({
      subject: 's', body: 'b',
      toRecipients: [{ emailAddress: { address: 'a@b.test' } }],
      ccRecipients: [{ emailAddress: { address: 'c@d.test' } }],
    });
    eq('C10 cc is carried when present', client.sent[0].cc.length, 1);
    eq('C11 the configured sender name is used', client.sent[0].from.name, 'Helpdesk');
  }

  {
    const client = fakeClient();
    const transport = transportFor(COMPLETE, client);
    let threw = null;
    await transport.sendMail({ subject: 's', body: 'b', toRecipients: [] }).catch((e) => { threw = e; });
    check('C12 a message with no recipient is refused', Boolean(threw));
    eq('C13 nothing reached the client', client.sent.length, 0);
  }

  {
    let threw = null;
    try {
      smtp.createSmtpTransport({ enabled: false });
    } catch (e) {
      threw = e;
    }
    check('C14 building a transport while disabled throws', Boolean(threw));
  }

  {
    const client = fakeClient();
    const transport = transportFor({ ...COMPLETE, SMTP_BROADCAST_DL: 'team@mail.test' }, client);
    eq('C15 hasBroadcastTarget follows the DL', transport.hasBroadcastTarget(), true);
    eq('C16 the DL is offered to the mailer fallback', transport.broadcastTarget(), 'team@mail.test');
    await transport.sendBroadcastMail({ subject: 's', body: 'b' });
    eq('C17 the broadcast goes to the configured DL', client.sent[0].to[0].address, 'team@mail.test');
  }

  {
    const client = fakeClient();
    const transport = transportFor(COMPLETE, client);
    eq('C18 with no DL there is no broadcast target', transport.hasBroadcastTarget(), false);
    let threw = null;
    await transport.sendBroadcastMail({ subject: 's', body: 'b' }).catch((e) => { threw = e; });
    check('C19 a broadcast with no DL is refused, not silently dropped', Boolean(threw));
  }

  /* ====================================================================== */
  console.log('\n--- D. the mailer contract under SMTP ---');

  // The mailer must not know which transport is live: it still sends the
  // builder's output verbatim, and the requester mail is still link-free.
  const sent = [];
  const capturing = {
    hasBroadcastTarget: () => true,
    async sendMail(mail) { sent.push(mail); },
    async sendBroadcastMail(mail) { sent.push(mail); },
  };
  const QUIET = { log() {}, warn() {}, error() {} };
  const mailer = createMailer({ transport: capturing, logger: QUIET });

  await mailer.notifyRequesterAck({
    id: 1, ticketNumber: 'TK-9', shortDescription: 'Laptop will not start',
    body: 'y', requesterEmail: 'r@requester.test', state: 'NEW', priority: 'high',
  });
  eq('D1 the requester ack is one mail', sent.length, 1);
  eq('D2 it addresses the requester', sent[0].toRecipients[0].emailAddress.address, 'r@requester.test');
  check('D3 the requester mail carries no link',
    !/https?:\/\/|#\/status\//.test(sent[0].body), sent[0].body);
  check('D4 it still invites the reply-by-email flow',
    sent[0].body.includes('Reply directly to this email'));
  check('D5 it names the ticket', sent[0].body.includes('TK-9'));

  // The reply alert falls back to whatever address the live transport owns.
  const fallback = [];
  const dlTransport = {
    hasBroadcastTarget: () => true,
    broadcastTarget: () => 'team@mail.test',
    async sendMail(mail) { fallback.push(mail); },
    async sendBroadcastMail(mail) { fallback.push(mail); },
  };
  await createMailer({ transport: dlTransport, logger: QUIET })
    .notifyReplyReceived({ id: 1, ticketNumber: 'TK-9', shortDescription: 'x', requesterEmail: 'r@requester.test' }, {});
  eq('D6 an unassigned reply alert falls back to the transport DL', fallback.length, 1);
  eq('D7 and it is the transport address, not a Graph one',
    fallback[0].toRecipients[0].emailAddress.address, 'team@mail.test');
  check('D8 the fallback alert is internal-only and link-free',
    !fallback[0].toRecipients.some((r) => r.emailAddress.address === 'r@requester.test')
    && !/https?:\/\//.test(fallback[0].body));

  // A broken provider must never fail a request: the mailer reports false.
  const dead = {
    hasBroadcastTarget: () => true,
    async sendMail() { throw new Error('smtp down'); },
    async sendBroadcastMail() { throw new Error('smtp down'); },
  };
  const errors = [];
  const deadMailer = createMailer({ transport: dead, logger: { ...QUIET, error: (m) => errors.push(m) } });
  eq('D9 a dead transport reports failure rather than throwing',
    await deadMailer.notifyRequesterAck({
      id: 1, ticketNumber: 'TK-9', shortDescription: 'x', body: 'y',
      requesterEmail: 'r@requester.test', state: 'NEW',
    }), false);
  check('D10 and the operator is told why', errors.some((m) => m.includes('smtp down')), errors.join(' | '));

  eq('D11 the module exports what the mailer needs',
    ['readSmtpEnv', 'logSmtpStatus', 'createSmtpTransport'].every((k) => typeof smtp[k] === 'function'), true);

  restoreEnv();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('SUITE ERROR:', err.stack || err);
  restoreEnv();
  process.exit(1);
});
