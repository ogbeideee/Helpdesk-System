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
| API      | Node.js + Express, **CommonJS** (`require`, not ESM) |
| Database | **SQLite** locally (`server/prisma/dev.db`) via Prisma; **PostgreSQL** on Supabase in production |
| Frontend | React 18 + Vite SPA (served by the API in production) |
| Routing  | Hash-based (hand-rolled `parseHash()` in `App.jsx`) — no react-router |
| Auth     | JWT sessions (bcrypt-hashed passwords) |
| Deployment | Fly.io (`fly.toml`, Docker build) |

## Run the complete system locally

```bash
# --- one-time server setup -------------------------------------------
cd server
copy .env.example .env               # or get the real .env from the project owner
npm install
npm run db:push                       # apply schema to the SQLite database
npm run db:init                       # seed groups + routing rules + admin bootstrap

# --- run backend (terminal 1) ----------------------------------------
cd server
npm run dev                           # API on http://localhost:4000

# --- run frontend (terminal 2) ---------------------------------------
cd client
npm install
npm run dev                           # UI on http://localhost:5173 (proxies /api)

# --- production mode instead -----------------------------------------
cd client && npm run build            # builds client/dist
cd ../server && npm start             # single server serves app + API on :4000

# --- deploy to Fly.io ------------------------------------------------
fly deploy                            # builds Docker image, deploys to https://app-name.fly.dev
fly ssh console -C "node /app/server/scripts/init-db.js"  # seed groups + admin on a fresh deploy
```

## Troubleshooting

### "Unknown field 'slaCycles' for include statement on model 'Ticket'"

The generated Prisma Client (`node_modules/.prisma/client`) was built from an
older schema. The client is **not** rebuilt automatically when
`server/prisma/schema.prisma` changes — a `git pull` alone is not enough.

```bash
cd server
npm run db:generate
```

(`npx prisma generate` is equivalent; on some Windows setups the PowerShell
execution policy blocks `npx` — `npm run` always works.)

then restart the API. Run the same command after every pull that touches
`server/prisma/`. The API checks this at startup now and exits with these
instructions instead of serving 500 errors.

If `prisma generate` fails with `EPERM ... query_engine-windows.dll.node`, the
dev server is still running and holding a file lock — stop it first.
OneDrive-synced project folders can cause the same lock; keeping the clone
outside OneDrive avoids it.

## First sign-in

There are no built-in accounts and no default passwords. The first
administrator comes from `INITIAL_ADMIN_EMAIL` in `server/.env`:

```env
INITIAL_ADMIN_EMAIL=dogbeide@bestaftechnologies.com
```

At startup, **only while no active administrator exists**, that address is
promoted (or provisioned) as ADMIN. Once one administrator exists the mechanism
is inert — changing the value can never mint a second one. Any administrator can
then promote others, and the last remaining administrator can be neither
demoted nor deactivated.

The bootstrapped account is created **without a password**. Set one from
**Admin → Agents**, or connect the identity provider. Everyone else is added
the same way: Admin → Agents → New agent.

## Adding your team

`npm run db:init` creates the six assignment groups and the default routing
rules, and **no agents at all** — populating a real helpdesk with invented
staff would corrupt routing and workload figures. Add real people through
**Admin → Agents**, giving each one a primary group, an optional supporting
group (up to 2 additional), and a skill level (L1 junior / L2 mid / L3 senior).
Supporting members receive only low/moderate priority tickets in their
non-primary groups. Until at least one agent exists in a group, tickets routed
there are created unassigned and shown as *awaiting assignment*.

## Development demo data (optional)

`npm run seed:demo` generates a fictional dataset — three demo logins, ten
fixture tickets and ~120 bulk tickets — so a fresh developer machine has
something to look at. It is **opt-in and never runs on startup**:

```bash
npm run seed:demo -- --confirm   # generate the demo dataset
npm run seed:demo -- --clear     # remove it again
npm run db:purge-demo            # report every demo record in the database
npm run db:purge-demo -- --apply # remove them
```

