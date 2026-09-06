/* Email parser tests.

   Pure unit tests: no database, no network, no Microsoft Graph, no
   credentials of any kind. The parsing layer is deliberately independent of
   any email provider, and these tests prove it.

   Usage: npm run test:parser  (from server/) */

const {
  parseEmail,
  tryParseEmail,
  EmailParseError,
  htmlToPlainText,
  extractTicketNumberFromSubject,
  stripReplyPrefixes,
  hasReplyPrefix,
} = require('../src/email/emailParser');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(
    name,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

/* ================================================================== */
/* 1. Plain-text email                                                */
/* ================================================================== */
{
  const parsed = parseEmail({
    messageId: 'msg-plain-1',
    conversationId: 'conv-plain-1',
    from: { name: 'John Doe', email: 'john.doe@company.com' },
    subject: 'Cannot connect to WiFi',
    body: 'Hello IT,\n\nMy laptop cannot connect to WiFi.',
    bodyType: 'text',
    receivedAt: '2026-08-26T12:00:00Z',
    attachments: [],
  });

  eq('plain: messageId', parsed.messageId, 'msg-plain-1');
  eq('plain: body preserved verbatim', parsed.body, 'Hello IT,\n\nMy laptop cannot connect to WiFi.');
  eq('plain: isHtml is false', parsed.isHtml, false);
  eq('plain: no attachments', parsed.attachments.length, 0);
  check('plain: receivedAt is ISO-8601', parsed.receivedAt === '2026-08-26T12:00:00.000Z', parsed.receivedAt);
  check('plain: body contains no markup', !/<[a-z/][^>]*>/i.test(parsed.body));
}

/* ================================================================== */
/* 2. HTML email                                                      */
/* ================================================================== */
{
  const parsed = parseEmail({
    messageId: 'msg-html-1',
    conversationId: 'conv-html-1',
    from: { name: 'John Doe', email: 'john.doe@company.com' },
    subject: 'Cannot access Outlook',
    body: '<p>Hello IT,</p><p>I cannot access Outlook.</p>',
    bodyType: 'html',
    receivedAt: '2026-08-26T12:00:00Z',
  });

  eq('html: converted to readable plain text', parsed.body, 'Hello IT,\n\nI cannot access Outlook.');
  eq('html: isHtml is true', parsed.isHtml, true);
  check('html: no tags remain', !/<[^>]+>/.test(parsed.body));
  check('html: paragraph break preserved', parsed.body.includes('\n\n'));
}

/* ================================================================== */
/* 3. Sender extraction                                               */
/* ================================================================== */
{
  const shapes = [
    ['{name,email}', { from: { name: 'Jane Roe', email: 'Jane.Roe@Company.com' } }],
    ['{name,address}', { from: { name: 'Jane Roe', address: 'Jane.Roe@Company.com' } }],
    ['Graph {emailAddress}', { from: { emailAddress: { name: 'Jane Roe', address: 'Jane.Roe@Company.com' } } }],
    ['"Name <addr>" string', { from: '"Jane Roe" <Jane.Roe@Company.com>' }],
    ['Name <addr> string', { from: 'Jane Roe <Jane.Roe@Company.com>' }],
    ['sender fallback field', { sender: { name: 'Jane Roe', email: 'Jane.Roe@Company.com' } }],
  ];

  for (const [label, extra] of shapes) {
    const p = parseEmail({ messageId: 'm', subject: 's', body: 'b', ...extra });
    check(
      `sender: ${label}`,
      p.senderEmail === 'jane.roe@company.com' && p.senderName === 'Jane Roe',
      JSON.stringify({ email: p.senderEmail, name: p.senderName })
    );
  }

  const lowered = parseEmail({ messageId: 'm', from: 'MIXED.Case@Example.COM', subject: 's', body: 'b' });
  eq('sender: address lower-cased', lowered.senderEmail, 'mixed.case@example.com');

  const bare = parseEmail({ messageId: 'm', from: '<solo@example.com>', subject: 's', body: 'b' });
  check('sender: angle-bracket-only address', bare.senderEmail === 'solo@example.com' && bare.senderName === null);
}

/* ================================================================== */
/* 4. Subject extraction (preserved verbatim)                         */
/* ================================================================== */
{
  const p = parseEmail({
    messageId: 'm',
    from: 'a@b.com',
    subject: '  Re: [INC-000123] Cannot connect to WiFi  ',
    body: 'x',
  });
  eq('subject: preserved including Re: prefix', p.subject, 'Re: [INC-000123] Cannot connect to WiFi');
  check('subject: parser did not strip the prefix', p.subject.startsWith('Re:'));

  const empty = parseEmail({ messageId: 'm', from: 'a@b.com', body: 'x' });
  eq('subject: missing subject becomes empty string', empty.subject, '');
}

/* ================================================================== */
/* 5 + 6. Ticket number extraction, including Re:/RE: replies         */
/* ================================================================== */
{
  const cases = [
    ['[INC-000123] Cannot connect to WiFi', 'INC-000123'],
    ['Re: [INC-000123] Cannot connect to WiFi', 'INC-000123'],
    ['RE: [INC-000123] Cannot connect to WiFi', 'INC-000123'],
    ['re: [INC-000123] Cannot connect to WiFi', 'INC-000123'],
    ['Fwd: [INC-000123] Cannot connect to WiFi', 'INC-000123'],
    ['RE: RE: FW: [INC-000123] still broken', 'INC-000123'],
    ['AW: [INC-000123] noch kaputt', 'INC-000123'],
    ['INC-000123 without brackets', 'INC-000123'],
    ['Ticket INC-000123 follow-up', 'INC-000123'],
    ['legacy HD-2026-000042 reference', 'HD-2026-000042'],
    ['Cannot connect to WiFi', null],
    ['', null],
    ['INC-123', null], // wrong width - not a ticket number
  ];

  for (const [subject, expected] of cases) {
    eq(`ticket#: ${JSON.stringify(subject).slice(0, 46)}`, extractTicketNumberFromSubject(subject), expected);
  }

  eq('reply prefix: stripped', stripReplyPrefixes('Re: [INC-000123] WiFi'), '[INC-000123] WiFi');
  eq('reply prefix: stacked prefixes stripped', stripReplyPrefixes('RE: FW: Re: Printer down'), 'Printer down');
  eq('reply prefix: none to strip', stripReplyPrefixes('Printer down'), 'Printer down');
  check('reply prefix: detected', hasReplyPrefix('Re: hello') === true && hasReplyPrefix('hello') === false);
}

/* ================================================================== */
/* 7. Empty / missing body                                            */
/* ================================================================== */
{
  const missing = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's' });
  check('body: missing body -> empty string, no throw', missing.body === '' && missing.isHtml === false);

  const empty = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: '' });
  eq('body: empty string body', empty.body, '');

  const whitespace = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: '   \n\n  \t ' });
  eq('body: whitespace-only body collapses to empty', whitespace.body, '');

  const nullBody = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: null });
  eq('body: null body', nullBody.body, '');

  const emptyHtml = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: '<p></p>', bodyType: 'html' });
  eq('body: empty HTML collapses to empty', emptyHtml.body, '');

  const preview = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', bodyPreview: 'Preview only' });
  eq('body: falls back to bodyPreview', preview.body, 'Preview only');
}

