# Email parsing layer

Email parsing is deliberately independent of any email provider. Nothing in
`server/src/email/` imports Microsoft Graph, Azure, Prisma, or the ticket
business logic - a test asserts this.

```text
Microsoft 365 / Graph  |  IMAP  |  dev endpoint
        v
Email Provider Adapter        (provider-specific -> RawEmailInput)
        v
Email Parser                  (RawEmailInput -> NormalizedEmail)
        v
Email Ingestion               (src/services/emailIngestion.js - field mapping)
        v
Ticket Creation Service       (src/services/ticketIntake.js)
   dedupe -> thread match -> screen -> relevance triage
            -> classify -> number -> route
        v
Assignment Engine
        v
Ticket  (or an activity on an existing ticket)
```

| File | Role |
|---|---|
| `src/email/types.d.ts` | TypeScript model: `NormalizedEmail`, `EmailAttachment`, `RawEmailInput` |
| `src/email/emailParser.js` | `parseEmail()` / `tryParseEmail()` - raw email -> normalized |
| `src/email/signature.js` | Deterministic signature / legal-footer detection |
| `src/email/htmlToText.js` | Deterministic HTML -> readable plain text |
| `src/email/subjectUtils.js` | Ticket-number and reply-prefix helpers |
| `src/services/emailIngestion.js` | Maps `NormalizedEmail` onto the intake payload |

The parser is a pure function: no clock beyond a `receivedAt` fallback, no
network, no database, no LLM. It does **not** classify, prioritise, assign,
create tickets, send notifications, or decide whether an email is a new ticket
or a reply - all of that stays in ticket ingestion. The optional Groq relevance
service is called later by `ticketIntake`, never by the parser.

## Normalized email

```json
{
  "messageId": "test-message-001",
  "conversationId": "test-conversation-001",
  "senderEmail": "john.doe@company.com",
  "senderName": "John Doe",
  "subject": "Cannot connect to WiFi",
  "body": "Hello IT,\n\nMy laptop cannot connect to WiFi.",
  "receivedAt": "2026-08-26T12:00:00.000Z",
  "isHtml": true,
  "attachments": []
}
```

The subject is preserved verbatim - `Re:` prefixes are never stripped from it.
`extractTicketNumberFromSubject()` identifies `INC-000123` in all of
`[INC-000123] ...`, `Re: [INC-000123] ...` and `RE: [INC-000123] ...`.

