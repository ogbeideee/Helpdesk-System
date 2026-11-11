// Central error handling.
//
// Eighty-plus handlers across the routes used to answer 5xx with the raw
// `err.message` — which for a Prisma failure is a driver-level string naming
// tables, columns and constraints. Everyone signed in deserves better, and the
// log needs the truth even when the response does not carry it:
//
//   - the log retains status, route, code and stack frames, excluding raw
//     driver values and query strings that may contain private data;
//   - the client gets a generic message for 5xx (ERROR_DETAIL=1 is permitted
//     only outside production);
//   - 4xx passes through untouched — those are deliberate domain answers
//     ("already closed", "no longer RESOLVED — refresh") the UI quotes
//     verbatim, and this middleware never rewrites them.
//
// Express recognises this by arity (err, req, res, next): registered last in
// server.js, it catches anything a route's own catch re-threw, and any handler
// route-local 5xx JSON is also sanitized by the boundary in server.js.
function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars — the arity IS the contract
  return function errorHandlerMiddleware(err, req, res, _next) {
    // Status precedence: the error carries it (this codebase's convention —
    // handover 409s and the like set err.status), then whatever the response
    // already committed, then 500.
    const status =
      (err && Number.isInteger(err.status) && err.status >= 400 ? err.status : null)
      || (err && Number.isInteger(err.statusCode) && err.statusCode >= 400 ? err.statusCode : null)
      || (res.statusCode >= 400 ? res.statusCode : 500);
    const isServerError = status >= 500;

    if (isServerError) {
      const code = /^[A-Za-z0-9_]{1,40}$/.test(err?.code || '') ? err.code : 'unclassified';
      const frames = String(err?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n');
      logger.error(
        `[error] ${req.method} ${req.path || String(req.originalUrl || '').split('?')[0]} -> ${status}: ${code}` +
          (frames ? `\n${frames}` : '')
      );
    }

    if (res.headersSent) {
      // Nothing sane can be sent anymore; let express close the socket.
      return;
    }

    if (!isServerError) {
      // A 4xx that reached here unhandled still shows the caller why — those
      // messages are written for humans.
      return res.status(status).json({ error: (err && err.message) || 'Request failed' });
    }

    const detail = process.env.NODE_ENV !== 'production' && process.env.ERROR_DETAIL === '1';
    return res.status(500).json({
      error: detail
        ? String((err && err.message) || err)
        : 'Something went wrong on the server. It has been logged — try again, and contact IT if it repeats.',
    });
  };
}

module.exports = { errorHandler };
