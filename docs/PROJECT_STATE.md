# Project State

Current checkpoint. Update this at the end of every task.
Architecture and conventions live in `../CLAUDE.md`.

_Last updated: 2026-10-21_

## Current Phase

The helpdesk no longer files tickets about its own people's mail. A message from
one of your accounts that only *copied* the helpdesk mailbox opens no ticket,
because the department was shown a conversation, not asked into it. (Before
that: a greeting reaches the person it names — "Dear Bash," is Bashir's ticket,
not the quietest agent's — and a birthday or farewell notice opens no ticket at
all.)

## Completed

- **Ubuntu production cutover (2026-11-11).** Verified a fresh database dump,
  started the Ubuntu container, and pointed Nginx at the local application.
  Public HTTPS health and frontend checks passed, and invalid intake and
  confirmation requests reached the application's handlers. Fly billing blocked
  changing automatic start. The Fly machine was cordoned and stopped, then
  stopped again after one restart. A subsequent request to the old endpoint
  timed out and Fly still reported the machine stopped.

- **Live DNS reached Ubuntu (2026-11-11).** The A record was switched before
  the container started. Issued and installed a trusted certificate with
  HTTP validation and configured the renewal reload hook. Nginx temporarily
  forwards to the healthy Fly app over verified TLS. The public frontend and
  health check pass. Ubuntu production remains stopped pending Fly control
  access and the application handover.

- **Ubuntu web ports verified (2026-11-11).** Nginx listens on 80 and 443,
  redirects HTTP to HTTPS, and proxies to the loopback application port.
  Both listeners responded from outside the VM. HTTPS uses a temporary
  self-signed certificate, and the upstream container is stopped pending
  cutover. Install a trusted certificate before directing users to the VM.

- **Ubuntu deployment staged (2026-11-11).** Installed Docker and Compose on
  the new VM and built `helpdesk:2026-11-11` from the scanned release package.
  All 17 migrations applied to isolated PostgreSQL, and the container served
  the health endpoint and production frontend. A read-only check found the
  production schema up to date. Staged the root-owned configuration and created
  the production container in `/opt/helpdesk`. HTTPS routing and the live
  handover remain pending.

- **Linux production configuration prepared (2026-11-03).** User reports image
  build succeeded; Compose syntax check passed with the empty configuration
  file. Exported 34 allowlisted runtime environment variables from the live
  Fly machine to a git-ignored, user-restricted local configuration file.
  No values displayed and no container started. Secure transfer to the VM,
  configuration verification and HTTPS/cutover remain outstanding.

- **Linux migration package prepared (2026-11-03).** Ubuntu VM has Docker and
  Compose installed; user verified SSH from their Windows computer to the VM.
  Exported allowlisted application sources from the live Fly instance and
  overlaid the four prepared copy-only intake/parser/admin-setting files.
  Package and SHA-256 file manifest are under git-ignored
  `.scratch/linux-release-2026-11-03/`; all 222 packaged files passed the
  repository secret scanner. No environment files, mailbox data, attachment
  cache or dependencies were included. Package has not yet been built on
  Linux or started. Production configuration, HTTPS, backup/migration review,
  updates and single-instance cutover remain outstanding; Fly stays running.

- **Linux VM setup guide (2026-10-23).** Created the simplified seven-page
  Word guide at `docs/exports/Helpdesk Linux VM Setup Guide.docx`, with its
  text source at `docs/linux-vm-helpdesk-setup.md`. Covers host identification,
  separate Linux VM creation, Ubuntu and Docker, existing Supabase and Power
  Automate configuration, HTTPS access, single-instance cutover, rollback and
  maintenance. Uses example placeholders only. Standard renderer lacks
  LibreOffice on this host; exported through Word and inspected all seven
  rendered pages. No server, domain or deployment changes were made.

- **Laptop-payment correspondence excluded (2026-10-23, live setting).**
  Investigated screenshot INC-001926 (id 1843). Retained audits show creation
  at 12:21 UTC and deletion at 12:24 UTC; no ticket remains. Its sender has no
  registered account, and relevance triage returned disposition=ticket with
  reason=no_action_required, policy=not_skip. Original recipient headers are
  unavailable from the retained audit, so copy-only status was not asserted.
  Added the specific full subject, stripped of reply prefixes, to the audited
  `intakeIgnoredSubjects` setting using the deletion snapshot. Verified live
  screening for original/reply/forward variants, preserved prior exclusions,
  and checked an unrelated laptop request does not match this new entry.
  No deployment, sender-wide exclusion, mail send or further deletion.

- **Copy-only intake correction (2026-10-23).** INC-001925 was a manager's
  instruction to two colleagues, with an unconfigured department alias on Cc.
  Its triage decision was informational_announcement but attachments vetoed
  suppression. Added explicit `intakeInternalDomains` for employees without
  accounts, exact-domain matching, and direct-To precedence across all intake
  aliases. Added an admin field and regression coverage. Fixed dated iPhone
  attribution lines with sender addresses so unprefixed history cannot affect
  classification. Four focused server suites, client checks and build pass.
  INC-001924's source actually includes a configured helpdesk address on To;
  it remains accepted by the direct-address rule. Existing tickets retained.
  Four-file release prepared from current live sources in `.scratch/copy-release`;
  Fly rejected the build because the hosting account has overdue invoices.
  The new domain setting and parser change are not deployed.
  Applied the missing department alias immediately through the audited live
  settings service. Re-exported INC-001925 and verified the live screen now
  suppresses its copied-only shape while direct requests still pass. No mail
  was sent and no existing ticket was deleted. After deployment, run the guarded
  `.scratch/copy-configure.cjs` on the server to enable the verified organisation
  sender domain; it preserves existing settings and verifies both outcomes.

- **Pickup acknowledgement ticket removed (2026-10-22).** Investigated
  INC-001922: relevance triage recommended skip/no_action_required, but
  attachment_present vetoed suppression; reply references matched no stored
  ticket/comment. At the user's explicit request, privately archived and deleted
  only INC-001922 (id 1839) in a guarded transaction with a retained deletion
  audit. Verified no matching ticket remains. Original mailbox message intact.
  No new pickup-screening rule was added in this task.

- **Vendor conversation intake exclusion (2026-10-22, live setting).**
  User identified INC-001921 as non-helpdesk vendor coordination. Its sender is
  not a registered account, so internal-copy screening did not apply. Added
  the specific vendor reference `IN00003901` to `intakeIgnoredSubjects` through
  the audited settings service, preserving all prior exclusions. Verified the
  live screening service skips new-ticket candidates for the original subject
  and reply/forward variants; other vendor references remain unaffected.
  Existing ticket retained; no deployment or mailbox changes required.

- **Qualitative weekly report wording (2026-10-22, deployed).** Summary and
  accomplishments now omit exact activity totals: single work has no quantity,
  repeated work uses multiple/several. AI receives frequency labels instead of
  raw counts; validation rejects unsupported digit and written totals. Factual
  fallback follows the same policy and preserves project status and technical
  names. Stored activity counts and existing drafts remain intact; regenerate
  to use the new wording. Weekly-report suite passes on disposable PostgreSQL.
  Scoped writer-only release `deployment-01M5HYWAJWCAZQPS9D9ZTWKMTN`
  deployed on the existing machine. Smoke/health and DNS checks passed; live
  writer hash and synthetic qualitative generation verified without changing
  saved reports or calling the AI provider. Public health passed.

- **Weekly report workspace refresh (2026-10-22, deployed).** Implemented the
  approved page layout without editing the navbar or shell: readable week
  navigation, compact expandable activity rows with quick counts, All/Recorded/
  Favourites filters, separate Activities and Report preview tabs, folded setup
  and shared activity management, and a sticky readiness/action bar. Report
  wording now autosaves with serialized snapshots, in-flight edit retention,
  failure pause/retry and flushing before navigation/generation/export. Previous
  report notes require a selective comparison before replacement. View checks,
  full client checks and production build pass. Mocked browser checks cover
  counters, filters, selective carry-forward, generation/export, wording saves,
  in-flight edits, conflict retry, stale reports and week navigation; overflow
  checks pass at 320/390/768/900/1440px. Browser screenshots inspected in light
  and dark. No backend or database changes. Scoped eight-file frontend release
  `deployment-01M5HY5NK67HD18YR0V9VB12N4` deployed from the prior live image;
  live CSS diff contains only weekly-report additions. Single-machine status,
  smoke/health checks and DNS passed. Public health and deployed bundle checks
  passed; browser checks against the deployed frontend with mocked API data
  also passed, without changing production report records.

