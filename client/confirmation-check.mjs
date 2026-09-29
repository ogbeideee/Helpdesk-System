/* Unit checks for src/confirmationView.js — the pure display model behind the
   "awaiting confirmation" indicator on the ticket queue and detail screen.
   Plain node, no framework, following the repo's check-script pattern.

   The contract pinned here:
   - the indicator exists only for tickets the API marked awaitingConfirmation
   - the deadline label rounds the way a human reads a countdown
   - past the deadline the indicator flips to the sweep's wording, without
     inventing a second auto-close policy client-side
   - a payload without the deadline (auto-close disabled) still shows the chip,
     with no clock attached

   Run: node confirmation-check.mjs  (from client/) */
import { confirmationIndicator, confirmationTone } from './src/confirmationView.js';

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

const NOW = new Date('2026-09-29T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/* ---- gate: only what the API marked ------------------------------------ */
eq('null for a CLOSED ticket', confirmationIndicator({ state: 'CLOSED' }, NOW), null);
eq('null for an IN_PROGRESS ticket', confirmationIndicator({ state: 'IN_PROGRESS' }, NOW), null);
eq('null when the API flag is missing (old payload)', confirmationIndicator({ state: 'RESOLVED' }, NOW), null);
eq('null for null input', confirmationIndicator(null, NOW), null);

/* ---- window disabled: chip without a clock ------------------------------ */
const noClock = confirmationIndicator({ awaitingConfirmation: true }, NOW);
check('awaiting without a deadline still shows the chip', noClock && noClock.pending === true);
eq('the no-clock chip says awaiting confirmation', noClock.label, 'awaiting confirmation');
eq('the no-clock detail explains the wait', noClock.detail, 'waiting for the requester to confirm');
eq('no-clock tone is neutral', confirmationTone(noClock), '');
eq('autoCloseAt is null without a deadline', noClock.autoCloseAt, null);

/* ---- with a deadline ----------------------------------------------------- */
const day = 2 * DAY;
const ind = confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(day) },
  NOW
);
check('a fresh deadline is pending', ind.pending === true && ind.overdue === false);
eq('the chip reads awaiting confirmation', ind.label, 'awaiting confirmation');
eq('the detail names the countdown', ind.detail, 'closes automatically in 2 days');
eq('tone is neutral far from the deadline', confirmationTone(ind), '');

/* ---- rounding the way a human reads -------------------------------------- */
eq('90 minutes reads in hours', confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(90 * 60_000) }, NOW
).detail, 'closes automatically in 2 hours');
eq('59 minutes reads in minutes', confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(59 * 60_000) }, NOW
).detail, 'closes automatically in 59 minutes');
eq('one minute reads singular', confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(61 * 1000) }, NOW
).detail, 'closes automatically in 1 minute');
eq('under a minute says so', confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(30 * 1000) }, NOW
).detail, 'closes automatically in less than a minute');
eq('23h is soon', confirmationTone(confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(23 * HOUR) }, NOW
)), 'soon');
eq('25h is not soon', confirmationTone(confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(25 * HOUR) }, NOW
)), '');
eq('26h keeps the day rounding', confirmationIndicator(
  { awaitingConfirmation: 1 === 1, confirmationAutoCloseAt: iso(26 * HOUR) }, NOW
).detail, 'closes automatically in 1 day');

/* ---- past the deadline ---------------------------------------------------- */
const past = confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: iso(-5 * HOUR) },
  NOW
);
eq('past the deadline pending is false', past.pending, false);
eq('past the deadline the label flips', past.label, 'closing…');
eq('past the deadline the detail names the sweep', past.detail, 'closes automatically on the next sweep');
eq('past the deadline tone is overdue', confirmationTone(past), 'overdue');
eq('exactly at the deadline is overdue (remaining 0)', confirmationIndicator(
  { awaitingConfirmation: true, confirmationAutoCloseAt: NOW.toISOString() }, NOW
).overdue, true);

/* ---- tone map -------------------------------------------------------------- */
eq('null tone is empty', confirmationTone(null), '');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
