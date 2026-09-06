/* Unit checks for src/slaSettingsView.js — the pure display model behind the
   admin SLA settings page. Plain node, no framework, following the repo's
   existing check-script pattern (sla-check / live-check / ssr-check). These
   pin the contract the page relies on: the form is built verbatim from the
   GET /api/sla/settings payload, client-side validation mirrors the server's
   rules so obviously-broken values never leave the browser, and the PATCH
   body carries canonical values (numbers, sorted working days).

   Run: node sla-settings-check.mjs  (from client/) */
import {
  buildForm, validateForm, formPayload, formDirty, normalizeHolidays,
  isoDay, isValidTimeZone, timezoneOptions, WEEKDAYS,
} from './src/slaSettingsView.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---- helpers ---------------------------------------------------------- */
eq('isoDay trims a Postgres DATE payload', isoDay('2026-09-07T00:00:00.000Z'), '2026-09-07');
eq('isoDay passes a plain day through', isoDay('2026-09-07'), '2026-09-07');
eq('isoDay of nothing is empty', isoDay(null), '');
check('Africa/Lagos is a valid zone', isValidTimeZone('Africa/Lagos'));
check('UTC is a valid zone', isValidTimeZone('UTC'));
check('made-up zones are rejected', !isValidTimeZone('Mars/Olympus'));
check('empty is not a zone', !isValidTimeZone(''));
check('weekday list is Monday-first with Sunday last', WEEKDAYS[0].day === 1 && WEEKDAYS[WEEKDAYS.length - 1].day === 0 && WEEKDAYS.length === 7);
check('timezone options exist and put the default first', Array.isArray(timezoneOptions()) && timezoneOptions()[0] === 'Africa/Lagos');

/* ---- buildForm: the API payload becomes form state -------------------- */
const PAYLOAD = {
  settings: {
    slaResponseTargetMinutes: 60,
    slaResolutionHoursCritical: 4,
    slaResolutionHoursHigh: 8,
    slaResolutionHoursModerate: 24,
    slaResolutionHoursLow: 72,
    slaWorkdayStartHour: 8,
    slaWorkdayEndHour: 17,
    slaWorkingDays: '1,2,3,4,5',
    slaTimezone: 'Africa/Lagos',
  },
  definitions: [{ key: 'slaResponseTargetMinutes', label: 'Response SLA target (working minutes)', help: 'Working time…', default: 60, group: 'sla' }],
  holidays: [
    { id: 2, date: '2026-12-25T00:00:00.000Z', name: 'Christmas Day' },
    { id: 1, date: '2026-10-01T00:00:00.000Z', name: null },
  ],
};
const form = buildForm(PAYLOAD);
eq('numbers arrive as input strings', form.slaResponseTargetMinutes, '60');
eq('working days become day numbers', JSON.stringify(form.workingDays), JSON.stringify([1, 2, 3, 4, 5]));
eq('timezone carried verbatim', form.slaTimezone, 'Africa/Lagos');
eq('holidays normalised to calendar days', form.holidays[0].date, '2026-12-25');
eq('holiday names default to empty', form.holidays[1].name, '');

check('a missing payload yields empty fields (never fake values)', buildForm(null).slaResponseTargetMinutes === '' && buildForm(null).workingDays.length === 0);
eq('holidays normaliser tolerates nothing', JSON.stringify(normalizeHolidays(undefined)), '[]');

/* ---- validateForm: mirrors the server rules --------------------------- */
const valid = { ...form };
eq('the payload the server sent validates cleanly', validateForm(valid).length, 0);

const broken = (patch) => validateForm({ ...valid, ...patch });
check('zero response target is rejected', broken({ slaResponseTargetMinutes: '0' }).length > 0);
check('fractional minutes are rejected', broken({ slaResponseTargetMinutes: '10.5' }).length > 0);
check('empty minutes are rejected', broken({ slaResponseTargetMinutes: '' }).length > 0);
check('zero resolution target is rejected', broken({ slaResolutionHoursCritical: '0' }).length > 0);
check('start hour 24 is rejected', broken({ slaWorkdayStartHour: '24' }).length > 0);
check('end hour 25 is rejected', broken({ slaWorkdayEndHour: '25' }).length > 0);
check('a day ending when it starts is rejected',
  broken({ slaWorkdayStartHour: '10', slaWorkdayEndHour: '10' }).some((e) => /end after it starts/.test(e)));
check('a day ending before it starts is rejected',
  broken({ slaWorkdayStartHour: '18', slaWorkdayEndHour: '9' }).some((e) => /end after it starts/.test(e)));
check('an empty working week is rejected', broken({ workingDays: [] }).some((e) => /at least one working day/.test(e)));
check('an empty timezone is rejected', broken({ slaTimezone: '  ' }).some((e) => /required/.test(e)));
check('an invalid timezone is rejected', broken({ slaTimezone: 'Mars/Olympus' }).some((e) => /IANA/.test(e)));
check('errors name the field they fail', broken({ slaResponseTargetMinutes: '-1' })[0].includes('Response SLA target'));

/* ---- formPayload: the PATCH body -------------------------------------- */
const payload = formPayload({ ...valid, workingDays: [5, 1, 3], slaTimezone: ' Africa/Abidjan ' });
eq('numbers become numbers', payload.slaResponseTargetMinutes, 60);
eq('working days are canonicalised and sorted', payload.slaWorkingDays, '1,3,5');
eq('working days are deduplicated', formPayload({ ...valid, workingDays: [1, 1, 2] }).slaWorkingDays, '1,2');
eq('timezone is trimmed', payload.slaTimezone, 'Africa/Abidjan');
check('payload carries exactly the nine settings keys',
  Object.keys(payload).length === 9 && 'slaResponseTargetMinutes' in payload && 'slaTimezone' in payload);

/* ---- formDirty: save/reset enablement --------------------------------- */
eq('a fresh form is not dirty', formDirty(form, PAYLOAD), false);
eq('an edited form is dirty', formDirty({ ...form, slaResponseTargetMinutes: '30' }, PAYLOAD), true);
eq('reordering working days is not a change', formDirty({ ...form, workingDays: [5, 4, 3, 2, 1] }, PAYLOAD), false);
eq('nothing is dirty without a payload', formDirty(form, null), false);

process.exit(failures ? 1 : 0);
