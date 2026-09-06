/* Display model for the dashboard's SLA KPI row — the pure counterpart to
   slaView.js. Input is the `sla` block the dashboard API computes from the
   SLA cycle table; nothing here recomputes SLA outcomes or working time.
   The only local arithmetic is formatting backend-provided numbers into the
   KPI card view models (value, sub, meter segments, note) the Dashboard
   renders with its shared KpiCard component. */

import { fmtRemaining } from './slaView.js';

function pct(part, whole) {
  if (!whole) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/* `sla`      — the API's dashboard `sla` block (or null when absent)
   `totalOpen`— the dashboard's open-ticket count, the queue the approaching
                figure is a share of
   Returns    — KPI card view models, [] when there is no sla block (the row
                then stays hidden rather than showing six empty shells). */
export function slaKpiCards(sla, totalOpen = 0) {
  if (!sla) return [];

  const compliance = sla.compliance || {};
  const breaches = sla.breaches || {};
  const complianceTotal = compliance.total || 0;
  const complianceMet = compliance.met || 0;
  const responseBreaches = breaches.response || 0;
  const resolutionBreaches = breaches.resolution || 0;
  const responseApplicable = breaches.responseApplicable || 0;
  const resolutionApplicable = breaches.resolutionApplicable || 0;
  const approaching = sla.approachingTickets || 0;

  const avgResponse = sla.avgFirstResponseMs;
  const avgResolution = sla.avgResolutionMs;
  // Targets come from the API (the approved response target and the exact
  // working-time targets of the sampled cycles) — never hardcoded here.
  const responseTargetMs = sla.responseTargetMs;
  const resolutionTargetMs = sla.avgResolutionTargetMs;

  return [
    {
      tone: 'ok',
      label: 'SLA Compliance',
      value: compliance.rate != null ? `${compliance.rate}%` : null,
      sub: 'Completed cycles, all SLAs met',
      segments:
        complianceTotal > 0
          ? [
              {
                key: 'met',
                value: complianceMet,
                pct: pct(complianceMet, complianceTotal),
                title: `${complianceMet} cycles met every SLA`,
              },
              {
                key: 'missed',
                value: complianceTotal - complianceMet,
                pct: pct(complianceTotal - complianceMet, complianceTotal),
                title: `${complianceTotal - complianceMet} cycles breached an SLA`,
              },
            ]
          : [],
      note: complianceTotal
        ? `${complianceMet} of ${complianceTotal} completed cycles met`
        : 'No completed cycles yet',
    },
    {
      tone: 'critical',
      label: 'Response Breaches',
      value: responseApplicable ? responseBreaches : null,
      sub: 'First response late',
      segments: responseApplicable
        ? [
            {
              key: 'response',
              value: responseBreaches,
              pct: pct(responseBreaches, responseApplicable),
              title: `${responseBreaches} of ${responseApplicable} response clocks breached`,
            },
          ]
        : [],
      note: responseApplicable
        ? `${pct(responseBreaches, responseApplicable)}% of ${responseApplicable} cycles`
        : 'No SLA cycles yet',
    },
    {
      tone: 'critical',
      label: 'Resolution Breaches',
      value: resolutionApplicable ? resolutionBreaches : null,
      sub: 'Resolved past target',
      segments: resolutionApplicable
        ? [
            {
              key: 'resolution',
              value: resolutionBreaches,
              pct: pct(resolutionBreaches, resolutionApplicable),
              title: `${resolutionBreaches} of ${resolutionApplicable} resolution clocks breached`,
            },
          ]
        : [],
      note: resolutionApplicable
        ? `${pct(resolutionBreaches, resolutionApplicable)}% of ${resolutionApplicable} cycles`
        : 'No SLA cycles yet',
    },
    {
      tone: 'warn',
      label: 'Approaching Breach',
      value: approaching,
      sub: 'Open · under 25% of SLA left',
      segments: totalOpen
        ? [
            {
              key: 'approaching',
              value: approaching,
              pct: pct(approaching, totalOpen),
              title: `${approaching} of ${totalOpen} open tickets`,
            },
          ]
        : [],
      note: totalOpen
        ? `${pct(approaching, totalOpen)}% of the open queue`
        : 'No open tickets',
    },
    {
      tone: 'primary',
      label: 'Avg First Response',
      value: avgResponse != null ? fmtRemaining(avgResponse) : null,
      sub: 'Working time to first reply',
      segments:
        avgResponse != null && responseTargetMs
          ? [
              {
                key: 'response',
                value: avgResponse,
                pct: pct(avgResponse, responseTargetMs),
                title: `${pct(avgResponse, responseTargetMs)}% of the response target`,
              },
            ]
          : [],
      note: sla.firstResponseCount
        ? `Across ${sla.firstResponseCount} answered ${sla.firstResponseCount === 1 ? 'cycle' : 'cycles'}`
        : 'No responses recorded yet',
    },
    {
      tone: 'info',
      label: 'Avg Resolution',
      value: avgResolution != null ? fmtRemaining(avgResolution) : null,
      sub: 'Working time to resolve',
      segments:
        avgResolution != null && resolutionTargetMs
          ? [
              {
                key: 'resolution',
                value: avgResolution,
                pct: pct(avgResolution, resolutionTargetMs),
                title: `${pct(avgResolution, resolutionTargetMs)}% of the average target`,
              },
            ]
          : [],
      note: sla.resolutionCount
        ? `Across ${sla.resolutionCount} completed ${sla.resolutionCount === 1 ? 'cycle' : 'cycles'}`
        : 'No resolutions recorded yet',
    },
  ];
}
