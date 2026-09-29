# AGENTS.md

Durable project knowledge. Read this and `docs/PROJECT_STATE.md` at the start of
a session, then open only the source files the current task needs.

`README.md` is the public front door — what the product is, how to run it, the
stack and the tests. The per-subsystem detail lives in `docs/`, indexed from the
README. `QUICKSTART.md` is the short version for setup and daily commands.
Link to those; don't duplicate them.
The **codebase is the source of truth for implementation**; this file is the
source of truth for architecture and conventions.

---

## Purpose

Internal IT helpdesk ticketing system for one organisation. Employees raise
requests by email; the system creates tickets, classifies and routes them,
assigns an agent, and tracks them to resolution. The live deployment uses the
Microsoft 365-to-Gmail forwarding and IMAP path.

## Stack

| Layer | Technology |
|---|---|
| API | Node.js + Express, **CommonJS** (`require`, not ESM) |
| Database | **PostgreSQL** via Prisma — Supabase in production (`DATABASE_URL` / `DIRECT_URL` in `server/.env`) |
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

## Responsive layout

One implementation, a documented breakpoint ladder, and no second stylesheet
for small screens. The mobile rules live in one section at the end of
`client/src/index.css`; nothing above them changes.

- Ladder, largest first: **1240 / 1180 / 1100 / 1080 / 900 / 860 / 768 / 640 /
  620 / 560**. A new width means editing the ladder and
  `client/mobile-check.mjs` together.
- **Wider than 768px** the rail is a standing column — labelled, or icons below
  900px. **At 768px and below** it is a drawer: `App.jsx` owns `navOpen`,
  `TopBar` renders `.nav-toggle`, `.sidebar` is fixed and slides in, a
  `.nav-scrim` closes it and the page behind it stops scrolling. That width is
  stated twice on purpose — `MOBILE_NAV_QUERY` in `App.jsx` and the
  `max-width: 768px` block — so **change both together**.
- The drawer always shows full labels: it re-points the `--rail-*` tokens for
  `.shell` *and* `.shell.is-collapsed`, because collapsing is a desktop
  preference with no meaning on a phone.
- A table either folds into cards or scrolls inside its own frame — never
  widens the page. Folding is opt-in (`.table-stack` on the wrapper) and every
  cell carries the `data-label` it prints; the ticket queue folds from 860px
  because it is the screen people live in.
- Fields are 16px on phones: below that iOS zooms the page when one takes
  focus and leaves it zoomed.
- `cd client && npm test` includes `mobile-check.mjs`, which pins this contract
  (ladder, drawer wiring, stacked-table labels, input size, safe-area opt-in).
  It is static analysis of the CSS and shell markup, not a browser — it cannot
  see a layout, only the rules that produce it.

## Major modules

**Services** (`server/src/services/`)
| File | Owns |
|---|---|
| `userService.js` | Roles, initial-admin bootstrap, last-admin protection |
| `assignmentPolicy.js` | Who may assign what, to whom (`checkTarget`, `listCandidates`) |
| `assignmentEngine.js` | Picks the agent: `decide()` → group + skill, `assign()` → agent |
| `routingService.js` | Keyword rule matching and precedence |
| `defaultRoutingRules.js` | The starter rules (incl. `Software (Advanced)`), seeded when none exist |
| `workloadService.js` | Workload, unattended claiming, `moveTicket`, rebalancing |
| `handoverService.js` | Handover offers, queue, expiry, reroute |
| `settingsService.js` | Admin-configurable values (`Setting` table, env defaults) |
| `intakeScreening.js` | Automated-mail gate — RFC 3834 headers + ignored senders → `skipped_automated` |
| `emailTriageService.js` | Optional Groq relevance gate → `skipped_non_ticket`; fail-open, policy-gated, audited |
| `ticketIntake.js` / `emailIngestion.js` | Email → ticket pipeline |

**Other** — `src/states.js` (lifecycle), `src/teams.js` (assignment groups),
`src/mailer.js` (the *only* notification sender), `src/email/` (deterministic
parser), `src/graph/` (M365), `src/authMiddleware.js`, `src/rateLimit.js`
(dependency-free in-memory fixed-window limiter).

**Routes** (`server/routes/`) — `auth, profile, tickets, agents, routing,
workload, handovers, dashboard, stats, public, webhooks, dev`. `public.js` is the
only unauthenticated surface besides auth/health: the requester status lookup,
rate-limited and answering 404 for a bad token.

