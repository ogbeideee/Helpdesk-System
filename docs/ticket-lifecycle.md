# Ticket lifecycle and assignment

```text
NEW  ->  IN_PROGRESS  ->  RESOLVED  ->  CLOSED
```

A ticket can be reassigned at any point before it is CLOSED.

| Transition | How |
|---|---|
| NEW -> IN_PROGRESS | `POST /api/tickets/:id/start` ("Start working") |
| IN_PROGRESS -> RESOLVED | `POST /api/tickets/:id/resolve` - **a resolution note is required** |
| RESOLVED -> CLOSED | `POST /api/tickets/:id/close` |
| RESOLVED -> IN_PROGRESS | rework, via `POST /api/tickets/:id/status` |
| CLOSED -> anything | **rejected** |

**CLOSED is final.** No agent-driven transition leaves it. A closed ticket
returns only when the requester replies by email, which reopens it to
IN_PROGRESS and writes its own audit entry. That path deliberately bypasses
the transition map in `src/states.js`, so "final for people, reopenable by the
requester" lives in exactly one place.

Resolving records the resolution note, the resolving agent, `resolvedAt` and
the transition. Closing records the closing actor, `closedAt` and an audit
entry.

## Who may do what

All of it is enforced in `src/services/assignmentPolicy.js` and applied by
every route, so calling the API directly gains nothing over using the UI.

| Action | AGENT | ADMIN |
|---|---|---|
| Start / resolve / close | only tickets assigned to them | any ticket |
| Reassign | only their own ticket, **within their own group**, to an **available** teammate | any open ticket, **across groups**, may pick an unavailable agent |
| Change assignment group | no | yes |

An agent may not select themselves (they already hold the ticket), an
unavailable teammate, or anyone outside their assignment group. Availability is
the `Agent.isActive` flag - the one the Agents admin screen toggles.

## Reassignment

`GET /api/tickets/:id/assignment-candidates` returns each candidate with
availability, workload, skill level, group, and whether the caller may actually
select them. The UI renders that decision rather than re-deriving it:

```text
Current Assignment
Hardware Team · Jane Smith · 5 open

Reassign to:
(o) Sarah Smith    Senior · Available · 2 open tickets
( ) John Doe       Mid    · Available · 4 open tickets
( ) Michael Brown  Junior · Unavailable · 8 open tickets   <- not selectable
```

Available agents are listed first, then by lightest workload, so an unavailable
agent is never the default suggestion. A reassignment accepts an optional
reason and always writes an audit entry naming the previous agent, the new
agent, the group, the actor and the reason - the old assignment is preserved as
history, never overwritten:

```text
Reassigned from Jane Smith to Sarah Smith (Hardware & Devices, skill level 3)
  — Reason: Handing over due to shift change.
by Jane Smith · 27 Aug 2026, 10:42
```

## Assignment group changes (admin)

Changing the group validates that the group exists, records the previous and
new group, and **clears the assignee when they do not belong to the new
group** - a ticket is never left owned by someone from the wrong team. The
existing assignment engine then re-routes it automatically; pass
`autoAssign: false` to leave it in triage.

## Workload

Open workload counts tickets in **NEW** and **IN_PROGRESS** only.

- **CLOSED** never counts.
- **RESOLVED does not count.** The work is finished and the ticket is only
  awaiting closure, so counting it would make an agent look busier than they
  are and skew the assignment engine.

This is `OPEN_STATES` from `src/states.js`, the same definition the dashboard
and the assignment engine already use, so every workload number in the product
comes from one place. It is exposed on `/api/dashboard` (`ticketsPerAgent`) and
on the assignment-candidates endpoint.

## Activity timeline

The ticket detail timeline distinguishes creation, assignment, reassignment,
group change, status changes, internal notes, requester updates, resolution,
closure and reopening - each with its own icon and styling.