It refuses to run without `--confirm`, and refuses again when
`NODE_ENV=production`. Demo requesters use obviously fictional `@demo.example`
addresses and demo logins a fictional company domain, so `db:purge-demo` can
identify them exactly. The demo passwords live in
`server/scripts/seed-demo.js` and are printed when the seed runs — they are
deliberately not documented here, in the UI, or in any configuration file.

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
  toggles, live workload, **multi-group membership** (primary + up to 2 supporting
  groups shown with distinct badges); deactivation releases their open tickets.
- **Assignment Groups** — per-group capacity: active agents, open tickets,
  unassigned queue; create, edit and deactivate groups through the UI.
- **Simulate Email** (development only, hide with
  `VITE_ENABLE_EMAIL_SIMULATOR=false` before building for production) — submits
  to `POST /api/tickets/from-email` and shows classification/routing results.

The frontend contains **no business logic**: validation, transitions,
assignment, workload, permissions and audit logging all happen in the API and
errors are surfaced verbatim in the UI.

## Tests

Plain Node scripts — no test framework. Each suite creates its own throw-away
SQLite database, runs against real Prisma queries, and cleans up after itself.
No suite ever touches `server/prisma/dev.db`.

Run individual suites during development:

```bash
cd server
npm run test:assignment-pool    # group pool, availability state, eligibility
npm run test:routing            # routing rules + preview
npm run test:assignment-groups  # multi-group membership (max 3, leads)
npm run test:workload           # workload, claiming, rebalancing
npm run test:handover           # handover lifecycle
npm run test:api                # HTTP endpoints
npm run test:e2e                # full end-to-end workflow
npm run test:sla                # SLA cycle tracking
npm run test:lifecycle          # ticket state machine
npm run test:users              # role management
# … ~30 suites total
```

`npm test` runs every suite in sequence. Each suite reports `PASS` / `FAIL`,
then exits with code 0 (all pass) or 1 (any fail).

## Users, roles and administrators

There is one user table for the whole product (`Agent` - the historical name).
No second user system.

| Role | Can sign in | Receives tickets | Manages users |
|---|---|---|---|
| `USER` | yes | **no** | no |
| `AGENT` | yes | yes | no |
| `ADMIN` | yes | yes | yes |

Stored values are lower-case (`user` / `agent` / `admin`). Anyone signing in for
the first time becomes **AGENT** - there is no code path that yields ADMIN on a
first sign-in. Nobody can change their own role, and only an ADMIN can change
anyone else's.

Two independent flags:

- **`isActive`** - the account is enabled. An inactive account cannot sign in
  and never receives tickets, not even from an admin.
- **`isAvailable`** - currently accepting new work. An agent on leave stays
  active but unavailable; an admin may still assign to them deliberately.

`externalId` / `externalProvider` are ready for Microsoft Entra ID.
**Entra authentication is not implemented** - `provisionUserFromIdentity()` in
`src/services/userService.js` is the seam it will use.

### Initial administrator

The first administrator cannot be created through the admin API, because that
API requires an administrator. `INITIAL_ADMIN_EMAIL` closes that gap exactly
once:

```env
INITIAL_ADMIN_EMAIL=dogbeide@bestaftechnologies.com
```

At startup, **only while there are zero active administrators**, that account is
promoted to ADMIN (or provisioned without a password if it does not exist yet).
As soon as one administrator exists the mechanism is inert - re-running it, or
re-pointing the variable at somebody else, can never mint a second admin. The
server logs which happened:

```text
[users] administrator bootstrap inert (3 administrator(s) already exist)
```

The address lives in configuration only; it appears in no business logic.

### Administrator management

There is **no permanent "super admin"**. Every ADMIN has identical rights,
including over other admins: any admin can promote an AGENT, demote another
ADMIN, and manage accounts. The initial administrator is not special once
others exist.

One invariant is enforced: **at least one active administrator always remains.**
The final admin can be neither demoted (`409`) nor deactivated (`409`), and no
one can change their own role or deactivate their own account (`403`).

