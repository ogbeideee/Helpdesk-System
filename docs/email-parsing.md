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
   dedupe -> thread match -> classify -> number -> route
        v
Assignment Engine
        v
Ticket  (or an activity on an existing ticket)
```

| File | Role |
|---|---|
| `src/email/types.d.ts` | TypeScript model: `NormalizedEmail`, `EmailAttachment`, `RawEmailInput` |
| `src/email/emailParser.js` | `parseEmail()` / `tryParseEmail()` - raw email -> normalized |
| `src/email/htmlToText.js` | Deterministic HTML -> readable plain text |
| `src/email/subjectUtils.js` | Ticket-number and reply-prefix helpers |
| `src/services/emailIngestion.js` | Maps `NormalizedEmail` onto the intake payload |

The parser is a pure function: no clock beyond a `receivedAt` fallback, no
network, no database, no LLM. It does **not** classify, prioritise, assign,
create tickets, send notifications, or decide whether an email is a new ticket
or a reply - all of that stays in ticket ingestion.

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
`attachmentId`, `isInline`). No file bytes are read and nothing is uploaded
anywhere - persistent attachment storage is a later phase.

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
parse -> dedupe by messageId -> new ticket OR reply activity
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

**Reply detection** (performed by intake, not the parser): a ticket number in
the subject or body wins first; otherwise a matching `conversationId` **from the
same requester** threads the email onto that ticket. A different sender on the
same conversation gets their own ticket.

**Idempotency** comes from the unique `graphMessageId` on both `Ticket` and
`Comment`, so replaying a message creates neither a second ticket nor a second
activity.

Attachment metadata is returned with the response but not yet persisted.

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

Run the parser tests with `npm run test:parser` (104 checks) and the ingestion
tests with `npm run test:ingest` (76 checks), both from `server/`. Neither
requires credentials.
