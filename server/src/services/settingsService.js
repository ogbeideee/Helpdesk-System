// Administrator-configurable runtime settings.
//
// Environment variables supply the defaults; the Setting table holds only the
// values an administrator has actually changed, so a fresh install and a
// customised one read from the same code path.
const prisma = require('../lib/prisma');

/**
 * Every setting an administrator may change, with its type, default and
 * bounds. Adding a key here is all that is needed to expose it.
 */
const DEFINITIONS = {
  handoverPendingLimit: {
    label: 'Maximum active handover requests per recipient',
    type: 'int',
    min: 1,
    max: 20,
    env: 'HANDOVER_PENDING_LIMIT',
    fallback: 2,
    help: 'Further requests are queued and activated in order as slots free up.',
  },
  handoverExpiryMinutes: {
    label: 'Handover request expiry (minutes)',
    type: 'int',
    min: 1,
    max: 60 * 24 * 30,
    env: 'HANDOVER_EXPIRY_MINUTES',
    fallback: 24 * 60,
    help: 'An unanswered request expires and the ticket stays with its current agent.',
  },
};

function defaultFor(key) {
  const def = DEFINITIONS[key];
  const raw = def.env ? process.env[def.env] : undefined;
  if (raw === undefined || raw === '') return def.fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clamp(key, Math.trunc(parsed)) : def.fallback;
}

function clamp(key, value) {
  const def = DEFINITIONS[key];
  if (def.min !== undefined && value < def.min) return def.min;
  if (def.max !== undefined && value > def.max) return def.max;
  return value;
}

/** Parse and validate one incoming value. */
function parseValue(key, value) {
  const def = DEFINITIONS[key];
  if (!def) return { ok: false, error: `Unknown setting "${key}"` };
  if (def.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n)) return { ok: false, error: `${def.label} must be a whole number` };
    if (def.min !== undefined && n < def.min) {
      return { ok: false, error: `${def.label} must be at least ${def.min}` };
    }
    if (def.max !== undefined && n > def.max) {
      return { ok: false, error: `${def.label} must be at most ${def.max}` };
    }
    return { ok: true, value: n };
  }
  return { ok: true, value: String(value) };
}

/** All settings, stored values overriding the defaults. */
async function getAll(client = prisma) {
  const rows = await client.setting.findMany({ where: { key: { in: Object.keys(DEFINITIONS) } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of Object.keys(DEFINITIONS)) {
    if (stored.has(key)) {
      const parsed = parseValue(key, stored.get(key));
      out[key] = parsed.ok ? parsed.value : defaultFor(key);
    } else {
      out[key] = defaultFor(key);
    }
  }
  return out;
}

async function get(key, client = prisma) {
  return (await getAll(client))[key];
}

/**
 * Apply a partial update. Returns the full, effective settings so a caller
 * never has to guess what took effect.
 */
async function update(changes, actor, client = prisma) {
  const errors = [];
  const writes = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const parsed = parseValue(key, raw);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    writes.push({ key, value: String(parsed.value) });
  }
  if (errors.length) return { ok: false, errors };

  for (const w of writes) {
    await client.setting.upsert({
      where: { key: w.key },
      create: { ...w, updatedBy: actor || null },
      update: { value: w.value, updatedBy: actor || null },
    });
  }
  return { ok: true, settings: await getAll(client) };
}

/** Metadata for an administration screen. */
function describe() {
  return Object.entries(DEFINITIONS).map(([key, def]) => ({
    key,
    label: def.label,
    help: def.help,
    type: def.type,
    min: def.min,
    max: def.max,
    default: defaultFor(key),
  }));
}

module.exports = { DEFINITIONS, getAll, get, update, describe, parseValue };