- **Suggested resolution notes (2026-10-22, deployed).** Resolve dialog offers
  three editable outcome-focused notes for each fixed ticket category. Selecting
  a suggestion explicitly replaces the draft; agents review/edit before the
  existing resolve action. Wording lives in `client/src/resolutionView.js`.
  Client checks (including the new resolution check) and production build pass.
  No backend, lifecycle or notification changes. Scoped two-file frontend
  release `deployment-01M5HRG9AFK1TTYXTJT9QXW9BY` deployed from the prior live
  image, preserving unrelated local work. Existing single machine, smoke/health
  checks and DNS passed; public health and the live ticket bundle verify the
  suggestions are present.

- **Existing-thread identity backfill (2026-10-21).** Investigated INC-001915:
  created 13:35 UTC, nine minutes before the adapter release at 13:44 UTC.
  Its RFC reply references have no current Ticket/Comment target; no current
  earlier transformer ticket exists. Original MIME exports verified the RFC
  identity, requester and Outlook thread root for all 11 current email tickets.
  Backfilled only null conversation identities with compare-and-set guards in
  two audited transactions (10 plus one export retry). Zero email tickets now
  lack a conversation identity. Read-only execution of the actual resolver
  confirms a same-requester follow-up matches INC-001915. No tickets/messages
  were merged or deleted; ownership, lifecycle and ticket numbering unchanged.
  Private source-verification manifests are in git-ignored server/backups/.

- **Reply splitting diagnosis and Outlook identity fix (2026-10-21, deployed).**
  Live INC-001907/001911 share the same requester and Outlook Thread-Index
  root, but their exported MIME contains no In-Reply-To or References. The
  adapter discarded Thread-Index and stored no conversation identity, so the
  later reply opened a ticket. Adapter now derives a namespaced conversation
  identity from a validated 22-byte Outlook root, retaining RFC-reference
  precedence and the existing same-requester restriction. Separate roots,
  malformed indexes and different senders are covered. Power Automate, email
  parser, IMAP and IMAP OAuth suites passed (4/4); secret scan clean. Scoped
  one-file release `deployment-01M5FB7SJCEEMX03PTHB57Q1ZR` deployed on the
  existing single machine. Machine/DNS checks and a deployed parser-only
  original/reply identity test passed without ingestion or sending email.
  Existing tickets have null identities and need a
  source-verified backfill; no live tickets were changed or merged. SIM-card
  pair INC-001900/001912 is another likely split, not yet source-confirmed.

- **Health awareness announcement screening (2026-10-21, deployed).** INC-001913
  exposed a gap between greeting banners and general informational mail.
  Deterministic intake now screens health awareness sessions only with matching
  subject, broadcast audience, organised/scheduled session and health evidence
  in cleanBody. Narrow informational phrases do not count as requests; other
  request words veto screening. Missing prose fails open, permitted subjects
  and existing-ticket replies retain precedence. Intake-screening regression
  coverage includes the screenshot wording and genuine IT requests. Intake
  screening suite and secret scan passed. Scoped one-file release
  `deployment-01M5F8PM9TNDM02GWHQMPRT7S2` preserved the existing single machine;
  deployed source hash matches local, machine checks and public health passed.
  At the user's request, archived and deleted only INC-001913 in a guarded
  transaction (no replies or attachments), preserving AuditEvent history and
  ticket numbering. Ten other tickets remain. Private archive lives under
  git-ignored server/backups/; original mailbox message remains untouched.

- **Administrator assignment-group deletion (2026-10-20, deployed).** Added
  Delete group to the existing group editor with a confirmation step and
  backend-supplied availability/restriction text. The administrator-only
  service protects default/fallback groups, all primary/supporting memberships,
  active/inactive rules, current/originating ticket references and historical
  SLA references. A group row lock guards concurrent FK writers; deletion and
  `group.deleted` auditing are atomic, with audit history retained. Routing
  suite (16 deletion checks), assignment-group and audit suites, client checks,
  production build and secret scans passed. Scoped four-file release
  `deployment-01M5CESFSNQJJT0FR5PP2DN60H` rebuilt the live frontend, kept the
  existing single machine and required no migration. Live health and groups
  API returned 200; unused F is deletable and the default is protected.
  No production group was deleted during verification.

- **Launch security fixes and live pilot (2026-10-20).** Deployed a dependency-only
  image `deployment-01M5CDRNWG92PBJXTZ24VXQ1DT` onto the existing single
  machine. Local and deployed audits report zero vulnerabilities; live health
  passed, with no application-source, frontend-bundle or schema changes.
  Client checks/build passed; 52/53 server suites passed on the full run and
  the corrected duplicate-header parser expectation passed on rerun (all 53
  suites have passing results). Verified direct and department email intake,
  preferred Farook assignment, requester acknowledgement, same-thread
  reply/reopen, staff copy-only screening, resolve mail and two-step requester
  confirmation. Archived and removed both synthetic pilot tickets afterwards;
  final queue has zero tickets and numbering is preserved. Team availability
  confirmed by owner. CI audit/deployment gates prepared locally. Native flow
  failure-alert configuration is still pending access to the flow-owning
  account; David's session sees no owned/shared flows. Browser permission
  prevented a repeat live attachment upload; automated attachment coverage
  passed and prior live commissioning remains recorded below. See
  [launch-readiness.md](launch-readiness.md) for details and remaining action.

- **Pre-launch ticket reset (2026-10-20).** At the user's explicit request,
  removed all 134 existing tickets in one guarded transaction, including 240
  comments, 71 attachment references, 300 lifecycle audit rows, 9 conversation
  reads, 140 SLA cycles, 599 SLA events and 498 ticket notifications. Cleared
  another 57 legacy ticket notifications with null references afterwards.
  Final checks: zero tickets and in-app ticket notifications; live health 200
  with ok true. A private
  database backup passed restore/migration rehearsal on disposable PostgreSQL
  before deletion. Preserved 9 accounts, 7 groups, 20 memberships, 9 routing
  rules, 10 settings, administrative audit history, delivered-email metadata,
  mailbox messages and ticket numbering (global counter 1897). A reset audit
  event and private operation manifest record the action. Replaying old source
  emails can recreate tickets now their original identity rows are removed.
  Local production dependency audit reports 1 critical, 4 high and 7 moderate
  findings; remediation and verification of the deployed image remain pending.

- **Power Automate integration deployed; O365 sender enabled (2026-10-19).**
  Scoped backend release deployment-01M5AA6WCXG48GYJBTYCVNRESW layers ten
  reviewed application files over the prior live image, with no migration,
  frontend build or unrelated workspace edits. Incoming MIME intake is live:
  user verified readable ticket content, an attachment listing, and a requester
  reply threaded into the original ticket (INC-001889). Gateway authentication,
  failure responses, source export and an authorised shared-mailbox test send
  were commissioned; the user confirmed receipt. Production and local outbound
  flags are now enabled. Live runtime selected power_automate; a cutover test
  completed successfully through the durable notification sender, and public
  health passed after restart. Existing IMAP configuration remains available for
  historical sources; this cutover changes the selected notification sender.
  All notifications retain mailer.js and durable Notification delivery. Gateway
  requires explicit completion acknowledgement; HTTP 202 does not count as sent.
  Shared parsing preserves screening, RFC dedupe, threading and attachments;
  cache misses can re-export the source. Secrets remain environment-only and
  diagnostics expose booleans only. User declined credential replacement.
  Eleven affected server suites passed on disposable PostgreSQL; secret scans
  passed. No schema change. See power-automate.md for flow contracts, rollback
  and operational limits. Power Automate platform failure alerts are required;
  the IMAP watchdog does not monitor flows.

- **Measured loading improvements (2026-10-18, deployed).** Applied
  concurrent independent ticket-detail reads, selective mutation cache
  invalidation and a shared visible-page refresh clock. Desktop notification
  polling remains active in background tabs. See
  `loading-performance-2026-10-18.md` for methodology and limitations: detail
  median 31.4→21.8 ms locally and 556.1→320.9 ms with controlled 50 ms query
  delay; read receipts caused zero unrelated refetches versus three before.
  These are disposable/synthetic measurements, not production page timings.
  Client checks/build and four affected server suites passed. Deployed release
  `deployment-01M57CKYATB6PNASF1D97MKPS3` to the existing single machine;
  Fly smoke/health/machine checks and DNS passed. Public health, new entry and
  detail assets, immutable caching, production CSP and anonymous API rejection
  passed. Detail download timed out on the default local network path, then
  succeeded immediately over IPv4 (HTTP 200, 57,549 bytes). No schema or visual
  changes; production performance was not benchmarked.

