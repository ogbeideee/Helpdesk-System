// Scheduled weekly and monthly operational reports.
//
// Reuses every existing piece — no second scheduler, no second mailer, no new
// reporting math:
//   - Period aggregation comes from src/reports.js (which itself delegates SLA
//     performance to the SLA reporting service). This module only renders and
//     delivers what that service returns; it never recomputes a metric.
//   - Delivery rides the existing mailer (sendMailSafe / createMailer with an
//     injectable transport for tests). Recipients come exclusively from the
//     'reports' settings group — ticket requesters are never involved.
//   - Scheduling follows the sweeper conventions: one low-frequency interval
//     (REPORT_SCHEDULER_INTERVAL_MS, 0 disables) with an overlap guard and a
//     try/catch per tick, so a failed report can neither crash the server nor
//     stop unrelated jobs. Each tick checks whether the configured send moment
//     for the previous completed period has arrived; a server that was down
//     over the moment catches up on the first tick after start.
//   - Period boundaries are computed in the SLA timezone (Africa/Lagos by
//     default — the same configured timezone the working calendar uses), and
//     "previous completed week/month" means the fully elapsed week (Mon–Sun)
//     / month before the current one.
//   - Exactly-once delivery without schema changes, in the same spirit as the
//     SLA sweeper: a send is recorded as a 'report.sent' audit event whose
//     metadata starts with the deterministic period key, and that record is
//     the dedupe gate — replaying a period (server restart, overlapping ticks,
//     a re-run CLI) can never send twice. Failures are recorded as
//     'report.failed' and do NOT mark the period sent, so the next tick (or a
//     manual run) retries naturally.
const prisma = require('./lib/prisma');
const settingsService = require('./services/settingsService');
const auditService = require('./services/auditService');
const reports = require('./reports');
const mailerModule = require('./mailer');

const SWEEP_INTERVAL_MS = Number(process.env.REPORT_SCHEDULER_INTERVAL_MS || 10 * 60 * 1000);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* ====================================================================== */
/* Wall-clock helpers — pure, exported for the boundary tests              */
/* ====================================================================== */

/** Offset (ms) to add to a UTC instant to get the wall clock in `timeZone`. */
function tzOffsetMs(instant, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asUtc - instant;
}

/** The wall-clock calendar date of an instant: {y, m, d, weekday} (Mon=1..Sun=7). */
function tzWall(instant, timeZone) {
  // Date + number string-concatenates (Date's ToPrimitive for `+` is string),
  // so go through getTime() explicitly.
  const shifted = new Date(instant.getTime() + tzOffsetMs(instant, timeZone));
  const gmtDay = shifted.getUTCDay(); // 0=Sunday
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    weekday: ((gmtDay + 6) % 7) + 1,
  };
}

/** A wall-clock date+time in `timeZone` as a real UTC instant (2-pass DST-safe). */
function wallToInstant(wall, hour, minute, timeZone) {
  const utcMidnight = Date.UTC(wall.y, wall.m - 1, wall.d);
  let guess = utcMidnight + hour * 3600000 + minute * 60000;
  guess = utcMidnight + hour * 3600000 + minute * 60000 - tzOffsetMs(guess, timeZone);
  return new Date(guess);
}

