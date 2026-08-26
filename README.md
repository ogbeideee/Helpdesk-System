# TicketDesk — IT Helpdesk Ticketing System

Production-ready internal helpdesk for the IT department. Runs **fully locally
without any Microsoft 365 credentials** — a built-in email simulator stands in
for the Graph ingestion layer, which adds inbox polling and Microsoft Graph
change notifications (webhooks) when configured.

```text
Employee sends email          (today: Simulate Email page → POST /api/tickets/from-email)
        ↓
System detects new message    (dedupe by message ID)
        ↓
Creates a ticket              HD/INC ticket number, HTML→text, thread matching
        ↓
Classifies category           configurable keyword rules
        ↓
Determines assignment group   config/assignment.config.json
        ↓
Assigns an available agent    assignment engine: skill ≥ required, lowest workload
        ↓
Agent works the request       portal: start work → notes → updates
        ↓
Status workflow               NEW → IN_PROGRESS → RESOLVED → CLOSED (+ reopen)
        ↓
Resolution                    mandatory resolution note, full audit history
```

## Stack

| Layer    | Technology |
|----------|------------|
| API      | Node.js + Express |
| Database | SQLite via Prisma (`server/prisma/dev.db`) |
| Frontend | React 18 + Vite SPA (served by the API in production) |
| Auth     | JWT sessions (bcrypt-hashed passwords) |

## Run the complete system locally

```bash
# --- one-time setup ---------------------------------------------------
cd server
npm install
copy .env.example .env          # GRAPH_* vars can stay empty
npm run db:push                 # create schema
npm run db:init                 # seed teams + admin + sample agents

# --- seed demo accounts + realistic demo data (recommended) -----------
npm run seed:demo               # demo logins + 10 fixture tickets + ~120 bulk tickets
npm run seed:demo -- --clear    # remove demo tickets again
npm run seed:demo -- --clear --accounts   # also remove the demo logins

# --- run backend (terminal 1) ----------------------------------------
cd server
npm run dev                     # API on http://localhost:4000

# --- run frontend (terminal 2) ---------------------------------------
cd client
npm install
npm run dev                     # UI on http://localhost:5173 (proxies /api)

# --- production mode instead -----------------------------------------
cd client && npm run build      # builds client/dist
cd ../server && npm start       # single server serves app + API on :4000
```

Sign in with `admin@noctincan.com` / `ChangeMe!123` (sample agents use the same
password — change both before real use), or use the demo accounts below.

## Development Demo Accounts

**Local/development only.** These accounts exist so you can log in and inspect
the dashboard and the different role experiences before production
authentication is connected. They are created by the backend seed
(`npm run seed:demo`) — the passwords live in `server/scripts/seed-demo.js`,
never in frontend source and never in production configuration. The seed
refuses to run when `NODE_ENV=production` (override with `--force`).

| Role | Email | Password | Skill | Assignment group |
|---|---|---|---|---|
| Admin | `admin.demo@noctincan.com` | `DemoAdmin!123` | — | — |
| Agent (senior) | `senior.demo@noctincan.com` | `DemoSenior!123` | 3 (senior) | Service Desk |
| Agent (junior) | `junior.demo@noctincan.com` | `DemoJunior!123` | 1 (junior) | Accounts & Access |

> The requested group names map onto the four existing routing teams
> (`src/teams.js`): **General IT Support → Service Desk** (the default group)
> and **Password Reset Team → Accounts & Access** (the group that owns the
> `Password Reset` category). No new groups were added, so the assignment
> engine's category→group routing is unchanged.

The admin account reaches agent administration (`/api/agents` write endpoints);
the two agent accounts get `403` there, which is the intended role split.

### Demo data

`npm run seed:demo` is **idempotent** — re-running it never creates duplicates.
It seeds, in order:

1. the three demo logins (upserted by email; the password hash is re-applied so
   the documented credentials always work)
2. ten deterministic fixture tickets keyed by a stable `graphMessageId`, covering
   every state (`NEW`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`), every priority
   (`low`, `moderate`, `high`, `critical`), all four categories, and both
   assigned and unassigned tickets — seven of them carry comment threads and
   state history so the ticket detail/activity page has something to show
3. ~120 bulk randomised tickets for dashboard volume (skipped when already present)

Demo requesters all use obviously fictional `@demo.example` addresses.

## The UI

- **Dashboard** — total open / new / in progress / unassigned / critical,
  breakdowns by priority, category, assignment group and agent workload,
  recently created tickets.
- **Tickets** — searchable table (ticket #, subject, requester, email,
  category, priority, status, group, agent, SLA, created, updated) with
  status/priority/category/group/agent filters and pagination.
- **Ticket detail** — properties panel, workflow actions (start, resolve with
  mandatory note, close, reopen), assign/reassign, group & priority changes,
  internal notes vs requester-facing updates, and a unified activity timeline
  (created, assignments, status changes, notes, resolution).
- **Agents** (admin) — create/edit agents, skill levels L1–L3, availability
  toggles, live workload; deactivation releases their open tickets.
- **Assignment Groups** — per-group capacity: active agents, open tickets,
  unassigned queue; routing rules stay configurable in
  `server/config/assignment.config.json`.
- **Simulate Email** (development only, hide with
  `VITE_ENABLE_EMAIL_SIMULATOR=false` before building for production) — submits
  to `POST /api/tickets/from-email` and shows classification/routing results.

The frontend contains **no business logic**: validation, transitions,
assignment, workload, permissions and audit logging all happen in the API and
errors are surfaced verbatim in the UI.

## Tests

```bash
cd server
npm test            # ingestion suite (33 checks) + API suite (49 checks)
npm run test:e2e    # full user-journey scenario incl. edge cases (34 checks)
```

`test:e2e` boots a real server and walks the complete workflow: create agents
across groups with different skills → simulated email → verify number,
classification, routing and engine assignment → dashboard visibility →
IN_PROGRESS → internal note → requester update → resolve-without-note rejected
→ resolve → close → invalid transitions rejected → full audit trail →
duplicate messageId idempotency → reassignment → priority/SLA recalculation →
no-available-agent awaiting path → SPA served.

## Microsoft 365 / Microsoft Graph

Register an Entra ID app with application permissions `Mail.ReadWrite` +
`Mail.Send`, then fill `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET`, `GRAPH_SHARED_MAILBOX`, `GRAPH_BROADCAST_DL` in
`server/.env`. Missing credentials are never fatal — the API, frontend and
simulated-email endpoint keep working with Graph off.

### Two ingestion mechanisms, one pipeline

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

### Webhook configuration

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
