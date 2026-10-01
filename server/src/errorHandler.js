// Central error handling.
//
// Eighty-plus handlers across the routes used to answer 5xx with the raw
// `err.message` — which for a Prisma failure is a driver-level string naming
// tables, columns and constraints. Everyone signed in deserves better, and the
// log needs the truth even when the response does not carry it:
//
//   - the server log gets everything: status, route, stack, the real message;
//   - the client gets a generic message for 5xx (unless ERROR_DETAIL=1, an
//     operator switch for the rare case someone is watching a terminal and a
//     browser at the same time);
//   - 4xx passes through untouched — those are deliberate domain answers
//     ("already closed", "no longer RESOLVED — refresh") the UI quotes
//     verbatim, and this middleware never rewrites them.
//
// Express recognises this by arity (err, req, res, next): registered last in
// server.js, it catches anything a route's own catch re-threw, and any handler
// that keeps its own `res.status(500).json({ error: err.message })` keeps
// working unchanged until it is migrated.
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
      logger.error(
        `[error] ${req.method} ${req.originalUrl} -> ${status}: ${err && err.message ? err.message : err}` +
          (err && err.stack ? `\n${err.stack}` : '')
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

    const detail = process.env.ERROR_DETAIL === '1';
    return res.status(500).json({
      error: detail
        ? String((err && err.message) || err)
        : 'Something went wrong on the server. It has been logged — try again, and contact IT if it repeats.',
    });
  };
}

module.exports = { errorHandler };