- **Security/UX release and reply-alert removal (2026-10-18).** Deployed
  `deployment-01M57AJAWTSVTQK1HSS88RPSFZ` to the existing single Fly machine.
  Migration `20261018090000_revoked_sessions`, committed with its schema hunk
  as `b9555b5`, is applied and verified complete. A private read-only backup
  passed restoration/migration rehearsal with core rows and memberships intact.
  Local Prisma's production migration command returned an opaque engine error;
  the same committed migration succeeded from the deployment host, then table
  existence and migration completion were independently checked. Runtime is
  explicitly production. Received reply/reopen alerts no longer send to an
  assignee or DL; unread/conversation updates remain, and requester-facing
  emails remain active. Legacy queued alerts are expired before transport.
  Affected email/conversation/SMTP/operations/security suites: 6/6 passed, on
  top of the preceding 52/52 server regression and client checks/build. Machine
  health, DNS, public health and published CSP/assets passed release checks.
  The public sign-in screen also loaded in the browser without console errors;
  the new session route rejects anonymous calls and the published detail bundle
  contains the draft/save controls. No test emails were sent in production.

- **Security/UX review implementation (2026-10-18, local).** Rows 2–11 are
  implemented; see `security-and-ux-2026-10-18.md` for behavior, verification and
  rollout. Cookie sessions and durable logout revocation, script CSP, aggregate
  throttling, safe errors, staff-only workspace access, emailed staff response
  SLA, tab-scoped drafts, modal focus isolation, compact phone detail, explicit
  property saves, error retries and bounded initial conversation reads. Preserved
  navigation/theme tokens. Includes an additive RevokedSession migration, not
  applied to production. Final server regression: 52/52 suites passed on the
  disposable PostgreSQL cluster. Client checks/build and tracked/new-file secret
  scans pass. Browser checks use disposable data and production script CSP:
  drafts, explicit saves, enriched conversation preservation, pending edits,
  nested dialog focus/cleanup, light/dark and 360/390/768/1024/1366px layouts with
  no page overflow. Temporary UI harnesses removed after verification;
  screenshots/logs are outside the repository. Existing application data and
  deployment remain unchanged.

- **Read-only product review (2026-10-18).** Findings and evidence limits in
  `product-review-2026-10-18.md`: session/CSP containment, login aggregate
  throttling, raw route errors, draft loss, modal focus, phone inspector order,
  silent data errors, refresh-overwritten group selection, full-thread reads
  and synchronous bcrypt. Prior staff-email response-SLA discrepancy remains.
  Client checks/build passed; live public health and CSP checked. Dependency
  registry audit stalled; no authenticated browser or live performance audit
  was available. No application changes or deployment.

- **Conversation continuity (2026-10-14).** Restored a persistent Original
  request badge and kept the opening email visible in long threads. Added
  local date separators, exact recorded clock times, stable message numbers
  and explicit gaps for hidden replies. Quoted history opens directly from
  each email, sorted chronologically only with readable quoted dates. Unique
  earlier sender-address/text matches get compact links; full quoted copies
  and unmatched context remain available. Links reveal and focus hidden
  targets without changing the hash route. Renamed the stored-text disclosure
  View complete email. Existing standalone replies, attachment placement,
  unread behavior and threading permissions are preserved. Pure helpers and
  expanded conversation checks cover timezone boundaries, hidden/unread gaps,
  ambiguity, unknown senders, internal notes and quote preservation. Browser
  checked a nine-message synthetic thread in light/dark, link expansion/focus,
  and 390px phone wrapping/no overflow. All client checks, build and secret
  scan passed. Temporary preview files removed. Response-SLA treatment of
  staff emails remains a separate issue; no backend/database changes here.
  Deployed as `deployment-01M4X6KP0HFDQ5XQ62BHDAA3EP`; machine/DNS/public-health
  checks and published bundle checks passed. Browser verified the live ticket
  still has six separate messages, visible dates/clocks and the opening badge;
  its final quoted trail cross-references all four earlier messages, and the
  opening-message link focuses the correct entry without changing the route.

- **Ticket-detail mockup alignment correction (2026-10-14).** Corrected the
  initial styling-only pass after the user's live screenshots exposed its
  layout mismatch. The subject/metadata now lead the conversation panel,
  which joins directly to the composer. Person avatars, underlined tabs and
  grouped message diagnostics reduce clutter. The inspector uses compact SLA
  wording from slaView, with cycle dates/history and secondary account facts
  in disclosures; skill warnings and permitted actions remain visible.
  Phone layout keeps the subject above the inspector and conversation. The
  existing navigation and global header are unchanged. Actual components were
  browser checked with synthetic data in light/dark at 1366x900 and on a
  390x844 phone: no horizontal overflow, 16px inputs, actions within the
  desktop viewport, and thread correction still opens from Message details.
  Client checks, production build and secret scan passed. Temporary preview
  files removed before packaging. Deployed as
  `deployment-01M4X4XJQPPE4KTXQ0BKG4DBGG`; machine/DNS/public-health checks
  passed, published assets verified, and the user's live ticket page was
  refreshed and visually checked in the authenticated browser. The subject
  is inside the conversation panel, sender avatars and compact diagnostic
  disclosures are present, and the primary action is visible at the original
  desktop viewport. Navigation remains unchanged.

- **Ticket detail visual refinement (2026-10-14).** Applied the approved
  conversation/inspector direction using existing theme tokens. Soft message
  surfaces, amber internal-note edges and an unread divider improve reading;
  SLA now leads the single inspector, with existing primary actions moved
  into its Actions section. Navigation and global header are unchanged.
  Composer visibility controls now expose their pressed state and the input
  has an accessible name. All client checks (including mobile/contrast) and
  production build and secret scan passed. Deployed as
  `deployment-01M4X3VZPQCZCA18TB1J3TTZZR`; machine checks, DNS and public health
  passed. Live stylesheet and ticket-detail bundle verified to include the
  workspace styles and inspector actions. No server/database changes in this
  task. Visual browser verification remains outstanding.

- **Long weekly-review dialog fix (2026-10-13).** Fixed an overflowing review
  whose Generate report button was below the viewport. The review opts into a
  bounded flex modal with a keyboard-focusable scrolling activity region and
  fixed header/footer. Other modal layouts retain their existing behavior.
  All client checks/build and secret scan passed. Browser tested all 15
  activities with long descriptions at 1920x930, default desktop and 390x640;
  verified scroll position changes, footer visibility, no mobile horizontal
  overflow, and successful generation. Deployed image
  `deployment-01M4VAZK3G2G958WYR06PBV6N1`; machine/DNS/public-health checks
  passed. Live report bundle and stylesheet verified for bounded modal,
  scrolling activity region and pinned footer. No database/server changes.

- **Weekly report convenience improvements (2026-10-13).** Added personal
  account-backed favourites, serialized/debounced entry autosave, project
  progress/completion statuses and a review-before-generation modal with
  optional project/off-site description prompts. Preferences are separate from
  weekly report facts; existing draft fingerprints remain compatible when no
  project status is supplied. Completed-with-zero is rejected server-side.
  Carry-forward clears project statuses. Writer prompts, factual wording and
  AI passage validation respect explicit statuses. Client checks/build and
  expanded isolated weekly-report tests passed. Browser checked in-flight
  typing survives autosave/reload, favourites persist, review prompts appear,
  and generated project wording remains in progress. Migration
  `20261013180000_weekly_report_preferences` committed as `26e943f`.
  Applied migration to the application database (16 migrations current).
  Full server run 51/51 passed; final client checks/build passed, including
  serialization, in-flight edit retention and failure/retry checks. Browser
  also verified trailing spaces survive an autosave acknowledgement. Deployed
  image `deployment-01M4V77ZKH9CMD54H9SVYJGYJC` on the existing single machine.
  Machine/DNS/public-health checks passed. Live bundle includes all four
  improvements; authenticated preferences read, synthetic AI project-status
  wording and Excel export passed without writing production report data.
  Updated-file and tracked-file secret scans clean; local server environment
  secret file excluded from the image.

