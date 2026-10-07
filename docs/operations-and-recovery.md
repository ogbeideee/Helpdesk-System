# Operations and recovery

Administrators open **Profile → Settings** for email delivery, intake decisions,
nickname aliases and the greeting tester. Records start with this release;
historical skipped emails cannot be reconstructed from ticket rows.

## Email delivery

The existing Notification table retains outbound delivery state. The mailer
encrypts queued content with AES-256-GCM using a key derived from `JWT_SECRET`.
No payload, confirmation token or provider error text is returned by the API.
The initial send is immediate; failures retry after 1, 5, 30 and 120 minutes,
up to five total attempts. A thirty-second worker checks due items. A database
lease prevents concurrent workers from sending the same queued row.

“Delivered” means the provider accepted the send, not proof of arrival in an
inbox. A crash after provider acceptance but before saving success can produce
a duplicate; Graph and SMTP provide no exactly-once guarantee here. An expired
final-attempt lease is marked as an unknown outcome, requiring administrator
review before a retry. Failed content expires after seven days; sent/expired
delivery metadata expires after thirty days. Rotating `JWT_SECRET` makes old
queued payloads unreadable; review pending deliveries during credential rotation.
The console fallback does not represent a real email delivery.

Delivery persistence failure is reported without failing the ticket action.
If the database is unavailable before a delivery row can be stored, that email
cannot be automatically recovered by this queue; check the operator logs.

## Intake and aliases

The existing AuditEvent trail records created, appended, reopened and screened
email outcomes. Records include the routing/assignment reason and greeting
acceptance or refusal, without storing the email body or recipient headers.
Audit persistence failure fails open to normal intake. Duplicate deliveries
do not create another decision entry.

Aliases use `nickname = saved agent name` or the saved sign-in address. Every
entry must identify exactly one account. The preview uses saved configuration
and creates no ticket. It identifies the addressee; assignment still enforces
availability, role, skill, group and workload limits.

## Health and diagnostics

`GET /api/health` is public liveness only. `GET /api/admin/diagnostics` requires
an administrator and carries integration/polling details. Use that authenticated
endpoint when investigating mailbox failures. No endpoint returns credentials.

## Back up and rehearse recovery

From `server/`:

```powershell
npm run db:backup
npm run db:rehearse-recovery -- ../backups/helpdesk-TIMESTAMP.dump
```

The backup command reads the application database without changing it and
exports application tables, sequences and migration history. It excludes
provider-managed Supabase authentication/storage extensions. Credentials are
passed through the subprocess environment, never command-line arguments.
Use matching PostgreSQL tools (`POSTGRES_BIN` can name their directory).

Files live in the git-ignored `backups/` directory. They contain sensitive
application data; restrict that directory to the operator and copy verified
backups to an approved private storage location. They are not included in the
deployment image. A local backup alone does not protect against machine loss.
Provider backup frequency, retention and point-in-time recovery must be checked
in the Supabase dashboard; they cannot be inferred from a database connection.

The rehearsal accepts only a backup file in that directory. The test helper
creates a disposable loopback database; the command restores there, applies
committed migrations and checks that core row counts and primary memberships
are preserved. It removes the disposable database afterwards. It never accepts
a caller-supplied restore database or writes to the application database.

For an actual incident, stop the single application machine and preserve the
current database before restoring through the database administrator/provider.
Recover the matching application revision and migration history, restore into
a separate database first, verify it, then change the application's connection
secrets and restart its one machine. Verify sign-in, ticket history, memberships,
new intake, outbound mail and an uncached attachment before reopening service.
Use [credential rotation](credential-rotation.md) for mailbox credentials.
The mailbox remains the attachment archive; database backups retain metadata,
not attachment cache bytes.

## Schema and archival maintenance

`npm run db:deploy` applies committed PostgreSQL migrations. The unsupported
`db:push`, `db:migrate-v2` and `db:migrate-assignment-groups` shortcuts were
removed. Historical SQLite artifacts and disabled one-off scripts are preserved
under `archive/legacy-database-tools/`; reusable purge and software-relevel
commands remain supported.

Primary-group changes and membership removals use the same canonical membership
table. Clearing a primary removes that non-lead membership and promotes the
oldest remaining membership. Selecting an existing supporting group makes it
primary. Replacing a primary with a new group replaces the former non-lead
membership; a lead must be demoted before that membership can be removed.

Apply the primary-membership migration only with the matching application
release: older code expects the removed Agent column. For rollout, prepare the
tested image and verified backup, stop the single old machine, apply committed
migrations, deploy the prepared image and verify administrator diagnostics.
Rollback after this migration requires a matching snapshot/revision or a
forward compatibility repair; deploying the old image alone is insufficient.
