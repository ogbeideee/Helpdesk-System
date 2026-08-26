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

function actorLabel(agent) {
  return agent ? `${agent.name} <${agent.email}>` : 'system';
}

/** Decorate tickets with derived fields for clients. */
function serializeTicket(t) {
  return {
    ...t,
    awaitingAssignment: !t.assignedAgentId && isOpenState(t.state),
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
      assignment = await assignmentEngine.assign({ category, priority });
    }

    const created = await prisma.$transaction(async (tx) => {
      const ticketNumber = await nextTicketNumber(tx);
      let teamId = null;
      if (assignment) {
        teamId = assignment.groupName
          ? (await tx.team.findUnique({ where: { key: assignment.groupKey } }))?.id ?? null
          : null;
      } else if (req.body.assignmentGroup) {
        teamId =
          (await tx.team.findUnique({ where: { key: String(req.body.assignmentGroup) } }))?.id ?? null;
      }

      const auditNote = !assignment
        ? `Created via portal by ${actorLabel(req.agent)}`
        : assignment.agent
          ? `Auto-routed to ${assignment.groupName}, assigned to ${assignment.agent.name}: ${assignment.reason}`
          : `Routed to ${assignment.groupName || 'triage'} — awaiting assignment (${assignment.reason})`;

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
    if (!agent.isActive) return res.status(400).json({ error: `Agent ${agent.email} is inactive` });

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        assignedAgentId: agent.id,
        auditLogs: {
          create: {
            fromState: ticket.state,
            toState: ticket.state,
            actor: actorLabel(req.agent),
            note:
              ticket.assignedAgentId === agent.id
                ? `Reconfirmed assignment to ${agent.name}`
                : `Assigned to ${agent.name}${agent.skillLevel ? ` (skill level ${agent.skillLevel})` : ''}`,
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

// POST /api/tickets/:id/claim — convenience: assign to self
router.post('/:id/claim', async (req, res) => {
  try {
    const ticket = await loadTicketOr404(req.params.id, res, {
      assignedAgent: true,
      team: true,
    });
    if (!ticket) return;
    if (['RESOLVED', 'CLOSED'].includes(ticket.state)) {
      return res.status(400).json({ error: `Cannot claim a ${ticket.state.toLowerCase()} ticket` });
    }
    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        assignedAgentId: req.agent.id,
        auditLogs: {
          create: {
            fromState: ticket.state,
            toState: ticket.state,
            actor: actorLabel(req.agent),
            note: 'Claimed via portal',
          },
        },
      },
      include: DETAIL_INCLUDE,
    });
    res.json(serializeTicket(updated));
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
    const existing = await loadTicketOr404(req.params.id, res, { team: true });
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
      if (req.body.assignmentGroup === null) {
        data.teamId = null;
        notes.push('removed from assignment group');
      } else {
        const team = await prisma.team.findUnique({
          where: { key: String(req.body.assignmentGroup) },
        });
        if (!team) return res.status(400).json({ errors: [`unknown assignment group "${req.body.assignmentGroup}"`] });
        data.teamId = team.id;
        notes.push(`moved to assignment group ${team.name}`);
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
