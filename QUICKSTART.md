# TicketDesk — Quick Start

Internal IT helpdesk for one organisation: employees email a shared mailbox,
the system turns each message into a ticket, classifies it, routes it to an
assignment group, assigns an agent and tracks it to resolution. Without any
Microsoft 365 credentials, a built-in email simulator stands in for inbox
ingestion.

> This is the short version. `README.md` is the full manual — architecture,
> business rules, Graph/IMAP setup, troubleshooting — and `server/.env.example`
> documents every environment variable.

## Requirements

- Node.js 18+ and npm (Windows; PowerShell or Git Bash)
- A PostgreSQL database for the application — Supabase in production;
  `DATABASE_URL` and `DIRECT_URL` go in `server/.env`
- For tests only: a local PostgreSQL installation (client binaries on PATH)

## Set up

```bash
npm install                   # repo root — installs the server + client workspaces

cd server
copy .env.example .env        # or get the real .env from the project owner
npm run db:deploy             # apply the committed Prisma migrations
npm run db:init               # assignment groups + default routing rules + admin bootstrap
```

Run it:

```bash
# development — API on :4000, UI on :5173 with hot reload
npm run dev                   # from the repo root

# production — one server on :4000 serving the built app and the API
cd client && npm run build
cd ../server && npm start     # deploy to Fly.io: see README.md ("fly deploy")
```

## First sign-in

There are no built-in accounts and no default passwords. While the database
has zero active administrators, the address in `INITIAL_ADMIN_EMAIL` is
provisioned as an admin at startup — exactly once; changing the value later
can never mint a second admin. The bootstrapped account has **no password**:
set one under **Admin → Agents**, and add the rest of the team there too
(primary group, up to two supporting groups, skill level). `db:init`
deliberately creates no agents.

## Tests

Plain Node scripts, no test framework — 35 suites, each running on its own
throw-away PostgreSQL database. One-time setup, then:

```bash
cd server
npm run test:pg:up            # disposable local cluster on 127.0.0.1:5433 (+ server/.env.test)
npm test                      # every suite, with a per-suite PASS/FAIL summary
node scripts/run-all-tests.js imap email-sources   # or just a few, by substring
```

A full run never touches the application database.

## Email ingestion

- **Development:** the **Simulate Email** screen posts to
  `POST /api/tickets/from-email` — the exact pipeline real mail travels.
- **Production (optional):** Microsoft Graph (shared mailbox, client
  credentials) and/or IMAP. Both are off until their environment block is
  complete, and missing credentials are never fatal — the rest of the system
  keeps working. Full checklists: the "Microsoft 365" and IMAP sections of
  `README.md`; test a Graph connection safely with `npm run graph:check`.

## Where to go next

| Need | Read |
|---|---|
| Full manual — rules, routing, workload, handovers, SLA, Graph/IMAP, deployment | `README.md` |
| Every environment variable explained | `server/.env.example` |
| Current status, decisions and known issues | `docs/PROJECT_STATE.md` |
| Change history | `docs/CHANGELOG.md` |
