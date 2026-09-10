# AGENTS.md

Durable project knowledge. Read this and `docs/PROJECT_STATE.md` at the start of
a session, then open only the source files the current task needs.

`README.md` (~890 lines) is the long-form manual — link to it, don't duplicate it.
The **codebase is the source of truth for implementation**; this file is the
source of truth for architecture and conventions.

---

## Purpose

Internal IT helpdesk ticketing system for one organisation. Employees raise
requests by email; the system creates tickets, classifies and routes them,
assigns an agent, and tracks them to resolution. Runs fully locally with no
Microsoft 365 credentials — a built-in email simulator stands in for Graph.

## Stack

| Layer | Technology |
|---|---|
| API | Node.js + Express, **CommonJS** (`require`, not ESM) |
| Database | **SQLite** via Prisma — `server/prisma/dev.db` |
| Frontend | React 18 + Vite SPA, served by the API in production |
| Routing (UI) | **Hash-based**, hand-rolled — no react-router. `parseHash()` in `client/src/App.jsx` |
| Auth | JWT sessions, bcrypt password hashes |
| Tests | Plain Node scripts, no test framework |

## Layering rule

Business rules live in `server/src/services/`. Routes validate input, authorise
the caller and shape the response — they never define a rule. The frontend only
*reflects* decisions the backend already made (e.g. `selectable` flags on
assignment candidates). **An agent must not be able to bypass a rule by calling
the API directly.**

## Theming

One set of component rules; **only token values change between themes**. Never
write a second implementation of a component for light mode.

- `:root` = dark palette, `:root[data-theme="light"]` = light. Same token names.
- `<html data-theme>` is stamped by an inline script in `client/index.html`
  **before first paint** — that is what prevents a flash of the wrong theme.
  `src/theme.js` mirrors that logic; change both together.
- Preference is `light` / `dark` / `system`; only an explicit choice is stored
  (`localStorage` key `td_theme`), so `system` keeps following the OS.
- Any new colour must come from a token. Seeded avatars set `--avatar-h` only;
  saturation and lightness are theme tokens.

## Major modules

**Services** (`server/src/services/`)
| File | Owns |
|---|---|
| `userService.js` | Roles, initial-admin bootstrap, last-admin protection |
| `assignmentPolicy.js` | Who may assign what, to whom (`checkTarget`, `listCandidates`) |
| `assignmentEngine.js` | Picks the agent: `decide()` → group + skill, `assign()` → agent |
| `routingService.js` | Keyword rule matching and precedence |
| `defaultRoutingRules.js` | The 6 starter rules, seeded when none exist |
| `workloadService.js` | Workload, unattended claiming, `moveTicket`, rebalancing |
| `handoverService.js` | Handover offers, queue, expiry, reroute |
| `settingsService.js` | Admin-configurable values (`Setting` table, env defaults) |
| `ticketIntake.js` / `emailIngestion.js` | Email → ticket pipeline |

**Other** — `src/states.js` (lifecycle), `src/teams.js` (assignment groups),
`src/mailer.js` (the *only* notification sender), `src/email/` (deterministic
parser), `src/graph/` (M365), `src/authMiddleware.js`.

**Routes** (`server/routes/`) — `auth, tickets, agents, routing, workload,
handovers, dashboard, stats, webhooks, dev`.

**Client** (`client/src/components/`) — one component per screen plus
`ui.jsx` (shared primitives: `Modal`, `Spinner`, `EmptyState`, `Icon`,
`usePopover`, `useToast`, …). Import from `ui.jsx` rather than rebuilding;
`Icon` is the only icon set, so no screen inlines its own SVG.

**Client shell** — `App.jsx` renders a navigation rail plus `TopBar.jsx`
(the application header) around the routed screen. Anything that acts on the
product as a whole — global search, appearance, notifications, the account
menu — lives in the header and lives there **once**; the rail carries
navigation, availability and identity only.

**Page titles** come from the header, not the screen: `App.jsx` holds a
per-route default and a screen overrides it through `usePageHeader`
(`src/pageHeader.js`) when it knows better — a live queue count, the ticket
number. No screen draws its own `h1`.

**Hash routing takes a query string** — `#/tickets?agentId=4`,
`?agentId=unassigned`, `?category=Software` — so a link can carry queue
filters. `parseHash()` splits it off before matching the path, and only keys
the queue already filters on are honoured.

## Database

- `npx prisma db push` only. **There is no `migrations/` directory** — never run
  `prisma migrate dev`, it would reset the database.
- Regenerating the client fails while a dev server holds the query engine DLL
  (Windows `EPERM`): stop the API first.
