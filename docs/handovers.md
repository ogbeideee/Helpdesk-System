# Agent-to-agent handovers

A handover is an **offer**, not a move:

```
Agent A -> request handover -> Agent B -> accept / decline / suggest
```

The ticket keeps its owner, its status, its group and its SLA until the
recipient accepts. Nothing about a pending request counts toward anybody's
workload, because workload is counted from `Ticket.assignedAgentId` and only
`moveTicket` ever changes it.

## The three replies

| Reply | Effect |
|---|---|
| **Accept** | Ownership transfers immediately. The status is untouched, the previous agent is notified, and the handover stays in the ticket's history. |
| **Decline** | The ticket stays with the original agent. The history records "Handover declined by [name]", and they are free to ask somebody else. |
| **Suggest Another** | Declines, and shows the suggestion to the original agent. **No request is sent to the person named** - it stays the original agent's decision. |

Only one offer is outstanding per ticket at a time.

## Pending limit and the queue

A recipient holds at most **2** active requests (`handoverPendingLimit`).
Further requests are **QUEUED** in FIFO order; when a slot frees up - an
answer, a cancellation, an expiry, or an administrator raising the limit - the
oldest queued request is activated automatically and the recipient is notified.
Queue position is derived from insertion order rather than stored, so it can
never drift.

## Expiry

An unanswered request expires after `handoverExpiryMinutes` (default 24h). On
expiry it is marked **EXPIRED**, ownership stays where it was, and the original
agent is told.

The clock **pauses while the recipient is unavailable**: the deadline is
cleared and the remaining time banked, then restored when they are available
again, so time away never costs somebody a request. A paused request is
skipped by the sweeper by construction.

If the recipient is **deactivated** they cannot answer at all, so the request is
routed to another suitable available agent using the normal assignment rules
(never back to the agent who still owns the ticket). If nobody is suitable it is
cancelled and the original agent is told.

## Cancellation

The original agent can withdraw a pending or queued request before it is
answered; an administrator can cancel any. It is marked **CANCELLED** and kept
in the ticket's history, and - deliberately - **the recipient is not notified**.

Resolving or closing a ticket cancels any outstanding handover and records
that, leaving the ticket resolved or closed.

## History

Completed handovers are never deleted. `GET /api/tickets/:id/handovers` returns
the full chain oldest-first, and the ticket detail screen renders it:

```
Mr. Dare -> Sarah   declined
Sarah    -> John    accepted
```

Each row keeps the previous agent, the new agent, the timestamps and the result.

## Permissions (enforced on the backend)

| | AGENT | ADMIN |
|---|---|---|
| Request a handover | own tickets, own group only | any open ticket, anyone |
| Accept / decline / suggest | only requests sent to them | any request |
| Cancel | only requests they raised | any request |
| Override (force the transfer) | no | yes |
| Reassign directly | own tickets, own group | anyone |

The ownership rules are `assignmentPolicy.checkTarget`, unchanged - handovers
add no second permission model.

## Configuration

`handoverPendingLimit` and `handoverExpiryMinutes` are administrator-editable on
the Handovers screen and stored in the `Setting` table. `HANDOVER_PENDING_LIMIT`
and `HANDOVER_EXPIRY_MINUTES` supply the defaults for a fresh install;
`HANDOVER_SWEEP_INTERVAL_MS` controls the expiry sweep (`0` disables it).

## Concurrency

Every status change is a conditional update with the expected current status in
the WHERE clause, and the ownership move itself is `moveTicket`'s existing
compare-and-set. Two people cannot both accept the same handover, an accept
cannot race a cancellation, and queue promotion is idempotent - replaying it
simply finds no eligible row.
