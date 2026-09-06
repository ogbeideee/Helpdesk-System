const express = require('express');
const prisma = require('../src/lib/prisma');
const {
  STATES,
  PRIORITIES,
  OPEN_STATES,
  isValidState,
  canTransition,
  isOpenState,
  isValidPriority,
} = require('../src/states');
const { nextTicketNumber } = require('../src/ticketNumbers');
const { computeDueAt } = require('../src/sla');
const slaService = require('../src/slaService');
const assignmentEngine = require('../src/services/assignmentEngine');
const notificationService = require('../src/mailer');
const { intakeEmailMessage, IntakeValidationError } = require('../src/services/ticketIntake');
const { classify } = require('../src/graph/categoryRules');
const assignmentPolicy = require('../src/services/assignmentPolicy');
const workloadService = require('../src/services/workloadService');
const handoverService = require('../src/services/handoverService');
const auditService = require('../src/services/auditService');
const { getAttachmentStorage } = require('../src/services/attachmentStorage');

const router = express.Router();

const LIST_INCLUDE = {
  assignedAgent: { select: { id: true, name: true, email: true, skillLevel: true } },
  team: true,
  slaCycles: { orderBy: { cycleNumber: 'asc' } },
};
const DETAIL_INCLUDE = {
  assignedAgent: true,
  team: true,
  auditLogs: { orderBy: { createdAt: 'desc' } },
  comments: { orderBy: { createdAt: 'asc' } },
  attachments: { orderBy: { createdAt: 'asc' } },
  slaCycles: { orderBy: { cycleNumber: 'asc' } },
  slaEvents: { orderBy: [{ at: 'asc' }, { id: 'asc' }] },
};

/**
 * Attachment metadata for API responses. The private storage key and the
 * source message id NEVER leave the backend — the client gets the display
 * filename, type, size and the download route to use.
 */
function serializeAttachment(a) {
  return {
    id: a.id,
    ticketId: a.ticketId,
    commentId: a.commentId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    source: a.source,
    createdAt: a.createdAt,
  };
}

function truncateShortDescription(value) {
  const str = String(value || '').trim();
  return str.length <= 160 ? str : str.slice(0, 160);
}

/**
 * Lifecycle actions (start / resolve / close) belong to the ticket's owner.
 * An administrator may always act. An unassigned open ticket stays actionable
 * so a ticket in triage never gets stuck with nobody able to touch it.
 */
function canActOnTicket(ticket, actor) {
  if (assignmentPolicy.isAdmin(actor)) return { ok: true };
  if (!actor) return { ok: false, status: 401, error: 'Authentication required' };
  if (!ticket.assignedAgentId) return { ok: true };
  if (ticket.assignedAgentId === actor.id) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'Only the assigned agent or an administrator can change this ticket',
  };
}

function actorLabel(agent) {
  return agent ? `${agent.name} <${agent.email}>` : 'system';
}

/** Decorate tickets with derived fields for clients. */
function serializeTicket(t, slaContext = {}) {
  // Raw cycle rows stay out of the payload; the structured `sla` block below
  // carries the same per-cycle history in a stable shape. SLA timeline events
  // are trimmed to the fields the ticket timeline renders; list payloads have
  // no slaEvents loaded and expose none (undefined keys vanish in JSON).
  const { slaCycles, slaEvents, attachments, ...ticket } = t;
  const hoursLeft = workloadService.hoursUntilClaimable(t);
  return {
    ...ticket,
    // Metadata only — storage keys never leave the backend.
    ...(attachments ? { attachments: attachments.map(serializeAttachment) } : {}),
    awaitingAssignment: !t.assignedAgentId && isOpenState(t.state),
    // A NEW ticket becomes takeable by a teammate once it has gone unattended
    // for the configured threshold. Surfaced so the UI reflects the rule the
    // backend enforces rather than re-deriving it.
    unattended: workloadService.isUnattended(t),
    hoursUntilClaimable: hoursLeft,
    overdue: Boolean(t.dueAt && isOpenState(t.state) && new Date(t.dueAt) < new Date()),
    sla: slaService.serializeSla(t, slaContext),
    ...(slaEvents
      ? {
          slaEvents: slaEvents.map((e) => ({
            id: e.id,
            cycleId: e.cycleId,
            type: e.type,
            clock: e.clock,
            at: e.at,
            actor: e.actor,
            detail: e.detail,
          })),
        }
      : {}),
  };
}

// Holiday calendar + working calendar for SLA serialization, so
// remaining-time math that crosses a public holiday stays exact and follows
// the configured working calendar. Two indexed queries on small tables.
async function slaCtx(now = new Date()) {
  const policy = await slaService.loadSlaPolicy();
  return {
    now,
    calendar: policy.calendar,
    holidays: await slaService.loadHolidaysBetween(
      now,
      new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
      prisma,
      policy
    ),
  };
}

