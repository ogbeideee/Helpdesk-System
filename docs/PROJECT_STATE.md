# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-09-16_

## Current Phase

Supporting (multi-group) membership feature — an agent can belong to up to 3
groups. Groups other than the primary act as "supporting" memberships, which
can only receive low/moderate priority tickets from those secondary groups.

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
- Client UI redesign (dashboard, tickets queue, ticket detail, handovers,
  agents, routing rules, assignment groups, simulate email, sign-in)
- Light / dark theme (one component implementation, tokens only; `light` /
  `dark` / `system`; flash-free before first paint; WCAG AA in both palettes)
- Reference-based visual polish (header, KPI row, Recent Tickets table, utility
  rail, navigation rail, one card language)
- Assignment-group membership model (`TeamMembership` join table: agentId,
  teamId, isLead, max 3 groups per agent, one lead per group, baseline
  migration)
- AI classifier seam + benchmark framework (20 test cases A–T, Gemini / Groq
  + Qwen adapters, mock mode, HTML comparison charts)
- Prisma client freshness guard (`server.js` boot check)
- Vercel/serverless deployment prep (workspaces, `bootStartupChecks`,
  `startBackgroundJobs`, `build` script, resilient testdb.js)
- Fly.io deployment prep (Dockerfile, .dockerignore, fly.toml, root `start`
  script)
- **Modal textarea focus fix** — `Modal` component no longer re-runs focus
  effect on every render, fixing keystroke-by-keystroke focus loss in
  textarea inputs.
- **Notification poll interval reduced** — 60s → 10s for near-real-time updates
- **Previous session (2026-09-10):** AI classifier seam + benchmark,
  Prisma guard, Vercel/Fly prep (all committed as `6c045eb` etc.)

## Completed This Session (2026-09-16)

- **`origin/feature/tests-and-docs` pulled into `post-deployment-v1`.** The two
  commits behind (`fd8b31d` full-suite test runner + IMAP/email-source test
  stabilisation, `df792e2` `QUICKSTART.md` + the PostgreSQL database story)
  merged as `8996136`. The 18-file working-tree WIP was stashed and restored
  around the merge; the single `docs/PROJECT_STATE.md` conflict was resolved by
  keeping this file's condensed structure and grafting in the 2026-09-14 notes.
- **`AGENTS.md` / `CLAUDE.md` database contradiction fixed.** The Database
  section still read "`npx prisma db push` only — there is no `migrations/`
  directory" while `server/prisma/migrations/` had shipped 7 PostgreSQL
  migrations, and the "Schema changes ship as committed migrations" bullet sat
  stranded in the *Intentionally NOT implemented* list. The Database section
  now documents the migration workflow, the vestigial SQLite artifacts and the
  read-only caveat; both mirrors kept in step.
- **Stale Known Issues bullet corrected.** This file's "No `migrations/`
  directory — `prisma db push` is the daily workflow" was replaced with the
  real constraint: `prisma migrate dev/reset` cannot be used against the
  application database.
- **README.md database story corrected.** The Stack table claimed "**SQLite**
  locally (`server/prisma/dev.db`) via Prisma", the setup block ran
  `npm run db:push` "to apply schema to the SQLite database", and the Tests
  section said each suite creates a throw-away SQLite database. All three now
  match the PostgreSQL-only schema (`db:deploy`, disposable local test
  cluster), and the suite count was corrected from ~30 to ~35.
- **README restructured for a public audience.** The repository is public and
  the default branch is `main`, so the 954-line README was the first thing a
  visitor saw — 80% of it behaviour specs naming internal symbols
  (`moveTicket`, `OPEN_STATES`, `Ticket.assignedAgentId`). The front door is
  now 230 lines (what it is, stack, run it, first sign-in, team, demo data,
  UI, tests, troubleshooting) plus a documentation index and a scope /
  limitations section. The detail moved *verbatim* into seven new
  `docs/*.md` files — users-and-roles, ticket-lifecycle,
  assignment-groups-and-routing, workload-and-rebalancing, handovers,
  email-parsing, microsoft-graph — with headings promoted one level and no
  line of content dropped (verified line-by-line against the old file).
- **Real administrator address removed from the README.** The organisation's
  own admin address appeared twice in the public README, while `.env.example`
  deliberately ships `INITIAL_ADMIN_EMAIL` empty and `scripts/test-users.js`
  asserts that the domain never appears in source. Both occurrences are now
  the reserved `admin@example.com` placeholder.
- **`AGENTS.md` / `CLAUDE.md` doc map updated.** They still described the
  README as the "~890-line long-form manual"; they now point at `docs/` for
  per-subsystem detail.

## Completed This Session (2026-09-14)

- **Full-suite test runner — `npm test` rewritten.** The old 35-suite `&&`
  chain stopped at the first failure, silently skipping every suite behind it
  (one flake hid 22 suites during a verification run). `server/scripts/run-all-tests.js`
  now runs every suite in the same fixed order, streams live output, prints a
  per-suite `PASS/FAIL` summary and exits non-zero when anything failed.
  Substring filters are supported: `node scripts/run-all-tests.js imap email-sources`.
- **test:imap made environment-proof.** A developer `.env` holding a real
  mailbox configuration (`IMAP_PORT=993`, `IMAP_POLL_INTERVAL_MS=30000`, …)
  leaked through dotenv into the suite's "unset → default" assertions — A5
  expected the plaintext default port 143, A9 the 120000 ms default interval.
  The suite now scrubs every `IMAP_*` variable after `.env` is loaded and
  before any `src/imap/*` module takes its config snapshot; `withEnv`
  re-adds exactly what each scenario needs. Test-only change.