/** Calendar arithmetic on a wall date (no timezone involved). */
function addWallDays(wall, days) {
  const t = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (wall) => `${wall.y}-${pad2(wall.m)}-${pad2(wall.d)}`;

/** The previous fully completed week (Mon 00:00 → Sun 24:00, wall clock). */
function previousWeekPeriod(now, timeZone) {
  const today = tzWall(now, timeZone);
  const currentWeekStart = addWallDays(today, -(today.weekday - 1));
  const prevWeekStart = addWallDays(currentWeekStart, -7);
  const start = wallToInstant(prevWeekStart, 0, 0, timeZone);
  const end = wallToInstant(currentWeekStart, 0, 0, timeZone); // exclusive
  return {
    start,
    end,
    // Inclusive bound for the report queries (the service filters with lte).
    to: new Date(end.getTime() - 1),
    period: `weekly:${isoDay(prevWeekStart)}`,
    startWall: prevWeekStart,
    endWall: addWallDays(currentWeekStart, -1),
  };
}

/** The previous fully completed month (1st 00:00 → 1st 00:00, wall clock). */
function previousMonthPeriod(now, timeZone) {
  const today = tzWall(now, timeZone);
  const prevMonth = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
  const start = wallToInstant({ y: prevMonth.y, m: prevMonth.m, d: 1 }, 0, 0, timeZone);
  const end = wallToInstant({ y: today.y, m: today.m, d: 1 }, 0, 0, timeZone); // exclusive
  return {
    start,
    end,
    to: new Date(end.getTime() - 1),
    period: `monthly:${prevMonth.y}-${pad2(prevMonth.m)}`,
    startWall: { y: prevMonth.y, m: prevMonth.m, d: 1 },
    endWall: { y: today.y, m: today.m, d: 1 },
  };
}

/** When this week's weekly report should go out (wall clock in `timeZone`). */
function weeklySendMoment(now, timeZone, weeklyDay, sendHour) {
  const today = tzWall(now, timeZone);
  return wallToInstant(addWallDays(today, weeklyDay - today.weekday), sendHour, 0, timeZone);
}

/** When this month's monthly report should go out. */
function monthlySendMoment(now, timeZone, monthlyDay, sendHour) {
  const today = tzWall(now, timeZone);
  return wallToInstant({ y: today.y, m: today.m, d: monthlyDay }, sendHour, 0, timeZone);
}

/* ====================================================================== */
/* Delivery                                                                */
/* ====================================================================== */

function parseRecipients(blob) {
  return String(blob || '')
    .split(/[,;\n]+/)
    .map((a) => a.trim())
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
}

/** Minutes → a short human duration for the email body (presentation only). */
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const rest = mins % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function fmtDay(wall) {
  return `${wall.d} ${MONTHS[wall.m - 1].slice(0, 3)}`;
}

/** Human period label for the subject and the body header. */
function periodLabel(kind, p) {
  if (kind === 'monthly') return `${MONTHS[p.startWall.m - 1]} ${p.startWall.y}`;
  return `${fmtDay(p.startWall)} – ${fmtDay(p.endWall)} ${p.endWall.y}`;
}

/**
 * Render the email from the report payload. Every number is read off the
 * payload — this formats, it never computes.
 */
function renderReport({ kind, periodLabel: label, timeZone, report }) {
  const t = report.totals ?? {};
  const sla = report.sla?.totals ?? {};
  const live = sla.live ?? {};
  const lines = [];
  const section = (name) => lines.push('', name, '-'.repeat(name.length));

  section(`${kind === 'monthly' ? 'MONTHLY' : 'WEEKLY'} HELPDESK REPORT`);
  lines.push(`Period: ${label} (${timeZone})`);

  section('TICKET VOLUME');
  lines.push(`Created: ${t.created ?? 0}    Resolved: ${t.resolved ?? 0}`);
  const busiest = (report.volume ?? []).reduce((a, b) => {
    const sum = (r) => r.created + r.resolved;
    return !a || sum(b) > sum(a) ? b : a;
  }, null);
  if (busiest && busiest.created + busiest.resolved > 0) {
    lines.push(`Busiest day: ${busiest.day} (${busiest.created} created, ${busiest.resolved} resolved)`);
  }

  section('BY STATUS');
  for (const row of report.byStatus ?? []) lines.push(`  ${row.state.padEnd(14)} ${row.count}`);
  section('BY PRIORITY');
  for (const row of report.byPriority ?? []) lines.push(`  ${row.priority.padEnd(14)} ${row.count}`);

  section('BY ASSIGNMENT GROUP');
  for (const g of report.byGroup ?? []) {
    lines.push(`  ${(g.team ?? 'No group').padEnd(24)} ${String(g.count).padStart(4)}  (${g.open} still open)`);
  }
  section('BY AGENT');
  for (const a of report.byAgent ?? []) {
    lines.push(`  ${(a.agent ?? 'Unassigned').padEnd(24)} ${String(a.count).padStart(4)}  (${a.open} still open)`);
  }

  section('FIRST RESPONSE');
  const fr = t.firstResponse ?? {};
  lines.push(
    `Answered: ${fr.responded ?? 0} of ${fr.eligible ?? 0} created tickets` +
    (fr.eligible ? ` (${fr.rate ?? 0}%)` : '') +
    ` · average ${fmtDuration(fr.avgMs)} (wall clock)`
  );

  section('RESOLUTION');
  const res = t.resolution ?? {};
  lines.push(`Resolved: ${res.count ?? 0} · average age at resolution ${fmtDuration(res.avgMs)} (wall clock)`);

  section('SLA PERFORMANCE');
  lines.push(
    `Compliance: ${sla.rate == null ? 'no completed cycles' : `${sla.rate}%`} ` +
    `(${sla.met ?? 0} of ${sla.total ?? 0} completed cycles met)`
  );
  lines.push(
    `Completed breaches: response ${sla.response?.breached ?? 0} · resolution ${sla.resolution?.breached ?? 0}`
  );
  lines.push(
    `Average first response: ${fmtDuration(sla.response?.avgMs)} · ` +
    `average resolution: ${fmtDuration(sla.resolution?.avgMs)} (working time)`
  );
  lines.push(
    `Live now: ${live.openCycles ?? 0} open · ` +
    `${(live.responseBreaches ?? 0) + (live.resolutionBreaches ?? 0)} breaching · ` +
    `${live.approaching ?? 0} approaching`
  );

  // Notable breaches: the SLA report's own per-bucket aggregates, listed when
  // non-zero. Nothing here recalculates a breach — it only names where the
  // service already found them.
  const notable = [];
  for (const b of report.sla?.byPriority ?? []) {
    if (b.response.breached || b.resolution.breached) {
      notable.push(`  priority ${b.priority}: ${b.response.breached} response, ${b.resolution.breached} resolution`);
    }
  }
  for (const g of report.sla?.byGroup ?? []) {
    if (g.response.breached || g.resolution.breached) {
      notable.push(`  group ${g.team ?? 'unknown'}: ${g.response.breached} response, ${g.resolution.breached} resolution`);
    }
  }
  if (notable.length) {
    section('NOTABLE BREACHES');
    lines.push(...notable.slice(0, 8));
  } else {
    section('NOTABLE BREACHES');
    lines.push('  none recorded in this period');
  }

  lines.push('', `Generated ${new Date().toUTCString()} by the scheduled report runner.`);
  return lines.join('\r\n');
}

/** Has this period already been delivered? The sent-audit row is the gate. */
async function alreadySent(client, period) {
  const row = await client.auditEvent.findFirst({
    where: { action: 'report.sent', metadata: { contains: `"period":"${period}"` } },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Generate and deliver one scheduled report. Never throws: every outcome is a
 * {status} so a failed report cannot take the tick (or the server) down.
 *
 * Statuses: sent | already_sent | no_recipients | dry_run | failed | error
 */
async function sendScheduledReport({
  kind,
  now = new Date(),
  client = prisma,
  mailer = mailerModule,
  logger = console,
  dryRun = false,
} = {}) {
  if (kind !== 'weekly' && kind !== 'monthly') {
    return { status: 'error', error: 'kind must be "weekly" or "monthly"' };
  }
  try {
    const settings = await settingsService.getAll(client);
    const timeZone = settings.slaTimezone || 'Africa/Lagos';
    const period = kind === 'weekly'
      ? previousWeekPeriod(now, timeZone)
      : previousMonthPeriod(now, timeZone);
    const label = periodLabel(kind, period);
    const recipients = parseRecipients(settings.reportRecipients);

    if (await alreadySent(client, period.period)) {
      return { status: 'already_sent', periodKey: period.period };
    }
    if (recipients.length === 0) {
      return { status: 'no_recipients', period };
    }

    const report = await reports.reportsOverview({
      from: period.start,
      to: period.to,
      now,
      client,
    });
    const subject = `[IT Helpdesk] ${kind === 'monthly' ? 'Monthly' : 'Weekly'} report ${label}`;
    const body = renderReport({ kind, periodLabel: label, timeZone, report });

    if (dryRun) {
      return { status: 'dry_run', period, label, subject, body, recipients, report };
    }

    const ok = await mailer.sendMailSafe({
      subject,
      body,
      toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
    });

    if (ok) {
      await auditService.record(client, {
        action: 'report.sent',
        entityType: 'ScheduledReport',
        entityLabel: `${kind} ${label}`,
        actor: 'system (report scheduler)',
        to: { recipients },
        description: `Scheduled ${kind} report for ${label} delivered to ${recipients.length} recipient(s)`,
        // period leads the metadata: the dedupe gate matches on this exact
        // substring, so it must never fall foul of the JSON size cap.
        metadata: { period: period.period, kind, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(), subject },
      });
      logger.log(`[reports] ${kind} report for ${label} sent to ${recipients.length} recipient(s)`);
      return { status: 'sent', periodKey: period.period, subject, recipients };
    }

    await auditService.record(client, {
      action: 'report.failed',
      entityType: 'ScheduledReport',
      entityLabel: `${kind} ${label}`,
      actor: 'system (report scheduler)',
      to: { recipients },
      description: `Scheduled ${kind} report for ${label} failed to send`,
      metadata: { period: period.period, kind, error: 'mailer reported a failed send' },
    });
    logger.error(`[reports] ${kind} report for ${label} failed to send`);
    return { status: 'failed', periodKey: period.period };
  } catch (err) {
    // Report generation or audit failure: log and report — never propagate.
    logger.error(`[reports] ${kind} report run failed: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

/**
 * One scheduler pass: check both periods against their configured send
 * moments and deliver whatever is due (and not already sent).
 */
async function runDueReports({
  now = new Date(),
  client = prisma,
  mailer = mailerModule,
  logger = console,
} = {}) {
  const out = { weekly: 'not_due', monthly: 'not_due' };
  try {
    const settings = await settingsService.getAll(client);
    const timeZone = settings.slaTimezone || 'Africa/Lagos';
    const recipients = parseRecipients(settings.reportRecipients);
    if (recipients.length === 0) {
      // Dormant by configuration — quiet, not an error.
      out.weekly = 'no_recipients';
      out.monthly = 'no_recipients';
      return out;
    }
    if (
      settings.reportWeeklyEnabled === 1 &&
      now >= weeklySendMoment(now, timeZone, settings.reportWeeklyDay, settings.reportSendHour)
    ) {
      out.weekly = (await sendScheduledReport({ kind: 'weekly', now, client, mailer, logger })).status;
    }
    if (
      settings.reportMonthlyEnabled === 1 &&
      now >= monthlySendMoment(now, timeZone, settings.reportMonthlyDay, settings.reportSendHour)
    ) {
      out.monthly = (await sendScheduledReport({ kind: 'monthly', now, client, mailer, logger })).status;
    }
  } catch (err) {
    // A broken pass must never throw into the interval (or take the server).
    logger.error(`[reports] scheduler pass failed: ${err.message}`);
    if (out.weekly === 'not_due') out.weekly = 'error';
    if (out.monthly === 'not_due') out.monthly = 'error';
  }
  return out;
}

/* ====================================================================== */
/* Interval wiring — the same conventions as the other sweepers            */
/* ====================================================================== */

let sweepTimer = null;
let sweepRunning = false;

function startReportScheduler({ logger = console } = {}) {
  if (SWEEP_INTERVAL_MS <= 0) {
    logger.log('[reports] scheduler disabled (REPORT_SCHEDULER_INTERVAL_MS=0)');
    return false;
  }
  sweepTimer = setInterval(async () => {
    if (sweepRunning) return; // never overlap two passes
    sweepRunning = true;
    try {
      await runDueReports({ now: new Date(), logger });
    } finally {
      sweepRunning = false;
    }
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.log(`[reports] scheduler every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);
  return true;
}

function stopReportScheduler() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepRunning = false;
}

module.exports = {
  SWEEP_INTERVAL_MS,
  tzOffsetMs,
  tzWall,
  wallToInstant,
  previousWeekPeriod,
  previousMonthPeriod,
  weeklySendMoment,
  monthlySendMoment,
  parseRecipients,
  fmtDuration,
  periodLabel,
  renderReport,
  alreadySent,
  sendScheduledReport,
  runDueReports,
  startReportScheduler,
  stopReportScheduler,
};
