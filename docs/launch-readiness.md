# Launch readiness

Checkpoint: 2026-10-20. Team availability was confirmed by the owner.

## Verified

- Dependency-only image `deployment-01M5CDRNWG92PBJXTZ24VXQ1DT` is live on
  the existing single machine. Application source, the frontend bundle and the
  database schema were preserved. Live health returned 200 with `{ ok: true }`.
- Both local and deployed dependency audits report zero vulnerabilities,
  including development dependencies. Express 4.22.3, proxy-addr 2.0.8,
  mailparser 3.9.47 and Nodemailer 10.1.7 are installed in production.
  Prisma/client remain 6.19.3. The release used the live schema to generate
  its Prisma client, including all workspace-local dependency directories.
- Patched `deepmerge-ts` and CommonJS-compatible `uuid` overrides avoid a
  Prisma or Microsoft authentication major upgrade. DOCX is pinned to 9.7.1
  because 9.7.2 requires a dependency whose supported Node versions exclude
  the deployed Node 20 runtime. Vite is updated to 6.4.4 for the developer
  dependency findings; the live frontend was not rebuilt in this release.
- The full server run passed 52/53 suites. The one failure was the stale
  duplicate Message-ID expectation: patched mailparser selects the first
  header. The corrected parser suite passed on rerun, giving passing results
  for all 53 suites. Client checks and production build passed on the final
  dependency set. The tracked-file secret scan passed.
- CI audit checks and a production-audit deployment gate have been prepared
  locally. They take effect when these repository changes are published.

## Live pilot

The user authorised the requester and preferred handler before sending.
Three clearly labelled synthetic messages plus a requester reply were sent
through Outlook. No original mailbox messages were replayed.

| Check | Evidence |
|---|---|
| Direct helpdesk email | Created INC-001898 through Power Automate |
| Preferred handler | Assigned to Farook; greeting recorded in creation audit |
| Department email | Created INC-001899 and assigned automatically |
| Requester acknowledgement | Received and opened in the requester mailbox |
| Reply on acknowledgement | One comment on INC-001898; reopened the resolved ticket |
| Staff email with department only copied | `intake.skipped_automated`, copy-only reason; no third ticket |
| Resolve notification | Delivered to requester with confirmation link |
| Two-step confirmation | Opening link left ticket resolved; button closed it with confirmation audit |

Both synthetic tickets and their dependent records were privately archived
and removed after the pilot. The final queue contains zero tickets; numbering
continues forward. Mailbox messages and administrative audit history remain.

Live attachment upload was not repeated: the browser extension did not permit
local file upload. Attachment coverage passed in the automated suites; prior
live attachment commissioning is recorded in PROJECT_STATE.md. No extension
permissions were changed to complete the pilot.

## Remaining before broad rollout

Power Automate failure-alert settings could not be verified or changed under
the currently signed-in account. It can see no owned or shared flows and only
the default environment. The owner must sign in with the existing flow-owning
account; no extra flow permissions were granted.

For each incoming and outgoing flow, verify that repair-tip emails are enabled
in the flow properties and that the intended administrator is the existing
recipient/owner. If a separate recipient needs notifications, configure a
failure path within the existing flow rather than silently granting ownership.
Send only the flow name, time, run reference and a short failure category;
never email raw payloads, email bodies, tokens or connection secrets.

Microsoft documents optional owner repair-tip notifications in
[Troubleshoot a cloud flow](https://learn.microsoft.com/en-us/power-automate/fix-flow-failures#repair-tips-in-email).
The application polling watchdog does not monitor these event-driven flows;
see [Power Automate commissioning](power-automate.md#live-commissioning-and-cutover).
