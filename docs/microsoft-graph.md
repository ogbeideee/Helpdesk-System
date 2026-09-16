# Microsoft 365 / Microsoft Graph

The monitored mailbox is the Microsoft 365 **shared mailbox**
`ithelpdesk@mrsholdings.com`. The application only ever reads that mailbox -
never individual employee mailboxes.

Register an Entra ID app with **application** permissions `Mail.ReadWrite` +
`Mail.Send` (admin consent granted), then fill `GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SHARED_MAILBOX` and
`GRAPH_BROADCAST_DL` in `server/.env`. Missing credentials are never fatal -
the API, dashboard and simulated-email endpoints keep working with Graph off,
and the server logs `Microsoft Graph integration disabled`.

Authentication is MSAL client-credentials with token caching; tokens are
renewed before expiry and re-acquired on a 401. Secrets and tokens are never
logged and never reach the frontend.

## Graph adapter

```text
Microsoft Graph (shared mailbox)
      v
Graph Email Adapter      src/graph/graphMailAdapter.js  (Graph shape -> RawEmailInput)
      v
Email Parser             src/email/emailParser.js
      v
Ticket Ingestion         src/services/emailIngestion.js -> ticketIntake.js
      v
Ticket / Activity  ->  Assignment Engine
```

The adapter only translates Graph's vocabulary into the shared normalized
model. It performs no classification, no assignment, no ticket creation and
makes no reply-vs-new decision - tests assert this. Graph mail and simulated
mail therefore travel exactly the same path.

## Safe connectivity check

Before enabling ingestion, verify the connection **without creating anything**:

```bash
cd server
npm run graph:check                 # 5 newest unread, inside the age window
npm run graph:check -- --limit 3
npm run graph:check -- --all        # ignore the age cutoff
```

It authenticates, resolves the shared mailbox, parses a few messages and prints
safe metadata (sender, subject, body length, a short excerpt, attachment
metadata). It never creates tickets, never marks anything read, and never
prints a token, secret or complete body. It is a command rather than an HTTP
route on purpose - mailbox contents are never exposed through an API endpoint.

## Ingestion safety

Switching the integration on must not convert an existing inbox into hundreds
of tickets, so ingestion is bounded by default:

| Variable | Default | Effect |
|---|---|---|
| `GRAPH_INGEST_MAX_AGE_HOURS` | `24` | only mail newer than this is ingested; `0` disables the limit |
| `GRAPH_INGEST_SINCE` | *(unset)* | absolute ISO cutoff; wins over the rolling window |
| `GRAPH_POLL_BATCH_SIZE` | `25` | messages fetched per cycle (max 100) |
| `GRAPH_DRY_RUN` | `false` | `true` = authenticate, read and parse, but never create tickets or mark anything read |

The cutoff is applied **server-side** in the Graph query, so an old backlog is
never even fetched.

## Polling behaviour

Every `MAIL_POLL_INTERVAL_MS` (default 2 minutes) the poller lists unread inbox
messages inside the window, fetches attachment metadata when present, parses,
and hands the normalized email to the shared ingestion service.

A message is marked read **only after a definitive outcome** (ticket created,
activity added, reopened, duplicate, rejected, or self-addressed). A transient
failure leaves it unread and logs the reason, so the next cycle retries it.

Read/unread is a delivery concern and never the idempotency mechanism: the
unique `graphMessageId` on `Ticket` and `Comment` is what guarantees one email
can never produce two tickets, two activities, or duplicate notifications -
even if the mailbox reports it unread again.

Typical cycle:

```text
[graph] Found 2 unread message(s)
[graph] Processing message AAMkAGI1...
[email] Parsed message from john.doe@mrsholdings.com (html, 1 attachment(s))
[ticket] Created INC-000459
[assignment] Assigned INC-000459 to Lena Fischer
[graph] Marked message as read (ticket created)
```

Attachments are captured as metadata only - filename, content type, size and
the Graph attachment id used as a future content reference. Nothing is
downloaded or stored; attachment storage is a separate decision.



## Two ingestion mechanisms, one pipeline

| Mechanism | Trigger | Role |
|---|---|---|
| Change notifications (webhook) | Graph POSTs on new mail | Preferred, near-real-time |
| Inbox polling | Every 2 min (`MAIL_POLL_INTERVAL_MS`) | Always-on fallback |

Both funnel into the *same* service (`src/graph/mailService.js` →
`src/services/ticketIntake.js`), so classification, numbering, routing,
assignment and notifications are identical whichever path a message arrives on.
Idempotency is enforced by the unique `Ticket.graphMessageId` and
`Comment.graphMessageId`: if the webhook and the poller both see one email, the
second one resolves to `duplicate` and changes nothing.

## Webhook configuration

Webhooks are **optional and off by default** — local development needs no
public URL and no tunnel (ngrok is not a dependency). Set `WEBHOOK_PUBLIC_URL`
to the public HTTPS base URL of the server to enable them:

```env
WEBHOOK_PUBLIC_URL=https://helpdesk.example.com
GRAPH_WEBHOOK_CLIENT_STATE=<random 32-byte hex>
```

The notification URL is derived as
`<WEBHOOK_PUBLIC_URL>/api/webhooks/microsoft-graph` — nothing is hardcoded. If
the variable is absent or not HTTPS, the server logs that webhook mode is
unavailable and continues on polling.

Endpoint behaviour (`POST /api/webhooks/microsoft-graph`):

- answers Graph's `validationToken` handshake with the raw token as `text/plain`
- authenticates every notification by comparing `clientState` against the stored
  subscription (Graph's documented mechanism; constant-time comparison)
- retrieves the message, then hands it to the shared pipeline
- on retrieval/processing failure: logs it, leaves the mail **unread**, and lets
  the next poll recover it

Subscriptions expire (~3 days max), so `src/graph/subscriptionService.js` owns
their lifecycle: create, inspect, renew, delete, plus an automatic renewal timer
(`GRAPH_SUBSCRIPTION_RENEW_INTERVAL_MS`, default 30 min) that renews before
expiry and recreates a subscription that expired or that Graph has forgotten.
The record is persisted (`GraphSubscription`) so restarts reuse it. Graph
lifecycle events (`reauthorizationRequired`, `subscriptionRemoved`, `missed`)
are handled on the same endpoint.

`GET /api/health` reports Graph/webhook/polling state, subscription status and
expiry, last successful processing and last error — and never exposes secrets.
