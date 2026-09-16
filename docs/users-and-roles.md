# Users, roles and administrators

There is one user table for the whole product (`Agent` - the historical name).
No second user system.

| Role | Can sign in | Receives tickets | Manages users |
|---|---|---|---|
| `USER` | yes | **no** | no |
| `AGENT` | yes | yes | no |
| `ADMIN` | yes | yes | yes |

Stored values are lower-case (`user` / `agent` / `admin`). Anyone signing in for
the first time becomes **AGENT** - there is no code path that yields ADMIN on a
first sign-in. Nobody can change their own role, and only an ADMIN can change
anyone else's.

Two independent flags:

- **`isActive`** - the account is enabled. An inactive account cannot sign in
  and never receives tickets, not even from an admin.
- **`isAvailable`** - currently accepting new work. An agent on leave stays
  active but unavailable; an admin may still assign to them deliberately.

`externalId` / `externalProvider` are ready for Microsoft Entra ID.
**Entra authentication is not implemented** - `provisionUserFromIdentity()` in
`src/services/userService.js` is the seam it will use.

## Initial administrator

The first administrator cannot be created through the admin API, because that
API requires an administrator. `INITIAL_ADMIN_EMAIL` closes that gap exactly
once:

```env
INITIAL_ADMIN_EMAIL=admin@example.com
```

At startup, **only while there are zero active administrators**, that account is
promoted to ADMIN (or provisioned without a password if it does not exist yet).
As soon as one administrator exists the mechanism is inert - re-running it, or
re-pointing the variable at somebody else, can never mint a second admin. The
server logs which happened:

```text
[users] administrator bootstrap inert (3 administrator(s) already exist)
```

The address lives in configuration only; it appears in no business logic.

## Administrator management

There is **no permanent "super admin"**. Every ADMIN has identical rights,
including over other admins: any admin can promote an AGENT, demote another
ADMIN, and manage accounts. The initial administrator is not special once
others exist.

One invariant is enforced: **at least one active administrator always remains.**
The final admin can be neither demoted (`409`) nor deactivated (`409`), and no
one can change their own role or deactivate their own account (`403`).

An ADMIN can view users, provision agents, activate/deactivate, change
assignment group, skill level and availability, and promote/demote. All of it
is enforced in `src/services/userService.js`, so calling the API directly gains
nothing over the UI - an AGENT or USER receives `403` from every admin route.

## Audit

`UserAuditLog` records user creation, role changes, activation/deactivation,
availability, assignment-group and skill-level changes, each with the actor and
a timestamp. Read it at `GET /api/agents/:id/audit` (admin only). Ticket history
stays in `TicketAuditLog` - separate concerns, separate tables.

## Development accounts

The demo accounts are seeded only by `npm run seed:demo`, which refuses to run
when `NODE_ENV=production`. Nothing creates fake users automatically.
