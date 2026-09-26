// Minimal fixed-window rate limiter — no dependency, in-memory.
//
// Scope: this is a single-instance deployment (the background pollers assume
// one process), so a process-local Map is the right tool. Buckets are keyed by
// a caller-supplied function (IP, IP+email, account id, …) and pruned lazily
// on access plus a slow sweeper, so the Map cannot grow unboundedly.
//
// Applied only where online guessing is cheap or tokens can be probed:
//   - routes/auth.js        /login      (password guessing)
//   - routes/profile.js     /password   (current-password guessing)
//   - routes/public.js      ticket-status (signed-token probing)
// A limited request gets 429 + Retry-After and never reaches the handler —
// importantly it never reaches bcrypt, so the limiter also caps the CPU cost
// an attacker can impose.

const buckets = new Map();

function prune(now) {
  for (const [key, b] of buckets) {
    if (now > b.resetAt) buckets.delete(key);
  }
}

// Best-effort background prune; unref'd so it never keeps a process alive
// (or blocks a test suite from exiting).
const sweeper = setInterval(() => prune(Date.now()), 60_000);
sweeper.unref();

/**
 * @param {object} opts
 * @param {number} opts.windowMs  window length in ms
 * @param {number} opts.max       requests allowed per key per window
 * @param {(req) => string} opts.keyFn  bucket key; return '' to skip limiting
 * @param {string} opts.message   client-facing error text
 */
function rateLimit({ windowMs, max, keyFn, message }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
      return res.status(429).json({ error: message });
    }
    // Expose remaining budget so honest clients (and tests) can observe it.
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    next();
  };
}

/** Test hook: drop every bucket. */
function _reset() {
  buckets.clear();
}

module.exports = { rateLimit, _reset };
