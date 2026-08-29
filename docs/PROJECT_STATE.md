# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-08-29_

## Current Phase

Client UI redesign — second pass, working toward the supplied reference
composition. **Uncommitted work in the working tree.** Frontend only: the
backend, the database and every API are untouched (`git status -- server/` is
clean and `dev.db` is byte-for-byte unchanged).

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
- Client shell: navigation rail + application header + workspace

## In Progress

Nothing in flight. The client work is finished but **uncommitted**.

Modified but not committed:

- `client/src/App.jsx`, `client/src/index.css`, `client/src/components/ui.jsx`
  and 9 screen components
- New: `client/src/pageHeader.js`, `client/src/components/TopBar.jsx`,
  `client/src/components/NotificationBell.jsx`
- Untracked helpers: `client/live-check.mjs`, `client/ssr-check.mjs` — both are
  **stale**: their `document` mock no longer satisfies React 18, so they fail
  before evaluating the bundle. Replaced in practice by the jsdom check
  described under Last Verified.

What the second pass changed:

- **Application header.** Page title/subtitle, global search (Ctrl-K over
  tickets, people and categories), appearance, notifications and the account
  menu. Each of those controls now exists exactly once.
- **Page titles** move to the header via `usePageHeader` (`src/pageHeader.js`).
  The shell renders a per-route default; a screen overrides it when it knows
  better (live queue count, ticket number). Screens no longer draw their own
  `h1`.
- **Dashboard** rebuilt to the reference composition: five KPI cards, a
  full-width Recent Tickets table (ID / Subject / Requester / Status /
  Priority / Assigned to / Age), Priority / Category / Group meters, Agent
  Workload, and a right utility rail (Quick Actions, System Status, My Stats).
- **Hash routing takes a query string** — `#/tickets?agentId=4`,
  `?agentId=unassigned`, `?category=Software` — so a link can carry queue
  filters. Only keys the queue already filters on are honoured.
- **Navigation rail collapses** to an icon rail (persisted in `td_sidebar`) and
  collapses automatically below 900px.
- **Notifications moved** out of the sidebar availability switch into the
  header bell (`NotificationBell.jsx`); the sidebar control is now availability
  only.
- Ctrl-K belongs to the global header search; the Tickets filter field took
  `/`.

To finish: commit.

## Next

Not started, no order committed to:

1. Verify Microsoft Graph against live credentials
2. Introduce Prisma migrations
3. Retire or repair `client/live-check.mjs` / `client/ssr-check.mjs` — the jsdom
   harness supersedes them

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

- **The Agents table needs horizontal scrolling** at ~1440px to reach the row
  actions. It no longer clips them, but the column layout should be tightened
  when that screen is redesigned. The narrower rail buys back ~180px; the
  column widths themselves are still untouched.
- **The dashboard KPI cards carry no trend line.** The reference design shows a
  sparkline per figure; nothing in this system stores history, so the slot
  carries the figure's real share of the open queue instead. Restoring a trend
  line means storing snapshots first — a backend change, deliberately not made.
- **Microsoft Graph has never run against live credentials.** Auth, mailbox
  access and subscription renewal are verified only against mocks.
- **Background workers run in every server process.** The rebalancer and the
  handover expiry sweep are safe under concurrency but wasteful with more than
  one instance; a real deployment wants a single worker or leader election.
- **No `migrations/` directory.**
- One ambiguous ticket kept deliberately: `INC-000724` "PC is overheating", from
  a real gmail address via the email simulator. Delete it if it was only a test.

## Last Verified

**2026-08-29**, after the reference-led second pass of the client redesign:

- 63 browser checks pass in a jsdom harness driving the production bundle
  against a live API on a throw-away database: the shell, every KPI, the
  Recent Tickets columns, the utility rail, global search, the appearance menu
  in both directions, theme persistence, notifications, the account menu,
  sidebar collapse and its persistence, all nine screens, link-borne queue
  filters and the sign-out path. **0 console errors.**
- `npx vite build` succeeds
- All 12 server suites pass — 1049 checks, 0 failures
- Backend untouched: `git status -- server/` clean, `dev.db` md5 unchanged
- No hardcoded colour remains outside the token blocks in `index.css`
  (`--on-solid` now drives filled buttons; the two toasts and the neutral tint
  became tokens)

Earlier checkpoints:

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

Then **2026-08-28**, after the Tickets queue and Ticket detail:

- 48 browser checks pass: queue filters, sorting, Ctrl-K, empty and loading
  states, detail layout, inspector fields, action hierarchy, activity kinds,
  both themes, and the responsive breakpoints — 0 console errors
- Activity timeline verified against a temporary six-event fixture ticket
  (created, assigned, started, internal note, requester update, resolved),
  which was deleted afterwards
- Backend untouched; 12 suites still pass; client build succeeds

Then **2026-08-28**, after the polish pass:

- 129 browser checks pass (40 quality gate + 41 theme + 48 queue/detail),
  0 console errors
- All text meets WCAG AA in both themes; two token failures were found and
  fixed (light `--success` at 4.06:1, dark `--muted-2` at 4.45:1)
- No horizontal page overflow at 1440 / 1280 / 1024 / 820 / 760px
- Backend untouched; 12 suites pass; build succeeds