/* ================================================================== */
/* 8. Missing sender name                                             */
/* ================================================================== */
{
  const noName = parseEmail({ messageId: 'm', from: { email: 'noname@company.com' }, subject: 's', body: 'b' });
  check('sender: missing name -> null (address still parsed)', noName.senderName === null && noName.senderEmail === 'noname@company.com');

  const emptyName = parseEmail({ messageId: 'm', from: { name: '   ', email: 'blank@company.com' }, subject: 's', body: 'b' });
  eq('sender: blank name -> null', emptyName.senderName, null);

  const nameIsAddress = parseEmail({ messageId: 'm', from: { name: 'same@company.com', email: 'same@company.com' }, subject: 's', body: 'b' });
  eq('sender: name identical to address -> null', nameIsAddress.senderName, null);
}

/* ================================================================== */
/* 9. Multiple attachments                                            */
/* ================================================================== */
{
  const parsed = parseEmail({
    messageId: 'm',
    from: 'a@b.com',
    subject: 'Screenshots attached',
    body: 'See attached.',
    attachments: [
      { name: 'screenshot.png', contentType: 'image/png', size: 20481, id: 'att-1' },
      { filename: 'error-log.txt', mimeType: 'text/plain', size: '1024', attachmentId: 'att-2' },
      { fileName: 'report.pdf', contentType: 'application/pdf', size: 88000, contentId: 'att-3', isInline: false },
      { name: 'logo.gif', contentType: 'image/gif', size: 900, id: 'att-4', isInline: true },
      { size: 10 }, // no filename at all
    ],
  });

  eq('attachments: all five normalized', parsed.attachments.length, 5);
  const [a1, a2, a3, a4, a5] = parsed.attachments;
  check('attachments: name/contentType/size/id from {name,id}', a1.filename === 'screenshot.png' && a1.contentType === 'image/png' && a1.size === 20481 && a1.attachmentId === 'att-1');
  check('attachments: alt keys {filename,mimeType,attachmentId}', a2.filename === 'error-log.txt' && a2.contentType === 'text/plain' && a2.attachmentId === 'att-2');
  eq('attachments: numeric string size coerced', a2.size, 1024);
  check('attachments: {fileName,contentId} handled', a3.filename === 'report.pdf' && a3.attachmentId === 'att-3');
  eq('attachments: inline flag preserved', a4.isInline, true);
  eq('attachments: default inline flag is false', a3.isInline, false);
  check('attachments: missing filename -> "unnamed"', a5.filename === 'unnamed' && a5.contentType === '' && a5.attachmentId === null);
  check('attachments: metadata only (no content field)', parsed.attachments.every((a) => !('content' in a) && !('bytes' in a)));

  const none = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: 'b' });
  check('attachments: absent -> empty array', Array.isArray(none.attachments) && none.attachments.length === 0);

  const junk = parseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: 'b', attachments: [null, 'nope', 42] });
  eq('attachments: non-object entries ignored', junk.attachments.length, 0);
}

