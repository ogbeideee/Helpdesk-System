# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-09-10_

## Current Phase

**The client UI is finished and signed off.** The redesign, the light/dark
theme and the reference-led visual polish are all complete, committed
(`7ae07c3` on `ui-polish`) and **approved as the baseline**.

No UI work is in flight, and none is planned. The next phase is backend:
Microsoft Graph against live credentials, then Prisma migrations.

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
- **Client UI redesign — complete.** Every screen: dashboard, tickets queue,
  ticket detail, handovers, agents, routing rules, assignment groups, simulate
  email, sign-in.
- **Light / dark theme — complete.** One component implementation, tokens only;
  `light` / `dark` / `system`, flash-free before first paint, WCAG AA text in
  both palettes, and no hardcoded colour outside the token blocks.
- **Reference-based visual polish — complete.** Application header (title,
  global search, appearance, notifications, account), five-card KPI row,
  operational Recent Tickets table, metered breakdowns, right utility rail,
  collapsible navigation rail, one card language across the product.
- **Assignment-group membership model (database layer) — complete.** New
  `TeamMembership` join table (agentId, teamId, isLead) as the source of
  truth for multi-group membership. Rules: max 3 groups per agent, exactly
  one lead per group (partial unique index + transactional service logic),
  a lead must be a member, leading never grants ADMIN. The effective group set is deduplicated (`getEffectiveGroupIds` / `countEffectiveGroups`):the legacy `Agent.teamId` counts toward the max-3 but is never counted twice. Legacy single-group
  `Agent.teamId` data was migrated through the new baseline migration
  (`server/prisma/migrations/…_add_assignment_group_memberships`) and the
  idempotent runner `npm run db:migrate-assignment-groups`. Focused suite:
  `npm run test:assignment-groups`. `Agent.teamId` is retained as a
  transition field for this phase only.

## In Progress

No active work in flight. The next phase (not started): wire a chosen AI
classifier into the new production seam, then flip routing / workload / UI
over to `TeamMembership` and drop the legacy `Agent.teamId` column.

## Completed This Session (2026-09-10)

- **AI classifier seam — complete.** `ticketIntake.js` gains an injectable
  `options.classifier` that receives `{subject, body, cleanBody, text}`.
  Defaults to the existing keyword classifier; falls back to it when an injected
  classifier returns no usable category. `cleanBody` (quote/signature-stripped)
  flows from the email parser through `emailIngestion.js` to the classifier.
  Parsing-rule fields still win per-field over any classifier.
- **AI benchmark framework — complete.** 20 frozen test cases (A–T) spanning
  the four categories with adversarial traps, provider adapters for Gemini and
  Groq/Qwen (OpenAI-compatible), JSON extraction / schema validation / per-case
  scoring / terminal report / JSON export / self-contained HTML comparison
  charts. `--mock` mode runs the identical pipeline with zero network access.
  124 focused-suite checks enforce correctness (test-classifier-seam.js:
  52 checks; test-ai-benchmark.js: 72 checks). Both pass.
- **Prisma client freshness guard — added.** `server.js` now validates at boot
  that the generated Prisma Client matches `schema.prisma` — exits with fix
  instructions instead of serving 500 errors.
- **Vercel/serverless deployment prep — complete.** `server.js` refactored to
  extract `bootStartupChecks()` and `startBackgroundJobs()`, with server
  listener and all 7 background timers gated behind `if (require.main ===
  module)`. Module exports `{ app, startBackgroundJobs, bootStartupChecks }`
  so a hosting platform can mount the Express app without starting the
  listener or background jobs. `package.json` converted to npm workspaces
  (`"workspaces": ["client", "server"]`), adding a root `build` script.
  `testdb.js` `PRISMA_CLI` resolution made resilient to workspace hoisting.
  All 35 test suites pass (2 pre-existing IMAP env config failures unchanged).
  Client `npm run build` succeeds.
- All committed as `6c045eb` on `ui-polish`.
- **Fly.io deployment prep — complete.** Added root `start` script (`node server/server.js`), `Dockerfile`, `.dockerignore`, and `fly.toml` (256MB shared VM, port 4000, HTTPS forced). `npm run build` + `npm start` verified locally.

## Next

Not started, no order committed to:

1. Verify Microsoft Graph against live credentials
2. **Wire a classifier into the seam.** The `options.classifier` seam is in place
   and defaulting to the keyword rules; the AI benchmark (Gemini / Groq+Qwen vs
   the keyword baseline) can pick a provider, but none is wired into production yet —
   nothing reads `GEMINI_API_KEY` / `GROQ_API_KEY` outside the benchmark.
3. **Flip the assignment-group readers over to `TeamMembership`.** Routing,
   workload, the Agents/Assignment-Groups APIs and the UI should read/write
   multi-group membership (max 3, per-group leads) through
   `groupMembershipService`, then the transition field `Agent.teamId` and its
   `Team.agents` relation are dropped.
3. Maintenance: retire or repair `client/live-check.mjs` /
   `client/ssr-check.mjs`. Both are stale — their `document` mock no longer
   satisfies React 18, so they fail before evaluating the bundle, and they
   failed that way before the redesign too. A jsdom harness supersedes them.
   Deferred deliberately; not a blocker.

## Important Decisions

- **SQLite + `prisma db push`** as the daily schema workflow. A minimal
  migration history exists for the assignment-group membership change; use
  `npm run db:migrate-assignment-groups` to (re)apply its data backfill and
  the partial "one lead per group" index to a `db push`-managed database.
  `prisma migrate dev` would reset the database.
- **`Team` is the assignment group; `Agent` is every account** (roles `user` /
  `agent` / `admin`). Historical table names, deliberately not renamed.
- **Multi-group membership lives in `TeamMembership`.** `Agent.teamId` is a
  transitional primary-group pointer only, kept in sync until readers flip.
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
- **The current UI is the approved baseline (2026-08-29).** Feature work adds to
  it in its existing visual language; it does **not** redesign or substantially
  alter it. No new layout system, no re-theming, no restyling of screens that a
  feature merely touches, and no third re-do of the dashboard — unless the
  owner explicitly asks for it. Extending the baseline is expected: a new screen
  reuses `ui.jsx`, the `Icon` set, `usePopover`, `usePageHeader` and the
  existing tokens.

## Known Issues

- **The dashboard KPI cards carry no trend line.** _Accepted, not a defect._
  The reference design shows a sparkline per figure; nothing in this system
  stores history, so the slot carries the figure's real share of the open queue
  instead. A trend line would need snapshot storage first — a backend change.
  Leave as is.
- **The Agents table scrolls horizontally at ~1440px** to reach the row actions.
  _Accepted, not a defect._ Nothing is clipped and every action is reachable;
  the current responsive behaviour stands unless a real usability problem is
  reported.
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
