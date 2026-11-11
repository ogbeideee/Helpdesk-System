# Helpdesk review — 18 October 2026

Read-only application review. No application changes or deployment. Evidence:
current source, existing user screenshots, client checks/build, and live public
health response headers. No authenticated browser was available; fresh rendered
mobile/tablet/zoom checks and authenticated latency measurements remain pending.
Dependency audit requests stalled and were stopped; no current vulnerability
count is asserted. No penetration test or production load test was performed.

## Priorities and findings

1. **Security: close the historical credential-rotation follow-up.** Project
   state records credentials packaged into a prior image, subsequent packaging
   correction, and rotation still required. This review cannot establish whether
   rotation happened externally. Verify completion before treating this closed.
2. **Security: strengthen session containment.** `client/src/api.js` stores the
   bearer token in localStorage; logout clears it locally. Auth tokens live 12h,
   with password-change invalidation but no individual session revocation.
   `securityHeaders.js` supplies only frame-ancestors CSP, also confirmed live.
   A script-injection vulnerability would therefore have significant session
   impact. No injection exploit was established. Plan a tested script CSP and
   revocable sessions; an HttpOnly-cookie change also needs CSRF protection.
3. **Security: login throttling has no independent aggregate cap.** Its sole
   bucket is IP plus target email, so changing target emails creates new buckets.
   Pair per-target protection with aggregate IP limits. This also matters because
   bcrypt comparison is synchronous on the API event loop.
4. **Security: raw error disclosure remains.** Several route catches, including
   auth and ticket reads, return `err.message`; these bypass the central generic
   error handler. Failures can reveal internal database/query details. Return
   stable public errors and retain sanitized diagnostic information server-side.
5. **Workflow correctness: emailed staff replies and first-response SLA differ.**
   The app note route calls `recordFirstResponse`; intake does not. Conversation
   display can classify received staff mail as an agent reply nevertheless.
   Define which verified staff email counts, then pin the same rule in intake,
   conversation display and SLA tests. Do not blindly count every copied email.
6. **UX: reply drafts are vulnerable to navigation/reload loss.** TicketDetail
   keeps noteText only in component state, without a leave guard or persisted
   per-ticket draft. Add recovery scoped to account/ticket/visibility, an explicit
   saved indicator and clear behavior after send/logout. Account for sensitive
   message retention when choosing persistence.
7. **Accessibility: shared modal focus is incomplete.** Modal focuses its first
   field and handles Escape, but has no focus trap, background inertness or
   explicit focus restoration. Keyboard users can leave an open dialog. Fix the
   shared primitive and test Tab/Shift-Tab, nested dialogs and trigger restoration.
8. **Responsive UX: the full inspector precedes the conversation on phones.**
   CSS explicitly orders subject, inspector, conversation, then composer. Useful
   controls remain accessible, but reading/replying requires passing all inspector
   sections. Prefer a compact SLA/owner/action summary with expandable properties
   and a jump-to-reply control. This is a source-backed usability concern, not a
   newly observed overflow failure.
9. **Design: small secondary typography and inconsistent edit behavior.** Numerous
   labels/metadata use 10–11px; inspector priority/category save immediately while
   group requires Apply. Improve important metadata legibility and make save
   behavior predictable, with clear pending/saved feedback. Preserve theme tokens
   and navigation. Small text alone does not establish a WCAG violation.
10. **UX: some failures masquerade as empty data.** GlobalSearch catches failed
    ticket searches into an empty list; remote-access loading catches errors into
    an empty sessions list; group loading silently fails. Distinguish unavailable,
    empty and stale data, and expose retry without discarding usable content.
11. **Performance: collapsing a thread does not reduce its payload.** Detail
    includes all comments, audit logs and SLA events; conversationService parses
    original/quoted bodies and loads all account emails on each describe call.
    The open-ticket timer re-reads detail every minute. Long threads need bounded
    history reads or incremental updates and measured parse/query budgets.
12. **Performance: synchronous bcrypt blocks unrelated requests.** Login uses
    compareSync and password change uses compareSync/hashSync on the single API
    process. Use asynchronous password operations and validate concurrent request
    behavior in an isolated environment, never load-test the shared production API.
13. **UX: timed refresh can overwrite a pending group selection.** The event-based
    refresh checks groupPick against the server value, but the separate minute
    timer calls load unconditionally; load sets groupPick from the response.
    Preserve dirty fields across both refresh paths.

## Strengths and verification

- Client checks, including responsive static contracts, contrast checks, cache
  behavior and conversation helpers, passed. They do not prove rendered usability.
- Production build passed: main JS 250.16 KB / 76.02 KB gzip, shared CSS 103.07 KB /
  19.02 KB gzip, lazy ticket detail 52.51 KB / 15.06 KB gzip. No bundle-size emergency.
- Queue reads are paged at 25 and select display data; parameterized queries,
  compression, fingerprinted asset caching and lazy screens already exist.
- Live health returned 200 with framing protection and nosniff middleware in source.
- Backend role checks, password-change invalidation and attachment allowlisting
  are useful existing safeguards. This review does not certify every endpoint.

## Next verification pass

Use an authenticated staging/disposable environment for queue, dashboard, ticket
detail, handovers, reports and settings at 360/390/768/1024/1366px, short landscape,
200% zoom, both themes and keyboard-only input. Check overflow, action visibility,
drawer/modal focus, virtual keyboard, draft recovery, slow/offline errors and
long-thread behavior. Measure API p50/p95 and payload/query counts before setting
performance targets. Re-run dependency audits when registry access works; verify
backup retention and rotation records separately.