/* ================================================================== */
/* 10. HTML with excessive markup                                     */
/* ================================================================== */
{
  const messy = `
    <!DOCTYPE html>
    <html xmlns:o="urn:schemas-microsoft-com:office:office">
      <head>
        <meta charset="utf-8">
        <style>body { font-family: Calibri; color: #1f1f1f; }</style>
        <script>window.tracker = 1;</script>
      </head>
      <body>
        <!-- Outlook conditional noise -->
        <div class="WordSection1" style="font-size:11pt">
          <p class="MsoNormal"><span style="color:#333">Hello&nbsp;IT,</span></p>
          <p class="MsoNormal">&nbsp;</p>
          <p class="MsoNormal">
            My <b>laptop</b> cannot connect to <i>WiFi</i>.<br>
            It started <u>this morning</u>.
          </p>
          <ul>
            <li>Tried restarting</li>
            <li>Tried forgetting the network</li>
          </ul>
          <table><tr><td>Asset</td><td>LAP-4471</td></tr></table>
          <p>Thanks &amp; regards,</p>
        </div>
      </body>
    </html>`;

  const parsed = parseEmail({
    messageId: 'm',
    from: 'a@b.com',
    subject: 'Messy',
    body: messy,
    bodyType: 'html',
  });

  const b = parsed.body;
  check('messy html: no tags survive', !/<[^>]+>/.test(b), b.slice(0, 120));
  check('messy html: no <style> content', !b.includes('Calibri') && !b.includes('font-size'));
  check('messy html: no <script> content', !b.includes('window.tracker'));
  check('messy html: no comments', !b.includes('conditional noise'));
  check('messy html: text preserved', b.includes('Hello IT,') && b.includes('My laptop cannot connect to WiFi.'));
  check('messy html: <br> became a line break', /WiFi\.\s*\n\s*It started this morning\./.test(b), JSON.stringify(b));
  check('messy html: list items bulleted', b.includes('- Tried restarting') && b.includes('- Tried forgetting the network'));
  check('messy html: list items single-spaced', b.includes('- Tried restarting\n- Tried forgetting the network'), JSON.stringify(b));
  check('messy html: table cells kept on one row', /Asset\s*\t?\s*LAP-4471/.test(b), JSON.stringify(b));
  check('messy html: &nbsp; decoded', b.includes('Hello IT,'));
  check('messy html: &amp; decoded', b.includes('Thanks & regards'));
  check('messy html: no runs of 3+ newlines', !/\n{3,}/.test(b));
  check('messy html: no double spaces', !/ {2,}/.test(b), JSON.stringify(b));

  // Direct converter checks
  eq('htmlToPlainText: simple paragraphs', htmlToPlainText('<p>Hello IT,</p><p>I cannot access Outlook.</p>'), 'Hello IT,\n\nI cannot access Outlook.');
  eq('htmlToPlainText: non-string input', htmlToPlainText(null), '');
  eq('htmlToPlainText: entity-encoded markup stays literal', htmlToPlainText('<p>use &lt;b&gt; for bold</p>'), 'use <b> for bold');
}

/* ================================================================== */
/* 11 + 12. Message ID and conversation ID extraction                 */
/* ================================================================== */
{
  eq('messageId: from messageId', parseEmail({ messageId: 'mid-1', from: 'a@b.com' }).messageId, 'mid-1');
  eq('messageId: from id', parseEmail({ id: 'mid-2', from: 'a@b.com' }).messageId, 'mid-2');
  eq('messageId: from internetMessageId', parseEmail({ internetMessageId: '<mid-3@host>', from: 'a@b.com' }).messageId, '<mid-3@host>');
  eq('messageId: messageId wins over id', parseEmail({ messageId: 'win', id: 'lose', from: 'a@b.com' }).messageId, 'win');

  eq('conversationId: from conversationId', parseEmail({ messageId: 'm', conversationId: 'conv-1', from: 'a@b.com' }).conversationId, 'conv-1');
  eq('conversationId: from threadId', parseEmail({ messageId: 'm', threadId: 'thread-1', from: 'a@b.com' }).conversationId, 'thread-1');
  eq('conversationId: absent -> null', parseEmail({ messageId: 'm', from: 'a@b.com' }).conversationId, null);
  eq('conversationId: blank -> null', parseEmail({ messageId: 'm', conversationId: '   ', from: 'a@b.com' }).conversationId, null);
}