**Client** (`client/src/components/`) — one component per screen plus
`ui.jsx` (shared primitives: `Modal`, `Spinner`, `EmptyState`, `Icon`,
`usePopover`, `useToast`, …). Import from `ui.jsx` rather than rebuilding;
`Icon` is the only icon set, so no screen inlines its own SVG.

**Client view modules** (`client/src/*View.js`, `*View.jsx` sibling files) —
every derivation, formatter and vocabulary lives in a pure module next to the
components that render it, never inside the component: `slaView.js`,
`remoteAccessView.js`, `auditView.js`, `reportsView.js`, `slaReportView.js`,
`slaKpis.js`, `poolView.js`, `emailRulesView.js`, `m365View.js`,
`availabilityHistoryView.js`, `ticketTimelineView.js`, `attachmentView.js`,
`confirmationView.js`. A
screen owns layout, local state and the API call; a view module owns the rule.
Each is pinned by a plain-node check script in `client/` wired into
`cd client && npm test` — the same contract the server suites keep.

A screen that outgrows one file splits **by region**, not by rule:
`TicketDetail.jsx` is the page shell (load, mutate, fold the result back in)
and delegates to `TicketConversation.jsx` (the activity rail),
`TicketInspector.jsx` (the right-hand column) and `TicketModals.jsx`. The
component files are never allowed to grow a private copy of a rule that
already has a view module.

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

- **Schema changes ship as committed migrations.** `server/prisma/migrations/`
  holds the PostgreSQL history (init + dated migrations) and `npm run db:deploy`
  (`prisma migrate deploy`) applies it — the test harness runs `migrate deploy`
  per suite. `prisma migrate dev/reset` is deliberately unused against the
  application database because it can reset it; `npm run db:push` is not the
  workflow either.
- `prisma/dev.db`, `prisma/migrations-sqlite-archive/` and
  `prisma/postgres-baseline-preview.sql` are vestigial pre-PostgreSQL
  artifacts. Nothing under `src/` or `routes/` reads them — only the one-off
  `scripts/migrate-sqlite-to-pg.cjs` and `diag-ticket730.cjs` open `dev.db`,
  and read-only.
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
`RESOLVED → IN_PROGRESS` rework. Resolving asks the requester to confirm (the
resolve email carries the confirmation link). `CLOSED` is final for people;
only a requester email reply reopens it, via `ticketIntake.js`, which
deliberately bypasses `canTransition`. Four paths write `ticket.closed`, all
compare-and-set and audited with their `via` metadata: an agent closing their
own ticket (plain), an administrator overriding a pending confirmation
(`via: force_close` — the button reads "Force close…", the requester's link
goes dead), the requester's confirmation click (`via:
resolution_confirmation`), and the auto-close sweep (`via: auto_close`) —
unconfirmed RESOLVED tickets close after `resolutionAutoCloseDays` (default 3,
admin-tunable; 0 disables), swept by `src/resolutionSweeper.js`. Every serialized ticket carries the derived
`awaitingConfirmation` flag and, when auto-close is enabled, an absolute
`confirmationAutoCloseAt` deadline — the queue's status cell, the detail
header and the inspector render it through `confirmationView.js`; the client
never re-derives the window.

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

**Routing precedence** — subject-keyword evidence → priority asc →
category-specific over agnostic → more matched keywords → longer keyword →
lower id. Classification and routing read only the sender's own words (quoted
history and the signature are stripped first). Matching is deterministic and
punctuation/case-insensitive. **No LLM anywhere in routing or parsing.**

**Skill requirement** — the minimum skill a ticket needs is the bar of the
routing rule that governs it *inside the group that owns it*, plus the priority
boost (`high` +1, `critical` +2, capped at 3) — never a per-category figure.
`assignmentEngine.requiredSkill` derives it on read for `GET /api/tickets/:id`
(`requiredSkillLevel` / `requiredSkillRule`), and `groupSkillBars()` reports a
group's bar as the lowest among its active rules, which is what
`/api/assignment-groups` and the assignment pool display — one source, so no
screen can advertise a bar the engine does not apply. Derived, never stored:
correcting a rule corrects every ticket it governs, past and present, with no
backfill. Software is first-line work, so `Software & Applications` asks for
JUNIOR while `Software (Advanced)` (priority 5, above its own catch-all at 6)
keeps MID for wording that is genuinely advanced — a crash, an error code, data
loss, a deployment, an integration. Seeding never overwrites an
administrator's rules, so an installation seeded earlier is corrected with
`npm run db:relevel-software` (`--apply`), which audits both writes and touches
no ticket row.

**The sender's own words** — `cleanBody` is the body minus quoted history,
forwarded blocks and the signature. `email/signature.js` is pure and
conservative: it strips only a legal/social footer marker, or a *trailing run*
of contact lines behind a closing salutation — never a lone line, never a
contact detail written mid-request. The raw `body` always keeps everything.

**Attachments** — bytes are fetched and uploaded by `attachmentService`; the
body stays text, so decorative inline images (signature logos, social icons,
pasted pictures) are **skipped, not stored** — inline images only, and they
never consume the size/count limits. Skips are logged and counted in the
`ticket.created` audit metadata. `ATTACHMENT_SKIP_INLINE_IMAGES=false` restores
the old behaviour.

**Email relevance triage** — `emailTriageService` runs only after deterministic
screening and thread resolution, and only for new-ticket candidates. Groq may
recommend `ticket`, `skip`, or `review`; it never chooses category, priority,
assignment group, or agent. `skipped_non_ticket` requires a valid high-confidence
result, an allowlisted reason, the approved-sender policy, no attachment, no
local action signal, and a successfully persisted `EmailTriageDecision`. Every provider,
validation, configuration, or persistence failure fails open to ticket
creation. The admin Profile → Settings surface owns the runtime mode, threshold,
sender/reason allowlists, metrics, and emergency stop; the Groq key is an
environment secret only.

**Session lifetime** — JWTs are stateless 12h bearer tokens, so there is no
revocation list. `Agent.passwordChangedAt` stands in for one: `userService`
stamps it on every password write (self-service or admin reset) and
`requireAuth` rejects any token whose `iat` predates it. `express` runs with
`trust proxy: 1` so rate-limit keys see the real client address behind Fly.

**One link in email: the resolution confirmation.** No notification carries a
URL **except the resolve notification**, whose signed `#/confirm/:token` link
lets the requester close their own resolved ticket — the one action a requester
cannot safely express by replying ("yes" is ambiguous against reopen-on-reply).
The page is deliberately two-step (the GET shows the ticket; a button POSTs
closes it), so mail scanners that prefetch links close nothing.
`email/statusLink.js` signs it; `routes/public.js` POST /confirm-resolution
answers it (compare-and-set close from RESOLVED only, rate-limited, audited as
`via: resolution_confirmation`). A requester has no portal account — often
their account is the very thing that is broken — so every other notification
stays link-free and the reply-to-this-mail address remains the channel for
everything else. `PORTAL_BASE_URL` gates the link: unset, the resolve mail
falls back to the old "will be closed after confirmation" wording.