async function loadTicketOr404(idParam, res, include = DETAIL_INCLUDE) {
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  const ticket = await prisma.ticket.findUnique({ where: { id }, include });
  if (!ticket) res.status(404).json({ error: 'Ticket not found' });
  return ticket;
}
// ---------------------------------------------------------------------------
// Simulated email ingestion (stands in for the future Microsoft Graph feed)
// ---------------------------------------------------------------------------
router.post('/from-email', async (req, res) => {
  try {
    const result = await intakeEmailMessage(req.body || {});
    if (result.status === 'skipped_self') {
      return res.status(200).json({ status: result.status, ticket: null });
    }
    const code =
      result.status === 'created'
        ? 201
        : result.status === 'duplicate'
          ? 200
          : 200;
    res.status(code).json({
      status: result.status,
      duplicate: result.status === 'duplicate',
      ticket: result.ticket ? serializeTicket(result.ticket) : null,
      ...(result.assignment
        ? {
            assignment: {
              group: result.assignment.groupName,
              groupKey: result.assignment.groupKey,
              minSkillLevel: result.assignment.minSkillLevel,
              assignedAgentId: result.assignment.agent ? result.assignment.agent.id : null,
              awaitingAssignment: result.assignment.awaitingAssignment,
              reason: result.assignment.reason,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof IntakeValidationError) {
      return res.status(400).json({ errors: err.errors });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
// GET /api/tickets — list with filters
router.get('/', async (req, res) => {
  try {
    const where = {};
    if (req.query.status && isValidState(req.query.status)) where.state = req.query.status;
    if (req.query.priority && isValidPriority(req.query.priority)) where.priority = req.query.priority;
    if (req.query.mine === '1') where.assignedAgentId = req.agent.id;
    if (req.query.unassigned === '1') where.assignedAgentId = null;
    if (req.query.overdue === '1') {
      where.dueAt = { lt: new Date() };
      where.state = { in: OPEN_STATES };
    }
    if (req.query.group) {
      const team = await prisma.team.findUnique({ where: { key: String(req.query.group) } });
      if (team) where.teamId = team.id;
    }
    if (req.query.category) {
      where.category = String(req.query.category);
    }
    if (req.query.agentId !== undefined && req.query.agentId !== '') {
      const agentId = Number(req.query.agentId);
      if (Number.isInteger(agentId)) where.assignedAgentId = agentId;
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      where.OR = [
        { shortDescription: { contains: q } },
        { body: { contains: q } },
        { requesterEmail: { contains: q } },
        { ticketNumber: { contains: q } },
      ];
    }

    const take = Math.min(Number(req.query.limit) || 100, 200);
    const skip = Number(req.query.skip) || 0;

    const list = await prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: LIST_INCLUDE,
    });
    const ctx = await slaCtx();
    res.json(list.map((t) => serializeTicket(t, ctx)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id
router.get('/:id', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res);
    if (!ticket) return;
    res.json(serializeTicket(ticket, await slaCtx()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Creation (portal/manual — walk-ups, phone calls)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const shortDescription = truncateShortDescription(req.body.shortDescription);
    if (!shortDescription) {
      return res.status(400).json({ errors: ['shortDescription is required'] });
    }
    const requesterEmail = String(req.body.requesterEmail || '').trim();
    if (!requesterEmail) {
      return res.status(400).json({ errors: ['requesterEmail is required'] });
    }
    const priority = isValidPriority(req.body.priority) ? req.body.priority : 'moderate';
    const body = String(req.body.body || '');
    const categoryInput = String(req.body.category || '').trim();
    const category =
      categoryInput || classify(`${shortDescription}\n${body}`).category;

    // Assignment engine decides group + best agent (unless autoAssign disabled).
    let assignment = null;
    if (req.body.autoAssign !== false) {
      assignment = await assignmentEngine.assign({
        category,
        priority,
        text: `${shortDescription}
${body || ''}`,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const ticketNumber = await nextTicketNumber(tx);
      let teamId = null;
      if (assignment) {
        teamId = assignment.teamId ?? null;
      } else if (req.body.assignmentGroup) {
        teamId =
          (await tx.team.findUnique({ where: { key: String(req.body.assignmentGroup) } }))?.id ?? null;
      }

      const ruleNote = assignment && assignment.ruleName
        ? `rule "${assignment.ruleName}"`
        : 'no routing rule matched — default group';
      const auditNote = !assignment
        ? `Created via portal by ${actorLabel(req.agent)}`
        : assignment.agent
          ? `Auto-routed to ${assignment.groupName} via ${ruleNote}, assigned to ${assignment.agent.name}` +
            (assignment.crossTeam ? ' from another team (group unchanged)' : '') +
            `: ${assignment.reason}`
          : `Routed to ${assignment.groupName || 'triage'} via ${ruleNote} — awaiting assignment (${assignment.reason})`;

      const row = await tx.ticket.create({
        data: {
          ticketNumber,
          shortDescription,
          body,
          category,
          priority,
          state: 'NEW',
          source: 'portal',
          requesterEmail,
          requesterName: req.body.requesterName ? String(req.body.requesterName).trim() : null,
          teamId,
          // Permanent record of where the ticket first landed.
          originatingTeamId: teamId,
          assignedAgentId: assignment && assignment.agent ? assignment.agent.id : null,
          dueAt: computeDueAt(priority),
          auditLogs: {
            create: [
              { fromState: null, toState: 'NEW', actor: actorLabel(req.agent), note: auditNote },
            ],
          },
        },
        include: { assignedAgent: true, team: true },
      });
      await auditService.record(tx, {
        action: 'ticket.created',
        entityType: 'Ticket',
        entityId: row.id,
        entityLabel: row.ticketNumber,
        ticketId: row.id,
        actor: req.agent,
        to: { state: 'NEW', priority, category, source: 'portal' },
        description: `${row.ticketNumber} created via portal by ${actorLabel(req.agent)}`,
        metadata: {
          group: assignment ? assignment.groupName ?? null : teamId ? (await tx.team.findUnique({ where: { id: teamId } }))?.name ?? null : null,
          assignedAgent: assignment && assignment.agent ? assignment.agent.name : null,
          rule: assignment ? assignment.ruleName ?? null : null,
        },
      });
      return row;
    });

    // SLA cycle 1 starts at creation. It recomputes the targets on the
    // working calendar (Mon–Fri 08:00–17:00 Lagos, holidays excluded) and
    // syncs Ticket.dueAt / responseDueAt to the cycle, replacing the calendar
    // estimate set above.
    await slaService.startCycle(created, { cycleNumber: 1, startedAt: created.createdAt });

    // Notifications (development mode logs them).
    notificationService.notifyNewTicketToDl(created).catch(() => {});
    notificationService.notifyRequesterAck(created).catch(() => {});
    if (created.assignedAgent) {
      notificationService.notifyAssignment(created, created.assignedAgent).catch(() => {});
    }

    const full = await prisma.ticket.findUnique({
      where: { id: created.id },
      include: DETAIL_INCLUDE,
    });
    res.status(201).json(serializeTicket(full, await slaCtx()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Shared state-machine application (used by /status, /resolve, /close).
async function applyStateChange(existing, toState, { actor, agent, note, resolution }) {
  if (!isValidState(toState)) {
    return { status: 400, body: { errors: [`state must be one of: ${STATES.join(', ')}`] } };
  }
  if (toState === existing.state) {
    return { status: 400, body: { error: `Ticket is already ${toState}` } };
  }
  if (!canTransition(existing.state, toState)) {
    return {
      status: 400,
      body: { error: `Invalid transition ${existing.state} -> ${toState}` },
    };
  }

  const data = {
    state: toState,
    auditLogs: {
      create: {
        fromState: existing.state,
        toState,
        actor,
        note: note || null,
      },
    },
  };

  if (toState === 'RESOLVED') {
    const text = String(resolution ?? '').trim() || String(existing.resolution || '').trim();
    if (!text) {
      return {
        status: 400,
        body: { error: 'A resolution note is required when moving to RESOLVED' },
      };
    }
    data.resolution = text;
    data.resolvedAt = new Date();
  } else if (toState === 'IN_PROGRESS') {
    // Reopen/rework path.
    if (['RESOLVED', 'CLOSED'].includes(existing.state)) {
      data.resolvedAt = null;
      data.closedAt = null;
      data.resolution = null;
    }
  } else if (toState === 'CLOSED') {
    data.closedAt = new Date();
  }

  const updated = await prisma.ticket.update({
    where: { id: existing.id },
    data,
    include: DETAIL_INCLUDE,
  });

  // Unified trail: the state transition (TicketAuditLog keeps its own row
  // above — the domain timeline is untouched).
  await auditService.record(prisma, {
    action:
      toState === 'RESOLVED'
        ? 'ticket.resolved'
        : toState === 'CLOSED'
          ? 'ticket.closed'
          : toState === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(existing.state)
            ? 'ticket.reopened'
            : toState === 'IN_PROGRESS' && existing.state === 'NEW'
              ? 'ticket.started'
              : 'ticket.status_changed',
    entityType: 'Ticket',
    entityId: existing.id,
    entityLabel: existing.ticketNumber,
    ticketId: existing.id,
    actor: agent || actor,
    from: { state: existing.state },
    to: { state: toState },
    description: `${existing.ticketNumber} moved from ${existing.state} to ${toState}`,
    metadata: note ? { note } : null,
  });

  notificationService
    .notifyStatusChanged(updated, { previousState: existing.state })
    .catch(() => {});

  // A ticket that is finished has nothing to hand over: any outstanding offer
  // is cancelled and kept in the history. The ticket itself is untouched.
  if (['RESOLVED', 'CLOSED'].includes(toState)) {
    await handoverService.cancelForTicket(updated.id, actor, `Ticket was ${toState.toLowerCase()}`);
  }

  // SLA bookkeeping for the lifecycle transitions that matter: RESOLVED
  // closes out the current cycle with its outcome; a reopen from RESOLVED or
  // CLOSED preserves that cycle and starts the next one.
  let slaTicket = null;
  if (toState === 'RESOLVED') {
    slaTicket = await slaService.finalizeOpenCycle(updated, {
      at: data.resolvedAt,
      actor,
      include: DETAIL_INCLUDE,
    });
  } else if (toState === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(existing.state)) {
    slaTicket = await slaService.restartCycle(updated, {
      actor,
      reason: `Reopened from ${existing.state}`,
      include: DETAIL_INCLUDE,
    });
  }

  return { status: 200, body: serializeTicket(slaTicket || updated, await slaCtx()) };
}

// POST /api/tickets/:id/status — explicit workflow transitions
router.post('/:id/status', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res);
    if (!ticket) return;
    if (req.body.state === undefined) {
      return res.status(400).json({ errors: ['state is required'] });
    }
    const result = await applyStateChange(ticket, req.body.state, {
      actor: actorLabel(req.agent),
      agent: req.agent,
      note: req.body.note,
      resolution: req.body.resolution,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/resolve — shortcut requiring a resolution note
router.post('/:id/resolve', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res);
    if (!ticket) return;
    const allowed = canActOnTicket(ticket, req.agent);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    if (!String(req.body.resolution || '').trim() && !String(ticket.resolution || '').trim()) {
      return res.status(400).json({ error: 'resolution is required to resolve a ticket' });
    }
    const result = await applyStateChange(ticket, 'RESOLVED', {
      actor: actorLabel(req.agent),
      agent: req.agent,
      resolution: req.body.resolution,
      note: req.body.note,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/close — only from RESOLVED
router.post('/:id/close', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res);
    if (!ticket) return;
    const allowed = canActOnTicket(ticket, req.agent);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    const result = await applyStateChange(ticket, 'CLOSED', {
      actor: actorLabel(req.agent),
      agent: req.agent,
      note: req.body.note,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/assign — route to a specific agent
router.post('/:id/assign', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;
    if (['RESOLVED', 'CLOSED'].includes(ticket.state)) {
      return res
        .status(400)
        .json({ error: `Cannot assign a ${ticket.state.toLowerCase()} ticket` });
    }

    let agent = null;
    if (req.body.agentId !== undefined) {
      if (!Number.isInteger(req.body.agentId)) {
        return res.status(400).json({ error: 'agentId must be an integer' });
      }
      agent = await prisma.agent.findUnique({ where: { id: req.body.agentId } });
    } else if (req.body.agentEmail !== undefined) {
      agent = await prisma.agent.findUnique({
        where: { email: String(req.body.agentEmail).trim().toLowerCase() },
      });
    } else {
      return res.status(400).json({ error: 'agentId or agentEmail is required' });
    }
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Authorization lives in the policy, not in the UI: an agent may only
    // hand their own ticket to an available teammate in the same group.
    const verdict = assignmentPolicy.checkTarget(ticket, req.agent, agent);
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error });
    }

    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const previous = ticket.assignedAgent ? ticket.assignedAgent.name : 'nobody';
    const groupName = ticket.team ? ticket.team.name : 'no group';

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        assignedAgentId: agent.id,
        auditLogs: {
          create: {
            fromState: ticket.state,
            toState: ticket.state,
            actor: actorLabel(req.agent),
            // Previous holder, new holder and group are all preserved so the
            // history reads as a handover rather than an overwrite.
            note:
              `Reassigned from ${previous} to ${agent.name} ` +
              `(${groupName}, skill level ${agent.skillLevel})` +
              (reason ? ` — Reason: ${reason}` : ''),
          },
        },
      },
      include: DETAIL_INCLUDE,
    });

    await auditService.record(prisma, {
      action: 'ticket.assigned',
      entityType: 'Ticket',
      entityId: ticket.id,
      entityLabel: ticket.ticketNumber,
      ticketId: ticket.id,
      actor: req.agent,
      from: {
        assignedAgentId: ticket.assignedAgentId ?? null,
        assignedAgent: ticket.assignedAgent ? ticket.assignedAgent.name : null,
      },
      to: { assignedAgentId: agent.id, assignedAgent: agent.name },
      description: `${ticket.ticketNumber} reassigned from ${previous} to ${agent.name}`,
      metadata: { group: groupName, reason: reason || null, via: 'assign' },
    });

    if (ticket.assignedAgentId !== agent.id) {
      notificationService.notifyAssignment(updated, agent).catch(() => {});
    }
    res.json(serializeTicket(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/reassign — hand a ticket to a teammate
//
// Same rules as /assign (one policy, one implementation); this endpoint exists
// because "reassign" is the action agents actually perform and it carries an
// optional reason.
router.post('/:id/reassign', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;

    let target = null;
    if (req.body.agentId !== undefined) {
      if (!Number.isInteger(req.body.agentId)) {
        return res.status(400).json({ error: 'agentId must be an integer' });
      }
      target = await prisma.agent.findUnique({ where: { id: req.body.agentId } });
    } else if (req.body.agentEmail !== undefined) {
      target = await prisma.agent.findUnique({
        where: { email: String(req.body.agentEmail).trim().toLowerCase() },
      });
    } else {
      return res.status(400).json({ error: 'agentId or agentEmail is required' });
    }

    const verdict = assignmentPolicy.checkTarget(ticket, req.agent, target);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const previous = ticket.assignedAgent ? ticket.assignedAgent.name : 'nobody';
    const groupName = ticket.team ? ticket.team.name : 'no group';

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        assignedAgentId: target.id,
        auditLogs: {
          create: {
            fromState: ticket.state,
            toState: ticket.state,
            actor: actorLabel(req.agent),
            note:
              `Reassigned from ${previous} to ${target.name} ` +
              `(${groupName}, skill level ${target.skillLevel})` +
              (reason ? ` — Reason: ${reason}` : ''),
          },
        },
      },
      include: DETAIL_INCLUDE,
    });

    await auditService.record(prisma, {
      action: 'ticket.assigned',
      entityType: 'Ticket',
      entityId: ticket.id,
      entityLabel: ticket.ticketNumber,
      ticketId: ticket.id,
      actor: req.agent,
      from: {
        assignedAgentId: ticket.assignedAgentId ?? null,
        assignedAgent: ticket.assignedAgent ? ticket.assignedAgent.name : null,
      },
      to: { assignedAgentId: target.id, assignedAgent: target.name },
      description: `${ticket.ticketNumber} reassigned from ${previous} to ${target.name}`,
      metadata: { group: groupName, reason: reason || null, via: 'reassign' },
    });

    notificationService.notifyAssignment(updated, target).catch(() => {});
    res.json(serializeTicket(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id/assignment-candidates — who this ticket can go to
//
// Returns availability, workload and skill for each candidate plus whether the
// caller may actually select them, so the UI can render the list without
// re-deriving any rule.
router.get('/:id/assignment-candidates', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;

    const candidates = await assignmentPolicy.listCandidates(ticket, req.agent);
    res.json({
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      state: ticket.state,
      assignmentGroup: ticket.team
        ? { id: ticket.team.id, key: ticket.team.key, name: ticket.team.name }
        : null,
      currentAssignee: ticket.assignedAgent
        ? {
            id: ticket.assignedAgent.id,
            name: ticket.assignedAgent.name,
            email: ticket.assignedAgent.email,
            skillLevel: ticket.assignedAgent.skillLevel,
            available: ticket.assignedAgent.isActive,
            openTickets: await assignmentPolicy.workloadFor(ticket.assignedAgent.id),
          }
        : null,
      // Admins may reach other groups; agents see their own group only.
      canChangeGroup: assignmentPolicy.isAdmin(req.agent),
      candidates,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/start — NEW -> IN_PROGRESS in one click
//
// The assignee (or an admin) begins work without touching a status dropdown.
router.post('/:id/start', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;

    if (ticket.state !== 'NEW') {
      return res
        .status(400)
        .json({ error: `Only a NEW ticket can be started (this one is ${ticket.state})` });
    }

    const admin = assignmentPolicy.isAdmin(req.agent);
    if (!admin) {
      if (!ticket.assignedAgentId) {
        return res
          .status(403)
          .json({ error: 'Claim this ticket before starting work on it' });
      }
      if (ticket.assignedAgentId !== req.agent.id) {
        return res
          .status(403)
          .json({ error: 'You can only start work on tickets assigned to you' });
      }
    }

    const result = await applyStateChange(ticket, 'IN_PROGRESS', {
      actor: actorLabel(req.agent),
      agent: req.agent,
      note: req.body && req.body.note ? String(req.body.note) : 'Work started',
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets/:id/claim — "Take Ticket"
//
// An agent may take an unassigned ticket in their own group at any time, or
// one already assigned to a colleague only once it has been NEW and untouched
// for the unattended threshold (4h by default). Administrators are exempt.
// The move is concurrency-safe: two agents racing for the same ticket cannot
// both win.
async function takeTicket(req, res) {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;

    const verdict = workloadService.checkClaim(ticket, req.agent);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    const outcome = await workloadService.moveTicket({
      ticket,
      toAgentId: req.agent.id,
      actor: req.agent,
      note: `taken by ${req.agent.name} (${verdict.reason})`,
      notificationType: 'ticket_taken',
      // The previous assignee is told their ticket was taken.
      notifyPrevious: true,
    });

    if (!outcome.moved) {
      // Somebody else got there first.
      return res.status(409).json({ error: 'Another agent took this ticket first' });
    }

    const fresh = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: DETAIL_INCLUDE,
    });
    res.json(serializeTicket(fresh));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// One handler, two names: "claim" is the historical path, "take" is what the
// UI calls the action.
router.post('/:id/claim', takeTicket);
router.post('/:id/take', takeTicket);

// ---------------------------------------------------------------------------
// Handovers (agent A offers the ticket to agent B; B decides)
// ---------------------------------------------------------------------------

// POST /api/tickets/:id/handover — request a handover to a teammate.
// The ticket does NOT change owner here; see routes/handovers.js for the reply.
router.post('/:id/handover', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, { assignedAgent: true, team: true });
    if (!ticket) return;
    if (!Number.isInteger(req.body && req.body.agentId)) {
      return res.status(400).json({ error: 'agentId is required' });
    }
    const result = await handoverService.createRequest({
      ticket,
      actor: req.agent,
      targetAgentId: req.body.agentId,
      note: req.body.note,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id/attachments/:attachmentId — authorized download.
//
// The ONLY path to attachment content. Authentication comes from the router
// (requireAuth on /api/tickets); any agent who may read the ticket may
// download its attachments, matching ticket visibility. Content is always
// served as an inert octet-stream with an attachment disposition and
// nosniff — an inbound attachment is never executed, rendered or previewed,
// whatever its declared MIME type says. Storage keys never appear anywhere
// in the response.
router.get('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {});
    if (!ticket) return;
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(attachmentId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, ticketId: ticket.id },
    });
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    let content;
    try {
      content = await getAttachmentStorage().get(attachment.storageKey);
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        // The metadata row exists but the object is gone — say so plainly
        // instead of pretending the download succeeded.
        return res.status(404).json({ error: 'Attachment content is no longer available' });
      }
      throw err;
    }

    const asciiFallback = attachment.filename.replace(/[^\x20-\x7e]/g, '_') || `attachment-${attachment.id}`;
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(content.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback.replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id/handovers — the complete handover chain, oldest first
router.get('/:id/handovers', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {});
    if (!ticket) return;
    res.json({ handovers: await handoverService.historyForTicket(ticket.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared handler for internal notes and requester-facing updates.
async function addNote(req, res) {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note body is required' });
    const isInternal = Boolean(req.body.isInternal);

    const comment = await prisma.comment.create({
      data: {
        ticketId: ticket.id,
        authorAgentId: req.agent.id,
        authorName: req.agent.name,
        authorEmail: req.agent.email,
        isRequester: false,
        isInternal,
        body: body.slice(0, 8000),
      },
    });

    // Response SLA: the first public agent reply is the qualifying response.
    // Internal notes and requester messages never count (requester replies
    // arrive through intake, which does not call this).
    if (!isInternal) {
      await slaService.recordFirstResponse(ticket, {
        at: comment.createdAt,
        responderId: req.agent.id,
        actor: actorLabel(req.agent),
      });
    }

    // Unified trail: that a note exists, who wrote it and whether it is
    // internal — never its content, which lives on the Comment row.
    await auditService.record(prisma, {
      action: 'ticket.commented',
      entityType: 'Comment',
      entityId: comment.id,
      entityLabel: `${ticket.ticketNumber} note #${comment.id}`,
      ticketId: ticket.id,
      actor: req.agent,
      description:
        `${req.agent.name} added ${isInternal ? 'an internal note' : 'a public reply'} to ${ticket.ticketNumber}`,
      metadata: { isInternal },
    });

    // Requester-facing updates are emailed (logged in development mode);
    // internal notes never leave the helpdesk. Assembly and sending live in
    // the mailer — the route only decides WHO may be emailed.
    if (!isInternal && ticket.requesterEmail) {
      notificationService
        .notifyAgentReply(ticket, { agentName: req.agent.name, body })
        .catch(() => {});
    }

    res.status(201).json(comment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/tickets/:id/notes  (alias kept: /comments)
router.post('/:id/notes', addNote);
router.post('/:id/comments', addNote);

// ---------------------------------------------------------------------------
// Partial update (PATCH; PUT kept as an alias)
// ---------------------------------------------------------------------------
function validatePatchBody(body) {
  const errors = [];
  if (body.state !== undefined) errors.push('state cannot be changed via PATCH — use POST /api/tickets/:id/status');
  if (body.assignedAgentId !== undefined || body.agentId !== undefined) {
    errors.push('assignment cannot be changed via PATCH — use POST /api/tickets/:id/assign');
  }
  if (body.resolution !== undefined) {
    errors.push('resolution is set when resolving — use POST /api/tickets/:id/resolve');
  }
  if (body.shortDescription !== undefined && !truncateShortDescription(body.shortDescription)) {
    errors.push('shortDescription cannot be empty');
  }
  if (body.priority !== undefined && !isValidPriority(body.priority)) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  return errors;
}

async function patchTicket(req, res) {
  try {
    const existing = await loadTicketOr404(req.params.id, res, { team: true, assignedAgent: true });
    if (!existing) return;

    const errors = validatePatchBody(req.body || {});
    if (errors.length) return res.status(400).json({ errors });

    const data = {};
    const notes = [];
    const patchMeta = { clearedAssignee: false, autoAssignedTo: null };
    let newGroupName;
    if (req.body.shortDescription !== undefined) {
      data.shortDescription = truncateShortDescription(req.body.shortDescription);
    }
    if (req.body.body !== undefined) data.body = String(req.body.body);
    if (req.body.category !== undefined && String(req.body.category).trim()) {
      data.category = String(req.body.category).trim().slice(0, 80);
    }
    if (req.body.requesterName !== undefined) {
      data.requesterName = req.body.requesterName ? String(req.body.requesterName).trim() : null;
    }
    if (req.body.priority !== undefined && req.body.priority !== existing.priority) {
      data.priority = req.body.priority;
      data.dueAt = computeDueAt(req.body.priority, existing.createdAt);
      notes.push(`priority changed to ${req.body.priority} (SLA target recalculated)`);
    }
    if (req.body.assignmentGroup !== undefined) {
      // Moving a ticket between teams is an administrator action: an agent
      // must not be able to push work onto an unrelated group.
      const verdict = assignmentPolicy.checkGroupChange(existing, req.agent);
      if (!verdict.ok) return res.status(verdict.status).json({ errors: [verdict.error] });

      const previousGroup = existing.team ? existing.team.name : 'none';

      if (req.body.assignmentGroup === null) {
        data.teamId = null;
        newGroupName = null;
        notes.push(`assignment group changed from ${previousGroup} to none`);
        // Nobody can own a ticket that belongs to no group.
        if (existing.assignedAgentId) {
          data.assignedAgentId = null;
          patchMeta.clearedAssignee = true;
          notes.push('cleared the assignee, who no longer matches the group');
        }
      } else {
        const team = await prisma.team.findUnique({
          where: { key: String(req.body.assignmentGroup) },
        });
        if (!team) return res.status(400).json({ errors: [`unknown assignment group "${req.body.assignmentGroup}"`] });
        data.teamId = team.id;
        newGroupName = team.name;
        notes.push(`assignment group changed from ${previousGroup} to ${team.name}`);

        // Never leave a ticket owned by someone from the wrong team.
        if (existing.assignedAgentId) {
          const current = await prisma.agent.findUnique({ where: { id: existing.assignedAgentId } });
          if (!current || current.teamId !== team.id) {
            data.assignedAgentId = null;
            patchMeta.clearedAssignee = true;
            notes.push(
              `cleared the assignee ${current ? current.name : 'unknown'}, who is not in ${team.name}`
            );
          }
        }

        // Re-route through the existing engine when the ticket is now
        // unassigned and still open. Opt out with autoAssign:false.
        const wantsAuto = req.body.autoAssign !== false;
        const willBeUnassigned =
          data.assignedAgentId === null || (!existing.assignedAgentId && data.assignedAgentId === undefined);
        if (wantsAuto && willBeUnassigned && isOpenState(existing.state)) {
          const decision = await assignmentEngine.assign(
            {
              category: existing.category,
              priority: existing.priority,
              text: `${existing.shortDescription}
${existing.body || ''}`,
              // Pin the group the admin just chose: routing rules must not
              // move the ticket somewhere else behind their back.
              forceTeamId: team.id,
            },
            prisma,
            { log: () => {}, warn: () => {} }
          );
          if (decision.agent && decision.agent.teamId === team.id) {
            data.assignedAgentId = decision.agent.id;
            patchMeta.autoAssignedTo = decision.agent.name;
            notes.push(`auto-assigned to ${decision.agent.name} by the assignment engine`);
          }
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ errors: ['no supported fields to update'] });
    }
    if (notes.length) {
      data.auditLogs = {
        create: {
          fromState: existing.state,
          toState: existing.state,
          actor: actorLabel(req.agent),
          note: notes.join('; '),
        },
      };
    }

    const updated = await prisma.ticket.update({
      where: { id: existing.id },
      data,
      include: DETAIL_INCLUDE,
    });

    // Unified trail: priority and group moves get their own documented
    // actions; anything else that changed is one structured ticket.updated
    // event. (TicketAuditLog keeps its combined note row from above.)
    if (data.priority !== undefined) {
      await auditService.record(prisma, {
        action: 'ticket.priority_changed',
        entityType: 'Ticket',
        entityId: existing.id,
        entityLabel: existing.ticketNumber,
        ticketId: existing.id,
        actor: req.agent,
        from: { priority: existing.priority },
        to: { priority: data.priority },
        description: `${existing.ticketNumber} priority changed from ${existing.priority} to ${data.priority}`,
        metadata: { slaTargetRecalculated: true },
      });
    }
    if (data.teamId !== undefined && data.teamId !== existing.teamId) {
      await auditService.record(prisma, {
        action: 'ticket.group_changed',
        entityType: 'Ticket',
        entityId: existing.id,
        entityLabel: existing.ticketNumber,
        ticketId: existing.id,
        actor: req.agent,
        from: { group: existing.team ? existing.team.name : null },
        to: { group: newGroupName ?? null },
        description:
          `${existing.ticketNumber} assignment group changed from ` +
          `${existing.team ? existing.team.name : 'none'} to ${newGroupName ?? 'none'}`,
        metadata: patchMeta,
      });
    }
    const editedFields = ['shortDescription', 'body', 'category', 'requesterName'].filter(
      (key) => data[key] !== undefined && data[key] !== existing[key]
    );
    if (editedFields.length) {
      // `body` is free text that lives on the ticket — record that it changed,
      // never its contents.
      await auditService.record(prisma, {
        action: 'ticket.updated',
        entityType: 'Ticket',
        entityId: existing.id,
        entityLabel: existing.ticketNumber,
        ticketId: existing.id,
        actor: req.agent,
        from: Object.fromEntries(
          editedFields.filter((k) => k !== 'body').map((k) => [k, existing[k]])
        ),
        to: Object.fromEntries(
          editedFields.filter((k) => k !== 'body').map((k) => [k, data[k]])
        ),
        description: `${existing.ticketNumber} updated (${editedFields.join(', ')})`,
        metadata: editedFields.includes('body') ? { fields: editedFields } : null,
      });
    }

    // Priority changes recompute the open cycle's resolution target from the
    // cycle start (approved policy 8), not from the change instant. Tickets
    // without an SLA cycle (created before the feature) keep the calendar
    // dueAt computed above.
    let slaUpdated = null;
    if (data.priority !== undefined) {
      slaUpdated = await slaService.onPriorityChanged(updated, {
        actor: actorLabel(req.agent),
        previousPriority: existing.priority,
        include: DETAIL_INCLUDE,
      });
    }
    res.json(serializeTicket(slaUpdated || updated, await slaCtx()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.patch('/:id', patchTicket);
router.put('/:id', patchTicket);

// DELETE /api/tickets/:id — admin only
router.delete('/:id', async (req, res) => {
  try {
    if (req.agent.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator role required to delete tickets' });
    }
    const existing = await loadTicketOr404(req.params.id, res);
    if (!existing) return;
    // One atomic step: the event and the deletion commit or roll back
    // together, and the event's ticketId link is SetNull'd by the delete while
    // the entityLabel keeps the ticket number readable afterwards.
    await prisma.$transaction([
      prisma.auditEvent.create({
        data: auditService.buildEvent({
          action: 'ticket.deleted',
          entityType: 'Ticket',
          entityId: existing.id,
          entityLabel: existing.ticketNumber,
          ticketId: existing.id,
          actor: req.agent,
          from: { state: existing.state, shortDescription: existing.shortDescription },
          description: `Ticket ${existing.ticketNumber} deleted by ${req.agent.name} <${req.agent.email}>`,
        }),
      }),
      prisma.ticket.delete({ where: { id: existing.id } }),
    ]);
    res.json({ deleted: existing.ticketNumber, at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
