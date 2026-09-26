# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-09-26_

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

## Completed This Session (2026-09-26)

- **Merged `origin/feature/tests-and-docs` (Farook, 2026-09-25) into
  `post-deployment-v1`.** Two commits: `feat(client): make the UI usable on
  phones, drop the duplicate queue search` and `perf(server): compress
  responses and harden ticket queue performance`. Four files conflicted
  (`App.jsx`, `AgentsPage.jsx`, `TicketsPage.jsx`, `TopBar.jsx`) and were
  resolved by keeping both sides: his `lazy()` route chunks, `data-label`
  cells and the mobile nav toggle, alongside our supporting-membership chips,
  bulk queue actions and `routeKey`. `package-lock.json` was regenerated rather
  than hand-merged. His `index.css` mobile pass, `server.js` response
  compression and the new Prisma migration merged cleanly and are kept. The
  email simulator stays out of the client: he reintroduced the route on his
  branch, ours removed it in favour of the live IMAP path.
- `backup-before-merge` points at `d7a47ef` (the pre-merge state) if this
  resolution ever needs to be undone.

- **Signatures and inline images no longer pollute tickets or storage.** New
  `email/signature.js` (pure, deterministic) strips free-form corporate
  signature blocks and legal footers from `cleanBody` via a footer marker or a
  trailing contact run behind a closing salutation; the raw `body` is untouched.
  `imapMailAdapter` and `graph/mailService` propagate `isInline` /
  `contentDisposition`, and `attachmentService.prepareForStorage()` skips
  decorative inline images instead of storing them (reported in `skipped`, logged
  once per message by intake, counted as `inlineImagesSkipped` in the audit
  metadata, excluded from the size/count limits). New
  `db:purge-signature-images` cleans the backlog: dry run reports **277 of 308**
  stored attachments (8.8 MB, 50 tickets) match; the other 31 are real named
  attachments. **Not yet applied — awaiting the go-ahead for `--apply`.**
  Suites green: parser (182), attachments, email-sources, classifier-seam,
  email-rules, email-integration, imap, ingest, triage ×2, screening,
  graph-mailbox, m365.

## Completed This Session (2026-09-26, resumed)

Picked up the interrupted session and finished it. The suite count went 37 → 41.

- **Requester self-service status (signed link).** `email/statusLink.js` mints a
  stateless HMAC token over `ticketId.requesterEmail`; the acknowledgement and
  status-update mails carry a "check progress" link to `#/status/<token>`,
  rendered by the new `StatusPage.jsx` without a session. The only other
  unauthenticated surface is `routes/public.js` — one endpoint, rate-limited,
  returning just the ticket's public face and 404 for a forged, tampered or
  cross-requester token. New `test-status-link` suite (26 checks) pins the
  signing, the exposure surface, the two mails and the throttle.

- **Rate limiting on the guessing surfaces.** New dependency-free fixed-window
  limiter `src/rateLimit.js`, applied to `POST /api/auth/login` (IP + target
  email, 20/5 min), `POST /api/profile/password` (per account, 10/5 min) and
  the public status lookup (IP, 30/5 min). A 429 never reaches the handler, so
  it also caps the bcrypt cost an attacker can impose. `trust proxy: 1` so keys
  see the real address behind the Fly proxy. All env-tunable and documented in
  `.env.example`.

- **Password changes now invalidate every session.** `Agent.passwordChangedAt`
  (migration `20260926000000_agent_password_changed_at`) is stamped by
  `userService.applyUserUpdate` on every password write — self-service and admin
  reset alike — and `requireAuth` rejects any token whose `iat` predates it, at
  second granularity so a sign-in in the same second is never locked out. Four
  new checks in `test-profile` (F1–F4).

- **TicketDetail split by region.** `TicketDetail.jsx` went from 1348 to ~400
  lines and is now the page shell only (load, mutate, fold the result back in),
  delegating to `TicketConversation.jsx` (activity rail), `TicketInspector.jsx`
  (right-hand column) and `TicketModals.jsx`. The comment/attachment logic it
  used to carry inline is now two pure view modules — `ticketTimelineView.js`
  (event merge, audit classification, SLA and handover vocabulary) and
  `attachmentView.js` (grouping, labels, the inert download) — each pinned by a
  new check script in `cd client && npm test`. Two real fixes fell out of the
  extraction: the reassign/handover radio list is one component instead of two
  copies, and a negative byte count can no longer reach the DOM as `-5 B`.
  `ActionsCard` lost three destructured props it never used.

