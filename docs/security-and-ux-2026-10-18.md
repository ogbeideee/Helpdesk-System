# Security and usability improvements — 18 October 2026

Implements rows 2–11 of the product-review summary. Released on 18 October 2026
as `deployment-01M57AJAWTSVTQK1HSS88RPSFZ` after a verified backup/recovery rehearsal
and the committed session migration. Redundant received-reply/reopen emails
were also discontinued at release; requester-facing mail remains active.

## Behavior

- Browser login uses a 12-hour HttpOnly cookie, Secure in production and
  SameSite=Strict. New browser login returns no JWT. The browser keeps only a
  random session-change marker in localStorage; existing browser bearer sessions
  convert on account validation without extending expiry. API bearer clients
  retain their existing contract.
- Logout persists a SHA-256 digest in RevokedSession and clears the cookie. Both
  cookie and bearer requests check revocation, including after a server restart.
  Cookie mutations require a matching Origin or same-origin Fetch Metadata.
  Cookie login also rejects foreign browser origins. Password-change invalidation
  remains in place. Non-staff accounts are denied ticket workspace API access,
  including remote-session reads; self profile/account access remains available.
- Production CSP allows same-origin scripts and hashes the exact inline theme
  boot script from the built HTML. Script attributes, objects, framing and foreign
  script sources are blocked. React inline styles remain permitted. Development
  retains Vite HMR. Route-local 5xx JSON is sanitized as well as central errors;
  production cannot enable raw error detail. Central logs omit raw driver values
  and query strings while retaining route, error code and stack frames.
- Login has a fixed aggregate IP cap (100 attempts in five minutes) in addition
  to its existing IP/target cap. Login bcrypt comparison is asynchronous.
- A non-empty received reply from an active agent/admin account stops the first
  response clock on an open ticket. Requester identity takes precedence. Vendor,
  inactive/non-staff, quoted-only and automated-header messages do not count.
  Comment/attachment creation and SLA recording share a transaction. Ticket locks
  serialize response recording. Dedupe remains authoritative. This does not
  retroactively invent historical sent times or change old SLA cycles.
- Reply drafts are scoped to account, ticket and Public/Internal visibility in
  sessionStorage, expire after 12 hours and clear on sign-out. Saved text survives
  navigation/reload in that tab. Sending clears only text that still matches the
  sent draft; newer edits survive. Storage failures show a warning and protect a
  browser unload. Drafts are not uploaded to the server or shared between tabs.
- Shared dialogs portal to the document body, isolate the background, trap Tab
  and Shift-Tab, restore focus and preserve scrolling correctly across nested
  dialogs, including closing parent and child together.
- Phone ticket detail starts with a compact owner/SLA/primary-action summary.
  Ticket details expands properties, secondary actions and remote assistance;
  Write reply jumps to and focuses the composer. Existing navigation is retained.
- Priority, category and group use explicit Save changes/Cancel. Only changed
  fields are sent, so saving priority cannot trigger group routing. Dirty group
  selections survive timed/event refresh; priority/category edits survive incoming
  server refreshes. Mutation responses cannot replace enriched conversation
  metadata with raw/full comment arrays.
- Key metadata, inspector headings, filter labels, form hints and notification
  metadata are more legible. Internal composition has an amber edge using theme
  tokens. Search/group/handover/remote-assistance failures expose retry instead of
  silently reporting an empty result; usable existing data remains displayed.
- Browser ticket reads request the latest 20 comments and bounded activity, with
  attachments for the opening request and loaded comments only. Earlier history
  is explicitly loaded when requested. Full-history API reads remain compatible.
  Absolute message numbering and original-request labeling survive partial reads.
  Incomplete histories are not automatically marked entirely read. Once users
  explicitly load complete history, that view continues to refresh fully.

## Validation and rollout

Final verification: **52/52 server suites passed**, all client check scripts
passed, production build passed, and tracked/new-file secret scans were clean.
All database suites ran on disposable local PostgreSQL. Temporary browser
fixtures were removed after verification.

Client check scripts cover drafts, changed-field payloads, history numbering,
cookie/bearer headers, cache isolation, existing responsive/contrast contracts and
conversation preservation. Server review checks cover cookie flags, foreign
origins, independent session revocation, bearer upgrade, aggregate throttling,
non-staff access, response qualification/dedupe, partial history and safe errors.
Read budgets retain their existing data-query ceilings and separately require
exactly one revocation lookup per authenticated request.

Browser verification uses disposable local PostgreSQL and fictional accounts:
draft mode isolation/reload/navigation, field saving and refresh preservation,
conversation types/counts after saving, keyboard focus wrap/restoration, nested
dialog cleanup at 390x640, light/dark themes, and 360/390/768/1024/1366px layouts.
The built SPA was also exercised with the production script CSP; no script-policy
errors were observed. Screenshots and test logs remain outside the repository.

The additive migration `20261018090000_revoked_sessions` is committed as
`b9555b5` and applied to production. It was deployed from the application host
after the local Prisma command returned an opaque schema-engine failure; table
existence and completed migration metadata were independently verified.
The prior credential-rotation and dependency-audit follow-ups are separate.
