require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// This backend talks to the Supabase Session Pooler (port 5432), which caps the
// number of concurrent client sessions (default 15). Prisma's own default
// connection_limit scales with CPU count (num_cpus*2+1), which on a 12-core
// host (~25) is well above the pooler's cap, so the pool over-provisions and
// intermittent EMAXCONNSESSION errors appear under concurrent query bursts.
//
const { PrismaClient } = require('@prisma/client');

// Prisma reads connection_limit from the connection URL, not from a
// PRISMA_PG_CONNECTION_LIMIT environment variable. Apply the configured cap
// explicitly without changing the migration connection or logging credentials.
const databaseUrl = new URL(process.env.DATABASE_URL);
const requestedLimit = Number(process.env.PRISMA_PG_CONNECTION_LIMIT || databaseUrl.searchParams.get('connection_limit') || 10);
databaseUrl.searchParams.set('connection_limit', String(Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 10) : 10));

// Single shared instance for the whole process. Never instantiate another
// PrismaClient in the running app: a second pool would double connection use
// against the session-pooler cap.
module.exports = require('./membershipClient').wrap(new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } }));
