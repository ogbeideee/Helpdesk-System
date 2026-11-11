const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { STATES, isValidState, isValidPriority } = require('../states');
const { AWAITING_RESPONSE_SQL } = require('./replyActivityService');

const QUEUE_SELECT = {
  id: true, ticketNumber: true, shortDescription: true, requesterName: true,
  requesterEmail: true, category: true, priority: true, state: true,
  teamId: true, assignedAgentId: true, createdAt: true, updatedAt: true,
  dueAt: true, firstResponseAt: true, responseDueAt: true,
  responseBreached: true, resolvedAt: true, closedAt: true,
  team: { select: { id: true, key: true, name: true } },
  assignedAgent: { select: { id: true, name: true } },
  slaCycles: { orderBy: { cycleNumber: 'desc' }, take: 1 },
};

/* The quick views — the one-click questions an agent actually asks of the
   queue. The NAME is all the client sends; what each name MEANS is decided
   here, next to the SQL that implements it, so the definition cannot drift
   into a second implementation in the browser. */
const QUICK_VIEWS = ['mine', 'unassigned', 'needs-response', 'sla-overdue'];

/* One quick view as a SQL predicate.
   `viewerId` is the authenticated agent's id — "mine" is the caller's own
   work, so the id comes from the session and never from the query string. */
function quickViewClause(view, viewerId) {
  switch (view) {
    // Open work assigned to the caller. Closed and resolved tickets are
    // history, not a to-do list.
    case 'mine':
      return Number.isSafeInteger(viewerId)
        ? Prisma.sql`t."assignedAgentId" = ${viewerId} AND t."state" IN ('NEW', 'IN_PROGRESS')`
        : Prisma.sql`FALSE`;
    // Nobody has picked it up yet — the pool an agent claims from.
    case 'unassigned':
      return Prisma.sql`t."assignedAgentId" IS NULL AND t."state" IN ('NEW', 'IN_PROGRESS')`;
    // The ball is with us: the newest message on the ticket is not ours. The
    // rule itself lives in replyActivityService, which is also what draws the
    // "Reply received" chip — a filter and a chip that disagreed would be
    // worse than either alone.
    case 'needs-response':
      return Prisma.sql`t."state" <> 'CLOSED' AND ${AWAITING_RESPONSE_SQL}`;
    // Open, and a clock has already run out. Both mirrors of the current
    // cycle are read: an unanswered response past its target, or a resolution
    // past its target while the ticket is still open.
    case 'sla-overdue':
      return Prisma.sql`t."state" IN ('NEW', 'IN_PROGRESS') AND (
        (t."responseBreached" = true AND t."firstResponseAt" IS NULL)
        OR (t."dueAt" IS NOT NULL AND t."dueAt" < now())
      )`;
    default:
      return Prisma.sql`TRUE`;
  }
}

/**
 * Everything a queue query filters by, as one SQL predicate. Shared by the
 * page query and the per-status counts so the two can never describe
 * different sets — a count that disagrees with the rows is worse than none.
 */
function queueWhere(query = {}) {
  const clauses = [Prisma.sql`TRUE`];
  const view = QUICK_VIEWS.includes(String(query.view)) ? String(query.view) : '';
  if (view) clauses.push(quickViewClause(view, Number(query.viewerId)));
  if (isValidState(query.status)) clauses.push(Prisma.sql`t."state" = ${query.status}`);
  if (isValidPriority(query.priority)) clauses.push(Prisma.sql`t."priority" = ${query.priority}`);
  if (query.category) clauses.push(Prisma.sql`t."category" = ${String(query.category)}`);
  if (query.group) clauses.push(Prisma.sql`t."teamId" IN (SELECT id FROM "Team" WHERE key = ${String(query.group)})`);
  if (query.agentId === 'unassigned') clauses.push(Prisma.sql`t."assignedAgentId" IS NULL`);
  else if (query.agentId && Number.isInteger(Number(query.agentId))) clauses.push(Prisma.sql`t."assignedAgentId" = ${Number(query.agentId)}`);
  return Prisma.join(clauses, ' AND ');
}

