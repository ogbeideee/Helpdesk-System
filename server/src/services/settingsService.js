// Administrator-configurable runtime settings.
//
// Environment variables supply the defaults; the Setting table holds only the
// values an administrator has actually changed, so a fresh install and a
// customised one read from the same code path.
//
// Definitions carry a `group` so each administration screen (and each API
// surface) sees only its own keys: handovers screen → 'handover', SLA screen
// → 'sla'. parseValue validates one value against its definition; CROSS_RULES
// validate combinations across keys (e.g. the working day must end after it
// starts), which single-key checks cannot express.
const prisma = require('../lib/prisma');
const auditService = require('./auditService');

// IANA zone check — Intl throws on anything it cannot treat as a time zone.
function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Weekday tokens → 0–6 (Date.getUTCDay numbering, 0 = Sunday). Accepts the
// full and abbreviated names in any case, and the numbers themselves.
const WEEKDAY_TOKENS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function weekdayFromToken(token) {
  const t = String(token).trim().toLowerCase();
  if (/^\d$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n <= 6 ? n : null;
  }
  return Object.prototype.hasOwnProperty.call(WEEKDAY_TOKENS, t) ? WEEKDAY_TOKENS[t] : null;
}

const LABEL_WORKING_DAYS = 'Working days';

// Canonical stored form: comma-separated day numbers, sorted Sun→Sat,
// deduplicated. Accepts "mon-fri" style ranges too, since ranges are how
// humans write working weeks.
function canonicalWorkingDays(value) {
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const days = new Set();
  for (const item of raw) {
    const token = String(item).trim();
    if (!token) continue;
    const range = /^(\w+)-(\w+)$/.exec(token);
    if (range) {
      const from = weekdayFromToken(range[1]);
      const to = weekdayFromToken(range[2]);
      if (from === null || to === null) return { ok: false, error: `${LABEL_WORKING_DAYS}: "${token}" is not a weekday (use mon, tue, … or 0–6)` };
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    const day = weekdayFromToken(token);
    if (day === null) return { ok: false, error: `${LABEL_WORKING_DAYS}: "${token}" is not a weekday (use mon, tue, … or 0–6)` };
    days.add(day);
  }
  if (days.size === 0) return { ok: false, error: `${LABEL_WORKING_DAYS} must include at least one working day` };
  return { ok: true, value: [...days].sort((a, b) => a - b).join(',') };
}

/**
 * Every setting an administrator may change, with its type, default, bounds
 * and admin group. Adding a key here is all that is needed to expose it.
 *
 * SLA target bounds stay inside the holiday horizon the engine loads ahead of
 * a cycle start (120 calendar days), so a maximal configured target can still
 * freeze holiday-exact due instants.
 */
const DEFINITIONS = {
  handoverPendingLimit: {
    group: 'handover',
    label: 'Maximum active handover requests per recipient',
    type: 'int',
    min: 1,
    max: 20,
    env: 'HANDOVER_PENDING_LIMIT',
    fallback: 2,
    help: 'Further requests are queued and activated in order as slots free up.',
  },
  handoverExpiryMinutes: {
    group: 'handover',
    label: 'Handover request expiry (minutes)',
    type: 'int',
    min: 1,
    max: 60 * 24 * 30,
    env: 'HANDOVER_EXPIRY_MINUTES',
    fallback: 24 * 60,
    help: 'An unanswered request expires and the ticket stays with its current agent.',
  },

  // ---- SLA (see src/slaService.js — settings feed the existing engine) ----
  slaResponseTargetMinutes: {
    group: 'sla',
    label: 'Response SLA target (working minutes)',
    type: 'int',
    min: 1,
    max: 60 * 24 * 30,
    env: 'SLA_RESPONSE_TARGET_MINUTES',
    fallback: 60,
    help: 'Working time from the start of a cycle to the first agent response. 60 = one working hour.',
  },
  slaResolutionHoursCritical: {
    group: 'sla',
    label: 'Resolution target — critical (working hours)',
    type: 'int',
    min: 1,
    max: 2160,
    env: 'SLA_RESOLUTION_HOURS_CRITICAL',
    fallback: 4,
    help: 'Working time allowed to resolve a critical ticket.',
  },
  slaResolutionHoursHigh: {
    group: 'sla',
    label: 'Resolution target — high (working hours)',
    type: 'int',
    min: 1,
    max: 2160,
    env: 'SLA_RESOLUTION_HOURS_HIGH',
    fallback: 8,
    help: 'Working time allowed to resolve a high-priority ticket.',
  },
  slaResolutionHoursModerate: {
    group: 'sla',
    label: 'Resolution target — moderate (working hours)',
    type: 'int',
    min: 1,
    max: 2160,
    env: 'SLA_RESOLUTION_HOURS_MODERATE',
    fallback: 24,
    help: 'Working time allowed to resolve a moderate-priority ticket.',
  },
  slaResolutionHoursLow: {
    group: 'sla',
    label: 'Resolution target — low (working hours)',
    type: 'int',
    min: 1,
    max: 2160,
    env: 'SLA_RESOLUTION_HOURS_LOW',
    fallback: 72,
    help: 'Working time allowed to resolve a low-priority ticket.',
  },
  slaWorkdayStartHour: {
    group: 'sla',
    label: 'Working day starts (hour)',
    type: 'int',
    min: 0,
    max: 23,
    env: 'SLA_WORKDAY_START_HOUR',
    fallback: 8,
    help: 'First working hour of the day. The day starts at exactly this hour.',
  },
  slaWorkdayEndHour: {
    group: 'sla',
    label: 'Working day ends (hour)',
    type: 'int',
    min: 1,
    max: 24,
    env: 'SLA_WORKDAY_END_HOUR',
    fallback: 17,
    help: 'First non-working hour (24 = midnight). The day ends at exactly this hour.',
  },
  slaWorkingDays: {
    group: 'sla',
    label: 'Working days',
    type: 'string',
    env: 'SLA_WORKING_DAYS',
    fallback: '1,2,3,4,5',
    help: 'Days that count toward SLA time — Monday to Friday by default.',
    validate: canonicalWorkingDays,
  },
  slaTimezone: {
    group: 'sla',
    label: 'Timezone',
    type: 'string',
    env: 'SLA_TIMEZONE',
    fallback: 'Africa/Lagos',
    help: 'IANA timezone the working day and holidays are interpreted in.',
    validate(zone) {
      const v = String(zone).trim();
      if (!v) return { ok: false, error: 'Timezone is required' };
      if (!isValidTimeZone(v)) return { ok: false, error: `Timezone "${v}" is not a valid IANA timezone` };
      return { ok: true, value: v };
    },
  },

  // ---- scheduled reports (see src/reportScheduler.js) ---------------------
  // Report periods use the SLA timezone above; these keys configure delivery.
  // Empty recipients keeps the scheduler dormant — nothing is ever sent (and
  // nothing ever reaches a ticket requester) until an administrator lists
  // addresses here.
  reportRecipients: {
    group: 'reports',
    label: 'Report recipients',
    type: 'string',
    env: 'REPORT_RECIPIENTS',
    fallback: '',
    help: 'Comma- or newline-separated admin addresses that receive the weekly and monthly reports. Empty disables sending.',
    validate(raw) {
      const list = String(raw ?? '')
        .split(/[,;\n]+/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (list.length === 0) return { ok: true, value: '' };
      if (list.length > 25) return { ok: false, error: 'At most 25 report recipients' };
      for (const address of list) {
        if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
          return { ok: false, error: `"${address.slice(0, 60)}" is not a valid email address` };
        }
      }
      return { ok: true, value: [...new Set(list)].join(', ') };
    },
  },
  reportWeeklyEnabled: {
    group: 'reports',
    label: 'Send the weekly report (1 = yes, 0 = no)',
    type: 'int',
    min: 0,
    max: 1,
    env: 'REPORT_WEEKLY_ENABLED',
    fallback: 1,
    help: 'Weekly report covering the previous completed week.',
  },
  reportMonthlyEnabled: {
    group: 'reports',
    label: 'Send the monthly report (1 = yes, 0 = no)',
    type: 'int',
    min: 0,
    max: 1,
    env: 'REPORT_MONTHLY_ENABLED',
    fallback: 1,
    help: 'Monthly report covering the previous completed month.',
  },
  reportWeeklyDay: {
    group: 'reports',
    label: 'Weekday the weekly report is sent (Mon=1 … Sun=7)',
    type: 'int',
    min: 1,
    max: 7,
    env: 'REPORT_WEEKLY_DAY',
    fallback: 1,
    help: 'Monday by default — the first completed day after the report week ends.',
  },
  reportMonthlyDay: {
    group: 'reports',
    label: 'Day of month the monthly report is sent',
    type: 'int',
    min: 1,
    max: 28,
    env: 'REPORT_MONTHLY_DAY',
    fallback: 1,
    help: 'The 1st by default — always inside the month that follows the report month.',
  },
  reportSendHour: {
    group: 'reports',
    label: 'Hour of day reports are sent (report timezone)',
    type: 'int',
    min: 0,
    max: 23,
    env: 'REPORT_SEND_HOUR',
    fallback: 9,
    help: 'Wall-clock hour in the SLA timezone; 09:00 by default.',
  },
};

// Validations that span several keys. Run against the MERGED settings (stored
// values + the update being applied), so a partial update is judged against
// what would actually take effect.
const CROSS_RULES = [
  {
    keys: ['slaWorkdayStartHour', 'slaWorkdayEndHour'],
    check(values) {
      // Values may arrive as stored strings — compare numerically.
      if (Number(values.slaWorkdayEndHour) <= Number(values.slaWorkdayStartHour)) {
        return 'The working day must end after it starts';
      }
      return null;
    },
  },
];

function groupOf(key) {
  const def = DEFINITIONS[key];
  return def ? def.group : null;
}

function defaultFor(key) {
  const def = DEFINITIONS[key];
  const raw = def.env ? process.env[def.env] : undefined;
  if (raw === undefined || raw === '') return def.fallback;
  if (def.type === 'string') {
    const parsed = def.validate ? def.validate(raw) : { ok: true, value: String(raw) };
    return parsed.ok ? parsed.value : def.fallback;
  }
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
  if (def.type === 'string') {
    if (def.validate) return def.validate(value);
    const v = String(value ?? '').trim();
    if (!v) return { ok: false, error: `${def.label} is required` };
    return { ok: true, value: v };
  }
  return { ok: true, value: String(value) };
}

/**
 * All settings (optionally one group's), stored values overriding the
 * defaults. A stored value that no longer validates falls back to the
 * default rather than poisoning the engine.
 */
async function getAll(client = prisma, group = null) {
  const keys = Object.keys(DEFINITIONS).filter((k) => !group || groupOf(k) === group);
  const rows = await client.setting.findMany({ where: { key: { in: keys } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of keys) {
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
 * never has to guess what took effect. Values are validated individually and
 * then against the cross-key rules; nothing is written when anything fails.
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
  if (!errors.length) {
    const effective = { ...(await getAll(client)), ...Object.fromEntries(writes.map((w) => [w.key, w.value])) };
    for (const rule of CROSS_RULES) {
      if (!rule.keys.every((k) => effective[k] !== undefined)) continue;
      const error = rule.check(effective);
      if (error) errors.push(error);
    }
  }
  if (errors.length) return { ok: false, errors };

  // Snapshot the stored values first so the trail can show what changed.
  const stored = await client.setting.findMany({
    where: { key: { in: writes.map((w) => w.key) } },
  });
  const before = Object.fromEntries(stored.map((s) => [s.key, s.value]));
  const updatedBy =
    actor == null ? null : typeof actor === 'string' ? actor : `${actor.name} <${actor.email}>`;

  await client.$transaction(async (tx) => {
    for (const w of writes) {
      await tx.setting.upsert({
        where: { key: w.key },
        create: { ...w, updatedBy },
        update: { value: w.value, updatedBy },
      });
    }
    const changed = writes.filter((w) => before[w.key] !== w.value);
    if (changed.length) {
      await auditService.recordMany(
        tx,
        changed.map((w) => ({
          action: 'setting.updated',
          entityType: 'Setting',
          entityLabel: w.key,
          actor,
          ...(before[w.key] !== undefined ? { from: { value: before[w.key] } } : {}),
          to: { value: w.value },
          description: `Setting ${w.key} changed to ${w.value}`,
          metadata: { group: DEFINITIONS[w.key] ? DEFINITIONS[w.key].group : null },
        }))
      );
    }
  });
  return { ok: true, settings: await getAll(client) };
}

/** Metadata for an administration screen (optionally one group's). */
function describe(group = null) {
  return Object.entries(DEFINITIONS)
    .filter(([, def]) => !group || def.group === group)
    .map(([key, def]) => ({
      key,
      label: def.label,
      help: def.help,
      type: def.type,
      min: def.min,
      max: def.max,
      default: defaultFor(key),
      group: def.group,
    }));
}

module.exports = {
  DEFINITIONS,
  getAll,
  get,
  update,
  describe,
  parseValue,
  defaultFor,
  isValidTimeZone,
};