- **Queue composite indexes.** `schema.prisma` now declares the two
  `@@index([assignedAgentId, state])` / `@@index([teamId, state])` indexes that
  migration `20260914000000_ticket_queue_indexes` had been creating all along —
  the schema and the database were out of step.

- **Vercel retired.** `vercel.json` and `api/index.js` deleted, the serverless
  notes in `server.js` replaced with the single-instance Fly reality, and
  `statusLink.js` refuses to load in production without a signing secret. No
  Vercel reference is left outside the historical record in this file.

- **Repo hygiene.** Untracked and deleted `wi.txt`, `ws.txt`, `wi-err.txt`,
  `ws-err.txt` (Fly shell/websocket scratch output) and `server/vd.txt`,
  `server/engine-test3.txt` (a `dbcheck` dump and an empty file).

- **Docs corrected against the code.** `AGENTS.md` claimed "Attachment storage
  — attachments are parsed as metadata only; no file is stored anywhere", which
  has been false since `attachmentStorage.js` landed; it now states the real
  position (bytes stored and served locally, provider seam only, no S3/Azure).
  Added the session-lifetime, requester-status and throttling rules, the new
  route, the view-module and split-screen conventions, and `STATUS_LINK_SECRET`
  plus the six limiter variables to `.env.example`. `CLAUDE.md` had drifted 48
  lines behind `AGENTS.md` (missing the whole responsive-layout section, the
  `intakeScreening` row, the client test command) and was re-mirrored. Suite
  counts corrected 35 → 41 in `AGENTS.md`, `README.md`, `QUICKSTART.md`.

- **Fixed a duplicate line** left in `userService.applyUserUpdate`: the
  `passwordChangedAt` assignment, and its comment, appeared twice.

- **The live shared mailbox is out of the public repository, and cannot come
  back.** It shipped in `.env.example`, three docs, two test fixtures and two
  committed `.docx` domain-migration guides (42 and 45 occurrences). None of
  those shapes looks like a secret, which is exactly why nothing caught it — a
  scanner looking for a password has no reason to read an address, and the
  address *is* the ingestion target, so publishing it maps precisely where to
  phish or credential-stuff. The mailbox and the bare production domain are
  gone from every tracked text file, replaced with `example.com`.

  Two new scanner rules now block both forms (`production-mailbox` CRITICAL,
  `production-domain` HIGH), mirrored into `.gitleaks.toml` for CI. They
  **assemble the domain from fragments**, so the scanner and its own test suite
  never contain the value they forbid and `IGNORED_PATHS` needs no new
  exemption — an exemption is a hole that quietly rots. 21 new checks in
  `test-secret-scan`, including two that pin the rules do *not* over-reach onto
  a different customer's domain.

  The `.docx` route is closed structurally, not by convention: `*.docx` and
  `scripts-make-doc/` are git-ignored, and the four documents plus their
  generator scripts are untracked (left on disk). A `.docx` is deflated XML in a
  zip, so the scanner, `git grep -I` and gitleaks all skip it in silence — a
  binary no control can read has no place in a public repository. `I.18` asserts
  no `.docx` is tracked, so the policy cannot rot either.

  **One real bug found and fixed while proving the guard:** redaction was
  per-rule, so the mailbox rule blanked the local part and the domain rule
  blanked the host — and two excerpts of the same line printed one under the
  other reassembled the whole address. `makeFinding` now applies *every* rule's
  pattern to the line, and `I.12c` pins it. Partial redaction is not redaction
  once findings are listed.

  History was **not** rewritten: the domain was never a credential, it is
  already a public hostname, and anyone who cloned earlier keeps their copy
  regardless. This is a forward-only change.

  **The first push broke CI, and the cause was the rule itself.** The Secret
  scan workflow sweeps every commit in history, and a rule forbidding a value
  that is already in the history fires on every one of those commits — so
  writing the rules turned the entire history sweep red immediately, on all
  five runs. A rule that cannot pass its own gate is a rule somebody deletes
  under pressure. The two rules are now marked `forwardOnly`: the current tree
  (`--all`) and the pre-commit hook still apply every rule, and only the
  history sweep skips this pair. The credential rules keep sweeping history in
  full, because a credential in history is a live exposure that has to be found
  and rotated — `J.1`–`J.7` pin both halves of the split so it cannot be
  "fixed" later by dropping the rules.

  The same reasoning removed the two rules from `.gitleaks.toml`. gitleaks has
  no forward-only scoping, and the project scanner runs in the same workflow
  anyway, so putting them there only bought a permanently red signal on
  unpublishable history. The gate is now reproduced locally
  (`ci-gate.cjs` mirrors the workflow exactly: `--all`, then every commit
  oldest-first, then the self-test) and reports **37 commits, 0 range
  failures**.

