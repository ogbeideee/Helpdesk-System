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
const assignmentEngine = require('../src/services/assignmentEngine');
const notificationService = require('../src/mailer');
const { intakeEmailMessage, IntakeValidationError } = require('../src/services/ticketIntake');
const { classify } = require('../src/graph/categoryRules');
const assignmentPolicy = require('../src/services/assignmentPolicy');
const workloadService = require('../src/services/workloadService');
const handoverService = require('../src/services/handoverService');

const router = express.Router();

const LIST_INCLUDE = {
  assignedAgent: { select: { id: true, name: true, email: true, skillLevel: true } },
  team: true,
};
const DETAIL_INCLUDE = {
  assignedAgent: true,
  team: true,
  auditLogs: { orderBy: { createdAt: 'desc' } },
  comments: { orderBy: { createdAt: 'asc' } },
};

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
function serializeTicket(t) {
  const hoursLeft = workloadService.hoursUntilClaimable(t);
  return {
    ...t,
    awaitingAssignment: !t.assignedAgentId && isOpenState(t.state),
    // A NEW ticket becomes takeable by a teammate once it has gone unattended
    // for the configured threshold. Surfaced so the UI reflects the rule the
    // backend enforces rather than re-deriving it.
    unattended: workloadService.isUnattended(t),
    hoursUntilClaimable: hoursLeft,
    overdue: Boolean(t.dueAt && isOpenState(t.state) && new Date(t.dueAt) < new Date()),
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
    res.json(list.map(serializeTicket));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id
router.get('/:id', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res);
    if (!ticket) return;
    res.json(serializeTicket(ticket));
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

      return tx.ticket.create({
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
    });

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
    res.status(201).json(serializeTicket(full));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Shared state-machine application (used by /status, /resolve, /close).
async function applyStateChange(existing, toState, { actor, note, resolution }) {
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

  notificationService
    .notifyStatusChanged(updated, { previousState: existing.state })
    .catch(() => {});

  // A ticket that is finished has nothing to hand over: any outstanding offer
  // is cancelled and kept in the history. The ticket itself is untouched.
  if (['RESOLVED', 'CLOSED'].includes(toState)) {
    await handoverService.cancelForTicket(updated.id, actor, `Ticket was ${toState.toLowerCase()}`);
  }

  return { status: 200, body: serializeTicket(updated) };
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

    // Requester-facing updates are emailed (logged in development mode);
    // internal notes never leave the helpdesk.
    if (!isInternal && ticket.requesterEmail) {
      const subject =
        ['RESOLVED', 'CLOSED'].includes(ticket.state)
          ? `[${ticket.ticketNumber}] Update on your request`
          : `[${ticket.ticketNumber}] New message about your request`;
      notificationService
        .sendMailSafe({
          subject,
          toRecipients: [{ emailAddress: { address: ticket.requesterEmail } }],
          body: [
            `Hi ${ticket.requesterName || 'there'},`,
            '',
            `${req.agent.name} from the IT Helpdesk wrote:`,
            '',
            ...body.split('\n').map((l) => `> ${l}`),
            '',
            '--',
            `IT Helpdesk — Ticket ${ticket.ticketNumber}`,
          ].join('\r\n'),
        })
        .catch((e) => console.error(`[tickets] reply email failed: ${e.message}`));
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
        notes.push(`assignment group changed from ${previousGroup} to none`);
        // Nobody can own a ticket that belongs to no group.
        if (existing.assignedAgentId) {
          data.assignedAgentId = null;
          notes.push('cleared the assignee, who no longer matches the group');
        }
      } else {
        const team = await prisma.team.findUnique({
          where: { key: String(req.body.assignmentGroup) },
        });
        if (!team) return res.status(400).json({ errors: [`unknown assignment group "${req.body.assignmentGroup}"`] });
        data.teamId = team.id;
        notes.push(`assignment group changed from ${previousGroup} to ${team.name}`);

        // Never leave a ticket owned by someone from the wrong team.
        if (existing.assignedAgentId) {
          const current = await prisma.agent.findUnique({ where: { id: existing.assignedAgentId } });
          if (!current || current.teamId !== team.id) {
            data.assignedAgentId = null;
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
    res.json(serializeTicket(updated));
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
    await prisma.ticket.delete({ where: { id: existing.id } });
    res.json({ deleted: existing.ticketNumber, at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
