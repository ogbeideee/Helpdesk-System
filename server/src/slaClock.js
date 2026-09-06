// SLA working-time calendar.
//
// The approved calendar — Monday–Friday, 08:00–17:00, Africa/Lagos — is the
// default, and the one every value falls back to. Administrators can change
// the working days, the daily hours and the timezone through SLA settings
// (src/services/settingsService.js); this module therefore exposes
// createCalendar(), a factory that builds the same engine over any valid
// calendar configuration. Time outside the window — evenings, non-working
// days and SlaHoliday dates — does not count toward any SLA clock. The module
// is pure: it knows the calendar, not the database; holiday dates are passed
// in by the caller (slaService loads the SlaHoliday table).
//
// Zone handling: the offset for the configured zone is derived through Intl
// for the specific instant rather than hardcoded, so a future time-zone rule
// change cannot silently corrupt the clocks. All arithmetic runs on "wall"
// time — the zone's clock reading encoded as a UTC timestamp — and converts
// back through the zone offset, which keeps day boundaries and the window
// edges exact.
//
// Window edges: the start hour is the first working instant, the end hour the
// first non-working one. A deadline may therefore land exactly on the end
// hour; a response at 17:00 sharp has consumed the whole day and is on time.

const DAY_MS = 24 * 60 * 60 * 1000;
// Date.getUTCDay(): 0 = Sunday … 6 = Saturday.
const DEFAULT_WORKING_WEEKDAYS = [1, 2, 3, 4, 5];
// Day-iteration bound for the loops below: ~100 calendar years. Only reachable
// with pathological inputs (e.g. a holiday table covering everything); real
// SLA spans are days or weeks.
const MAX_DAY_ITERATIONS = 36600;

// Built-in defaults — the approved calendar. The settings service carries the
// same values as the fallbacks for its SLA keys.
const TIME_ZONE = 'Africa/Lagos';
const WORKDAY_START_HOUR = 8; // first working minute: 08:00 inclusive
const WORKDAY_END_HOUR = 17;  // end of the working day: 17:00 exclusive

function msOf(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Normalise the working-days config: an iterable of day numbers (0–6), or a
// comma-separated string of the same ("1,2,3,4,5", the canonical stored form).
function normalizeWeekdays(workingDays) {
  if (workingDays == null) return [...DEFAULT_WORKING_WEEKDAYS];
  const raw = typeof workingDays === 'string' ? workingDays.split(',') : workingDays;
  const days = new Set();
  for (const item of raw) {
    const n = Number(String(item).trim());
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new Error(`slaClock: invalid working day "${item}" (expected 0–6)`);
    }
    days.add(n);
  }
  if (days.size === 0) throw new Error('slaClock: the working week needs at least one working day');
  return [...days].sort((a, b) => a - b);
}

/**
 * Build the calendar engine over a configuration. Throws on an invalid
 * configuration — the settings API validates before saving, so this only
 * fires on programmer error or a bad deployment-time env override.
 *
 *   createCalendar({
 *     timeZone: 'Africa/Lagos',     // any IANA zone
 *     workdayStartHour: 8,          // 0–23, first working hour
 *     workdayEndHour: 17,           // 1–24, first non-working hour (24 = midnight)
 *     workingDays: [1,2,3,4,5],     // getUTCDay numbers, or '1,2,3,4,5'
 *   })
 */