**Outbound transport** — `src/mailer.js` picks exactly one: **Microsoft Graph →
SMTP → the console fallback**, in that order. All three speak the same small
interface (`sendMail`, `sendBroadcastMail`, `hasBroadcastTarget`, and
`broadcastTarget` for the reply-alert fallback), so no caller and no test changes
when the choice does. `src/smtp/config.js` is the SMTP option: enabled by
`SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`, implicit TLS on 465 by default,
`SMTP_FROM` defaulting to the authenticated user, and `SMTP_BROADCAST_DL`
falling back to `GRAPH_BROADCAST_DL` so a migration never silently stops the team
alert. `publicSmtpConfig()` is the only printable shape — the password is never
logged, stored or returned. `scripts/testdb.js` clears every `SMTP_*` variable for
every suite, so a developer's real App Password can never send real mail from a
test run.

**Throttling** — `src/rateLimit.js` is a fixed-window in-memory limiter,
applied only where guessing is cheap: `POST /api/auth/login` (IP + target
email), `POST /api/profile/password` (account), and both public surfaces
(`GET /ticket-status` and `POST /confirm-resolution`, IP). A 429 never reaches
the handler, so it also caps the bcrypt cost an attacker can impose.
Single-instance by design — a second machine would get its own buckets.

**Concurrency** — every ownership change goes through
`workloadService.moveTicket`, a compare-and-set (`updateMany` with the expected
current owner in the `WHERE`). Handover status changes use the same pattern.
Reuse it; do not write a bare `update` for ownership.

## Constraints

- Never hardcode credentials. **This repository is public**, so a committed
  secret is a published secret — one was, on 2026-09-26, and only GitHub push
  protection stopped it. Credentials live in `server/.env` (git-ignored) and
  the Fly secret store. `docs/credential-rotation.md` is the runbook. A
  pre-commit hook (`npm run hooks:install`) and the `Secret scan` CI workflow
  both block a commit that contains one; run the hook installer once per clone.
