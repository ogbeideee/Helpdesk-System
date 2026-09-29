// Resolution auto-close sweeper.
//
// When an agent resolves a ticket, the requester is asked to confirm (the
// resolve email carries a signed confirmation link). A requester who never
// answers should not leave the ticket RESOLVED forever, and nobody should
// close a hundred of them by hand: this sweep closes RESOLVED tickets once
// their confirmation window has passed.
//
// Conventions, same as the handover expiry and SLA sweepers:
//   - One bounded interval, guarded against overlapping runs (sweepRunning).
//   - Interval read at require time (interval is process-lifetime config;
//     the window itself is read from settings per sweep so an administrator's
//     change takes effect without a restart). 0 disables the sweeper.
//   - Every closure is a compare-and-set on state = 'RESOLVED' — a requester
//     confirming, an agent closing, or a reply reopening the ticket in the
//     same instant cannot be overwritten: the CAS decides.
//   - Every closure is audited ('ticket.closed', actor 'system', metadata
//     via: 'auto_close'), and the assigned agent gets an in-app notification.
//   - Single-instance by design, like every background job in this codebase.
const prisma = require('./lib/prisma');
const settingsService = require('./services/settingsService');
const auditService = require('./services/auditService');

// Read once at boot: RESOLUTION_SWEEP_INTERVAL_MINUTES, default 60.
const INTERVAL_MS = Math.max(
  0,
  Math.trunc(Number(process.env.RESOLUTION_SWEEP_INTERVAL_MINUTES ?? 60)) * 60 * 1000
);

let sweepTimer = null;
let sweepRunning = false;

/** One bounded sweep. `now` and the window are injectable for tests. */
async function sweepResolutions({ client = prisma, now = new Date(), windowDays = null } = {}) {
  const days =
    windowDays !== null && windowDays !== undefined
      ? windowDays
      : await settingsService.get('resolutionAutoCloseDays', client);
  // 0 (or a broken read falling back sanely) means: never close automatically.
  if (!Number.isFinite(days) || days <= 0) return { closed: 0, disabled: true };

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const due = await client.ticket.findMany({
    where: { state: 'RESOLVED', resolvedAt: { lte: cutoff } },
    select: {
      id: true,
      ticketNumber: true,
      resolvedAt: true,
      assignedAgentId: true,
      assignedAgent: { select: { id: true } },
    },
    take: 200,
  });

  const closedIds = [];
  for (const ticket of due) {
    // CAS: only the sweep that flips a still-RESOLVED row owns the closure.
    const result = await client.ticket.updateMany({
      where: { id: ticket.id, state: 'RESOLVED' },
      data: { state: 'CLOSED', closedAt: now },
    });
    if (result.count === 0) continue; // someone else got there first

    await client.ticketAuditLog.create({
      data: {
        ticketId: ticket.id,
        fromState: 'RESOLVED',
        toState: 'CLOSED',
        actor: 'system',
        note: 'Auto-closed — confirmation window elapsed',
      },
    });
    await auditService.record(client, {
      action: 'ticket.closed',
      entityType: 'Ticket',
      entityId: ticket.id,
      entityLabel: ticket.ticketNumber,
      ticketId: ticket.id,
      actor: 'system',
      from: { state: 'RESOLVED' },
      to: { state: 'CLOSED' },
      description: `${ticket.ticketNumber} auto-closed after ${days} day(s) without requester confirmation`,
      metadata: { via: 'auto_close', days },
    });
    if (ticket.assignedAgentId) {
      await client.notification
        .create({
          data: {
            agentId: ticket.assignedAgentId,
            ticketId: ticket.id,
            type: 'ticket_closed_by_requester',
            title: `${ticket.ticketNumber} auto-closed`,
            body: `No confirmation arrived within ${days} day(s) of resolution, so the ticket was closed automatically.`,
          },
        })
        .catch(() => {});
    }
    closedIds.push(ticket.id);
  }
  return { closed: closedIds.length, ids: closedIds, disabled: false };
}

function startResolutionSweeper({ logger = console } = {}) {
  if (INTERVAL_MS <= 0) {
    logger.log('[resolution] auto-close sweeping disabled (RESOLUTION_SWEEP_INTERVAL_MINUTES=0)');
    return false;
  }
  sweepTimer = setInterval(async () => {
    if (sweepRunning) return; // never overlap two sweeps
    sweepRunning = true;
    try {
      const { closed, disabled } = await sweepResolutions({});
      if (disabled) return; // window is 0 — configured off, stay quiet
      if (closed) logger.log(`[resolution] ${closed} resolved ticket(s) auto-closed`);
    } catch (err) {
      logger.error(`[resolution] auto-close sweep failed: ${err.message}`);
    } finally {
      sweepRunning = false;
    }
  }, INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.log(`[resolution] auto-close sweep every ${INTERVAL_MS / 60000} min`);
  return true;
}

function stopResolutionSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepRunning = false;
}

module.exports = { sweepResolutions, startResolutionSweeper, stopResolutionSweeper };
