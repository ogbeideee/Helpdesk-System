# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-08-28_

## Current Phase

Client UI redesign, continuing M3's first pass. **Uncommitted work in the
working tree.** Frontend only — no backend, database or API change.

Done this session: application-wide theme system (light/dark/system) with a
control in the nav rail, sidebar refinements, and Recent Tickets promoted to a
full-width lead section on the dashboard.

## Completed

- Email parsing → ticket pipeline (deterministic, no LLM)
- Microsoft 365 shared-mailbox ingestion: polling + change-notification webhooks
- Ticket lifecycle and reassignment authorization
- Production users, roles and initial-admin bootstrap
- Configurable routing rules, assignment groups and skill levels
- Workload, unattended-ticket claiming and automatic rebalancing
- Agent-to-agent handovers
- Demo-data removal and move to a real installation
- Per-suite test database isolation

## In Progress

Client redesign. Remaining areas, not yet started: Tickets list, Ticket detail,
Handovers, Agents, Routing Rules, Assignment Groups, Login.

Modified but not committed:

- `client/src/index.css` and 11 components under `client/src/components/`
  (`App.jsx`, `Dashboard`, `TicketsPage`, `TicketDetail`, `TicketForm`,
  `AgentsPage`, `GroupsPage`, `RoutingPage`, `HandoversPage`, `Login`,
  `SimulateEmailPage`)
- Untracked helpers: `client/live-check.mjs`, `client/ssr-check.mjs` — SSR/
  hydration checks that catch the "Rendered more hooks than during the previous
  render" class of bug

To finish: confirm each screen renders with no console errors, run
`npx vite build`, run the full suite, then commit.

## Next

Not started, no order committed to:

1. Continue the redesign screen by screen (Tickets list next)
2. Fix the Agents edit-dialog password autofill bug (see Known Issues) — small
   and it is actively corrupting passwords
3. Verify Microsoft Graph against live credentials
4. Introduce Prisma migrations

## Important Decisions

- **SQLite + `prisma db push`**, no migrations directory. `prisma migrate dev`
  would reset the database.
- **`Team` is the assignment group; `Agent` is every account** (roles `user` /
  `agent` / `admin`). Historical table names, deliberately not renamed.
- **Business rules live in services, never in routes or the frontend.** The UI
  renders backend decisions; it never re-derives a rule.
- **All ownership changes go through `workloadService.moveTicket`** — one
  compare-and-set, so background workers and live traffic cannot collide.
- **A handover is an offer.** Ownership moves only on accept, so a pending
  request counts toward nobody's workload.
- **Workload = `NEW` + `IN_PROGRESS`**, one definition shared by the dashboard,
  the assignment engine and the balancer.
- **No LLM in routing, classification or parsing** — deterministic keyword rules.
- **Tests own their database** (`server/scripts/lib/testdb.js`). A full run must
  leave `dev.db` untouched.
- **One component implementation, tokens only.** Themes swap CSS variable
  values; no component is written twice. The pre-paint inline script in
  `client/index.html` is what makes that flash-free.
- **`INITIAL_ADMIN_EMAIL` is configuration, not business logic** — no address is
  hardcoded, and a test asserts that.

## Known Issues

- **Agents edit dialog lets the browser autofill the password field**, which is
  then PATCHed — it silently changes an agent's password. Needs
  `autoComplete="new-password"` and to send `password` only when typed. This has
  already corrupted one account.
- **The Agents table needs horizontal scrolling** at ~1440px to reach the row
  actions. It no longer clips them, but the column layout should be tightened
  when that screen is redesigned.
- **Microsoft Graph has never run against live credentials.** Auth, mailbox
  access and subscription renewal are verified only against mocks.
- **Background workers run in every server process.** The rebalancer and the
  handover expiry sweep are safe under concurrency but wasteful with more than
  one instance; a real deployment wants a single worker or leader election.
- **No `migrations/` directory.**
- One ambiguous ticket kept deliberately: `INC-000724` "PC is overheating", from
  a real gmail address via the email simulator. Delete it if it was only a test.

## Last Verified

**2026-08-28**, after the demo cleanup:

- All 12 test suites pass — 1049 checks, 0 failures
- `npx vite build` succeeds
- App starts; `dogbeide@bestaftechnologies.com` signs in as `admin`
- No demo credentials in the UI, README, `.env.example` or built assets
- `General IT Support` exists, active, and is the default fallback group
- A full test run left `dev.db` byte-for-byte unchanged

Then **2026-08-28**, after the theme work:

- 41 browser checks pass: both themes on all 7 screens, persistence across
  reload, system-preference tracking, no flash, 0 console errors
- All text tokens meet WCAG AA (muted text was below it in both themes)
- Backend untouched — `git status -- server/` is clean; 12 suites still pass

**Not yet verified:** the six screens still to be redesigned.
