// Pure display model for the admin SLA settings page.
//
// The backend (GET /api/sla/settings) is the source of truth: this module
// only shapes the payload into form state, mirrors the server's validation so
// obviously-broken values never leave the browser, and builds the PATCH body.
// The authoritative rules live server-side in settingsService; anything this
// misses is caught there and surfaces as a save error.

// Display order Monday-first, Sunday last; `day` is the Date.getUTCDay number
// the backend's canonical "1,2,3,4,5" form uses (0 = Sunday).
export const WEEKDAYS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
];

// Fallback list for the timezone datalist when the browser cannot enumerate
// IANA zones. Africa/Lagos stays first: it is the system's default.
const FALLBACK_TIMEZONES = [
  'Africa/Lagos',
  'Africa/Abidjan', 'Africa/Accra', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Nairobi',
  'UTC',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
];

// The system default leads the list in every environment: it is what a fresh
// install shows first, whether or not the browser can enumerate IANA zones.
const DEFAULT_TIMEZONE = 'Africa/Lagos';

export function timezoneOptions() {
  let zones = FALLBACK_TIMEZONES;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const supported = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(supported) && supported.length) zones = supported;
    }
  } catch { /* older engine — fall through */ }
  return [DEFAULT_TIMEZONE, ...zones.filter((z) => z !== DEFAULT_TIMEZONE)];
}

export function isValidTimeZone(zone) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Postgres DATE values arrive as "2026-09-07T00:00:00.000Z"; date inputs need
// the plain calendar day.
export function isoDay(value) {
  if (!value) return '';
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.slice(0, 10);
}

/** Holiday rows as the list renders them. */
export function normalizeHolidays(holidays) {
  return (holidays || []).map((h) => ({
    id: h.id,
    date: isoDay(h.date),
    name: h.name || '',
  }));
}

const NUMBER_KEYS = [
  'slaResponseTargetMinutes',
  'slaResolutionHoursCritical',
  'slaResolutionHoursHigh',
  'slaResolutionHoursModerate',
  'slaResolutionHoursLow',
  'slaWorkdayStartHour',
  'slaWorkdayEndHour',
];

/**
 * Form state from the API payload. Values are held as strings (what the
 * inputs edit); workingDays becomes an array of day numbers; a missing
 * payload yields empty fields so a half-broken response can never look like
 * a saved configuration.
 */
export function buildForm(data) {
  const s = data?.settings || {};
  const form = {};
  for (const key of NUMBER_KEYS) {
    form[key] = s[key] != null ? String(s[key]) : '';
  }
  form.slaTimezone = s.slaTimezone || '';
  // Split drops the empty token first: Number('') is 0, which would otherwise
  // fabricate a Sunday out of an unset value.
  form.workingDays = String(s.slaWorkingDays || '')
    .split(',')
    .filter((d) => d.trim() !== '')
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  form.holidays = normalizeHolidays(data?.holidays);
  return form;
}

/** One human-readable issue per broken value; [] when the form can be saved. */
export function validateForm(form) {
  const errors = [];
  const int = (v) => Number.isInteger(Number(v)) && String(v).trim() !== '';
  const whole = (label, key, min, max) => {
    const v = form[key];
    if (!int(v)) errors.push(`${label} must be a whole number`);
    else if (Number(v) < min) errors.push(`${label} must be at least ${min}`);
    else if (max !== undefined && Number(v) > max) errors.push(`${label} must be at most ${max}`);
  };

  whole('Response SLA target', 'slaResponseTargetMinutes', 1);
  whole('Critical resolution target', 'slaResolutionHoursCritical', 1);
  whole('High resolution target', 'slaResolutionHoursHigh', 1);
  whole('Moderate resolution target', 'slaResolutionHoursModerate', 1);
  whole('Low resolution target', 'slaResolutionHoursLow', 1);
  whole('Working day start', 'slaWorkdayStartHour', 0, 23);
  whole('Working day end', 'slaWorkdayEndHour', 1, 24);
  if (
    int(form.slaWorkdayStartHour) && int(form.slaWorkdayEndHour) &&
    Number(form.slaWorkdayEndHour) <= Number(form.slaWorkdayStartHour)
  ) {
    errors.push('The working day must end after it starts');
  }
  if (!form.workingDays.length) errors.push('Pick at least one working day');
  if (!String(form.slaTimezone).trim()) errors.push('Timezone is required');
  else if (!isValidTimeZone(String(form.slaTimezone).trim())) {
    errors.push(`Timezone "${String(form.slaTimezone).trim()}" is not a valid IANA timezone`);
  }
  return errors;
}

/** The PATCH body for a form — numbers as numbers, days canonicalised. */
export function formPayload(form) {
  const payload = {};
  for (const key of NUMBER_KEYS) payload[key] = Number(form[key]);
  payload.slaWorkingDays = [...new Set(form.workingDays)].sort((a, b) => a - b).join(',');
  payload.slaTimezone = String(form.slaTimezone).trim();
  return payload;
}

/** True when the draft differs from the settings the server returned. */
export function formDirty(form, data) {
  if (!form || !data?.settings) return false;
  const payload = formPayload(form);
  return Object.entries(payload).some(([key, value]) => data.settings[key] !== value);
}