Attachments are **metadata only** (`filename`, `contentType`, `size`,
`attachmentId`, `isInline`). The parser never reads file bytes. What happens to
them afterwards is an intake decision, not a parsing one - see
[Attachments and inline images](#attachments-and-inline-images).

## Attachments and inline images

Two very different things arrive as MIME attachment parts, and the pipeline
keeps them apart.

**Real attachments** - a file the sender actually attached (an invoice PDF, a
named screenshot, `error-log.txt`). Metadata is persisted on the ticket or
comment, and the bytes are fetched and uploaded through
`attachmentService` → the configured `attachmentStorage` driver.

**Decorative inline images** - a mail client's own furniture: the signature logo,
social-media icons, a pasted picture. These are `multipart/related` parts with
`Content-Disposition: inline` (Graph reports them as `isInline`) and a
client-generated name like `image001.png`. Nothing ever renders them: the
ticket body is stored as **text**, so an agent can never click one, while the
object store grows by a few hundred KB per email. They are therefore **skipped,
not stored** - logged by name, counted in the `ticket.created` audit metadata
as `inlineImagesSkipped`, and excluded from the size/count limits. A pasted
screenshot is inline too and is skipped for the same reason; ask the sender to
attach it if it is needed.

The rule is narrow - **images only, inline only**. `ATTACHMENT_SKIP_INLINE_IMAGES=false`
restores the previous behaviour of storing every part. The IMAP adapter and
`graph/mailService.js` both pass `isInline` / `contentDisposition` through
verbatim, so one policy covers both channels.

`npm run db:purge-signature-images` (add `--apply`) removes the inline images
that were stored before this policy existed. Dry run by default, like every
other purge script; it only ever matches image parts whose filename is a mail
client's own `imageNNN.ext` / hash name, so named attachments are untouched.

## Signatures and legal footers

`body` is the sender's text verbatim; `cleanBody` is the sender's **own words**
- quoted replies, forwarded blocks and the signature are removed, and
`signature` / `quotedText` expose what was separated.

`signature.js` is pure, deterministic and deliberately conservative. It only
accepts two unambiguous shapes:

1. a footer marker that can only end a message ("This email is sent on behalf
   of…", "The contents of this e-mail… confidential", "We are on Social Media");
2. a **trailing run** of signature-shaped lines (contact, company, role, URL)
   introduced by a closing salutation - never a line in the middle of a
   request, and never a single line on its own.

So "Please call me on 0803 000 0000" inside a request survives, while a
Bestaf/MRS-style block under "Regards," does not. Classification, routing and
the relevance gate read `cleanBody`; nothing is deleted from `body`, which is
what the ticket and the audit trail keep.

## Development endpoint

`POST /api/dev/email/parse` runs raw email through the parser and returns the
normalized result. **It creates no ticket and writes nothing.** The whole
`/api/dev` router returns 404 when `NODE_ENV=production`.

```bash
curl -s -X POST http://localhost:4000/api/dev/email/parse \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "test-message-001",
    "conversationId": "test-conversation-001",
    "from": { "name": "John Doe", "email": "john.doe@company.com" },
    "subject": "Cannot connect to WiFi",
    "body": "<p>Hello IT,</p><p>My laptop cannot connect to WiFi.</p>",
    "bodyType": "html",
    "receivedAt": "2026-08-26T12:00:00Z",
    "attachments": []
  }'
```

Also available: `POST /api/dev/email/parse-batch` and
`GET /api/dev/email/ticket-number?subject=...`.

## Ingestion endpoint

`POST /api/dev/email/ingest` takes the **same body** as `/email/parse`, but the
normalized email continues into the existing ticket pipeline:

```text
parse -> dedupe by messageId -> thread/reply
      -> deterministic screen -> optional relevance triage
      -> classification -> assignment group -> agent -> audit log
```

No ticket logic lives in the route or in `emailIngestion.js` - they only
translate field names and delegate to `intakeEmailMessage()`. Classification,
ticket numbering, routing, assignment, reopening and audit are untouched.

Field mapping for a new ticket:

| Normalized email | Ticket |
|---|---|
| `subject` | `shortDescription` |
| `body` | `body` |
| `senderEmail` | `requesterEmail` |
| `senderName` | `requesterName` |
| `messageId` | `graphMessageId` |
| `conversationId` | `graphConversationId` |

Response `status` is one of:

| status | meaning |
|---|---|
| `created` | new ticket (HTTP 201) |
| `comment_added` | activity added to an existing ticket |
| `reopened` | requester replied to a RESOLVED/CLOSED ticket |
| `duplicate` | this `messageId` was already processed - nothing changed |
| `skipped_automated` | deterministic screening suppressed the message |
| `skipped_non_ticket` | the optional, policy-approved relevance gate suppressed the message |

**Reply detection** (performed by intake, not the parser): a ticket number in
the subject or body wins first; otherwise a matching `conversationId` **from the
same requester** threads the email onto that ticket. A different sender on the
same conversation gets their own ticket.

**Idempotency** comes from the unique `graphMessageId` on both `Ticket` and
`Comment`, so replaying a message creates neither a second ticket nor a second
activity.

Attachment metadata is persisted with the ticket or the comment, minus the
decorative inline parts the intake policy skips (above).

```bash
curl -s -X POST http://localhost:4000/api/dev/email/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "messageId": "demo-1",
    "conversationId": "demo-conv-1",
    "from": { "name": "John Doe", "email": "john.doe@company.com" },
    "subject": "Cannot connect to WiFi",
    "body": "<p>Hello IT,</p><p>My laptop cannot connect to WiFi.</p>",
    "bodyType": "html"
  }'
```

Run the parser tests with `npm run test:parser` (182 checks) and the ingestion
tests with `npm run test:ingest` (80 checks), both from `server/`. Neither
requires credentials. `npm run test:attachments` covers the inline-image
storage policy end to end, including a real IMAP ingestion.
