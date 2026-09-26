# Changelog

Major implementation milestones only — not individual code edits.

## 2026-09-26

- Kept email signatures and their logos out of tickets. A new deterministic
  `email/signature.js` strips free-form corporate signature blocks and legal
  footers from `cleanBody` — a footer marker, or a trailing run of contact lines
  behind a closing salutation, never a lone line and never a contact detail
  written mid-request — while the raw `body` (and therefore the ticket and its
  audit trail) keeps everything the sender sent.
- Stopped storing decorative inline images. Signature logos, social icons and
  pasted pictures are `Content-Disposition: inline` image parts that nothing can
  ever render, because the ticket body is text; the IMAP adapter and Graph
  `mailService` now pass `isInline` through, and `attachmentService` skips them
  (logged by name, counted as `inlineImagesSkipped` in the audit metadata,
  excluded from the size/count limits). `ATTACHMENT_SKIP_INLINE_IMAGES=false`
  restores the previous behaviour.
- Added `db:purge-signature-images` as a dry-run-by-default cleanup script for
  the inline images stored before the policy existed (277 of 308 attachments in
  the live database, ~8.8 MB, across 50 tickets — 31 named attachments excluded).

## 2026-09-25

- Added the cloud-first email relevance triage foundation: Groq provider integration,
  conservative auto-skip policy, fail-open behavior, sanitized decision persistence,
  provider retry/circuit monitoring, and administrator controls in Profile → Settings.
- Added a separate relevance benchmark and kept the existing category/priority AI
  benchmark unchanged.

## 2026-08-28

- Added an application-wide light/dark/system theme: one token layer, a
  pre-paint inline script so there is no flash, and an accessible control in
  the nav rail
- Raised muted text and section labels to WCAG AA in both themes
- Refined the sidebar (active-item marker, separated Development group) and
  promoted Recent Tickets to a full-width lead section on the dashboard
- Rebuilt the Tickets queue: search with Ctrl-K, status segments, sortable
  columns, skeleton loading, stacked rows on narrow screens
- Polish pass: unified the page-header and destructive-button patterns across
  all eight screens, replaced the last emoji icons with themed SVGs, collapsed
  the routing rules into one ordered list, and fixed the Agents row actions
  being pushed off-screen
- Rebuilt Ticket detail: one primary action in the header, a single inspector
  panel instead of stacked cards, and an activity rail with a distinct marker
  per event kind

- Moved from the demo dataset to a real installation: removed 8 seeded accounts
  (both demo admins) and 130 demo tickets with their comments, audit entries and
  notifications; added `db:purge-demo` as a dry-run-by-default cleanup script
- Made `seed:demo` opt-in (`--confirm`) and stripped every demo credential from
  the README, UI, `.env.example` and `db:init`
- Gave each test suite its own throw-away database, so a full run no longer
  touches `dev.db`
- Fixed a data-loss bug in `db:init`: its ticket-number backfill renumbered every
  existing `INC-` ticket on each run
- Implemented agent-to-agent handovers: offer/accept/decline/suggest, a pending
  limit with a FIFO queue, expiry that pauses while the recipient is unavailable,
  deactivation rerouting and admin override
- Implemented workload tracking, unattended-ticket claiming (4-hour threshold)
  and automatic rebalancing, all on one compare-and-set ownership move

## 2026-08-27

- Added configurable routing rules, assignment groups and skill levels, with a
  General IT Support fallback and cross-team fallback that preserves the group
- Added production roles (`user` / `agent` / `admin`), the `INITIAL_ADMIN_EMAIL`
  bootstrap, user administration and last-admin protection
- Hardened the ticket lifecycle and reassignment: backend authorization on every
  path, `CLOSED` made final, full activity timeline

## 2026-08-26

- Ingested real mail from the Microsoft 365 shared mailbox via polling, with a
  backlog guard and dry-run mode
- Connected the email parser to the ticket creation pipeline, reusing the
  existing intake rather than duplicating ticket logic
- Added the provider-independent, deterministic email parsing layer
  (HTML→text, thread matching, attachments as metadata only)
- Added Microsoft Graph change notifications (webhooks) with subscription
  lifecycle, validation handshake and auto-renewal
- Initial commit: TicketDesk IT helpdesk ticketing system
