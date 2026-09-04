require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// This backend talks to the Supabase Session Pooler (port 5432), which caps the
// number of concurrent client sessions (default 15). Prisma's own default
// connection_limit scales with CPU count (num_cpus*2+1), which on a 12-core
// host (~25) is well above the pooler's cap, so the pool over-provisions and
// intermittent EMAXCONNSESSION errors appear under concurrent query bursts.
//
// Pin the pool below the cap so a single server process can never exhaust it.
// 10 comfortably covers this app's peak concurrency (a 4-way Promise.all in
// /api/assignment-groups plus background jobs) and leaves headroom under the
// 15-client limit. Overridable via PRISMA_PG_CONNECTION_LIMIT if needed.
process.env.PRISMA_PG_CONNECTION_LIMIT = process.env.PRISMA_PG_CONNECTION_LIMIT || '10';

const { PrismaClient } = require('@prisma/client');

// Single shared instance for the whole process. Never instantiate another
// PrismaClient in the running app: a second pool would double connection use
// against the session-pooler cap.
module.exports = new PrismaClient();