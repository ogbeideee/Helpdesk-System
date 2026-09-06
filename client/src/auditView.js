// Pure display model for the admin Audit Trail page.
//
// The backend (GET /api/audit) is the only data source and does all filtering
// and pagination server-side: this module shapes each AuditEvent row for
// display, builds the query string for filter changes, and renders the
// structured from/to/metadata fields readably. It never filters rows that are
// already loaded and never computes audit facts — those are stored values.

/** Entity kinds the trail can reference, with human labels for the filter. */
export const ENTITY_TYPES = [
  'Ticket',
  'Comment',
  'HandoverRequest',
  'Agent',
  'Team',
  'RoutingRule',
  'Setting',
  'SlaHoliday',
];

const ENTITY_TYPE_LABELS = {
  Ticket: 'Ticket',
  Comment: 'Note / comment',
  HandoverRequest: 'Handover',
  Agent: 'User',
  Team: 'Assignment group',
  RoutingRule: 'Routing rule',
  Setting: 'Setting',
  SlaHoliday: 'Public holiday',
};

export function entityTypeLabel(type) {
  return ENTITY_TYPE_LABELS[type] || type || '—';
}

/**
 * Entity display for a row. Rows survive the entity they describe: a deleted
 * ticket's event keeps its entityLabel, its ids are nulled, and both cases
 * must render without breaking.
 */
export function entityDisplay(event) {
  if (!event || (!event.entityType && !event.entityLabel && event.entityId == null)) return '—';
  const label = entityTypeLabel(event.entityType);
  if (event.entityLabel) return `${label} · ${event.entityLabel}`;
  if (event.entityId != null) return `${label} #${event.entityId}`;
  return label;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One displayable value: primitives as strings, structures as compact JSON. */
export function displayValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The date inputs send calendar days; the API speaks ISO. */
function parseDayInput(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? { invalid: true } : d;
}

/**
 * Filter draft → API query. Everything is applied server-side, so the query
 * is the whole contract. Rejects an unparseable or reversed date range before
 * the request is made (same wording as the SLA reports range check).
 */
export function buildAuditQuery(draft = {}) {
  const query = {};
  const action = String(draft.action || '').trim();
  if (action) query.action = action;
  const entityType = String(draft.entityType || '').trim();
  if (entityType) query.entityType = entityType;
  const actor = String(draft.actor || '').trim();
  if (actor) query.actor = actor;

  const from = parseDayInput(draft.from);
  if (from && from.invalid) return { ok: false, error: 'From must be a valid date' };
  const to = parseDayInput(draft.to);
  if (to && to.invalid) return { ok: false, error: 'To must be a valid date' };
  if (from && to && from > to) {
    return { ok: false, error: 'The start date must be on or before the end date' };
  }
  // An end date on its own covers one calendar day to 23:59:59.999.
  if (to && String(draft.to || '').trim().length === 10) {
    to.setUTCHours(23, 59, 59, 999);
  }
  if (from) query.from = from.toISOString();
  if (to) query.to = to.toISOString();
  return { ok: true, query };
}

/** Are any filters set (drives the Clear button and the empty-state hint)? */
export function isFiltered(query = {}) {
  return Boolean(
    query.action || query.entityType || query.actor || query.from || query.to
  );
}

/** Table rows: the fields the list shows, plus everything the detail needs. */
export function eventRows(events) {
  return (Array.isArray(events) ? events : []).map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actor: e.actor || 'system',
    actorId: e.actorId ?? null,
    action: e.action || '—',
    actionPrefix: String(e.action || '').split('.')[0] || '',
    entity: entityDisplay(e),
    entityType: e.entityType || null,
    entityId: e.entityId ?? null,
    entityLabel: e.entityLabel || null,
    ticketId: e.ticketId ?? null,
    description: e.description || e.action || '',
    from: e.from ?? null,
    to: e.to ?? null,
    metadata: e.metadata ?? null,
  }));
}

/**
 * from/to as displayable change pairs, keyed across both sides. A side that
 * was absent (creation, deletion) simply contributes no values.
 */
export function changePairs(row) {
  const from = isPlainObject(row && row.from) ? row.from : null;
  const to = isPlainObject(row && row.to) ? row.to : null;
  if (!from && !to) return [];
  // An absent side contributes null (rendered as an em-dash); a key that is
  // present with a null value means "none" and reads the same way.
  const side = (obj, key) => {
    if (!obj || !(key in obj)) return null;
    const value = obj[key];
    return value === null || value === undefined ? '—' : displayValue(value);
  };
  const keys = [...new Set([...Object.keys(from || {}), ...Object.keys(to || {})])];
  return keys.map((key) => ({ key, from: side(from, key), to: side(to, key) }));
}

/**
 * Structured metadata as flat key/value pairs. Objects and arrays are
 * stringified (React renders them harmlessly); a bare string metadata value
 * becomes a single "detail" entry.
 */
export function metadataPairs(row) {
  const meta = row && row.metadata;
  if (meta === null || meta === undefined) return [];
  if (isPlainObject(meta)) {
    return Object.entries(meta).map(([key, value]) => ({ key, value: displayValue(value) }));
  }
  return [{ key: 'detail', value: displayValue(meta) }];
}

/** "1–50 of 243" for the pagination footer; null when there is nothing. */
export function resultRange(data) {
  if (!data || !data.total) return null;
  const page = data.page || 1;
  const size = data.pageSize || 50;
  const start = (page - 1) * size + 1;
  return `${start}–${Math.min(page * size, data.total)} of ${data.total}`;
}
