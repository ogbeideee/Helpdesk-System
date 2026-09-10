// Vercel serverless entry: exposes the existing Express app to Vercel's Node runtime.
//
// server/server.js has been refactored so that requiring it does NOT bind a port and does
// NOT start any background timer (see the `require.main === module` guard there). This file
// is what Vercel compiles/bundles into the `/api/*` serverless function, so the whole
// API surface (/api/** routes) is served without running the long-lived background jobs.
//
// Vercel prerequisites (at deploy time, NOT done here):
//   - DATABASE_URL / DIRECT_URL point at the shared Supabase PostgreSQL
//   - JWT_SECRET set (production refuses to start without it)
//   - ATTACHMENT_STORAGE set to something that survives Vercel (local FS does NOT —
//     serverless filesystem is ephemeral); see vercel.json / DEPLOYMENT notes.
//
// IMPORTANT: this function serves ONLY /api/*. The SPA static assets are served by
// Vercel's static routing (see vercel.json). The `express.static` + SPA fallback in
// server.js are intentionally dead on Vercel (the static handler route is matched only when no
// /api/ prefix is present, and Vercel never sends non-/api requests here).
module.exports = require('../server/server.js').app;