- **test:email-sources F8 race removed.** The check slept a fixed 7 s for the
  server's first IMAP poll (fires ~5 s after boot, `src/imap/poller.js`) to
  fail against a dead port and record `lastError`; under load the poll landed
  late and F8 failed while F7/F9 passed. It now polls `/api/health` every
  500 ms for up to 20 s and asserts the moment the error is recorded — same
  assertions, deterministic outcome. Test-only change; the 5 s boot delay in
  the poller is deliberate and untouched.
- **Full `npm test`: 35/35 suites pass** on the disposable local PostgreSQL
  test cluster; `dev.db` untouched. `email-sources` additionally passed three
  consecutive runs. `AGENTS.md`'s stale SQLite database description was
  corrected in the same session (see below).
- **Docs split — `QUICKSTART.md` added.** The 890-line `README.md` is kept
  verbatim as the long-form manual (owner's choice); `QUICKSTART.md` now
  carries the short path: requirements, setup, first sign-in, tests, email
  ingestion, and pointers into the manual and `.env.example`.
  _(Superseded on 2026-09-16: the README is now the 230-line public
  front door and the detail lives in `docs/` — see above.)_
- **`AGENTS.md` / `CLAUDE.md` database story corrected.** Both files (line-for-line
  mirrors) still described the database as SQLite with `db push` as the schema
  workflow and "Supabase not used". Reality: production runs on Supabase
  PostgreSQL (`DATABASE_URL`/`DIRECT_URL`), `server/prisma/migrations/` holds
  the committed PostgreSQL history applied by `db:deploy` / `migrate deploy`,
  and tests run on the disposable local cluster from `test:pg:up`. The Stack
  table, the test-isolation section, the Commands block and the
  "Intentionally NOT implemented" list now match the code. `dev.db` survives
  only as a vestigial pre-migration artifact referenced by no code.

## In Progress

- **Supporting (multi-group) membership feature** — full implementation across
  engine, policy, workload, UI, and tests. See details below:

### Feature scope
| Component | Status |
|---|---|
| `groupMembershipService.isSupportingMember()` | Done |
| `assignmentEngine` supporting-tier gate for in-group + preferred + cross-team | Done |
| `assignmentPolicy.checkTarget` supporting-member low/moderate allowance | Done |
| `assignmentPolicy.listCandidates` flag supporting members | Done |
| `workloadService.checkClaim` supporting-tier gate | Done |
| `POST/DELETE /agents/:id/memberships` routes | Done |
| `POST /routing/groups` route for new groups | Done |
| `AgentsPage.jsx` table chips + AgentEditor supporting groups UI | Done |
| `RoutingPage.jsx` "New group" button + GroupEditor modal | Done |
| `field_ops` default routing rule + team definition | Done |
| `assignment.config.json` `supportingMaxPriority` | Done |
| `test-assignment-pool.js` J1–J11 supporting member assertions | Done |
| `isSupportingMember` flag on pool cards | Done |
| Rebalancer cross-team supporting tier gate | Done |

### Remaining work items
1. Run full test suite to validate all 35 suites pass
2. Run browser checks (jsdom harness)
3. `fly deploy` current state to production
4. Remove `Agent.teamId` legacy transition column (requires full reader flip)

## Known Issues

- **The dashboard KPI cards carry no trend line.** _Accepted, not a defect._
- **The Agents table scrolls horizontally at ~1440px.** _Accepted, not a defect._
- **Microsoft Graph has never run against live credentials.**
- **Background workers run in every server process.** Safe but wasteful with
  >1 instance.
- **Schema changes must ship as committed migrations.** `prisma migrate dev` /
  `reset` cannot be used against the application database — they can reset it.
  Apply `server/prisma/migrations/` with `npm run db:deploy`.
- One ambiguous ticket kept: `INC-000724` "PC is overheating".
- **Removing a supporting membership does not retroactively check current
  assignments.** If an agent holds a high/critical ticket from a group they are
  removed from as a supporting member, the ticket stays with them. The
  assignment engine only gates at time of assignment.

## Last Verified

**2026-09-16**, documentation and merge-verification pass — no application
code touched and the full suite deliberately not re-run (see remaining work
items):

- `git merge-base --is-ancestor origin/feature/tests-and-docs HEAD` — the
  feature branch is fully contained in `post-deployment-v1`
- The working tree still holds the same 18 modified files, with identical
  EOL-insensitive diff totals (689 insertions / 250 deletions) to the pre-pull
  snapshot, and `git diff` against the kept stash lists only the 8 files the
  merge introduced
- `node --check` passes on `run-all-tests.js`, `test-imap.js` and
  `test-email-sources.js`; `server/package.json` `test` is
  `node scripts/run-all-tests.js`
- `AGENTS.md` and `CLAUDE.md` differ only in their H1 title

**2026-09-14**, after the test-suite stabilisation:

- `npm test` (new runner): **35/35 server suites pass**, exit 0, on the
  disposable local PostgreSQL test cluster
- `test:email-sources` passed 3 consecutive runs after the F8 race fix
- `test:imap` A5/A9 pass with a real mailbox configured in `server/.env`
- `dev.db` untouched by the full run; `git status -- server/` shows only the
  two test-script fixes, the new `run-all-tests.js` and the `package.json`
  `test` script change

**2026-09-12** — supporting membership feature code complete, needs test and
build verification before commit.