An ADMIN can view users, provision agents, activate/deactivate, change
assignment group, skill level and availability, and promote/demote. All of it
is enforced in `src/services/userService.js`, so calling the API directly gains
nothing over the UI - an AGENT or USER receives `403` from every admin route.

### Audit

`UserAuditLog` records user creation, role changes, activation/deactivation,
availability, assignment-group and skill-level changes, each with the actor and
a timestamp. Read it at `GET /api/agents/:id/audit` (admin only). Ticket history
stays in `TicketAuditLog` - separate concerns, separate tables.

### Development accounts

The demo accounts are seeded only by `npm run seed:demo`, which refuses to run
when `NODE_ENV=production`. Nothing creates fake users automatically.

## Agent-to-agent handovers

A handover is an **offer**, not a move:

```
Agent A -> request handover -> Agent B -> accept / decline / suggest
```

The ticket keeps its owner, its status, its group and its SLA until the
recipient accepts. Nothing about a pending request counts toward anybody's
workload, because workload is counted from `Ticket.assignedAgentId` and only
`moveTicket` ever changes it.

### The three replies

| Reply | Effect |
|---|---|
| **Accept** | Ownership transfers immediately. The status is untouched, the previous agent is notified, and the handover stays in the ticket's history. |
| **Decline** | The ticket stays with the original agent. The history records "Handover declined by [name]", and they are free to ask somebody else. |
| **Suggest Another** | Declines, and shows the suggestion to the original agent. **No request is sent to the person named** - it stays the original agent's decision. |

Only one offer is outstanding per ticket at a time.

### Pending limit and the queue

A recipient holds at most **2** active requests (`handoverPendingLimit`).
Further requests are **QUEUED** in FIFO order; when a slot frees up - an
answer, a cancellation, an expiry, or an administrator raising the limit - the
oldest queued request is activated automatically and the recipient is notified.
Queue position is derived from insertion order rather than stored, so it can
never drift.

### Expiry

An unanswered request expires after `handoverExpiryMinutes` (default 24h). On
expiry it is marked **EXPIRED**, ownership stays where it was, and the original
agent is told.

The clock **pauses while the recipient is unavailable**: the deadline is
cleared and the remaining time banked, then restored when they are available
again, so time away never costs somebody a request. A paused request is
skipped by the sweeper by construction.

If the recipient is **deactivated** they cannot answer at all, so the request is
routed to another suitable available agent using the normal assignment rules
(never back to the agent who still owns the ticket). If nobody is suitable it is
cancelled and the original agent is told.

### Cancellation

The original agent can withdraw a pending or queued request before it is
answered; an administrator can cancel any. It is marked **CANCELLED** and kept
in the ticket's history, and - deliberately - **the recipient is not notified**.

Resolving or closing a ticket cancels any outstanding handover and records
that, leaving the ticket resolved or closed.

### History

Completed handovers are never deleted. `GET /api/tickets/:id/handovers` returns
the full chain oldest-first, and the ticket detail screen renders it:

```
Mr. Dare -> Sarah   declined
Sarah    -> John    accepted
```

Each row keeps the previous agent, the new agent, the timestamps and the result.

### Permissions (enforced on the backend)

| | AGENT | ADMIN |
|---|---|---|
| Request a handover | own tickets, own group only | any open ticket, anyone |
| Accept / decline / suggest | only requests sent to them | any request |
| Cancel | only requests they raised | any request |
| Override (force the transfer) | no | yes |
| Reassign directly | own tickets, own group | anyone |

The ownership rules are `assignmentPolicy.checkTarget`, unchanged - handovers
add no second permission model.

### Configuration

`handoverPendingLimit` and `handoverExpiryMinutes` are administrator-editable on
the Handovers screen and stored in the `Setting` table. `HANDOVER_PENDING_LIMIT`
and `HANDOVER_EXPIRY_MINUTES` supply the defaults for a fresh install;
`HANDOVER_SWEEP_INTERVAL_MS` controls the expiry sweep (`0` disables it).

### Concurrency

