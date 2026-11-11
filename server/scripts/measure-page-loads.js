// Disposable PostgreSQL only; optional controlled per-query delay models distance,
// not production latency. Run the identical script before and after changes.
const fixture = require('./lib/testdb').use('page_load_measurement');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const baseClient = new PrismaClient();
const delay = Number(process.env.MEASURE_QUERY_DELAY_MS || 0);
let queries = 0;
const raw = baseClient.$extends({ query: { $allModels: { async $allOperations({ args, query }) {
  queries++;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  return query(args);
} } } });
const prisma = require('../src/lib/membershipClient').wrap(raw);
require.cache[require.resolve('../src/lib/prisma')] = { exports: prisma };
const { app } = require('../server');
const { signToken } = require('../src/authMiddleware');
async function main() {
  const agent = await prisma.agent.create({ data: { name: 'Benchmark admin', email: 'benchmark@example.com', role: 'admin' } });
  const ticket = await prisma.ticket.create({ data: { ticketNumber: 'BENCH-1', shortDescription: 'Benchmark request', body: 'Please help', requesterEmail: 'requester@example.com' } });
  await prisma.comment.createMany({ data: Array.from({ length: 35 }, (_, i) => ({ ticketId: ticket.id, body: `Reply ${i}`, authorEmail: 'requester@example.com', isRequester: true })) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const result = { queryDelayMs: delay, samples: 12, endpoints: {} };
    for (const path of [`/tickets/${ticket.id}?history=recent`, '/tickets/queue?page=1', '/dashboard']) {
      const times = [], counts = [];
      for (let i = 0; i < 14; i++) {
        queries = 0;
        const start = performance.now();
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${signToken(agent)}` } });
        const data = await response.json();
        assert.equal(response.status, 200, JSON.stringify(data));
        if (path.includes('history')) { assert.equal(data.comments.length, 20); assert.equal(data.history.olderReplyCount, 15); }
        if (i >= 2) { times.push(performance.now() - start); counts.push(queries); }
      }
      times.sort((a, b) => a - b);
      result.endpoints[path.replace(`/tickets/${ticket.id}?`, '/tickets/:id?')] = { medianMs: +((times[5] + times[6]) / 2).toFixed(1), p95Ms: +times[11].toFixed(1), queryOperations: Math.max(...counts) };
    }
    console.log('MEASUREMENT ' + JSON.stringify(result));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await raw.$disconnect(); fixture.cleanup(); });

