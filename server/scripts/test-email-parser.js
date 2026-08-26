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
    'attachments', 'body', 'conversationId', 'isHtml', 'messageId',
    'receivedAt', 'senderEmail', 'senderName', 'subject',
  ];
  eq('contract: exactly the documented keys', Object.keys(parsed).sort().join(','), expectedKeys.join(','));

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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