Every status change is a conditional update with the expected current status in
the WHERE clause, and the ownership move itself is `moveTicket`'s existing
compare-and-set. Two people cannot both accept the same handover, an accept
cannot race a cancellation, and queue promotion is idempotent - replaying it
simply finds no eligible row.

## Workload, unattended tickets and rebalancing

### Workload

Active workload is tickets an agent owns in **NEW** or **IN_PROGRESS**.
RESOLVED and CLOSED never count - the work is finished. A ticket mid-handover
counts for nobody until the move commits.

One definition (`OPEN_STATES`) backs the dashboard, the assignment engine and
the balancer, so every figure agrees. Exposed at `GET /api/workload` (everyone
plus the imbalance spread) and `GET /api/workload/me`.

### Unattended tickets

A **NEW** ticket becomes claimable by a teammate once it is
`UNATTENDED_CLAIM_HOURS` old (default **4**). The clock starts at creation and
runs whether or not the ticket is assigned.

| Situation | Before 4h | After 4h |
|---|---|---|
| Assigned to someone else | agent blocked (403) | eligible teammate may take it |
| Unassigned | teammate may take it | teammate may take it |
| Any state, ADMIN | may assign at any time | may assign at any time |

`POST /api/tickets/:id/take` (alias `/claim`) is the **Take Ticket** action.
Ownership changes immediately, the previous assignee gets an in-app and email
notification, and an audit entry records the handover. Ticket payloads carry
`unattended` and `hoursUntilClaimable`, so the UI shows the rule the backend
enforces rather than re-deriving it.

### Availability

`AVAILABLE` / `UNAVAILABLE` is `Agent.isAvailable`, separate from `isActive`.
Agents control their own at `POST /api/workload/availability`; an admin can
change anyone's through `PATCH /api/agents/:id`.

Going unavailable:

- **IN_PROGRESS work blocks it** (409). The response lists the tickets and where
  to find them - half-finished work is not silently handed on.
- **NEW tickets need confirmation** (409 with the list). On confirm they are
  reassigned by the normal algorithm.
- **No suitable replacement** leaves `assignedAgentId = null` with the
  assignment group intact. Tickets are never dropped.

An administrator can force an agent off even with work in progress, but it
takes an explicit `{ "force": true }` - the first attempt returns 409 naming
the flag. Everything open is then reassigned automatically.

**Deactivating** an agent reassigns all their NEW and IN_PROGRESS tickets the
same way. CLOSED tickets stay where they are.

### Previous-team recovery

Before reassignment, a ticket whose current group differs from its
`originatingTeamId` is returned to that original group, so the right team picks
it up. `originatingTeamId` itself is never modified.

### Rebalancing

A significant imbalance is a gap of **3 or more** open tickets
(`REBALANCE_THRESHOLD`). The balancer moves **one ticket, then recalculates**,
so a busy agent is drained gradually rather than dumped on the first idle
colleague.

What it moves, in order:

1. a NEW ticket in the receiving agent's own group
2. a NEW ticket from any group
3. an IN_PROGRESS ticket - only when the gap is still at or above the threshold
   and no NEW ticket qualifies

CLOSED tickets are never moved, and the receiving agent must meet the skill
level the routing rules require. Only agents who belong to an assignment group
take part: a team-less account would otherwise always look like the quietest
and attract every move.

Runs every `REBALANCE_INTERVAL_MS` (default 5 min; `0` disables), bounded by
`REBALANCE_MAX_MOVES` per cycle so it can never spin. An admin can trigger one
at `POST /api/workload/rebalance`, with `{ "dryRun": true }` to see the next
move without making it.

### Concurrency

Every ownership change goes through `moveTicket`, which uses a conditional
update with the expected current owner in the WHERE clause. If another worker
moved the ticket first, zero rows match and the caller is told, rather than
overwriting their decision. Two agents racing for the same ticket cannot both
win, replaying a stale move is a no-op, and the background balancer is safe
alongside live traffic. Overlapping cycles are also prevented by a guard.

### Notifications