/* ================================================================== */
/* 13. Invalid email input                                            */
/* ================================================================== */
{
  const bad = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'not an email object'],
    ['number', 42],
    ['array', []],
    ['empty object', {}],
    ['missing messageId', { from: 'a@b.com', subject: 's' }],
    ['missing sender', { messageId: 'm', subject: 's' }],
    ['malformed sender', { messageId: 'm', from: 'not-an-email' }],
    ['sender without domain', { messageId: 'm', from: 'user@' }],
    ['sender without tld', { messageId: 'm', from: 'user@host' }],
  ];

  for (const [label, input] of bad) {
    let threw = null;
    try {
      parseEmail(input);
    } catch (err) {
      threw = err;
    }
    check(
      `invalid: ${label} rejected`,
      threw instanceof EmailParseError && Array.isArray(threw.errors) && threw.errors.length > 0,
      threw ? threw.message : 'did not throw'
    );
  }

  // tryParseEmail reports instead of throwing
  const r = tryParseEmail({ subject: 'no ids at all' });
  check('invalid: tryParseEmail returns ok:false', r.ok === false && r.errors.length >= 2, JSON.stringify(r));
  check('invalid: errors name the missing fields', r.errors.some((e) => e.includes('messageId')) && r.errors.some((e) => e.includes('sender')), JSON.stringify(r.errors));

  const good = tryParseEmail({ messageId: 'm', from: 'a@b.com', subject: 's', body: 'b' });
  check('invalid: tryParseEmail returns ok:true for valid input', good.ok === true && good.email.messageId === 'm');
}

/* ================================================================== */
/* Contract + separation-of-concerns guarantees                       */
/* ================================================================== */
{
  const parsed = parseEmail({
    messageId: 'contract-1',
    conversationId: 'conv-1',
    from: { name: 'John Doe', email: 'john.doe@company.com' },
    subject: 'Cannot connect to WiFi',
    body: '<p>Hello IT,</p><p>My laptop cannot connect to WiFi.</p>',
    bodyType: 'html',
    receivedAt: '2026-08-26T12:00:00Z',
    attachments: [],
  });

  const expectedKeys = [
    'attachments', 'body', 'cleanBody', 'conversationId', 'inReplyTo', 'internetMessageId',
    'isHtml', 'messageId', 'quotedText', 'receivedAt', 'recipients', 'references',
    'senderEmail', 'senderName', 'signature', 'subject',
  ];
  eq('contract: exactly the documented keys', Object.keys(parsed).sort().join(','), expectedKeys.join(','));
  check('contract: threading ids are normalized arrays',
    Array.isArray(parsed.inReplyTo) && Array.isArray(parsed.references)
    && parsed.internetMessageId === null
    && Array.isArray(parsed.recipients.to) && Array.isArray(parsed.recipients.cc)
    && Array.isArray(parsed.recipients.replyTo));
  check('contract: quote/signature fields default to separated-empty',
    typeof parsed.cleanBody === 'string' && parsed.quotedText === null && parsed.signature === null);

  // The parser must not leak ticket/business concepts into its output.
  const forbidden = ['category', 'priority', 'assignedAgent', 'team', 'ticketNumber', 'state', 'isReply', 'isNewTicket'];
  check('contract: no business fields in output', forbidden.every((k) => !(k in parsed)), Object.keys(parsed).join(','));

  // Purity: same input -> same output (no clocks, no randomness, no IO).
  const again = parseEmail({
    messageId: 'contract-1',
    conversationId: 'conv-1',
    from: { name: 'John Doe', email: 'john.doe@company.com' },
    subject: 'Cannot connect to WiFi',
    body: '<p>Hello IT,</p><p>My laptop cannot connect to WiFi.</p>',
    bodyType: 'html',
    receivedAt: '2026-08-26T12:00:00Z',
    attachments: [],
  });
  eq('contract: deterministic for identical input', JSON.stringify(again), JSON.stringify(parsed));

  // receivedAt defaults to now when the provider omits it.
  const noDate = parseEmail({ messageId: 'm', from: 'a@b.com' });
  check('contract: missing receivedAt defaults to a valid ISO timestamp', !Number.isNaN(Date.parse(noDate.receivedAt)));
  const badDate = parseEmail({ messageId: 'm', from: 'a@b.com', receivedAt: 'not-a-date' });
  check('contract: unparseable receivedAt falls back to now', !Number.isNaN(Date.parse(badDate.receivedAt)));
  const dateObj = parseEmail({ messageId: 'm', from: 'a@b.com', receivedAt: new Date('2026-01-02T03:04:05Z') });
  eq('contract: Date instance accepted', dateObj.receivedAt, '2026-01-02T03:04:05.000Z');

  // The module must not drag in the Graph stack.
  const loaded = Object.keys(require.cache).filter((f) => /[\\/]src[\\/]graph[\\/]/.test(f));
  check('contract: parsing pulls in no Graph modules', loaded.length === 0, loaded.join(', '));
  const heavy = Object.keys(require.cache).filter((f) => /@microsoft|@azure|@prisma[\\/]client/.test(f));
  check('contract: parsing pulls in no Graph/Azure/Prisma packages', heavy.length === 0, heavy.slice(0, 3).join(', '));
}