// Parameterized SQL supplies custom priority/state ordering and exact totals.
// Fetch only the selected page's display fields through the shared client.
async function queue(query, client = prisma) {
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(query.page)) || 1));
  const pageSize = 25;
  const sorts = {
    updated: Prisma.sql`t."updatedAt"`, created: Prisma.sql`t."createdAt"`,
    age: Prisma.sql`t."createdAt"`, ticket: Prisma.sql`t."ticketNumber"`,
    priority: Prisma.sql`CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 9 END`,
    status: Prisma.sql`CASE t.state WHEN 'NEW' THEN 0 WHEN 'IN_PROGRESS' THEN 1 WHEN 'RESOLVED' THEN 2 WHEN 'CLOSED' THEN 3 ELSE 9 END`,
  };
  const sort = Object.hasOwn(sorts, query.sort) ? sorts[query.sort] : sorts.updated;
  const direction = query.direction === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const where = queueWhere(query);
  // Count separately so an emptied last page can recover to a valid page.
  const [counts, ids] = await Promise.all([
    client.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS total FROM "Ticket" t WHERE ${where}`),
    client.$queryRaw(Prisma.sql`SELECT t.id FROM "Ticket" t WHERE ${where} ORDER BY ${sort} ${direction}, t.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
  ]);
  const total = counts[0].total;
  const rows = ids.length ? await client.ticket.findMany({ where: { id: { in: ids.map(row => row.id) } }, select: QUEUE_SELECT }) : [];
  const positions = new Map(ids.map((row, index) => [row.id, index]));
  rows.sort((a, b) => positions.get(a.id) - positions.get(b.id));
  const [byStatus, viewCounts] = await Promise.all([
    statusCounts(query, client),
    quickViewCounts(Number(query.viewerId), client),
  ]);
  return {
    tickets: rows,
    total,
    page,
    pageSize,
    // `all` is the whole table, so the header can say "12 of 240" and mean it.
    counts: { all: viewCounts.all, byStatus, views: viewCounts.views },
  };
}

/**
 * How many tickets sit in each status, for the CURRENT filter context — so a
 * tab can say how much clicking it would show.
 *
 * The status clause is deliberately dropped: a count narrowed by the tab you
 * are already looking at could only ever echo the rows below it. Every other
 * filter (and the quick view) still applies, so the tabs answer "given what I
 * am already asking for, how much is in each status?".
 */
async function statusCounts(query, client = prisma) {
  const where = queueWhere({ ...query, status: '' });
  const rows = await client.$queryRaw(
    Prisma.sql`SELECT t."state" AS state, COUNT(*)::int AS count FROM "Ticket" t WHERE ${where} GROUP BY t."state"`
  );
  // Every status is present, so a tab never has to render "undefined".
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

/**
 * How much work each quick view is holding, counted with no other filter, plus
 * the size of the whole table.
 *
 * A view is a front door, and a door reading "3" when there are twelve behind
 * it is worse than one that says nothing — so these ignore the filters
 * currently on the screen and describe the whole queue. `all` rides along for
 * the same reason: it is the denominator the header needs to say "12 of 240"
 * rather than leaving "12" to mean either thing.
 *
 * One query: one conditional aggregate per view.
 */
async function quickViewCounts(viewerId, client = prisma) {
  const [mine, unassigned, needsResponse, slaOverdue] = QUICK_VIEWS.map((view) => quickViewClause(view, viewerId));
  const [row] = await client.$queryRaw(Prisma.sql`
    SELECT
      COUNT(*)::int                                 AS "all",
      COUNT(*) FILTER (WHERE ${mine})::int          AS "mine",
      COUNT(*) FILTER (WHERE ${unassigned})::int    AS "unassigned",
      COUNT(*) FILTER (WHERE ${needsResponse})::int AS "needsResponse",
      COUNT(*) FILTER (WHERE ${slaOverdue})::int    AS "slaOverdue"
    FROM "Ticket" t`);
  return {
    all: row.all,
    views: {
      mine: row.mine,
      unassigned: row.unassigned,
      'needs-response': row.needsResponse,
      'sla-overdue': row.slaOverdue,
    },
  };
}

async function people(client = prisma) {
  return client.agent.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true } });
}
module.exports = { queue, queueWhere, people, QUICK_VIEWS, QUEUE_SELECT };
