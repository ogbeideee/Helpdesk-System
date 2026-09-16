# Workload, unattended tickets and rebalancing

## Workload

Active workload is tickets an agent owns in **NEW** or **IN_PROGRESS**.
RESOLVED and CLOSED never count - the work is finished. A ticket mid-handover
counts for nobody until the move commits.

One definition (`OPEN_STATES`) backs the dashboard, the assignment engine and
the balancer, so every figure agrees. Exposed at `GET /api/workload` (everyone
plus the imbalance spread) and `GET /api/workload/me`.

## Unattended tickets

A **NEW** ticket becomes claimable by a teammate once it is
`UNATTENDED_CLAIM_HOURS` old (default **4**). The clock starts at creation and
runs whether or not the ticket is assigned.

| Situation | Before 4h | After 4h |
|---|---|---|
| Assigned to someone else | agent blocked (403) | eligible teammate may take it |
| Unassigned | teammate may take it | teammate may take it |
| Any state, ADMIN | may assign at any time | may assign at any time |

`POST /api/tickets/:id/take` (alias `/claim`) is the **Take Ticket** action.
Ownership changes immediately, the previous assignee gets an in-app and email
notification, and an audit entry records the handover. Ticket payloads carry
`unattended` and `hoursUntilClaimable`, so the UI shows the rule the backend
enforces rather than re-deriving it.

## Availability

`AVAILABLE` / `UNAVAILABLE` is `Agent.isAvailable`, separate from `isActive`.
Agents control their own at `POST /api/workload/availability`; an admin can
change anyone's through `PATCH /api/agents/:id`.

Going unavailable:

- **IN_PROGRESS work blocks it** (409). The response lists the tickets and where
  to find them - half-finished work is not silently handed on.
- **NEW tickets need confirmation** (409 with the list). On confirm they are
  reassigned by the normal algorithm.
- **No suitable replacement** leaves `assignedAgentId = null` with the
  assignment group intact. Tickets are never dropped.

An administrator can force an agent off even with work in progress, but it
takes an explicit `{ "force": true }` - the first attempt returns 409 naming
the flag. Everything open is then reassigned automatically.

**Deactivating** an agent reassigns all their NEW and IN_PROGRESS tickets the
same way. CLOSED tickets stay where they are.

## Previous-team recovery

Before reassignment, a ticket whose current group differs from its
`originatingTeamId` is returned to that original group, so the right team picks
it up. `originatingTeamId` itself is never modified.

## Rebalancing

A significant imbalance is a gap of **3 or more** open tickets
(`REBALANCE_THRESHOLD`). The balancer moves **one ticket, then recalculates**,
so a busy agent is drained gradually rather than dumped on the first idle
colleague.

What it moves, in order:

1. a NEW ticket in the receiving agent's own group
2. a NEW ticket from any group
3. an IN_PROGRESS ticket - only when the gap is still at or above the threshold
   and no NEW ticket qualifies

CLOSED tickets are never moved, and the receiving agent must meet the skill
level the routing rules require. Only agents who belong to an assignment group
take part: a team-less account would otherwise always look like the quietest
and attract every move.

Runs every `REBALANCE_INTERVAL_MS` (default 5 min; `0` disables), bounded by
`REBALANCE_MAX_MOVES` per cycle so it can never spin. An admin can trigger one
at `POST /api/workload/rebalance`, with `{ "dryRun": true }` to see the next
move without making it.

## Concurrency

Every ownership change goes through `moveTicket`, which uses a conditional
update with the expected current owner in the WHERE clause. If another worker
moved the ticket first, zero rows match and the caller is told, rather than
overwriting their decision. Two agents racing for the same ticket cannot both
win, replaying a stale move is a no-op, and the background balancer is safe
alongside live traffic. Overlapping cycles are also prevented by a guard.

## Notifications

An automatically moved ticket notifies the original agent **in-app**
(`Notification`, `GET /api/workload/notifications`) **and by email** through the
existing notification service, recording why it moved. The sidebar shows an
unread badge.
