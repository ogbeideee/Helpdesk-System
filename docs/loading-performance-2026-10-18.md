# Loading performance comparison — 2026-10-18

Deployed as `deployment-01M57CKYATB6PNASF1D97MKPS3` on 2026-10-18.
No schema, layout or theme changes.

## Changes

- Ticket detail runs independent history enrichment, skill requirements,
  reply activity, conversation description and SLA context reads concurrently
  after loading the ticket. The response contract and authorization remain.
- Successful writes invalidate their affected read-cache entries. Read receipts
  invalidate the ticket and queue unread indicators; ticket edits also invalidate
  aggregates, reports and workload, while preserving other ticket details and
  assignment-group reference data. Thread correction invalidates all ticket
  details, including the destination. Unknown writes still invalidate everything.
  Account changes/logout still clear all cached data. Targeted invalidation also
  fences stale in-flight responses; revision metadata is bounded.
- The shell owns the visible-page 30-second clock. Ticket detail, handovers and
  integration status no longer run additional page timers. Handover badge reads
  share shell events and cached inbox requests. Focus/visibility bursts coalesce
  within one second. Redundant direct change listeners were removed from the
  dashboard and queue. Desktop notification polling remains active in background
  tabs intentionally, to preserve alerts.

## Measurements

The same `server/scripts/measure-page-loads.js` ran before and after the changes,
using disposable PostgreSQL, synthetic data (35 replies), two warm-ups and twelve
measured authenticated HTTP requests per endpoint. Timings include response-body
download and JSON parsing, but not browser rendering. Production was not tested.

| Scenario | Before median | After median | Change |
|---|---:|---:|---:|
| Ticket detail, local database | 31.4 ms | 21.8 ms | 31% lower |
| Ticket detail, controlled 50 ms delay per Prisma operation | 556.1 ms | 320.9 ms | 42% lower |
| Queue, local control | 17.7 ms | 15.5 ms | Small/noise-sensitive |
| Dashboard, local control | 13.8 ms | 15.8 ms | Small/noise-sensitive |
| Queue, delayed control | 248.0 ms | 255.5 ms | No improvement established |
| Dashboard, delayed control | 243.1 ms | 253.7 ms | No improvement established |

Detail p95 fell from 41.4 to 36.4 ms locally, and 615.4 to 342.6 ms with controlled
delay. Detail still executes 13 Prisma operations; overlap, not a smaller query
count, produced the improvement. The injected delay models operation latency,
not a real network or production database. Do not extrapolate a production SLA.

`client/measure-loading.mjs` used identical 40 ms mock transport before and after,
warming the dashboard, assignment groups and another ticket, then revisiting them
after a write:

| Scenario | Before network reads | After network reads | Before wait | After wait |
|---|---:|---:|---:|---:|
| Mark a different conversation read | 3 | 0 | 49.0 ms | 0.1 ms |
| Edit a different ticket | 3 | 1 | 43.9 ms | 43.2 ms |

The ticket edit still refreshes the affected dashboard; independent parallel
reads mean fewer requests do not necessarily reduce the total wait in this
fixture. These are mocked transport/cache measurements, not real page timings.

`client/refresh-check.mjs` executes a virtual ten-minute clock: the previous
shell-plus-ticket schedules invoked page loads 30 times; the shared schedule
invokes them 20 times (33% fewer). A focus/visibility event pair invokes one load
instead of two. These are load callback counts, not measured HTTP savings: the
existing cache can already deduplicate overlapping requests.

## Reproduce and verify

Run `node server/scripts/measure-page-loads.js` with optional
`MEASURE_QUERY_DELAY_MS=50`, and `node client/measure-loading.mjs`.
Both server measurement modes use the guarded disposable test database helper.
The client measurement uses synthetic responses and no live account.

Regression checks: full client checks and production build; server conversation,
read-performance, attachments and review-hardening suites passed (4/4).
Added cache invalidation/race, account-boundary, thread-destination and shared
refresh scheduling checks. Tracked-file secret scan passed.

Deployment smoke, machine health and DNS checks passed. Public verification
confirmed health, production CSP, entry `index-D7_Swzk7.js`, detail
`TicketDetail-NQP5Eupu.js`, immutable asset caching and anonymous ticket API 401.
The default local network path timed out fetching the detail asset; an IPv4
request succeeded immediately with HTTP 200 and 57,549 bytes. No authenticated
production page timings were collected.