- **Weekly activity frequency choices (2026-10-13).** Replaced always-visible
  counters with native Not done / Once / Multiple times radio choices.
  Multiple times reveals a counter starting at 2, with direct entry and + / −.
  Existing saved numeric counts remain compatible; descriptions are preserved,
  and zero-count descriptions are explicitly labelled progress only. Pure
  interaction helpers live in weeklyReportView.js; the new region component is
  WeeklyActivityFrequency.jsx. All client checks and production build passed.
  Browser verified option changes, multiple-count restoration, minimum 2,
  direct entry and save/reload persistence on disposable PostgreSQL data.
  No server or database changes. Deployed image
  `deployment-01M4V67CNT5K4K0K8ZP2055Y3J` on the existing single machine.
  Machine/DNS/public-health checks passed; live weekly report bundle and
  stylesheet verified for all three options. Updated-file secret scan clean.

- **Weekly report writing and references (2026-10-13).** Added a reusable
  private Excel writing/formatting reference per agent, prior-report note
  carry-forward with zeroed new activity counters, Groq-backed grounded prose
  generation and a local factual fallback. Create Report writes the summary
  and four accomplishment sections; editable saved drafts export without
  regeneration. Current-input fingerprints prevent stale exports. Reference
  uploads reject macros, formulas, external links and excessive archive sizes.
  Expanded isolated server suite covers upload privacy, formatting retention,
  old-fact exclusion, counts, provider failures, edited drafts and throttling.
  Browser checked generation, editing, export and reference re-upload against
  disposable test data. Original supplied workbook parsing verified. Added
  migration `20261013150000_weekly_report_reference`, committed with the initial
  report migration in `76e6953` and applied to the application database (all
  15 migrations current). Full server run 51/51 passed, client checks/build
  passed, and focused report tests passed again after sizing model output by
  the number of recorded activities. Tracked/untracked application scans clean.
  Deployed image `deployment-01M4TJ8F2YWN6RD4TPM1P0X4P1` on the existing single
  machine. Machine/DNS/public-health checks passed. Live authenticated API,
  synthetic AI writing, Excel export and reference re-parsing passed without
  writing any production report data. Live bundle includes upload, AI wording
  and editable-draft controls. Local server environment secret file excluded.

- **Personal weekly reports (2026-10-13).** Added staff-only weekly counters
  and descriptions for the 15 supplied activities, custom activities,
  administrator-managed standard activities, report notes and preview, and
  Excel export using the supplied template's sanitized formatting. Optional
  attributed-ticket counting is off by default. Personal snapshots have no
  change history and concurrent saves are protected. Applied migration
  `20261013120000_weekly_activity_reports` to the application database; all
  14 migrations are current. Full server run 51/51 passed, all client checks
  and production build passed, tracked and 30 untracked application-file
  secret scans clean. Deployed image
  `deployment-01M4TENM4C26WMH0JRG7Z5VFVS` on the existing single machine.
  Machine checks, DNS and public health passed; live bundle includes the
  weekly report screen. Read-only authenticated live checks loaded all 15
  activities and verified the generated Excel workbook and prepared-by field;
  anonymous access returns 401. Image excludes the local server environment
  secret file. See `weekly-reports.md`.

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.


- **Assignment email ticket links (2026-10-09).** The ticket number in assignment
  notifications is an HTML hyperlink to the authenticated `#/tickets/:id` page;
  the text alternative includes the same URL. Configured public origin/subpath
  is used, with safe fallback for absent/invalid configuration. No access token
  is embedded and existing ticket permissions apply. Requester notifications
  retain their existing link policy. Email integration, SMTP and resolution
  suites passed, including safe URL configuration and escaping checks. Existing
  delivered messages are unchanged. Fly release
  `deployment-01M4FYM9SAGQYXDHYXZTDQ5331` passed health checks. A production
  builder check (without sending email) confirmed the configured origin, correct
  ticket route, text alternative and absence of embedded credentials; the
  unauthenticated ticket API still returns 401. A synthetic email preview was
  visually verified.

- **Outlook trails and checklist audit (2026-10-09).** Verified the intake
  ledger's sender/message identities, friendly outcome labels, sender/ticket
  links, reply activity timestamps, queue/detail reply markers, tests and docs.
  Message IDs are now expandable/copyable in the ledger. Complete Outlook
  From/Sent/To/Cc/Subject blocks separate historical mail without requiring an
  Original Message marker; expanded history renders individual header dividers
  and collapsed signatures. Regression coverage includes the helpdesk portal
  signature banner, legal footer, wrapped recipients, multiple older emails,
  explicit signature delimiters and angle-bracket address preservation.
  Stored messages are unchanged. Affected server suites, client checks, build,
  secret scan and a disposable browser preview passed. A read-only check of the
  reported ticket confirmed separate current/quoted text and the portal banner
  inside the quoted email's collapsed signature. Fly release
  `deployment-01M4FWN5JTZCCM6TQD3MVQGYQ4` passed machine/public health checks,
  released-asset checks and an authenticated read-only response check of the
  reported ticket: Outlook headers separated, portal signature recognised,
  full original retained. No live message content was changed.

