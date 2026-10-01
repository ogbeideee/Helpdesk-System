// Security surface: headers, CORS decision, central error handler.
//
// These three sit OUTSIDE every route, so a plain app mount is the honest way
// to test them: the same middleware chain server.js builds, against fixtures
// that force each branch. No database is needed — nothing here touches Prisma.
//
//   A. security headers on every response
//   B. the CORS decision (production-locked, explicit-origins, dev-permissive)
//   C. the central error handler (5xx generic + logged, 4xx untouched,
//      ERROR_DETAIL escape hatch, headers-sent guard)
//
// Usage: npm run test:error-handling  (from server/)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const express = require('express');
const { securityHeaders, corsOptions } = require('../src/securityHeaders');
const { errorHandler } = require('../src/errorHandler');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

function buildApp() {
  const app = express();
  app.use(securityHeaders());
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/throw', (_req, _res, next) => next(new Error('db blew up: table "Ticket" missing')));
  return app;
}

async function main() {
  const http = require('http');
  const server = http.createServer(buildApp());
  void buildApp;
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    /* ---- A. headers ------------------------------------------------------ */
    console.log('\n--- A. security headers ---');
    const res = await fetch(`${base}/ok`);
    await res.json();
    check('A1 nosniff is global', res.headers.get('x-content-type-options') === 'nosniff');
    check('A2 framing is denied (X-Frame-Options)', res.headers.get('x-frame-options') === 'DENY');
    check('A3 framing is denied (CSP frame-ancestors)', (res.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
    check('A4 the referrer policy is cross-origin safe', res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin');

    /* ---- B. CORS ---------------------------------------------------------- */
    console.log('\n--- B. the CORS decision ---');
    delete process.env.CORS_ORIGINS;
    process.env.NODE_ENV = 'production';
    check('B1 production with no CORS_ORIGINS is same-origin only (no cors handling)', corsOptions() === null);
    process.env.CORS_ORIGINS = 'https://helpdesk.example.com, https://backup.example.com';
    const prod = corsOptions();
    check('B2 explicit origins are honoured as a list',
      Array.isArray(prod.origin) && prod.origin.length === 2
      && prod.origin.includes('https://helpdesk.example.com'));
    check('B3 the CORS config never echoes every origin',
      !(prod.origin === true || prod.origin === '*'));
    delete process.env.CORS_ORIGINS;
    process.env.NODE_ENV = 'development';
    check('B4 development stays permissive (the Vite proxy works)', corsOptions().origin === true);
    delete process.env.NODE_ENV;

    /* ---- C. the central handler ------------------------------------------- */
    console.log('\n--- C. the central error handler ---');
    const logged = [];
    const app = express();
    app.use(securityHeaders());
    app.get('/throw', (_req, _res, next) => next(new Error('db blew up: table "Ticket" missing')));
    app.get('/http-error', (_req, _res, next) => {
      const err = new Error('no longer RESOLVED — refresh');
      err.status = 409;
      next(err);
    });
    app.get('/already-sent', (_req, res, next) => {
      res.json({ partial: true });
      next(new Error('too late'));
    });
    app.use(errorHandler({ error: (line) => logged.push(String(line)), log() {}, warn() {} }));
    const server2 = http.createServer(app);
    await new Promise((r) => server2.listen(0, r));
    const base2 = `http://127.0.0.1:${server2.address().port}`;

    const boom = await fetch(`${base2}/throw`);
    const boomBody = await boom.json();
    check('C1 an unhandled 5xx answers 500', boom.status === 500);
    check('C2 the client sees a generic message, not the driver error',
      !JSON.stringify(boomBody).includes('table "Ticket"')
      && /logged/i.test(boomBody.error));
    check('C3 the log keeps the truth (message + stack)',
      logged.join('\n').includes('db blew up') && logged.join('\n').includes('    at '));

    logged.length = 0;
    const conflict = await fetch(`${base2}/http-error`);
    const conflictBody = await conflict.json().catch(() => ({}));
    check('C4 a deliberate 4xx passes through untouched', conflict.status === 409);
    check('C5 ...and its human message is preserved verbatim',
      conflictBody.error === 'no longer RESOLVED — refresh');
    check('C6 a 4xx is not logged as an error', logged.length === 0);

    const sent = await fetch(`${base2}/already-sent`);
    check('C7 a response already sent is not clobbered', sent.status === 200);

    process.env.ERROR_DETAIL = '1';
    const detail = await (await fetch(`${base2}/throw`)).json();
    check('C8 ERROR_DETAIL=1 is the operator escape hatch',
      String(detail.error).includes('db blew up'));
    delete process.env.ERROR_DETAIL;
    server2.close();
    // The fetch keep-alive socket would still race process.exit on Windows
    // (libuv assertion at shutdown); close it with the server.
    if (server2.closeAllConnections) server2.closeAllConnections();
  } finally {
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures += 1;
    console.error(`SUITE ERROR: ${err.stack || err}`);
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  // Give the fetch keep-alive socket a beat to finish closing before exit —
  // exiting the instant server.close() runs trips a libuv assertion on Windows.
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
})();