- **The live shared mailbox and its domain are forbidden too**, even though
  neither is a credential — publishing the ingestion target is publishing the
  map. Two scanner rules (`production-mailbox`, `production-domain`) block both
  forms, and they assemble the domain from fragments so the scanner and its own
  test suite never contain the value they forbid. Use `example.com` in
  `.env.example`, docs and fixtures. **`*.docx` is git-ignored**: a deflated-XML
  binary is skipped by the scanner, `git grep -I` and gitleaks alike, which is
  how the domain reached two committed guides. Keep generated documents on disk
  and commit the text they came from.
- Never expose a client secret or access token to the frontend. Never log
  tokens, secrets or full email bodies.
- **An unauthenticated endpoint publishes no operational target.**
  `GET /api/health` is the liveness probe, so it must not name the shared
  mailbox, the public base URL, or anything derived from them — report
  set/unset booleans and leave the values to an admin-gated route. Scrubbing
  the repo is undone by one careless response field.
- **A check-then-act dedupe is not idempotency.** The unique message identity
  (`Ticket`/`Comment` `graphMessageId` / `internetMessageId`) is the real
  arbiter. A P2002 on either column means a concurrent poller won — report
  `duplicate` and resolve to the winner's row, never throw and never leave the
  message unseen for a retry that races again. Guard **every** write of a
  raced-on identity, including the plain and the transactional variant of the
  same insert.
- The background jobs are **single-instance by design**. One machine polls the
  mailbox; a second one is not "merely wasteful" — it duplicates every poll.
  Keep `min_machines_running = 1`.
- No demo data on startup. `seed:demo` requires `--confirm` and refuses under
  `NODE_ENV=production`.
- Notifications go through `src/mailer.js` and the `Notification` table. Do not
  build a second notification system.
- Four ticket categories are fixed: `Password Reset`, `Inquiry / Help`,
  `Software`, `Hardware`.
- Tests must never touch the application database (the Supabase PostgreSQL) — see below.

## Commands

```bash
npm run dev                  # root: API :4000 + UI :5173 via concurrently
cd server && npm test        # all 43 suites (scripts/run-all-tests.js)
cd server && node scripts/run-all-tests.js imap   # a few suites, by substring
cd server && npm run test:pg:up      # one-time: disposable local test PostgreSQL
cd client && npx vite build  # production build
cd client && npm test        # client check scripts, incl. mobile-check.mjs (responsive contract)
cd server && npm run db:deploy       # apply the committed Prisma migrations
cd server && npm run db:init # groups + routing rules + admin bootstrap
cd server && npm run db:purge-demo   # dry run; --apply to remove demo data
cd server && npm run db:purge-signature-images  # dry run; --apply to drop stored signature images
npm run hooks:install         # pre-commit secret scan (once per clone)
npm run scan:secrets          # scan every tracked file for credentials
cd server && npm run test:secret-scan   # the scanner's own suite
```

Shell is **PowerShell / Git Bash on Windows**. Heredocs break on JSX and
backticks — write a Python patch script to the scratchpad instead.

## Test isolation

Every DB-touching suite starts with `require('./lib/testdb').use('<name>')`
**before any Prisma import**. Tests run on a disposable local PostgreSQL
cluster — initialized once by `npm run test:pg:up` into
`%USERPROFILE%\.ticketing-test-pg` (loopback-only, 127.0.0.1:5433) with its
credentials in `server/.env.test`. `use()` drops and recreates a per-suite
database, applies the committed migration history with `prisma migrate
deploy`, and drops the database again afterwards. The helper refuses Supabase
hosts, non-loopback hosts (unless `ALLOW_REMOTE_TEST_DATABASE=1`) and anything
resolving to the application's own `DATABASE_URL`/`DIRECT_URL`. A full run
leaves the application database — and the vestigial `server/prisma/dev.db` —
untouched. Suites create their own fixtures — never assume seeded accounts
exist.

## Intentionally NOT implemented

- **Microsoft Entra ID authentication.** The seam exists
  (`provisionUserFromIdentity`, `Agent.externalId/externalProvider`) but nothing
  calls it. Sign-in is local password only.
- **Live Microsoft Graph verification.** Polling, webhooks and subscription
  renewal are written and tested against mocks; they have never run against real
  Microsoft credentials.
- **Object storage beyond the local filesystem.** Attachment bytes are stored
  and served (`src/services/attachmentStorage.js`, local private directory by
  default), but only behind the injectable `put`/`get` provider seam — no S3 or
  Azure Blob provider is implemented.
- **Firebase.** Not used anywhere. (Supabase, by contrast, **is** the
  production PostgreSQL host.)

## Known issues

See `docs/PROJECT_STATE.md` — that file is the live list.
