// Unified audit trail — read-only, administrator-only.
//
// Mounted behind requireAdmin (see server.js): the AuditEvent table is the
// single cross-entity trail written by trusted backend code through
// src/services/auditService.js. This router only reads it: server-side
// filtering, server-side pagination, no write path of any kind.
//
// The domain-specific logs (TicketAuditLog, UserAuditLog, RoutingRuleAuditLog)
// keep their own endpoints and are untouched by this API.
const express = require('express');
const prisma = require('../src/lib/prisma');
const auditService = require('../src/services/auditService');

const router = express.Router();

// The entity kinds the instrumented write paths produce. Sent along with every
// response so the admin UI can offer the filter list without a second call.
const ENTITY_TYPES = [
  'Ticket',
  'Comment',
  'HandoverRequest',
  'Agent',
  'Team',
  'RoutingRule',
  'Setting',
  'SlaHoliday',
];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Strict ISO bound parsing, identical contract to the SLA report router. */
function parseBound(name, raw) {
  if (raw === undefined || raw === '') return { value: null };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { error: `${name} must be an ISO date (e.g. 2026-09-01 or 2026-09-01T00:00:00Z)` };
  }
  return { value: date };
}

// Stored rows are redacted at write time (auditService.sanitizeValue). The
// same filter is re-applied to object-shaped fields on the way out, so a
// credential-shaped key can never reach a client whatever wrote the row.
function redactParsed(value) {
  return value && typeof value === 'object' ? auditService.sanitizeValue(value) : value;
}

function serializeForApi(event) {
  const s = auditService.serialize(event);
  return {
    ...s,
    from: redactParsed(s.from),
    to: redactParsed(s.to),
    metadata: redactParsed(s.metadata),
  };
}

// GET /api/audit — paged, filtered trail.
//
//   action      substring of the action name, case-insensitive ("ticket." …)
//   entityType  exact entity kind, one of the ENTITY_TYPES
//   actor       substring of the actor label ("Ada <ada@…>", "system", an email)
//   actorId     exact acting agent id
//   from / to   createdAt bounds (ISO); from after to is rejected
//   page        1-based (default 1)
//   pageSize    1–200 (default 50)
router.get('/', async (req, res) => {
  try {
    const where = {};

    if (req.query.action !== undefined && String(req.query.action).trim() !== '') {
      where.action = { contains: String(req.query.action).trim(), mode: 'insensitive' };
    }
    if (req.query.entityType !== undefined && String(req.query.entityType).trim() !== '') {
      where.entityType = String(req.query.entityType).trim();
    }
    if (req.query.actor !== undefined && String(req.query.actor).trim() !== '') {
      where.actorLabel = { contains: String(req.query.actor).trim(), mode: 'insensitive' };
    }
    if (req.query.actorId !== undefined && String(req.query.actorId).trim() !== '') {
      const actorId = Number(req.query.actorId);
      if (!Number.isInteger(actorId)) {
        return res.status(400).json({ error: 'actorId must be an integer' });
      }
      where.actorId = actorId;
    }
    const from = parseBound('from', req.query.from);
    if (from.error) return res.status(400).json({ error: from.error });
    const to = parseBound('to', req.query.to);
    if (to.error) return res.status(400).json({ error: to.error });
    if (from.value && to.value && from.value > to.value) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    if (from.value || to.value) {
      where.createdAt = {
        ...(from.value ? { gte: from.value } : {}),
        ...(to.value ? { lte: to.value } : {}),
      };
    }

    const requestedPage = Number(req.query.page);
    const page = Number.isInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
    const requestedSize = Number(req.query.pageSize);
    const pageSize =
      Number.isInteger(requestedSize) && requestedSize >= 1
        ? Math.min(requestedSize, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.auditEvent.count({ where }),
    ]);

    res.json({
      events: rows.map(serializeForApi),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      entityTypes: ENTITY_TYPES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