/* ================================================================== */
/* Hardening: encoded headers, hygiene, quoting, limits                */
/* ================================================================== */
{
  const { decodeEncodedWords, sanitizeHeaderValue, separateQuotedContent, LIMITS } = require('../src/email/emailParser');

  /* ---- RFC 2047 encoded-words ---------------------------------------- */
  eq('H1 B-encoded UTF-8 subject decodes',
    decodeEncodedWords('=?utf-8?B?w4RscyB0aGUgY2Fmw6kgb3BlbnM=?='), 'Äls the café opens');
  eq('H2 Q-encoded UTF-8 subject decodes (underscore = space)',
    decodeEncodedWords('=?utf-8?Q?Caf=C3=A9_order?= is stuck'), 'Café order is stuck');
  eq('H3 ISO-8859-1 encoded word decodes',
    decodeEncodedWords('=?iso-8859-1?Q?caf=E9?='), 'café');
  eq('H4 stacked encoded words decode in place',
    decodeEncodedWords('=?utf-8?B?SsO2Zw==?= =?utf-8?Q?_done?='), 'Jög done');
  eq('H5 unknown charsets stay untouched (deterministic, never mojibake)',
    decodeEncodedWords('=?x-mystery?B?YWJj?='), '=?x-mystery?B?YWJj?=');
  eq('H6 plain subjects pass through byte-for-byte',
    decodeEncodedWords('No encoding here'), 'No encoding here');
  const encodedSender = parseEmail({
    messageId: 'h-s1',
    from: '=?utf-8?B?Uml0YSBSZXF1ZXN0ZXI=?= <rita@company.com>',
    subject: '=?utf-8?Q?Caf=C3=A9_printer?= issue',
    body: 'hello',
  });
  eq('H7 encoded sender display name decodes', encodedSender.senderName, 'Rita Requester');
  eq('H8 encoded subject decodes through parseEmail', encodedSender.subject, 'Café printer issue');
  eq('H9 the address itself is untouched by decoding', encodedSender.senderEmail, 'rita@company.com');

  /* ---- header hygiene / injection defense ----------------------------- */
  const crlf = parseEmail({
    messageId: 'h-c1',
    from: 'rita@company.com',
    subject: 'Line one\r\nBCC: victim@x.com',
    body: 'x',
  });
  eq('H10 CRLF in a subject collapses to spaces (header injection dead)',
    crlf.subject, 'Line one BCC: victim@x.com');
  const ctrl = parseEmail({
    messageId: 'h-c2',
    from: 'Rita\x00\u0007 Requester <rita@company.com>',
    subject: 'tab\tand\x01control',
    body: 'x',
  });
  eq('H11 control characters are stripped from names', ctrl.senderName, 'Rita Requester');
  eq('H12 control characters are stripped from subjects', ctrl.subject, 'tab and control');
  eq('H13 a subject of pure control characters degrades to empty',
    parseEmail({ messageId: 'h-c3', from: 'a@b.com', subject: '\r\n\r\n', body: 'x' }).subject, '');

  /* ---- Reply-To and recipients ---------------------------------------- */
  const replyTo = parseEmail({
    messageId: 'h-r1',
    from: 'rita@company.com',
    replyTo: ['"Service Desk" <desk@company.com>', 'backup@company.com'],
    to: ['a@x.com', { name: 'Bee', email: 'bee@x.com' }],
    cc: 'cc1@x.com, "Cee Cee" <cc2@x.com>',
    body: 'x',
  });
  eq('H14 Reply-To parses into the recipients model',
    JSON.stringify(replyTo.recipients.replyTo.map((a) => a.email)),
    JSON.stringify(['desk@company.com', 'backup@company.com']));
  eq('H15 Reply-To names survive', replyTo.recipients.replyTo[0].name, 'Service Desk');
  eq('H16 to-list parses mixed shapes', replyTo.recipients.to.map((a) => a.email).join(','), 'a@x.com,bee@x.com');
  eq('H17 cc-list parses string form', replyTo.recipients.cc.map((a) => a.email).join(','), 'cc1@x.com,cc2@x.com');
  eq('H18 recipient lists default to empty arrays',
    JSON.stringify(parseEmail({ messageId: 'h-r2', from: 'a@b.com', body: 'x' }).recipients),
    JSON.stringify({ to: [], cc: [], replyTo: [] }));

  /* ---- quoted replies, forwards, signatures --------------------------- */
  const quoted = parseEmail({
    messageId: 'h-q1',
    from: 'rita@company.com',
    subject: 'Re: printer',
    body: [
      'It happened again this morning.',
      '',
      'On 1 Sep 2026, at 09:00, IT Helpdesk wrote:',
      '> Please try rebooting.',
      '> Then tell us what happened.',
    ].join('\n'),
  });
  eq('Q1 the full body is preserved verbatim', quoted.body.includes('> Please try rebooting.'), true);
  eq('Q2 the clean body keeps only the sender’s words',
    quoted.cleanBody, 'It happened again this morning.');
  check('Q3 the quoted block is separated intact',
    quoted.quotedText.includes('On 1 Sep 2026') && quoted.quotedText.includes('> Please try rebooting.')
    && quoted.quotedText.includes('> Then tell us what happened.'));
  eq('Q4 no signature detected', quoted.signature, null);

  const signed = parseEmail({
    messageId: 'h-q2',
    from: 'rita@company.com',
    subject: 'hello',
    body: ['Question about my laptop.', '', '--', 'Rita Requester', 'Facilities, floor 3'].join('\n'),
  });
  eq('Q5 the standard signature delimiter separates the tail', signed.signature, 'Rita Requester\nFacilities, floor 3');
  eq('Q6 the clean body ends before the delimiter', signed.cleanBody, 'Question about my laptop.');

  const forwarded = parseEmail({
    messageId: 'h-q3',
    from: 'rita@company.com',
    subject: 'Fwd: printer',
    body: [
      'See below.',
      '',
      '---------- Forwarded message ----------',
      'From: Bob <bob@company.com>',
      'Date: Tue, 1 Sep 2026 at 10:00',
      'Subject: printer offline',
      'To: helpdesk@company.com',
      '',
      'The 3rd floor printer is offline.',
    ].join('\n'),
  });
  eq('Q7 the forwarded run is separated from the cover note', forwarded.cleanBody, 'See below.');
  check('Q8 the forwarded headers and body stay in the quoted part',
    forwarded.quotedText.includes('Forwarded message') && forwarded.quotedText.includes('The 3rd floor printer is offline.'));

  const plain = parseEmail({ messageId: 'h-q4', from: 'a@b.com', subject: 's', body: 'Just a normal message.\nSecond line.' });
  eq('Q9 plain bodies separate nothing', plain.quotedText === null && plain.signature === null, true);
  eq('Q10 clean body equals the body for plain mail', plain.cleanBody, plain.body);
  const quoteOnly = parseEmail({ messageId: 'h-q5', from: 'a@b.com', subject: 's', body: '> entirely quoted' });
  eq('Q11 a fully quoted body yields an empty clean view', quoteOnly.cleanBody, '');
  eq('Q12 the full text is still intact', quoteOnly.body, '> entirely quoted');

  /* ---- limits ----------------------------------------------------------- */
  const bigBody = 'x'.repeat(LIMITS.bodyChars + 5000);
  const bigParsed = parseEmail({ messageId: 'h-l1', from: 'a@b.com', subject: 's', body: bigBody });
  eq('L1 oversized bodies are capped', bigParsed.body.length, LIMITS.bodyChars + '\n[message truncated]'.length);
  check('L2 the truncation marker is visible', bigParsed.body.endsWith('[message truncated]'));
  const manyRecipients = Array.from({ length: LIMITS.recipientsPerList + 20 }, (_, i) => `r${i}@x.com`);
  eq('L3 recipient floods are capped',
    parseEmail({ messageId: 'h-l2', from: 'a@b.com', to: manyRecipients, body: 'x' }).recipients.to.length,
    LIMITS.recipientsPerList);
  const longChain = Array.from({ length: LIMITS.threadIds + 30 }, (_, i) => `<ref-${i}@x.com>`).join(' ');
  eq('L4 reference chains are capped',
    parseEmail({ messageId: 'h-l3', from: 'a@b.com', references: longChain, body: 'x' }).references.length,
    LIMITS.threadIds);
  eq('L5 the earliest references survive the cap', parseEmail({
    messageId: 'h-l4', from: 'a@b.com', references: longChain, body: 'x',
  }).references[0], 'ref-0@x.com');
  eq('L6 subject over the RFC line limit is bounded',
    parseEmail({ messageId: 'h-l5', from: 'a@b.com', subject: 's'.repeat(LIMITS.subjectChars + 100), body: 'x' }).subject.length,
    LIMITS.subjectChars);

  /* ---- empty and odd bodies --------------------------------------------- */
  const empty = parseEmail({ messageId: 'h-e1', from: 'a@b.com', subject: 's', body: '' });
  eq('E1 an empty body stays empty', empty.body, '');
  eq('E2 an empty body separates nothing', empty.cleanBody === '' && empty.quotedText === null && empty.signature === null, true);
  const whitespace = parseEmail({ messageId: 'h-e2', from: 'a@b.com', subject: 's', body: '   \n\n  ' });
  eq('E3 whitespace-only bodies normalize cleanly', whitespace.body, '');
  const unicode = parseEmail({ messageId: 'h-e3', from: 'a@b.com', subject: 's', body: 'Héllo wörld — 日本語テスト 🎉' });
  eq('E4 international characters and emoji pass through', unicode.body, 'Héllo wörld — 日本語テスト 🎉');

  /* ---- determinism -------------------------------------------------------- */
  const sample = { messageId: 'h-d1', from: 'Rita <rita@x.com>', subject: 'Re: café', body: 'body > quoted\nmore' };
  const first = JSON.stringify(parseEmail(sample));
  const second = JSON.stringify(parseEmail(sample));
  eq('D1 parsing is deterministic for identical input', first, second);
}