- Models: `Team` (= assignment group), `Agent` (= every user, any role),
  `Ticket`, `Comment`, `TicketAuditLog`, `UserAuditLog`, `RoutingRule`,
  `RoutingRuleAuditLog`, `Notification`, `HandoverRequest`, `Setting`,
  `TicketSequence`, `GraphSubscription`.
- Historical names: `Team` is the **assignment group**; `Agent` is **every
  account**, including `user` and `admin` roles.

## Business rules

**Lifecycle** — `NEW → IN_PROGRESS → RESOLVED → CLOSED`, plus
`RESOLVED → IN_PROGRESS` rework. `CLOSED` is final for people; only a requester
email reply reopens it, via `ticketIntake.js`, which deliberately bypasses
`canTransition`.

**Roles** — `user` (no tickets), `agent`, `admin`. First sign-in yields `agent`.
Nobody changes their own role. **At least one active admin always remains** — the
last one can be neither demoted nor deactivated. The first admin comes from
`INITIAL_ADMIN_EMAIL`, and only while zero active admins exist.

**Workload** = tickets owned in `NEW` or `IN_PROGRESS` (`OPEN_STATES`).
`RESOLVED`/`CLOSED` never count. One definition backs the dashboard, the
assignment engine and the balancer.

**Unattended claiming** — a `NEW` ticket becomes claimable by a teammate after
`UNATTENDED_CLAIM_HOURS` (default 4). Admins are exempt.

**Rebalancing** — moves one ticket at a time, then recalculates. Only agents who
belong to an assignment group take part (a team-less admin would otherwise always
look quietest).

**Handovers are offers** — the ticket keeps its owner, status, group and SLA
until the recipient accepts, so a pending request counts toward nobody's
workload. Default 2 active per recipient, then a FIFO queue. Expiry pauses while
the recipient is unavailable.

**Routing precedence** — priority asc → category-specific over agnostic → more
matched keywords → longer keyword → lower id. Matching is deterministic and
punctuation/case-insensitive. **No LLM anywhere in routing or parsing.**

**Concurrency** — every ownership change goes through
`workloadService.moveTicket`, a compare-and-set (`updateMany` with the expected
current owner in the `WHERE`). Handover status changes use the same pattern.
Reuse it; do not write a bare `update` for ownership.

## Constraints

- Never hardcode credentials. Never expose a client secret or access token to
  the frontend. Never log tokens, secrets or full email bodies.
- No demo data on startup. `seed:demo` requires `--confirm` and refuses under
  `NODE_ENV=production`.
- Notifications go through `src/mailer.js` and the `Notification` table. Do not
  build a second notification system.
- Four ticket categories are fixed: `Password Reset`, `Inquiry / Help`,
  `Software`, `Hardware`.
- Tests must never touch `server/prisma/dev.db` — see below.

## Commands

```bash
npm run dev                  # root: API :4000 + UI :5173 via concurrently
cd server && npm test        # all 12 suites (~1050 checks)
cd server && npm run test:handover   # one suite — prefer while developing
cd client && npx vite build  # production build
cd server && npm run db:push # apply schema changes
cd server && npm run db:init # groups + routing rules + admin bootstrap
cd server && npm run db:purge-demo   # dry run; --apply to remove demo data
```

Shell is **PowerShell / Git Bash on Windows**. Heredocs break on JSX and
backticks — write a Python patch script to the scratchpad instead.

## Test isolation

Every DB-touching suite starts with `require('./lib/testdb').use('<name>')`
**before any Prisma import**. That points `DATABASE_URL` at a throw-away
`prisma/test-<name>.db`, pushes the schema, and deletes it afterwards. A full
run leaves `dev.db` untouched. Suites create their own fixtures — never assume
seeded accounts exist.

## Intentionally NOT implemented

- **Microsoft Entra ID authentication.** The seam exists
  (`provisionUserFromIdentity`, `Agent.externalId/externalProvider`) but nothing
  calls it. Sign-in is local password only.
- **Live Microsoft Graph verification.** Polling, webhooks and subscription
  renewal are written and tested against mocks; they have never run against real
  Microsoft credentials.
- **Attachment storage.** Attachments are parsed as metadata only — no file is
  stored anywhere.
- **Supabase / Firebase.** Not used. SQLite is the database.
- **Prisma migration history is minimal.** `server/prisma/migrations/` holds
  one baseline migration for the assignment-group membership change. Day-to-day
  schema changes still go through `db push`; `prisma migrate dev/reset` is
  deliberately unused because it can reset the database. For `db push`-updated
  databases, `npm run db:migrate-assignment-groups` re-creates the partial
  unique index Prisma cannot express on SQLite.

## Known issues

See `docs/PROJECT_STATE.md` — that file is the live list.