An automatically moved ticket notifies the original agent **in-app**
(`Notification`, `GET /api/workload/notifications`) **and by email** through the
existing notification service, recording why it moved. The sidebar shows an
unread badge.

## Assignment groups and routing rules

### Assignment groups

An assignment group is an IT team (`Team` in the schema). Each has a name,
description, active flag and timestamps. Exactly one is the **default**:
`General IT Support`, which receives anything no rule claims.

| Group | Purpose |
|---|---|
| General IT Support | First-line support and triage. **Default.** |
| Accounts & Access | Accounts, passwords, MFA |
| Software & Applications | Desktop and LOB applications |
| Hardware & Devices | Laptops, peripherals, printers |
| Network Team | WiFi, LAN, VPN, routers |
| Field Operations | On-site installation: LAN cabling, router/switch setup, premises wiring (priority 30 routing rule) |

Groups can be created and edited by an admin at **Routing → Assignment Groups**.

### Multi-group membership

An agent belongs to exactly one **primary group** (`Agent.teamId`) and may
belong to up to **two additional supporting groups** via the `TeamMembership`
join table. Manage these at **Admin → Agents** → Edit → Supporting groups.

Supporting members receive only **low/moderate priority** tickets in their
non-primary groups — they appear as in-group candidates for the assignment
engine (not cross-team fallback). The threshold is configurable in
`config/assignment.config.json` (`supportingMaxPriority`).

An agent may lead multiple groups at once (lead status lives on the membership
row, not on the agent or the group). A group has exactly one lead.

### Routing rules

Rules are database rows an ADMIN edits at `/routing` (API: `/api/routing/rules`).
Each has a name, keywords, an optional category, a target group, an optional
preferred agent, an optional minimum skill, a priority and an active flag.

Matching is **deterministic string comparison** - no LLM, no network. Text is
lower-cased and stripped of punctuation, so `Wi-Fi`, `WiFi`, `WI-FI` and
`wi fi` all match the keyword `wifi`. Keywords match whole words, so `van` does
not match `advance`, and multi-word keywords match as phrases.

**Precedence.** Only active rules on active groups are considered. Among those
that match, the winner is decided by:

1. **`priority` ascending** - lower number wins. This is the administrator's
   explicit ordering and always dominates.
2. **Category-specific beats category-agnostic**, at equal priority.
3. **More matched keywords** wins - three matches is more specific than one.
4. **Longer matched keyword** wins - `docking station` beats `dock`.
5. **Lower id** - a stable tie-break so the result never depends on row order.

A rule with no keywords matches on category alone; one with neither is a
catch-all.

### Routing algorithm

Routing runs immediately on ticket creation:

```text
category classifier  ->  matching rule (or the default group)
      -> preferred agent, if active + available + sufficiently skilled + eligible
         (supporting members blocked for high/critical priority)
      -> else lowest open workload among primary + supporting members in the group,
         round-robin on ties
      -> else lowest workload ANYWHERE (cross-team fallback, respecting the
         supporting-member priority gate)
      -> else leave unassigned, group retained
```

The **cross-team fallback deliberately does not change the assignment group.**
A ticket can read `Assignment Group: General IT Support` while being worked by
someone from the Network Team - the group is who owns it, the assignee is who is
doing it. For high/critical tickets, the fallback also excludes supporting
members of the ticket's group.