function createCalendar(config = {}) {
  const timeZone = config.timeZone || TIME_ZONE;
  const startHour = config.workdayStartHour ?? WORKDAY_START_HOUR;
  const endHour = config.workdayEndHour ?? WORKDAY_END_HOUR;
  const workingWeekdays = normalizeWeekdays(config.workingDays);

  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new Error(`slaClock: invalid workday start hour ${startHour} (expected 0–23)`);
  }
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
    throw new Error(`slaClock: invalid workday end hour ${endHour} (expected 1–24)`);
  }
  if (endHour <= startHour) {
    throw new Error(`slaClock: the working day must end after it starts (${startHour}:00–${endHour}:00)`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`slaClock: "${timeZone}" is not a valid IANA time zone`);
  }

  const WORKDAY_MS = (endHour - startHour) * 60 * 60 * 1000;

  const wallFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // The zone's wall-clock reading of an instant: {y, m, d, hh, mm, ss}.
  function wallParts(value) {
    const parts = {};
    for (const p of wallFormatter.formatToParts(new Date(msOf(value)))) {
      parts[p.type] = p.value;
    }
    return {
      y: Number(parts.year),
      m: Number(parts.month),
      d: Number(parts.day),
      hh: Number(parts.hour),
      mm: Number(parts.minute),
      ss: Number(parts.second),
    };
  }

  // Offset of the zone at the given instant in ms (east of UTC → positive).
  function zoneOffsetMs(value) {
    const w = wallParts(value);
    const wallAsUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
    return wallAsUtc - Math.floor(msOf(value) / 1000) * 1000;
  }

  // Build an instant from a zone wall-clock reading.
  function fromWall(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
    const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
    const offset = zoneOffsetMs(new Date(wallAsUtc));
    return new Date(wallAsUtc - offset);
  }

  // Calendar-day key: the zone's calendar date encoded as its UTC-midnight
  // epoch ms. SlaHoliday.date (PostgreSQL DATE → JS Date at UTC midnight)
  // maps onto the same encoding, so holidays compare against the zone's
  // calendar days.
  function dayKey(value) {
    const w = wallParts(value);
    return Date.UTC(w.y, w.m - 1, w.d);
  }

  function ymdOfKey(dayKeyValue) {
    const d = new Date(dayKeyValue);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  // Normalize caller-supplied holiday dates (Date | ISO string | epoch ms) into
  // a Set of day keys.
  function holidayKeys(holidays) {
    if (holidays instanceof Set) return new Set(holidays);
    const set = new Set();
    for (const h of holidays || []) set.add(dayKey(h));
    return set;
  }

  function isWorkingDayKey(dayKeyValue, holidays) {
    if (!workingWeekdays.includes(new Date(dayKeyValue).getUTCDay())) return false;
    return !holidays.has(dayKeyValue);
  }

  // The day's work window as instants [start, end).
  function workWindow(dayKeyValue) {
    const { y, m, d } = ymdOfKey(dayKeyValue);
    return {
      start: fromWall(y, m, d, startHour),
      end: fromWall(y, m, d, endHour),
    };
  }

  function minuteOfDayOf(w) {
    return w.hh * 60 + w.mm;
  }

  function isWorkingMomentIn(t, holidays) {
    const w = wallParts(t);
    if (!isWorkingDayKey(dayKey(t), holidays)) return false;
    const minute = minuteOfDayOf(w);
    return minute >= startHour * 60 && minute < endHour * 60;
  }

  // True when the instant falls inside the working calendar.
  function isWorkingMoment(value, holidays = []) {
    return isWorkingMomentIn(msOf(value), holidayKeys(holidays));
  }

  function nextWorkingMomentIn(t, holidays) {
    const w = wallParts(t);
    const key = dayKey(t);
    if (isWorkingDayKey(key, holidays)) {
      const minute = minuteOfDayOf(w);
      if (minute < startHour * 60) {
        const { y, m, d } = ymdOfKey(key);
        return fromWall(y, m, d, startHour);
      }
      if (minute < endHour * 60) return new Date(t);
    }
    // Roll forward to the next working day's opening minute.
    let cursor = key + DAY_MS;
    for (let i = 0; i < MAX_DAY_ITERATIONS; i++) {
      if (isWorkingDayKey(cursor, holidays)) {
        const { y, m, d } = ymdOfKey(cursor);
        return fromWall(y, m, d, startHour);
      }
      cursor += DAY_MS;
    }
    throw new Error('slaClock: no working day found within 100 years of holiday data');
  }

  // The first working instant at or after `value`.
  function nextWorkingMoment(value, holidays = []) {
    return nextWorkingMomentIn(msOf(value), holidayKeys(holidays));
  }

  // Working milliseconds elapsed between two instants. End exclusive; spans
  // that start outside the calendar contribute only their in-calendar part.
  function workingMsBetween(start, end, holidays = []) {
    const endMs = msOf(end);
    const from = nextWorkingMomentIn(msOf(start), holidayKeys(holidays)).getTime();
    if (from >= endMs) return 0;
    const holidays2 = holidayKeys(holidays);
    let total = 0;
    let key = dayKey(from);
    for (let i = 0; i < MAX_DAY_ITERATIONS; i++) {
      const win = workWindow(key);
      if (win.start.getTime() >= endMs) break;
      if (isWorkingDayKey(key, holidays2)) {
        const lo = Math.max(from, win.start.getTime());
        const hi = Math.min(endMs, win.end.getTime());
        if (hi > lo) total += hi - lo;
      }
      key += DAY_MS;
    }
    return total;
  }

  // Add `amount` working milliseconds to an instant. A non-positive amount
  // rolls forward to the next working instant without adding time. The result
  // can land exactly on a window edge (e.g. 17:00) — that instant is the
  // deadline, and time has not yet run past it.
  function addWorkingMs(value, amount, holidays = []) {
    const holidays2 = holidayKeys(holidays);
    const from = nextWorkingMomentIn(msOf(value), holidays2).getTime();
    if (!Number.isFinite(amount) || amount <= 0) return new Date(from);
    let remaining = amount;
    let key = dayKey(from);
    for (let i = 0; i < MAX_DAY_ITERATIONS; i++) {
      if (isWorkingDayKey(key, holidays2)) {
        const win = workWindow(key);
        const lo = Math.max(from, win.start.getTime());
        const available = win.end.getTime() - lo;
        if (remaining <= available) return new Date(lo + remaining);
        remaining -= available;
      }
      key += DAY_MS;
    }
    throw new Error('slaClock: addWorkingMs could not land within 100 years');
  }

  return {
    timeZone,
    workdayStartHour: startHour,
    workdayEndHour: endHour,
    workingWeekdays,
    workdayMs: WORKDAY_MS,
    isWorkingMoment,
    nextWorkingMoment,
    workingMsBetween,
    addWorkingMs,
    dayKey,
  };
}

// The approved default calendar. The module-level functions below delegate to
// it, so existing callers that import the calendar directly (tests, the
// notifier, legacy due-date math) keep the exact same behaviour.
const defaultCalendar = createCalendar();
// Postgres DATE → JS Date at UTC midnight; zone-independent, so shared.
const dayKeyToDate = (key) => new Date(key);

module.exports = {
  createCalendar,
  defaultCalendar,
  dayKeyToDate,
  // Default-calendar constants (the approved calendar), kept for callers that
  // display or assert on them. Configured values live in the settings.
  TIME_ZONE,
  WORKDAY_START_HOUR,
  WORKDAY_END_HOUR,
  WORKDAY_MS: defaultCalendar.workdayMs,
  isWorkingMoment: defaultCalendar.isWorkingMoment,
  nextWorkingMoment: defaultCalendar.nextWorkingMoment,
  workingMsBetween: defaultCalendar.workingMsBetween,
  addWorkingMs: defaultCalendar.addWorkingMs,
  lagosDayKey: defaultCalendar.dayKey,
};