## Completed This Session (2026-09-24)

- **Live ticket queue controls.** The simulator is no longer exposed in the
  client navigation, hash routing, dashboard quick actions, or system status;
  the real M365-to-Gmail IMAP path remains documented. The queue now supports
  multi-selection and bulk priority, category, and assignment-group updates via
  the existing audited PATCH rules. Lifecycle action responses are now compact
  action projections rather than full conversation/attachment payloads.

- **Ticket lifecycle latency pass.** The ticket detail now consumes the updated
  ticket returned by Start/Resolve/Close, refreshes handovers and remote-access
  data in parallel, scopes remote-access lazy expiry to the displayed ticket,
  and reuses the Resolve SLA policy during finalization. Full server suite
  37/37 and the client production build pass.

- **Custom domain migration.** The helpdesk now runs on
  `https://ithelpdesk.example.com` (Fly.io certificate issued by
  Let's Encrypt, `fly certs add` + DNS by the domain holder). Both
  `PORTAL_BASE_URL` and `WEBHOOK_PUBLIC_URL` were repointed; the fly.dev
  address stays live for old emailed links. Runbook:
  `Helpdesk-Domain-Migration-Guide-v3.docx`.
- **Gmail IMAP ingestion restored.** The poller was failing every cycle with
  `invalid_grant` — the stored refresh token had been revoked/expired (Google's
  7-day expiry for OAuth apps left in "Testing"). A new token was generated via
  `scripts/generate-refresh-token.js` and set on Fly together with the matching
  client id/secret. Publish the OAuth app to "In production" to stop the weekly
  expiry.
- **Self-service account settings.** Every signed-in user can change their own
  display name and password at `#/settings` (account menu → Settings).
  New `routes/profile.js` (`PATCH /api/profile`,
  `POST /api/profile/password` — current password required, 8-char minimum,
  no-reuse), `SettingsPage.jsx`, and the `test-profile` suite (26 checks).
  Both writes go through `userService.applyUserUpdate`, so the audit trail
  matches an admin-made change; role/activation/skill cannot be smuggled in.
- **Routing quality repair (Fix A + Fix B).** Two layers were misrouting:
  - *Fix A (production rule table).* Culled generic prose words that were
    hijacking tickets (`server`, `site`, `field`, `pos`, `branch`, `outlet`,
    `terminate`, `connection`), gave the Hardware rule a real keyword list
    (2 → 18), and re-ordered the table so the per-category rules are evaluated
    first (Account & Access p5, Software p6, Hardware p7, General Enquiries p8)
    ahead of the category-agnostic rules (Network p10, Printing p20, Field Ops
    p30). Audited in `RoutingRuleAuditLog`.
  - *Fix B (engine).* Routing precedence gains **subject evidence** as the
    first criterion — a keyword the sender wrote in the subject beats a
    body-only match, whatever the priority — and both classification and
    routing now read the **sender's own words** (`msg.cleanBody`, quotes and
    signature stripped) instead of the whole mail thread. The
    separator-insensitive matcher (which lets `wi fi` match `wifi`) was a raw
    substring test; it is now a word-bounded window, so `physical` no longer
    matches `physically` — a latent bug that had been routing laptop-damage
    tickets to Field Operations and that `test-e2e` had been asserting against.
  - Verified against the 15 most recent production tickets: 5 route differently
    and all 5 are corrections (sick-leave notice and laptop screen out of Field
    Operations; a distribution-list request back to Accounts; SCADA and a price
    list back to Software). The trade-off is deliberate: a body-only keyword no
    longer outranks a ticket's own category, so an ambiguous request lands in
    General IT Support triage instead of a specialist queue.
- **Routing and membership update.** Added the account-creation/email
  provisioning rule for Accounts & Access and expanded the General IT Support
  rule to cover printer/toner, desk-phone and conference/meeting-room requests.
  Applied both changes to the live routing table. Ibiyemi Aboyewa now has
  Accounts & Access as the primary group, with General IT Support and Hardware
  & Devices as supporting memberships; six NEW tickets were released when the
  primary group changed.
