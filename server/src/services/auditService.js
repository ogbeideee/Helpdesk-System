// Unified, append-only audit trail (the AuditEvent table).
//
// One small service every instrumented operation funnels through. The rules:
//
//   1. Audit events are written by trusted backend code only — never from a
//      request body, never from the frontend. If the actor came over the wire
//      it is the authenticated agent from authMiddleware, nothing else.
//   2. Events are written with the same Prisma client/transaction as the
//      business operation, so a successful operation cannot leave the trail
//      empty and a failed one cannot leave a phantom event behind.
//   3. Nothing here updates or deletes events, and no API endpoint exposes a
//      write path: the trail is append-only from the application's normal
//      interfaces.
//   4. Sensitive values never reach the database. Before anything is stored,
//      sanitizeValue() redacts credential-shaped keys (password, token,
//      secret, hash, ...) and truncates long free text — the full text lives
//      on the entity, not in the trail.
//
// Convention for action names: "<entity>.<event>", lower snake case, e.g.
//   ticket.created / ticket.assigned / ticket.priority_changed
//   ticket.resolved / ticket.reopened / ticket.commented / ticket.deleted
//   handover.created / handover.accepted / handover.cancelled
//   agent.created / agent.updated / agent.deactivated
//   group.updated / routing_rule.updated / setting.updated
const prisma = require('../lib/prisma');

/** Keys whose values must never be recorded, whatever they contain. */
const SENSITIVE_KEY_RE =
  /pass(word|wd)?|secret|token|hash|authorization|auth|credential|api[-_]?key|cookie|bearer/i;

/** Free-text previews are capped: the trail describes, it does not archive. */
const VALUE_PREVIEW_MAX = 160;
/** Serialized from/to/metadata columns are capped as a whole. */
const JSON_MAX = 4000;

/** Cap a string for storage, marking what was cut. */
function truncate(text, max = VALUE_PREVIEW_MAX) {
  const str = String(text);
  return str.length <= max ? str : `${str.slice(0, max)}… [truncated ${str.length - max} chars]`;
}

/**
 * Redact + truncate one JSON-able value.
 * Objects with credential-shaped keys get those values replaced with
 * '[redacted]'; long strings become short previews; nesting is bounded.
 */
function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return truncate(value);
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (type === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 30)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return String(value);
}
/** JSON-serialise a value for storage, sanitised and length-capped. */
function sanitizeJson(value) {
  if (value === undefined) return null;
  return truncate(JSON.stringify(sanitizeValue(value) ?? null), JSON_MAX);
}

/**
 * Normalise an actor into { actorId, actorLabel }.
 * Only an object carrying an integer id (the authenticated Agent, or a seeded
 * fixture) is linked by id; strings are labels already ("system", an email…).
 */
function resolveActor(actor) {
  if (!actor) return { actorId: null, actorLabel: 'system' };
  if (typeof actor === 'string') return { actorId: null, actorLabel: actor };
  return {
    actorId: Number.isInteger(actor.id) ? actor.id : null,
    actorLabel: actor.name ? `${actor.name} <${actor.email}>` : 'system',
  };
}

/** Build the Prisma data object for one event. Throws on a malformed event. */
function buildEvent({
  action,
  entityType,
  entityId = null,
  entityLabel = null,
  ticketId = null,
  actor,
  from,
  to,
  description,
  metadata,
}) {
  if (!action || !entityType) {
    throw new Error('audit event requires both action and entityType');
  }
  const who = resolveActor(actor);
  return {
    action: String(action).slice(0, 80),
    entityType: String(entityType).slice(0, 40),
    entityId: Number.isInteger(entityId) ? entityId : null,
    entityLabel: entityLabel ? truncate(entityLabel, 200) : null,
    ticketId: Number.isInteger(ticketId) ? ticketId : null,
    actorId: who.actorId,
    actorLabel: who.actorLabel,
    fromValue: sanitizeJson(from),
    toValue: sanitizeJson(to),
    description: truncate(description || action, 500),
    metadata: metadata ? sanitizeJson(metadata) : null,
  };
}

/**
 * Record one event. Deliberately NOT swallow-fail-safe: it throws inside the
 * business transaction, so an audit row can never silently go missing while
 * the operation commits (requirement 11).
 */
async function record(client, event) {
  return (client || prisma).auditEvent.create({ data: buildEvent(event) });
}

/** Record several events in one round-trip. */
async function recordMany(client, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  return (client || prisma).auditEvent.createMany({
    data: events.map((e) => buildEvent(e)),
  });
}

/** All events for one ticket, oldest first by default. */
async function forTicket(ticketId, { order = 'asc', limit = 500 } = {}, client = prisma) {
  return client.auditEvent.findMany({
    where: { ticketId },
    orderBy: { id: order === 'desc' ? 'desc' : 'asc' },
    take: Math.min(Number(limit) || 500, 1000),
  });
}

/** API shape: parsed JSON fields, actor split into id + label. */
function serialize(event) {
  const parse = (s) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return s; // stored value was already a plain string
    }
  };
  return {
    id: event.id,
    createdAt: event.createdAt,
    actorId: event.actorId,
    actor: event.actorLabel,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    entityLabel: event.entityLabel,
    ticketId: event.ticketId,
    from: parse(event.fromValue),
    to: parse(event.toValue),
    description: event.description,
    metadata: parse(event.metadata),
  };
}

module.exports = {
  SENSITIVE_KEY_RE,
  VALUE_PREVIEW_MAX,
  JSON_MAX,
  truncate,
  sanitizeValue,
  sanitizeJson,
  resolveActor,
  buildEvent,
  record,
  recordMany,
  forTicket,
  serialize,
};