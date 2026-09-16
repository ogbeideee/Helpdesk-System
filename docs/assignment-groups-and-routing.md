# Assignment groups and routing rules

## Assignment groups

An assignment group is an IT team (`Team` in the schema). Each has a name,
description, active flag and timestamps. Exactly one is the **default**:
`General IT Support`, which receives anything no rule claims.

| Group | Purpose |
|---|---|
| General IT Support | First-line support and triage. **Default.** |
| Accounts & Access | Accounts, passwords, MFA |
| Software & Applications | Desktop and LOB applications |
| Hardware & Devices | Laptops, peripherals, printers |
| Network Team | WiFi, LAN, VPN, routers |
| Field Operations | On-site installation: LAN cabling, router/switch setup, premises wiring (priority 30 routing rule) |

Groups can be created and edited by an admin at **Routing → Assignment Groups**.

## Multi-group membership

An agent belongs to exactly one **primary group** (`Agent.teamId`) and may
belong to up to **two additional supporting groups** via the `TeamMembership`
join table. Manage these at **Admin → Agents** → Edit → Supporting groups.

Supporting members receive only **low/moderate priority** tickets in their
non-primary groups — they appear as in-group candidates for the assignment
engine (not cross-team fallback). The threshold is configurable in
`config/assignment.config.json` (`supportingMaxPriority`).

An agent may lead multiple groups at once (lead status lives on the membership
row, not on the agent or the group). A group has exactly one lead.

## Routing rules

Rules are database rows an ADMIN edits at `/routing` (API: `/api/routing/rules`).
Each has a name, keywords, an optional category, a target group, an optional
preferred agent, an optional minimum skill, a priority and an active flag.

Matching is **deterministic string comparison** - no LLM, no network. Text is
lower-cased and stripped of punctuation, so `Wi-Fi`, `WiFi`, `WI-FI` and
`wi fi` all match the keyword `wifi`. Keywords match whole words, so `van` does
not match `advance`, and multi-word keywords match as phrases.

**Precedence.** Only active rules on active groups are considered. Among those
that match, the winner is decided by:

1. **`priority` ascending** - lower number wins. This is the administrator's
   explicit ordering and always dominates.
2. **Category-specific beats category-agnostic**, at equal priority.
3. **More matched keywords** wins - three matches is more specific than one.
4. **Longer matched keyword** wins - `docking station` beats `dock`.
5. **Lower id** - a stable tie-break so the result never depends on row order.

A rule with no keywords matches on category alone; one with neither is a
catch-all.

## Routing algorithm

Routing runs immediately on ticket creation:

```text
category classifier  ->  matching rule (or the default group)
      -> preferred agent, if active + available + sufficiently skilled + eligible
         (supporting members blocked for high/critical priority)
      -> else lowest open workload among primary + supporting members in the group,
         round-robin on ties
      -> else lowest workload ANYWHERE (cross-team fallback, respecting the
         supporting-member priority gate)
      -> else leave unassigned, group retained
```

The **cross-team fallback deliberately does not change the assignment group.**
A ticket can read `Assignment Group: General IT Support` while being worked by
someone from the Network Team - the group is who owns it, the assignee is who is
doing it. For high/critical tickets, the fallback also excludes supporting
members of the ticket's group.

Supporting members (agents whose primary team differs from the ticket's group)
are considered **in-group candidates** for low/moderate priority tickets, not
cross-team fallbacks — they appear in the assignment pool alongside primary
members of the same group.

Every decision is written to the ticket's audit trail, naming the rule that won
and the keywords it matched. Rule administration itself is audited separately in
`RoutingRuleAuditLog` (`GET /api/routing/audit`): created, updated, activated,
deactivated, deleted, with actor and timestamp. A deleted rule keeps its history.

`POST /api/routing/preview` shows what a description would route to without
creating anything - also available as the "Test a ticket description" box on the
Routing Rules screen.

Starter rules are seeded only when the table is empty, so administrator edits
are never overwritten. They contain no employee names; a preferred agent is
configured against a real account by an administrator.