- **Ticket conversation improvements (2026-10-09).** Conversation/Activity tabs,
  clear message types, expandable quote/signature/original text, five-message
  folding, message-local attachments, response ownership and per-account unread
  badges/dividers are implemented. Admins can inspect recorded matching evidence
  and move received replies with attachments to another open ticket, with a
  reason, transactional state checks and audits on both tickets. Historical
  matching reasons remain explicitly unknown. Existing text, statuses and
  ownership are preserved. See [ticket-conversations.md](ticket-conversations.md).
  All 50 server suites passed (48 in the full run, two after fixing test fixture
  assumptions about the harness's cleared inbound settings); client checks,
  production build, secret scans and isolated browser checks passed. The queue
  retains its existing read-performance budget. A private production backup
  passed restoration and migration rehearsal before the additive migration was
  deployed. Schema/migration commit: `a93efc4`. Fly release
  `deployment-01M4FVWGH4QT3207NNVNEHG24V` passed machine health checks;
  public health, released interface assets and authenticated read-only queue/
  conversation API checks passed. Browser correction tests used disposable
  tickets only; no live conversation was moved for verification.

- **SeeCode architecture diagrams (2026-10-08).** Created the interactive
  [system overview](../diagrams/ticketdesk-architecture.html) and
  [email intake detail](../diagrams/email-intake.html), with editable JSON specs,
  source evidence and PNG exports in `diagrams/`. They use the app palette and
  distinguish live IMAP intake from the unverified Graph alternative and
  optional relevance triage. Both render without warnings; PNGs were visually
  checked for readable labels and connections. Documentation only; no deployment.

- **Bulk close of unfinished tickets corrected (2026-10-08).** The original
  selection action reused the resolved-only endpoint, so selecting New tickets
  failed with `Invalid transition NEW -> CLOSED`. Queue confirmation now sends
  an explicit administrator override. A service permits New/In Progress closure
  only for admins with a note, compares state and ownership, writes both audits
  transactionally and ends the SLA cycle. Ticket resolution remains unstated;
  outstanding handovers are cancelled and the ordinary status notification is
  sent. Resolved-ticket confirmation behavior remains intact. Already-closed
  selections are harmless; failed rows remain selected. Regression coverage
  includes both open states, owner/administrator permissions, required notes,
  SLA finalization, repeat requests and concurrent closes. The ten relevant
  API, handover, SLA and resolution-confirmation suites passed, together with
  all client checks, the production build and secret scanning. No schema change.
  Deployed `deployment-01M4DDDBEC6WB0BP502WM274PJ` to the existing single
  machine; deployment health checks, public liveness and the live bundle's
  administrator confirmation text passed. No live ticket was closed for testing.

- **Application-wide loading improvements (2026-10-08).** Authenticated display
  reads now share a bounded, memory-only session cache: fresh reads reuse data,
  revisits show cached results while refreshing, and successful writes/session
  changes invalidate it. Visible pages refresh every thirty seconds and on
  focus; the header provides refresh/retry feedback. Background refresh preserves
  unsaved settings drafts and applied report filters. Navigation preloads page
  code on hover/focus. Dashboard and agent screens each use one primary request;
  ticket detail renders before its secondary panels finish loading. The queue
  still displays twenty-five tickets per page, now fetched as twenty-five compact
  records with server-wide sorting/filtering and a separate total. Bodies remain
  available in detail/search; existing API consumers retain the full list shape.
  The long-email fixture verifies over ninety percent less queue payload. All
  49 server suites, client checks, production build and tracked/new-file secret
  scans passed. Browser checks covered main screens, pagination/sorting, detail,
  cached navigation and preserving a settings draft during refresh. No schema
  change or infrastructure relocation. Deployed image
  `deployment-01M4D9JCAVNGR4ECHH1Q4RCREP` on the existing single machine;
  deployment checks, public health and live bundle verification passed.
  Authenticated loopback reads on the deployed machine returned 78 legacy
  tickets in 541,254 bytes versus 25 queue rows in 38,845 bytes (93% reduction).
  One sequential smoke sample measured queue 2.04s, dashboard 1.63s, agents
  1.01s and groups 1.11s; the legacy queue took 1.67s. These are server API
  observations, not end-user page timings or evidence of a faster cold queue
  query. Cached navigation and fewer requests improve perceived loading;
  server/database distance remains a separate infrastructure limitation.

- **Bulk closing and announcement cleanup (2026-10-08).** Queue selection now
  offers Close selected with a confirmation explaining the requester override.
  It uses the existing close endpoint sequentially, preserving permissions,
  RESOLVED-only transitions, compare-and-set writes and audits. Successful rows
  are deselected; failures remain selected with a reason. Birthday ticket
  INC-001831 predates the October 7 birthday-filter implementation; replaying
  its stored body through today's parser yields an empty clean body and screens
  it out. Country/age-prefixed independence greetings were missing from the
  banner patterns and are now covered, with request-preservation checks.
  Removed four confirmed non-ticket emails: INC-001755 (sales circular),
  INC-001810 (safety event), INC-001819 (independence greeting), INC-001831
  (birthday). One requester comment and fifteen notifications were removed with
  them; no attachments. Verified all four absent afterwards. Saved three narrow
  ignored-subject phrases through the audited settings service for these
  standing announcements; induction and exit notices remain untouched.
  Client checks/build, intake-screening and resolution-confirm suites, and
  secret scan passed. Deployed image
  `deployment-01M4D6P3S1DA4M6XWVQSXWECT4` to the existing single Fly machine;
  deployment health checks passed. Public liveness returns 200/ok and the live
  application bundle contains the new Close selected control. No schema change.

- **Stale page imports recover after deployment (2026-10-07), release 49.**
  An already-open browser referenced a retired Handovers chunk. The SPA
  fallback incorrectly answered the missing JavaScript request with HTML 200.
  Missing `/assets` files now return 404/no-store; entry HTML revalidates even
  through the fallback. Vite preload failures trigger one refresh of the current
  route, guarded in session storage for sixty seconds to prevent loops. The
  error boundary gives a friendly reload action if recovery cannot proceed;
  retry no longer repeats React's cached rejected import. Existing open clients
  need one manual refresh to acquire this recovery code. Client checks/build,
  chunk recovery checks, API/read-performance tests and secret scan passed.
  Live Handovers JavaScript returns 200 with JavaScript content type, retired
  assets return 404, authenticated handover inbox passes, and IMAP is healthy.

- **Loading regression fixed and deployed (2026-10-07), Fly release 48.**
  Release 47 projected memberships even for scalar-only agent selections and
  added relation round trips to authentication and queue reads. The adapter now
  loads only requested primary-group data, and Prisma relation joins retrieve
  nested records in one database read. The declared pool limit previously had
  no effect; it now sets the connection URL limit explicitly (maximum ten).
  Dashboard breakdowns share one aggregate; independent queue/calendar reads
  run concurrently. Client requests time out after thirty seconds instead of
  showing an indefinite loading state. The 48 existing server suites and the
  new read-performance suite passed, plus final API/SLA dashboard checks, client
  checks, build and secret scan. The new test pins five SELECTs maximum for a
  100-ticket queue, seven for the dashboard and mixed-state count correctness.
  Image `deployment-01M4BZ77CW9H5QFQ9PR27ZFND8` is running on the single machine.
  Before: sequential live dashboard 3.2s and queue 4.4s. After: three rounds of
  five concurrent authenticated page requests completed in 1.4–2.3s per request.
  These are API timings, not a guarantee for every user's network. Public health
  and private diagnostics passed; IMAP running with no reported error. No data
  migration or ticket mutation was required for this correction.

- **Delivery, intake administration and recovery improvements verified locally
  (2026-10-07).** Notifications now retain encrypted pending mail with bounded
  retries and administrator retry controls. The administrator settings panel
  exposes intake outcomes, explicit greeting aliases and a greeting tester.
  Seven agreed aliases were saved live. Primary assignment groups now derive
  from canonical memberships; committed migrations replace the legacy column.
  Rich diagnostics require administrator authentication; public health is
  liveness only. Unsafe database shortcuts were removed and obsolete SQLite
  artifacts and repair tools were archived and disabled. A private production
  backup passed restoration, migration and assignment-preservation checks in
  disposable local PostgreSQL. Provider backup retention remains unverified.
  All **48/48 server suites**, client checks and the production build passed.
  Deployed as Fly **release 47**, image
  `deployment-01M4BYH12QVV2CA2EDJRCSGN87`. A fresh private backup passed recovery
  rehearsal before rollout. The single old machine was stopped for both
  migrations, then the matching image started. Public liveness, authenticated
  operations/diagnostics, assignment groups and tickets passed live checks;
  unauthenticated diagnostics returned 401. IMAP polling is running with a
  successful poll and no reported error. See `operations-and-recovery.md` for
  recovery and rollout requirements.

- **All email alerts styled and deployed (2026-10-07).** Shared inline-styled,
  table-based layout covers assignments, new-ticket broadcasts, requester replies
  and reopens, acknowledgements, status/resolution updates, public agent replies,
  ownership/handover updates, SLA warnings/breaches, reports, and ingestion alerts.
  Navy branding, explicit ticket identifiers, structured facts, amber approaching
  breach and red breach headings. SMTP retains the original text alternative;
  Graph sends HTML when available. Requester HTML preserves the confirmation
  link; user text is escaped. Operational reports/alarms carry no ticket-reply
  instruction. Added the pure `test-notification-layout` suite to the full runner.
  All **47/47 server suites**, all client checks, production build, tracked and
  new-file secret scans passed. Fly **release 46** deployed the tested image
  `deployment-01M4BTMJT9TNXHM4ZEZ36WMACY`; one machine running, public health
  healthy, IMAP polling active with no error. Layout checks also passed inside
  the deployed image using mock transport (no real emails sent). Existing inbox
  messages retain their original layout; actual Outlook rendering is still to
  be observed on a newly delivered alert. `.freebuff/` is excluded from Docker.

- **Internal mail that only copied the helpdesk opens no ticket (2026-10-07).**
  INC-001838 was the plain shape of it: an IT lead mailed a station manager's
  vendor about a downed V.I. link, copied the department for visibility, and the
  shared mailbox received it. Intake saw a real sender, an alarming subject and
  words that read like a request, and filed a ticket about a conversation the
  helpdesk was shown but never addressed on — which then took an agent, a
  workload slot and an SLA. Six earlier screens existed and none could see it,
  because every one of them reads the *words*, and this message's words are a
  perfectly good request; what makes it not one is a header. So the new signal
  (`intakeScreening.screenInternalCopy`, checked second, after the permitted
  subjects and before the recall/banner rules) reads the headers instead: the
  sender must be a known `Agent` account — any role, active or not, since a
  leaver's last mail must not open a ticket either — **and** a mailbox this
  installation ingests from must be on Cc/Bcc **and not** on `To`. That last
  clause is the whole rule: addressed to us is a request whatever it looks like,
  copied to us is FYI, so an agent emailing the helpdesk directly still gets a
  ticket, an outsider who copies us still gets a ticket, and only the
  copied-internal case is dropped. It is the one signal here that can discard a
  real message, so it fails open at every step — no recipient headers (the
  portal and dev intake paths compute none), no configured mailbox address, an
  agent-table read failure, or `intakeInternalCopies=0` all mean "no evidence,
  open the ticket". `intakeMailboxAddresses` (`INTAKE_MAILBOX_ADDRESSES`)
  overrides the addresses, which otherwise come from `GRAPH_SHARED_MAILBOX` and
  `IMAP_USER`. `To`/`Cc` now travel from the parser through the intake payload
  (`toIntakePayload.recipients`) purely for this check and are never stored.
  `db:purge-automated` **reports** the own-account copy-in candidates and never
  deletes them: a `Ticket` row stores no headers, so the rule cannot be replayed
  against stored data and only its coarse sender half could be — far too broad to
  delete on, since most mail an agent sends that reaches the helpdesk at all was
  addressed to it deliberately. Pinned by `test-intake-screening` K1–K21.

- **The greeting resolves, and a greeting banner never opens a ticket
  (2026-10-07).** Two live problems, one shared cause. (1) The intake read asked
  the database for `{ id, name }` and nothing else, while
  `addressedRecipient` ranks candidates by `role`, `isActive` and `isAvailable`;
  every account therefore looked like a non-staff record, the candidate list
  came back empty, and the greeting resolved to nobody, so "Dear Bash"
  (INC-001836) went to whoever the routing rule preferred. The feature's own
  suite was failing 15 checks that had never been run. Three corrections in the
  same seam: the intake read selects the columns the match reads (plus `email`,
  which alias targets point at); a column the caller did not describe is now
  **unstated**, never a rejection, so no caller can silence the feature by
  omission; and the tiers gained a **leading fragment** ("Bash" in "Bashir")
  beside the trailing one — exact → suffix → prefix → interior, ambiguity still
  resolving to nobody. `intakeAddressedAliases` (env
  `INTAKE_ADDRESSED_ALIASES`) lets an administrator pin a nickname the derived
  tiers cannot separate ("yemi" also ends "Adeyemi") as
  `bash = Bashir Oladipo`; it is checked first and matched against every
  account, because it states who the message was written for — the engine still
  decides who may take the work and records why it refused. (2) HR's birthday
  notice became a ticket (INC-001831, INC-001835): nothing had configured it
  away, and the relevance gate may legitimately never vote on it (an unapproved
  sender, or the flyer's attachment, vetoes a skip).
  `intakeScreening.matchBannerSubject` now screens the message **shape** — the
  subject must open with a known banner after peeling a `Re:`/`Fw:` chain, carry
  at most `MAX_BANNER_TAIL_WORDS` words after it, and contain no request word in
  the subject or in the sender's own words (`cleanBody`; the corporate footer an
  HR notice carries is signature, which is why the veto never reads the raw
  body). "Happy birthday — kindly reset my password" still opens a ticket.
  `db:purge-automated` reuses the same predicate, and a dry run against the live
  database matched exactly the two birthday tickets and nothing else. Pinned by
  `test-addressed-routing` I1–I40 / J1–J5 (J runs the real intake pipeline) and
  `test-intake-screening` J1–J22.

- **A greeting names the agent — "Dear Dare," is Dare's ticket (2026-10-05).**
  An employee who needs one person wrote their name in the first line, and the
  ticket went to whoever happened to be quietest. New pure
  `services/addressedRecipient.js` reads the salutation from **`cleanBody`**
  only — the sender's own words, with quoted history and the signature already
  stripped — and resolves it against `Agent.name`. The division of labour is the
  point: intake decides only *who the message was written for*, and
  `assignmentEngine.assign({ addressed })` decides *who may take the work*
  through the gate it already owned (active, available, staff role, skilled
  enough, under the workload cap), ahead of the rule's preferred agent. A
  greeting is therefore never a qualification and never changes the **group**:
  the routing rule still owns the ticket, and someone pulled in from another
  group is admitted only for the low/moderate tier, the same
  `supportingMaxPriority` gate the cross-team fallback uses, so a high or
  critical ticket never leaves its group this way. Because there is no nickname
  column, the match is derived and ranked — an exact name part, then a trailing
  syllable ("Yemi" in "Ibiyemi"), then an interior fragment — and **ambiguity
  resolves to nobody**. Reading is strict for the same reason: only the first
  block, only known openers, never "Dear all/IT/Sir", so a trailing "Dear Yemi,"
  sign-off or a quoted "Dear X," cannot redirect a ticket. Every failure mode —
  no match, several matches, no `cleanBody`, a settings error — falls open to
  ordinary routing: never a wrong assignment, never a dropped ticket.
  `intakeAddressedRouting` (env `INTAKE_ADDRESSED_ROUTING`, default on) switches
  it off; `addressedByName` rides the `ticket.created` audit metadata. Pinned by
  the new `test-addressed-routing` — which was failing 15 checks on the day it
  was written; the 2026-10-07 entry above is that correction.

- **Deterministic recall and subject screening — a recall or a standing
  announcement never opens a ticket (2026-10-01).** Two messages reached the
  queue that nobody had asked for: an M365 message recall (`Recall: <original
  subject>`) and an HR holiday announcement. Neither was catchable before — a
  recall arrives looking like the original human sender, so an ignored-sender
  rule could never separate it from their real mail, and the announcement came
  from a real internal address with no automated header. `services/
  intakeScreening.js` now applies two more deterministic signals, before the
  relevance gate and with no model involved: the built-in recall subject marker
  (`Recall:`), and a new administrator **ignored-subject** list
  (`intakeIgnoredSubjects`, env `INTAKE_IGNORED_SUBJECTS`; case- and
  spacing-insensitive substring of the subject). A permitted subject (an
  induction plan) is still checked first and still wins. The recall *report*
  sender `Office365Reports@microsoft.com` joins the built-in ignored senders.
  `db:purge-automated` reuses the same rules and gains `--subject` for a one-off
  cleanup. Pinned by `test-intake-screening` I1–I16. Separately, the test
  harness stopped inheriting the relevance gate: `testdb.js` now clears
  `GROQ_API_KEY` and `INTAKE_RELEVANCE_*`, so a developer's real key and
  `auto_skip` can no longer make a suite attempt a live provider call. The three
  junk tickets that prompted the change (INC-001815/INC-001816, the duplicated
  holiday announcement, and INC-001817, the recall) were then removed with
  `db:purge-automated --ticket … --apply`.
- **Attachment bytes are a cache, and the mailbox is the archive (2026-10-01).**
  Storing inbound binaries forever was never the requirement — they only have to
  be *viewable* — so the local directory is now explicitly a cache and the source
  message is the record. New `services/attachmentFetchService.js` serves a view
  cache-first, then re-reads the source message by the identity the `Attachment`
  row already carries (`messageId` + `source`) through the same adapter that
  parsed it on intake (`imap/sourceFetch.js` searches by RFC Message-ID;
  `graph/sourceFetch.js` lists and fetches by message id), matching strictly by
  sanitized name **and** byte size — a near-miss reports unavailable rather than
  serving the wrong file. Consequences: a deploy or machine replacement now
  costs a re-read instead of the bytes, and a cache write that fails **no longer
  costs the ticket** (intake logs it and keeps the metadata row; the old
  contract threw before any row existed — D11-D14 updated deliberately).
  Eviction is `src/attachmentCacheSweeper.js` (`ATTACHMENT_CACHE_TTL_DAYS`,
  default 30, 0 keeps everything; `ATTACHMENT_CACHE_SWEEP_INTERVAL_MINUTES`,
  default 360). Viewing: png/jpeg/gif/webp are served with their real type and
  an `inline` disposition behind a strict allowlist and `nosniff`, so a ticket
  can render a screenshot in a modal; SVG, HTML and everything else stay inert
  downloads, and the client follows the new `previewable` flag rather than
  deciding for itself. `db:purge-signature-images` is no longer needed (eviction
  covers the same bytes). Pinned by `test-attachments` D11-D14, F8a-F8g and
  G1-G29, plus `attachments-check` D1-D10.

- **Admin force close of a pending confirmation (2026-09-29, same feature).**
  Closing a RESOLVED ticket — which is always awaiting the requester's
  confirmation — is now a first-class audited override: `applyStateChange`
  writes the close as a compare-and-set on `state = 'RESOLVED'` (a requester
  confirming in the same instant wins; the admin gets a 409 with refresh
  guidance instead of double-closing), stamps `via: force_close` in the trail,
  and the description names the overriding admin. The detail header's primary
  action reads "Force close…" for those tickets and the dialog spells out the
  override. Permission boundary unchanged: admins anywhere, the ticket's own
  agent, and nobody else. Pinned by H1–H12 in `test-resolution-confirm`.
- **Awaiting-confirmation indicator (2026-09-29, same feature).** Serialized
  tickets now carry `awaitingConfirmation` (true while RESOLVED) and, when
  auto-close is enabled, an absolute `confirmationAutoCloseAt` — both derived
  server-side in `serializeTicket` from one settings read per request (the
  confirmation window rides `slaCtx`). New pure module
  `client/src/confirmationView.js` (26 checks, `confirmation-check.mjs` in the
  client chain) shapes the chip label/tone; `ConfirmationChip` in `ui.jsx`
  renders it in the queue's status cell, the detail header and the inspector,
  which also gains an absolute "Auto-close" row. Window 0 shows the chip with
  no clock. Pinned by G1–G9 in `test-resolution-confirm`.
- **Requester resolution confirmation + auto-close (2026-09-29).** The resolve
  notification now carries a signed confirmation link (the one link any
  outbound email carries — a deliberate, documented exception to the no-links
  rule) to a public two-step page: GET shows the resolution, the button POSTs
  `POST /api/public/confirm-resolution`, which compare-and-set closes the
  ticket from RESOLVED only and audits `via: resolution_confirmation`.
  Unconfirmed tickets auto-close after `resolutionAutoCloseDays` (default 3,
  0 disables; admin-tunable on SLA Settings) via the new
  `src/resolutionSweeper.js` background job (conventions of the handover/SLA
  sweepers; interval read at boot from `RESOLUTION_SWEEP_INTERVAL_MINUTES`).
  New suite `test-resolution-confirm` (41 checks) registered in the runner
  (43 suites total); `sla-settings-check` and `test-sla-settings` updated for
  the two new SLA-group keys. Client: `#/confirm/:token` route,
  `ConfirmResolutionPage.jsx`, `api.confirmResolution`.
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

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-28)