Supporting members (agents whose primary team differs from the ticket's group)
are considered **in-group candidates** for low/moderate priority tickets, not
cross-team fallbacks — they appear in the assignment pool alongside primary
members of the same group.

Every decision is written to the ticket's audit trail, naming the rule that won
and the keywords it matched. Rule administration itself is audited separately in
`RoutingRuleAuditLog` (`GET /api/routing/audit`): created, updated, activated,
deactivated, deleted, with actor and timestamp. A deleted rule keeps its history.

`POST /api/routing/preview` shows what a description would route to without
creating anything - also available as the "Test a ticket description" box on the
Routing Rules screen.

Starter rules are seeded only when the table is empty, so administrator edits
are never overwritten. They contain no employee names; a preferred agent is
configured against a real account by an administrator.

## Ticket lifecycle and assignment

```text
NEW  ->  IN_PROGRESS  ->  RESOLVED  ->  CLOSED
```

A ticket can be reassigned at any point before it is CLOSED.

| Transition | How |
|---|---|
| NEW -> IN_PROGRESS | `POST /api/tickets/:id/start` ("Start working") |
| IN_PROGRESS -> RESOLVED | `POST /api/tickets/:id/resolve` - **a resolution note is required** |
| RESOLVED -> CLOSED | `POST /api/tickets/:id/close` |
| RESOLVED -> IN_PROGRESS | rework, via `POST /api/tickets/:id/status` |
| CLOSED -> anything | **rejected** |

**CLOSED is final.** No agent-driven transition leaves it. A closed ticket
returns only when the requester replies by email, which reopens it to
IN_PROGRESS and writes its own audit entry. That path deliberately bypasses
the transition map in `src/states.js`, so "final for people, reopenable by the
requester" lives in exactly one place.

Resolving records the resolution note, the resolving agent, `resolvedAt` and
the transition. Closing records the closing actor, `closedAt` and an audit
entry.

### Who may do what

All of it is enforced in `src/services/assignmentPolicy.js` and applied by
every route, so calling the API directly gains nothing over using the UI.

| Action | AGENT | ADMIN |
|---|---|---|
| Start / resolve / close | only tickets assigned to them | any ticket |
| Reassign | only their own ticket, **within their own group**, to an **available** teammate | any open ticket, **across groups**, may pick an unavailable agent |
| Change assignment group | no | yes |

An agent may not select themselves (they already hold the ticket), an
unavailable teammate, or anyone outside their assignment group. Availability is
the `Agent.isActive` flag - the one the Agents admin screen toggles.

### Reassignment

`GET /api/tickets/:id/assignment-candidates` returns each candidate with
availability, workload, skill level, group, and whether the caller may actually
select them. The UI renders that decision rather than re-deriving it:

```text
Current Assignment
Hardware Team · Jane Smith · 5 open

Reassign to:
(o) Sarah Smith    Senior · Available · 2 open tickets
( ) John Doe       Mid    · Available · 4 open tickets
( ) Michael Brown  Junior · Unavailable · 8 open tickets   <- not selectable
```

Available agents are listed first, then by lightest workload, so an unavailable
agent is never the default suggestion. A reassignment accepts an optional
reason and always writes an audit entry naming the previous agent, the new
agent, the group, the actor and the reason - the old assignment is preserved as
history, never overwritten:

```text
Reassigned from Jane Smith to Sarah Smith (Hardware & Devices, skill level 3)
  — Reason: Handing over due to shift change.
by Jane Smith · 27 Aug 2026, 10:42
```

### Assignment group changes (admin)

Changing the group validates that the group exists, records the previous and
new group, and **clears the assignee when they do not belong to the new
group** - a ticket is never left owned by someone from the wrong team. The
existing assignment engine then re-routes it automatically; pass
`autoAssign: false` to leave it in triage.

### Workload

Open workload counts tickets in **NEW** and **IN_PROGRESS** only.

- **CLOSED** never counts.
- **RESOLVED does not count.** The work is finished and the ticket is only
  awaiting closure, so counting it would make an agent look busier than they
  are and skew the assignment engine.

This is `OPEN_STATES` from `src/states.js`, the same definition the dashboard
and the assignment engine already use, so every workload number in the product
comes from one place. It is exposed on `/api/dashboard` (`ticketsPerAgent`) and
on the assignment-candidates endpoint.

### Activity timeline

The ticket detail timeline distinguishes creation, assignment, reassignment,
group change, status changes, internal notes, requester updates, resolution,
closure and reopening - each with its own icon and styling.

## Email parsing layer

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

### Normalized email

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

### Development endpoint

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

### Ingestion endpoint

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

## Microsoft 365 / Microsoft Graph

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

### Graph adapter

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

### Safe connectivity check

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

### Ingestion safety

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

### Polling behaviour

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