- **Existing-ticket reroute.** Re-evaluated the 69 existing tickets with
  sender-clean text and applied the approved new-rule matches to all 14
  affected tickets. Ten active tickets were reassigned through
  `workloadService.moveTicket`; four RESOLVED/CLOSED tickets retained their
  historical assignees. A post-change check found no remaining target/group
  mismatches.
- **Field Operations misroute repair.** The live rule was narrowed to specific
  cabling, installation, POS and CCTV terms, removing broad words such as
  `site`, `field`, `premises` and `installation` that had captured ordinary
  tickets. All 17 active stale tickets were re-evaluated and moved out of Field
  Operations; the Laptop Bad Screen ticket now belongs to Hardware & Devices
  with Ibiyemi Aboyewa. Six active non-member assignments created by workload
  rebalancing were also corrected. The rebalancer now requires the recipient to
  be a primary or supporting member of the ticket's group.
- **AI email filtering implementation plan.** Generated
  `AI-Email-Filtering-Implementation-Plan.docx`, covering the hybrid filter
  architecture, free-model strategy, labeled benchmark, safety policy,
  rollout gates, operational metrics, and 30/60/90-day execution plan.


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

## Completed This Session (2026-09-25)

- **Email relevance triage foundation.** Added a separate Groq-backed triage
  service and conservative local policy after deterministic screening and
  before classification/routing. The default is disabled; all provider,
  validation, configuration and decision-log failures fail open to ticket
  creation. Existing-ticket replies bypass the gate.
- **Auditable decisions and migration.** Added `EmailTriageDecision` with a
  unique message identity and sanitized provider/model/prompt/policy metadata;
  no subject, body, attachment, evidence or raw model response is stored.
  Any attachment vetoes auto-skip. Graph, IMAP, webhook and simulated-email
  outcomes now distinguish `skipped_non_ticket`.
- **Admin controls.** Added an administrator-only management API and a
  Profile → Settings card for mode, confidence threshold, approved senders,
  reason-code allowlisting, metrics, provider check, refresh and an immediate
  auto-skip stop. `INTAKE_TRIAGE_KILL_SWITCH=true` is an environment-level
  stop that the UI cannot override.
- **Provider tooling.** Added a separate synthetic/labeled relevance benchmark
  CLI; the existing category/priority benchmark remains unchanged. Groq keys
  are environment secrets only.

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
1. Run browser checks (jsdom harness; no checked-in harness currently exists)
2. Remove `Agent.teamId` legacy transition column (requires full reader flip)

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

**2026-09-26**, after finishing the interrupted session:

- `cd server && npm test`: **41/41 suites passed** on the disposable local
  PostgreSQL test cluster
- `cd client && npm test`: all 13 check scripts pass, including the two new ones
  (`ticket-timeline-check` 47 checks, `attachments-check` 30 checks) and
  `mobile-check.mjs` (0 failures)
- `cd client && npx vite build`: Vite production build passed (76 modules)
- `npm run scan:secrets`: clean — and verified in the other direction too, by
  re-injecting the address into a tracked file and confirming the scanner
  blocks it with both values redacted
- `cd server && npm run test:secret-scan`: 81 passed, 0 failed

**2026-09-24**, after resuming the interrupted supporting-membership work and
applying the routing/membership update:

- `cd server && npm test`: **37/37 suites passed** on the disposable local
  PostgreSQL test cluster
- `cd client && npm run build`: Vite production build passed
- Live routing matcher verification passed for toner/printer, desk phone,
  conference-room setup, and email-account creation requests
- Live membership verification passed: Ibiyemi Aboyewa is primary in Accounts
  & Access and supporting in General IT Support and Hardware & Devices
- Existing-ticket reroute verification passed: 14 groups updated, 10 active
  owners reassigned through the compare-and-set path, 4 historical owners
  preserved, and no new-rule target/group mismatches remain
- Field Operations repair verification passed: no active tickets remain in the
  group, no active ticket is assigned to a non-member, and `INC-001768` is
  Hardware & Devices with Ibiyemi Aboyewa
- `cd server && npm test`: **37/37 suites passed** after the routing and
  rebalancer fixes; `cd client && npm run build`: Vite production build passed
- Fly deploy completed on 2026-09-24 as image version 25; both machines are
  started and healthy. Post-deploy verification found `INC-001768` in Hardware
  & Devices with Ibiyemi Aboyewa, 0 active Field Operations tickets, and 0
  active non-member assignments.
- No browser/jsdom harness is currently checked in; the legacy `Agent.teamId`
  reader surface still spans server policy/routing/reporting and client UI, so
  its removal remains a separate migration task

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