// Security headers — the zero-dependency counterpart of helmet.
//
// The app is a same-origin SPA served by this very process in production, and
// every API caller is `fetch` from that SPA, so the headers below cost nothing
// operationally and close the classics:
//
//   X-Content-Type-Options: nosniff   — a response is what its header says it
//                                       is (the attachment endpoint already set
//                                       this itself; setting it globally is
//                                       defence in depth, and per-route values
//                                       still win because they set it after).
//   X-Frame-Options: DENY and the     — the admin screens cannot be framed, so
//   frame-ancestors 'none'              no clickjacking overlay on top of
//                                       them. (frame-ancestors is the modern
//                                       directive; the X- header covers the
//                                       browsers that ignore CSP.)
//   Referrer-Policy: strict-origin-   — ticket numbers and requester emails in
//   when-cross-origin                   URLs never leak to a third party via
//                                       the Referer header.
//
// Production script CSP hashes the exact inline boot script in the built
// index.html. Development keeps Vite's HMR working. Inline style attributes
// remain allowed for React sizing and the shared theme-token component rules.
// HSTS is also not set: Fly terminates TLS and its proxy already answers
// redirects; a header duplicated at two layers is a header nobody owns.
//
// In production the API also locks CORS down: the SPA is served by this
// process, so cross-origin browser calls are never expected and the default
// `cors()` echo-any-origin is switched off. CORS_ORIGINS re-opens it explicitly
// for a real second origin (comma-separated); unset means credentials-carrying
// browsers are refused — the safe default for a session-token API.
const NODE_ENV = () => process.env.NODE_ENV || 'development';

function productionCsp() {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const built = path.join(__dirname, '../../client/dist/index.html');
  const html = fs.readFileSync(fs.existsSync(built) ? built : path.join(__dirname, '../../client/index.html'), 'utf8');
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]) && match[2].trim())
    .map(match => `'sha256-${crypto.createHash('sha256').update(match[2]).digest('base64')}'`);
  return `default-src 'self'; script-src 'self' ${hashes.join(' ')}; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

function securityHeaders() {
  const csp = NODE_ENV() === 'production' ? productionCsp() : "frame-ancestors 'none'";
  return function securityHeadersMiddleware(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  };
}

/**
 * CORS policy. `null` means "no CORS handling at all" — same-origin only,
 * which is exactly what the production shape (API serves the SPA) wants.
 * Exported separately so tests can assert the decision without a server.
 */
function corsOptions() {
  if (NODE_ENV() === 'production') {
    const raw = String(process.env.CORS_ORIGINS || '').trim();
    const origins = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (origins.length === 0) return null;
    return {
      origin: origins,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    };
  }
  // Development: the Vite dev server proxies /api, but a bare origin also
  // helps tooling; keep today's permissive shape locally.
  return { origin: true };
}

module.exports = { securityHeaders, corsOptions };
