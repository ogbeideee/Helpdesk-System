# Assignment groups and routing rules

## Assignment groups

An assignment group is an IT team (`Team` in the schema). Each has a name,
description, active flag and timestamps. Exactly one is the **default**:
`General IT Support`, which receives anything no rule claims.

| Group | Purpose |
|---|---|
| General IT Support | First-line support and triage, including printer/toner requests, desk phones, and meeting-room setup. **Default.** |
| Accounts & Access | Accounts, passwords, MFA, account creation and email provisioning |
| Software & Applications | Desktop and LOB applications |
| Hardware & Devices | Laptops, peripherals, printers and meeting-room equipment |
| Network Team | WiFi, LAN, VPN, routers |
| Field Operations | Specific on-site cabling, router/switch installation, POS, CCTV and premises-wiring requests (priority 30 routing rule; broad words such as `site`, `field`, `premises` and `installation` are not keywords) |

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

The current routing table sends account-creation and email-provisioning wording
to **Accounts & Access** (priority 3), while printer/toner, desk-phone and
meeting-room wording goes to **General IT Support** (priority 4). Password reset
requests continue to use the category-specific Accounts & Access rule (priority
5); the specialist category rules follow at priorities 6–8, with the advanced
software rule at 5 so it beats its own category catch-all, network at 10 and
field operations at 30.

Matching is **deterministic string comparison** - no LLM, no network. Text is
lower-cased and stripped of punctuation, so `Wi-Fi`, `WiFi`, `WI-FI` and
`wi fi` all match the keyword `wifi`. Keywords match whole words, so `van` does
not match `advance`, and multi-word keywords match as phrases. The
separator-insensitive form is word-bounded as well, so `physical` does not
match `physically`.

**Precedence.** Only active rules on active groups are considered. Among those
that match, the winner is decided by:

1. **Subject evidence** - a rule whose keyword matched in the subject beats one
   that only matched in the body. The subject is the sender's own summary while
   body text is noise-prone, so a subject hit is the stronger signal.
2. **`priority` ascending** - lower number wins. This is the administrator's
   explicit ordering and dominates within an evidence class.
3. **Category-specific beats category-agnostic**, at equal priority.
4. **More matched keywords** wins - three matches is more specific than one.
5. **Longer matched keyword** wins - `docking station` beats `dock`.
6. **Lower id** - a stable tie-break so the result never depends on row order.

A rule with no keywords matches on category alone; one with neither is a
catch-all. Classification and routing both read the **sender's own words**:
quoted history and the signature are stripped before either one runs, so a
keyword buried in a quoted thread cannot decide where a ticket goes.

## Skill requirements

A ticket's minimum skill is **not** a property of its category: it is the
requirement of the routing rule that governs the ticket, plus the priority
boost from `config/assignment.config.json` (`high` +1, `critical` +2, capped at
3).

| Rule | Requires |
|---|---|
| `Network Issues` (priority 10) | MID |
| `Software (Advanced)` (priority 5) | MID — a crash, an error code, data loss, a deployment, an integration |
| `Software & Applications` (priority 6, the category catch-all) | JUNIOR |
| `Field Operations` (priority 30) | JUNIOR |
| every other rule | JUNIOR — no bar above the first line |

Software is first-line work, so its catch-all asks for **L1** only. An
advanced rule exists because a blanket MID on the category levelled *every*
software ticket — plain "please install X" requests included — at L2. A
specific rule inside a category must beat that category's catch-all, which is
why `Software (Advanced)` sits at priority 5, above 6.

`GET /api/tickets/:id` answers for the ticket itself, as `requiredSkillLevel`
and `requiredSkillRule`, and the ticket inspector prints that. It is **derived
on read**, never stored, and scoped to the group that owns the ticket, so
another group's rules can never answer for it — and correcting a rule corrects
every ticket it governs, past and present, with no backfill.

A group's advertised bar — `GET /api/assignment-groups`, and the assignment
pool's `autoEligible` flag — is the **lowest** minimum skill among that group's
active rules: the same figure the engine gates on, never a second copy of it.
`config/assignment.config.json` used to carry its own `categories` map with a
`minSkillLevel` per category, which is exactly how a screen could read "L1"
while the engine demanded "L2"; that map is gone.

An installation seeded before this policy existed keeps its old rule rows, by
design — seeding never overwrites an administrator's edits. Bring it in line
explicitly:

```bash
npm run db:relevel-software             # report what would change (dry run)
npm run db:relevel-software -- --apply  # lower the catch-all, add the advanced rule
```

The script touches only Software rules: a keyword-free Software rule (the
category catch-all) is lowered to JUNIOR, `Software (Advanced)` is created from
the seed when it is missing, and any keyword rule an administrator wrote is
reported and left alone. Both writes land in the routing audit trail
(`GET /api/routing/audit`). No ticket row is modified.

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
members of the same group. Automatic workload rebalancing likewise requires the
recipient to be a primary or supporting member of the ticket's group; it never
moves a ticket to an unrelated team's member.

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