- **A mis-levelled ticket can no longer happen by design.** INC-001787 (a
  Software ticket) read "Skill required L2 · Standard" while the request was
  first-line work. The cause was twofold: the seeded Software catch-all rule
  demanded MID, and the ticket screen printed a *group* figure
  (`config/assignment.config.json` → `categories` → `minSkillLevel`) as if it
  were the ticket's own requirement — two sources of one rule, free to drift.

- **Skill requirement is now the engine's answer for the ticket.**
  `assignmentEngine.requiredSkill({category, priority, text, subject, teamId})`
  returns the bar of the rule governing the ticket *inside the group that owns
  it*, plus the priority boost (`high` +1, `critical` +2, capped at 3) — the
  exact figure `assign()` gates on. `GET /api/tickets/:id` exposes it as
  `requiredSkillLevel` / `requiredSkillRule`; `routingService.matchRule` gained
  an optional `teamId` scope so another group's rules cannot answer for a
  ticket. Derived on read, never stored, so correcting a rule corrects every
  ticket it governs — past and present — with no backfill. The inspector reads
  it through the new pure module `client/src/ticketSkillView.js` (pinned by
  `ticket-skill-check.mjs`, 26 checks), falling back to the group bar only for
  payloads that predate the field.

- **Software is first-line work.** The Software catch-all now requires JUNIOR,
  and a new `Software (Advanced)` rule (category Software, priority 5 — ahead
  of its own catch-all at 6) keeps MID for wording that is genuinely advanced:
  `error code`, `crash/crashes/crashing`, `blue screen`, `not responding`,
  `corrupt`, `data loss`, `licence|license server`, `enterprise application`,
  `integration failure`, `deployment failed`, `rollout`, `database error`,
  `application server`, `script failure`. Plain install/update/access requests
  stay L1.

