# TicketDesk — IT Helpdesk Ticketing System

Production-ready internal helpdesk for the IT department. Employees raise requests
by email; the configured Microsoft 365 or IMAP ingestion path turns each message
into a ticket, classifies it, routes it, assigns an agent and tracks it to
resolution.

```text
Employee sends email          (Microsoft 365 forwarding → Gmail → IMAP poller)
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
| Database | **PostgreSQL** via Prisma — Supabase in production (`DATABASE_URL` / `DIRECT_URL`); disposable local cluster for tests |
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
npm run db:deploy                     # apply the committed Prisma migrations
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
INITIAL_ADMIN_EMAIL=admin@example.com
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

A ticket's skill requirement comes from the **routing rule** that governs it,
never from its category alone: a rule may name a minimum skill, the priority
adds a boost (`high` +1, `critical` +2, capped at L3), and the ticket screen
prints that figure together with the rule that decided it. Software is
first-line work — its catch-all rule asks for L1, and only `Software (Advanced)`
wording (a crash, an error code, data loss, a deployment, an integration) asks
for L2. An installation seeded before that policy keeps its old rule rows,
because seeding never overwrites edited rules; bring it in line explicitly:

```bash
npm run db:relevel-software            # report what would change (dry run)
npm run db:relevel-software -- --apply # write it (audited; no ticket row changes)
```

See [`docs/assignment-groups-and-routing.md`](docs/assignment-groups-and-routing.md).

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
  status/priority/category/group/agent filters, multi-select, bulk priority /
  category / group changes, and pagination.
- **Ticket detail** — properties panel, workflow actions (start, resolve with
  mandatory note, close, reopen), assign/reassign, group & priority changes,
  internal notes vs requester-facing updates, and a unified activity timeline
  (created, assignments, status changes, notes, resolution).
- **Agents** (admin) — create/edit agents, skill levels L1–L3, availability
  toggles, live workload, **multi-group membership** (primary + up to 2 supporting
  groups shown with distinct badges); deactivation releases their open tickets.
- **Assignment Groups** — per-group capacity: active agents, open tickets,
  unassigned queue; create, edit and deactivate groups through the UI.

The frontend contains **no business logic**: validation, transitions,
assignment, workload, permissions and audit logging all happen in the API and
errors are surfaced verbatim in the UI.

## Tests

Plain Node scripts — no test framework. Each suite creates its own throw-away
PostgreSQL database on a disposable local cluster (one-time `npm run
test:pg:up`), runs against real Prisma queries, and cleans up after itself.
No suite ever touches the application database — or the vestigial
`server/prisma/dev.db`.

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
npm run test:resolution-confirm # requester resolution confirmation + auto-close
# … 43 suites total
```

`npm test` runs every suite in sequence. Each suite reports `PASS` / `FAIL`,
then exits with code 0 (all pass) or 1 (any fail).

## Documentation

`README.md` covers getting started. The detail lives beside it:

| Document | Covers |
|---|---|
| [`QUICKSTART.md`](QUICKSTART.md) | the short path: requirements, setup, first sign-in, tests |
| [`docs/users-and-roles.md`](docs/users-and-roles.md) | roles, permissions, the initial administrator, the audit trail |
| [`docs/ticket-lifecycle.md`](docs/ticket-lifecycle.md) | the state machine, who may do what, reassignment |
| [`docs/assignment-groups-and-routing.md`](docs/assignment-groups-and-routing.md) | groups, multi-group membership, routing rules and precedence |
| [`docs/workload-and-rebalancing.md`](docs/workload-and-rebalancing.md) | workload, unattended claiming, availability, rebalancing |
| [`docs/handovers.md`](docs/handovers.md) | handover offers, the pending queue, expiry, cancellation |
| [`docs/email-parsing.md`](docs/email-parsing.md) | the deterministic email-to-ticket pipeline |
| [`docs/email-relevance-triage.md`](docs/email-relevance-triage.md) | Groq relevance filtering, safety policy, monitoring and admin controls |
| [`docs/microsoft-graph.md`](docs/microsoft-graph.md) | Graph ingestion, polling, webhooks and the optional direct mailbox source |
| [`docs/credential-rotation.md`](docs/credential-rotation.md) | every credential, how to rotate it, and the secret-scanning controls |
| [`AGENTS.md`](AGENTS.md) | architecture and conventions, for contributors |
| [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) | the live checkpoint — current phase, known issues |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | major implementation milestones |

## Scope and limitations

This is the IT helpdesk for a single organisation — one department, not a
multi-tenant service. Accounts are created by an administrator; there is no
self-service sign-up.

- **Microsoft Entra ID sign-in is not implemented.** Sign-in is a local password
  only; the seam for it (`provisionUserFromIdentity`, `Agent.externalId`) exists
  but nothing calls it yet.
- **Microsoft Graph has never run against live credentials.** Polling, webhooks
  and subscription renewal are written and tested against mocks; the live
  deployment currently uses the Microsoft 365-to-Gmail forwarding and IMAP path.
- **Attachments are metadata only** — no file is stored anywhere.
- **Classification and routing remain deterministic.** The optional Groq
  relevance filter only decides whether a new message is safe to suppress from
  ticket creation; it never chooses category, priority, assignment group, or
  agent, and it is disabled by default.
- **Background jobs run in every server process.** Safe, but wasteful if you
  ever run more than one instance.
