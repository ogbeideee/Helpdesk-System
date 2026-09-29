# TicketDesk — Quick Start

Internal IT helpdesk for one organisation: employees email the Microsoft 365
helpdesk mailbox, the forwarding rule delivers it to the configured Gmail
mailbox, and the IMAP poller turns each message into a ticket, classifies it,
routes it to an assignment group, assigns an agent and tracks it to resolution.

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

Plain Node scripts, no test framework — 43 suites, each running on its own
throw-away PostgreSQL database. One-time setup, then:

```bash
cd server
npm run test:pg:up            # disposable local cluster on 127.0.0.1:5433 (+ server/.env.test)
npm test                      # every suite, with a per-suite PASS/FAIL summary
node scripts/run-all-tests.js imap email-sources   # or just a few, by substring
```

A full run never touches the application database.

## Email ingestion

- **Live setup:** email is forwarded from the Microsoft 365 helpdesk mailbox to
  the configured Gmail mailbox, where the IMAP poller processes it through the
  real intake pipeline.
- **Microsoft Graph (optional):** a direct Graph mailbox source can be enabled
  when its environment block is complete. Full checklists are in the
  "Microsoft 365" and IMAP sections of `README.md`.

## Email relevance triage (optional Groq filter)

1. Create a Groq API key and enable Zero Data Retention in Groq's Data
   Controls. Keep the key in the server/Fly secret store as `GROQ_API_KEY`.
2. Run the offline smoke benchmark:
   `cd server && npm run bench:ai:triage -- --mock`.
3. Deploy with `INTAKE_RELEVANCE_MODE=disabled` and
   `INTAKE_TRIAGE_KILL_SWITCH=true` while the key and policy are being checked.
4. After the administrator labeled benchmark, sign in as an admin and open
   **Profile → Settings**. Configure approved senders and reason codes, test the
   provider, then choose **Auto-skip**. The page shows metrics and an immediate
   **Disable auto-skip now** control.
5. Clear the environment kill switch only when ready. Provider failures,
   low-confidence results, ambiguous messages and decision-log failures always
   create a ticket.

See `docs/email-relevance-triage.md` for the safety contract and data
handling.

## Where to go next

| Need | Read |
|---|---|
| Full manual — rules, routing, workload, handovers, SLA, Graph/IMAP, deployment | `README.md` |
| Every environment variable explained | `server/.env.example` |
| Current status, decisions and known issues | `docs/PROJECT_STATE.md` |
| Change history | `docs/CHANGELOG.md` |