- **One source for a group's skill bar.** `config/assignment.config.json` no
  longer carries a `categories` map (a second copy of the category→group/skill
  rule). `/api/assignment-groups` and `assignmentPoolService.listGroupPools()`
  both read `assignmentEngine.groupSkillBars()` — the lowest minimum skill among
  a group's active rules, keyed by team id — so a screen can never advertise a
  bar the engine does not apply. This also fixed the opposite drift: the Network
  Team advertised L1 while its rule demanded MID.

- **Live-data correction: `db:relevel-software`** (dry run by default, `--apply`
  to write) brings an installation whose Software rules were seeded before the
  policy in line: a keyword-free Software rule is lowered to JUNIOR,
  `Software (Advanced)` is created from the seed when missing,
  administrator-authored keyword rules are reported and left untouched, and both
  writes are recorded in `RoutingRuleAuditLog`. It prints the before/after
  effect over the Software tickets already raised; **no ticket row is written**.
  Verified end to end on the disposable test cluster (18 checks: dry run →
  apply → idempotent, audits written, ticket rows untouched).

- **What the live dry run found (2026-09-28).** The deployment's Software
  catch-all (rule #10) is **already at L1** — so INC-001787's "L2 · Standard"
  came entirely from `assignment.config.json`'s `categories` map, the removed
  second source, while the engine was gating at L1 all along. 16 software
  tickets exist; 1 asks for L2 or more today (a high-priority one, via the
  documented boost). `--apply` would therefore only create `Software
  (Advanced)`, after which 3 of 16 ask for L2 or more. **`--apply` has NOT been
  run** — adding the advanced rule is a policy choice (advanced wording would
  go back to L2), not a correction. New suite pins: `test-routing` (seeded-rule
  contract + per-ticket derivation + the ticket detail payload),
  `test-assignment-pool` (B13–B16: the advertised bar follows the rules).

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-26)

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
  attachments. **Superseded 2026-10-01 — no longer needed.** Cached bytes are
  evicted on their TTL and a re-read is routine, so those rows are now just
  metadata; `--apply` was never run and does not need to be.
  Suites green: parser (182), attachments, email-sources, classifier-seam,
  email-rules, email-integration, imap, ingest, triage ×2, screening,
  graph-mailbox, m365.

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-26, resumed)

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

- **Concurrent intake is a duplicate, not an error.** The production IMAP
  poller logged `Unique constraint failed on the fields: (graphMessageId)` at
  `ticketIntake.js`, then a `created` outcome 1.4 s later — the two Fly
  machines both ran the poller, both listed the same unseen message, both
  passed the dedupe pre-check, and one lost the insert race. That pre-check is
  a check-then-act pair, so the unique index — not the check — is the real
  idempotency mechanism, and the loser used to throw P2002, be recorded as an
  ingestion error, and leave the message unseen for a retry that would race
  again. `isMessageIdentityConflict` + `resolveRaceWinner` now treat a lost race
  on either message-identity column as `duplicate`, resolving to the WINNER's
  ticket. Any other P2002 (a ticket-number collision) still propagates. Guarded
  in BOTH create paths — the ticket insert and the requester-reply insert, which
  has a transactional and a plain variant. The reply guard sits outside that
  branch precisely so one guard covers both. Pinned by a new concurrency section
  in `test-email-ingest` that ingests the same message twice concurrently and
  asserts one `created`, one `duplicate`, one row, and no rejection — for the
  ticket path AND the reply path. The comment in `server.js` claiming a second
  instance is "merely wasteful, not incorrect" was wrong and is corrected.

- **The unauthenticated health endpoint no longer publishes the ingestion
  target.** `GET /api/health` returned the live shared mailbox address, the
  notification URL, and (via the subscription object's own `notificationUrl`)
  the deployment's own domain — to anyone, which partly defeated the scrubbing
  in `2614977`. It is deliberately unauthenticated (it is the liveness probe),
  so the values are now reported as `mailboxConfigured` /
  `notificationUrlConfigured` booleans and stripped from the subscription shape.
  Administrators read the real values from `GET /api/microsoft-365`, which is
  behind `requireAdmin`. Pinned by F10–F17 in `test-email-sources`, which now
  configures a complete Graph block so the assertions cannot pass trivially.
  F17 exists because the *first* fix missed the subscription path and F11 caught
  it.

- **Scaled to ONE Fly machine (`fly scale count app=1 --yes`, 2026-09-27).**
  Machine `802031f61dde38` was destroyed, leaving a single `7813572fd93dd8`
  (release v36). The second machine was an accident of the
  first deploy on 2026-09-10 (created 27 s apart, never reconciled because
  `min_machines_running` is a floor, not a ceiling) and it was silently breaking
  roughly half of all attachment downloads, because attachments live on each
  machine's own local disk with no shared volume. Post-scale verification:
  both fly.dev and the custom domain answer 200; `ok: true`; IMAP polling live
  and advancing (confirmed the `lastPollAt` timestamp moves on its own, so it is
  a real poller, not a stale snapshot); `lastError` empty; `/api/teams` still
  401 unauthenticated and a forged public-status token still 404s; the health
  payload still contains no `@`, no mailbox and no deployment domain.
  Cost is now halved and the background jobs are genuinely single-instance.

  **Scaling BACK UP is not a one-liner.** `fly scale count app=2` is easy, but
  three things assume one process and are not safe at two:
  1. ~~**Attachments** — local filesystem, no volume, no object storage.~~
     _(Resolved 2026-10-01 by design, not by adding storage: the bytes are a
     cache and the source message is the archive, so an empty cache costs a
     re-read rather than the file, and two machines may each hold their own
     cache. No S3/Azure provider is needed. See the 2026-10-01 entry.)_
  2. **`rateLimit.js`** — in-memory `Map`, so each machine keeps its own
     buckets and login throttling on `/api/auth/login` silently HALVES. A
     security regression. Needs a shared store (Redis or DB-backed).
  3. **Background jobs** — the rebalancer, handover sweeper, SLA sweeper and
     report scheduler have no leader election, so all of them would run twice
     and could fight. Email ingestion alone is already safe thanks to the
     P2002/`duplicate` handling above.

  Scaling down is not a one-way door: all three fixes are additive and leave the
  single-machine case unchanged.

- **Note — CI never auto-deploys this branch.**
  `.github/workflows/fly-deploy.yml` triggers only on push to `main`/`master`,
  so work on `post-deployment-v1` is deployed by hand with
  `fly deploy --remote-only`. Releases v20 and v21 have been stuck in `running`
  state since 2026-09-24 (harmless, superseded).

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

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-24)

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


## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-16)

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

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-14)

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

## Completed

- **Aligned SLA pairs, option 01 (2026-10-12).** Queue SLA clocks render as
  fixed label/value pairs without pill backgrounds. Labels remain neutral;
  exceptional values retain explicit Missed/Overdue wording and a coloured
  dot. Values use tabular numbers and no wrapping. SLA column widened to
  248px; mobile cards give SLA a full-width row. Derived SLA values and backend
  rules are unchanged. Client checks, production build and secret scan passed.
  Deployed release deployment-01M4QQEX7VB2ZDKV590DYZA0P3; machine
  checks, DNS and public health passed. Live stylesheet index-BVnd-s9k.css
  verified for aligned pairs, transparent alerts and full-width mobile SLA.


- **Queue dividers and visual cleanup (2026-10-12).** Clearer horizontal row
  borders plus subtle vertical separators group identity, workflow, SLA and
  ownership. Group labels and healthy SLA clocks lose extra pill backgrounds.
  Group/agent content is bounded with ellipsis and full-name tooltips; avatars
  retain their size. Mobile cards explicitly remove vertical separators.
  Client checks, production build and secret scan passed. Deployed release
  deployment-01M4QPYD21NZP8WWS49JQKM9JP; machine/DNS checks and public
  health passed. Live stylesheet index-DiXXxUIu.css verified for separators,
  plain healthy SLA clocks and bounded group labels. No backend changes.


- **Lifecycle badge colours (2026-10-12).** Shared badges now use blue for New,
  violet for In Progress, green for Resolved and grey for Closed. Moderate
  priority remains neutral; High/Critical stay amber/red. Existing theme
  tokens and one shared component rule set cover both themes. Client checks,
  including badge contrast >=4.5:1 in light/dark, production build and secret
  scan passed. CSS-only product change. Deployed release
  deployment-01M4QNB8514GT1F9DPS6C1W7QG; machine checks, DNS and public
  health passed. Live stylesheet index-CRLt4-T6.css verified to contain
  the blue New and violet In Progress rules.


- **Queue release verification (2026-10-12).** Resolved the earlier session's
  process-spawning blocker without changing testpg: the disposable local
  PostgreSQL cluster starts normally here. Full server run: 49/50 passed,
  including SLA overdueMs, SLA dashboard/report, API and workload. The sole
  public-status rate-limit failure passed on immediate rerun; the test now
  pins 127.0.0.1 so address-family selection cannot split its per-IP bucket,
  and passed again. All 50 suites therefore have passing results, though the
  original full run was not completely green. Client checks and production
  build passed; tracked-file and 21 new application-file secret scans clean.
  No uncommitted migrations. Fly browser sign-in completed. CLI auto-upgrade
  failed during download; restored its existing executable and DLL backups
  and disabled update checks for this release. Final release: deployment-01M4QMY2K6Z42WDRADWGJXX1PE.
  Machine checks and DNS passed; public health returns only { ok: true };
  released bundle index-ChKTUvMS.js contains the queue quick views and
  response-owner wording. Remote inspection confirms only example environment
  files remain, with no local environment secret files.
  Packaging inspection found /app/server/.env present in the initial image:
  root-only Docker ignore patterns missed nested env files. Added recursive
  env exclusions and rebuilt; credentials from prior image copies require
  rotation under docs/credential-rotation.md. No values were displayed.
  Dependency audit (production dependencies): 1 critical, 4 high, 6 moderate;
  remediation remains a separate follow-up.
 This Session (2026-09-25)

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
2. Verify the primary-membership migration before production deployment (implemented 2026-10-07).

## Known Issues

- **Viewing an attachment depends on the mailbox credential.** Bytes are cached
  and re-read from the source message on a miss, so if the mailbox cannot be
  reached, an *uncached* attachment reports "no longer available". Same message
  the old lost-blob path produced, so nothing regresses — but it is the reason
  the ingestion credential health matters beyond ingestion.
- **The Graph re-read path has never run against live credentials**, like the
  rest of the Graph integration. The IMAP path (the live deployment) is the one
  exercised by `test-attachments`.
- **A cached byte is kept for `ATTACHMENT_CACHE_TTL_DAYS` (default 30).** That
  is a retention policy, not a limit: raise it, or set 0 to keep every cached
  file, if an installation wants attachments to stay on disk.
- **The dashboard KPI cards carry no trend line.** _Accepted, not a defect._
- **The Agents table scrolls horizontally at ~1440px.** _Accepted, not a defect._
- **Microsoft Graph has never run against live credentials.**
- **Background workers remain single-instance by design.** More than one
  server process can duplicate polls; the live deployment has one machine.
- **Schema changes must ship as committed migrations.** `prisma migrate dev` /
  `reset` cannot be used against the application database — they can reset it.
  Apply `server/prisma/migrations/` with `npm run db:deploy`.
- One ambiguous ticket kept: `INC-000724` "PC is overheating".
- **Removing a supporting membership does not retroactively check current
  assignments.** If an agent holds a high/critical ticket from a group they are
  removed from as a supporting member, the ticket stays with them. The
  assignment engine only gates at time of assignment.

- The earlier duplicate-message write failure is fixed in intake: unique
  identity conflicts resolve to the existing ticket/comment instead of throwing.
  The previous production health error is historical, not a current incident.

## Last Verified

**2026-10-01**, after the deterministic recall/subject screening change:

- `cd server && npm test`: **45/45 suites passed** on the disposable local
  PostgreSQL test cluster — 0 failures anywhere in the run (incl. the extended
  `test-intake-screening`, section I1–I16 added)
- The junk tickets this change is about were removed from the application
  database with `db:purge-automated --ticket INC-001815 --ticket INC-001816
  --ticket INC-001817 --apply` (65 → 62 email+portal tickets; 0 comments and 0
  attachment rows on any of them; the unrelated vendor tickets INC-001804/001805
  were left untouched)

**2026-10-01**, after the attachment-cache change:

- `cd server && npm test`: `test-attachments` (incl. the new section G, 29
  checks) plus `test-api`, `test-e2e`, `test-email-ingest`, `test-graph`,
  `test-graph-mailbox`, `test-imap`, `test-imap-oauth`, `test-lifecycle`,
  `test-sla-settings` and `test-resolution-confirm` all pass on the disposable
  local PostgreSQL test cluster. The remaining suites were not re-run in this
  session (the change does not touch them).
- `cd client && npm test`: all check scripts pass, including the extended
  `attachments-check.mjs` (preview section D) and `mobile-check.mjs`
  (0 failures)
- `cd client && npx vite build`: Vite production build passed

**2026-09-29**, after the requester resolution-confirmation feature:

- `cd server && npm test`: **43/43 suites passed** on the disposable local
  PostgreSQL test cluster (incl. the new `test-resolution-confirm`, 41 checks)
- `cd client && npm test`: all check scripts pass, including `mobile-check.mjs`
  (619 assertions, 0 failures)
- `cd client && npx vite build`: Vite production build passed
- `npm run scan:secrets`: clean

**2026-09-27**, after the pending-deployment audit and the two fixes it found:

- `cd server && npm test`: **41/41 suites passed** on the disposable local
  PostgreSQL test cluster
- `cd client && npm test`: all check scripts pass, including `mobile-check.mjs`
  (0 failures)
- `cd client && npx vite build`: Vite production build passed
- `npm run scan:secrets`: clean
- The local test cluster on 127.0.0.1:5433 had drifted from `server/.env.test`
  (password authentication failed). Fixed by resetting the cluster's `postgres`
  password to match `.env.test`; `test:pg:status` then reported
  "identity verified". `pg_hba.conf` was briefly set to `trust` to make that
  reset possible and has been restored byte-for-byte from a backup.

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
