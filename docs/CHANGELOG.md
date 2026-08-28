# Changelog

Major implementation milestones only — not individual code edits.

## 2026-08-28

- Added an application-wide light/dark/system theme: one token layer, a
  pre-paint inline script so there is no flash, and an accessible control in
  the nav rail
- Raised muted text and section labels to WCAG AA in both themes
- Refined the sidebar (active-item marker, separated Development group) and
  promoted Recent Tickets to a full-width lead section on the dashboard

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
