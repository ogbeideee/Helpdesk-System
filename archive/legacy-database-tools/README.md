# Historical database artifacts

These files describe the old SQLite deployment and pre-migration repair work.
They are retained for historical reference, excluded from the Docker image, and
their executable entry points are disabled. Any local `.db` snapshot remains
git-ignored; it is not a production backup.

Use `server/prisma/migrations/` and `npm run db:deploy` for PostgreSQL schema
changes. The supported maintenance commands in QUICKSTART remain available.