/* ================================================================== */
(async () => {
/* Cross-channel equivalence: IMAP raw fixtures vs Graph message shapes */
/* ================================================================== */
{
  const { toRawEmail: imapAdapter } = require('../src/imap/imapMailAdapter');
  const { toRawEmail: graphAdapter } = require('../src/graph/graphMailAdapter');

  // One logical email, expressed in both provider vocabularies.
  const RFC = [
    'From: Rita Requester <rita@company.com>',
    'To: "IT Helpdesk" <helpdesk@company.com>, second@company.com',
    'Cc: watcher@company.com',
    'Reply-To: desk@company.com',
    'Subject: =?utf-8?Q?Caf=C3=A9_printer_jams_on_duplex?=',
    'Message-ID: <cafe-printer-1@company.com>',
    'In-Reply-To: <cafe-printer-0@company.com>',
    'References: <cafe-printer-0@company.com> <cafe-printer-00@company.com>',
    'Date: Tue, 1 Sep 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="EQB1"',
    '',
    '--EQB1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The duplex unit jams every time.',
    '',
    '--EQB1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The <b>duplex unit</b> jams every time.</p>',
    '',
    '--EQB1--',
    '',
  ].join('\r\n');

  const GRAPH = {
    id: 'graph-eq-1',
    internetMessageId: '<cafe-printer-1@company.com>',
    conversationId: 'conv-eq-1',
    inReplyTo: 'cafe-printer-0@company.com',
    subject: 'Café printer jams on duplex',
    from: { emailAddress: { name: 'Rita Requester', address: 'rita@company.com' } },
    toRecipients: [
      { emailAddress: { name: 'IT Helpdesk', address: 'helpdesk@company.com' } },
      { emailAddress: { address: 'second@company.com' } },
    ],
    ccRecipients: [{ emailAddress: { address: 'watcher@company.com' } }],
    replyTo: [{ emailAddress: { address: 'desk@company.com' } }],
    body: { contentType: 'html', content: '<p>The <b>duplex unit</b> jams every time.</p>' },
    receivedDateTime: '2026-09-01T09:00:00Z',
  };

  const imapParsed = parseEmail(await imapAdapter({ uid: 1, source: Buffer.from(RFC, 'utf8'), internalDate: new Date('2026-09-01T09:00:00Z') }));
  const graphParsed = parseEmail(graphAdapter(GRAPH));

  // The fields that MUST be identical regardless of channel:
  eq('X1 identical internetMessageId', imapParsed.internetMessageId, graphParsed.internetMessageId);
  eq('X2 identical sender email', imapParsed.senderEmail, graphParsed.senderEmail);
  eq('X3 identical sender name (encoded header decoded like Graph)', imapParsed.senderName, graphParsed.senderName);
  eq('X4 identical subject (RFC 2047 decoded like Graph)', imapParsed.subject, graphParsed.subject);
  eq('X5 identical body text after HTML conversion', imapParsed.body, graphParsed.body);
  eq('X6 identical In-Reply-To', JSON.stringify(imapParsed.inReplyTo), JSON.stringify(graphParsed.inReplyTo));
  check('X7 References: IMAP carries the chain; Graph threads via conversationId',
    JSON.stringify(imapParsed.references) === JSON.stringify(['cafe-printer-0@company.com', 'cafe-printer-00@company.com'])
    && graphParsed.references.length === 0);
  eq('X8 identical recipients (to)', JSON.stringify(imapParsed.recipients.to), JSON.stringify(graphParsed.recipients.to));
  eq('X9 identical recipients (cc)', JSON.stringify(imapParsed.recipients.cc), JSON.stringify(graphParsed.recipients.cc));
  eq('X10 identical recipients (replyTo)', JSON.stringify(imapParsed.recipients.replyTo), JSON.stringify(graphParsed.recipients.replyTo));
  eq('X11 identical html flag', imapParsed.isHtml, graphParsed.isHtml);
  eq('X12 identical clean body', imapParsed.cleanBody, graphParsed.cleanBody);

  // Documented, deliberate source differences:
  check('X13 the provider id stays source-specific (Graph id vs RFC id)',
    graphParsed.messageId === 'graph-eq-1' && imapParsed.messageId === 'cafe-printer-1@company.com');
  check('X14 the conversation id is Graph-native (IMAP threads by references)',
    graphParsed.conversationId === 'conv-eq-1' && imapParsed.conversationId === null);

  // The downstream-relevant fields agree, which is what makes intake produce
  // identical tickets: dedupe identity, threading chain and content.
  check('X15 the dedupe identity matches across channels',
    imapParsed.internetMessageId === graphParsed.internetMessageId
    && imapParsed.internetMessageId === 'cafe-printer-1@company.com');
}

/* ================================================================== */
/* Malformed MIME through the IMAP adapter                             */
/* ================================================================== */
{
  const { toRawEmail: imapAdapter } = require('../src/imap/imapMailAdapter');

  // A truncated multipart: the final boundary never arrives.
  const truncated = [
    'From: rita@company.com',
    'Subject: truncated multipart',
    'Message-ID: <trunc-1@company.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="CUT"',
    '',
    '--CUT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This part is complete but the message was cut off mid-',
  ].join('\r\n');
  const truncParsed = parseEmail(await imapAdapter({ uid: 1, source: Buffer.from(truncated, 'utf8') }));
  check('M1 a truncated multipart still yields the sender and subject',
    truncParsed.senderEmail === 'rita@company.com' && truncParsed.subject === 'truncated multipart');
  eq('M2 the complete part is recovered', truncParsed.body.includes('complete but the message was cut off'), true);

  // Double headers: the first value wins, deterministically.
  const dupHeaders = [
    'From: first@company.com',
    'From: second@company.com',
    'Subject: first subject',
    'Subject: second subject',
    'Message-ID: <dup-1@company.com>',
    'Message-ID: <dup-2@company.com>',
    '',
    'body',
  ].join('\r\n');
  const dupParsed = parseEmail(await imapAdapter({ uid: 2, source: Buffer.from(dupHeaders, 'utf8') }));
  eq('M3 duplicate headers resolve deterministically (mailparser keeps the last)', dupParsed.messageId, 'dup-2@company.com');
  eq('M3b the resolution is stable across re-parses',
    (await imapAdapter({ uid: 9, source: Buffer.from(dupHeaders, 'utf8') })).messageId, dupParsed.messageId);

  // Folded headers (continuation lines) unfold into one value.
  const folded = [
    'From: rita@company.com',
    'Subject: this subject spans',
    ' several physical lines',
    'Message-ID: <fold-1@company.com>',
    '',
    'body',
  ].join('\r\n');
  const foldedParsed = parseEmail(await imapAdapter({ uid: 3, source: Buffer.from(folded, 'utf8') }));
  eq('M4 folded headers unfold into one value', foldedParsed.subject, 'this subject spans several physical lines');

  // Missing headers degrade safely.
  const bare = await imapAdapter({ uid: 4, source: Buffer.from('just some text, no headers at all', 'utf8') });
  let rejected = false;
  try { parseEmail(bare); } catch (err) { rejected = err.name === 'EmailParseError'; }
  check('M5 header-less garbage is a clean parse rejection', rejected);

  // Charset declarations are honored by the MIME layer.
  const latin = [
    'From: "José García" <jose@company.com>',
    'Subject: =?iso-8859-1?Q?anexo_firmado?= ',
    'Message-ID: <latin-1@company.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'El caf=E9 est=E1 listo.',
  ].join('\r\n');
  const latinParsed = parseEmail(await imapAdapter({ uid: 5, source: Buffer.from(latin, 'latin1') }));
  eq('M6 iso-8859-1 bodies decode to readable text', latinParsed.body.includes('El café está listo.'), true);
  eq('M7 encoded ISO subject decodes', latinParsed.subject, 'anexo firmado');
}

  const summary = failures ? failures + " check(s) FAILED" : "All checks passed";
  console.log(summary);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  failures += 1;
  console.error("SUITE ERROR: " + (err.stack || err));
  process.exit(1);
});
