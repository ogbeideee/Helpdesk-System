// SLA notifications.
//
// Sends the approved SLA alerts — approaching breach and breach, for the
// response and resolution clocks — to the assigned agent and the assignment
// group lead, through the EXISTING notification system: in-app rows in the
// Notification table plus the shared mailer (Graph when configured, console
// otherwise). This module owns no transport, no store and no scheduling of
// its own; it is the SLA-specific wording and recipient policy on top of the
// primitives every other feature uses (workloadService.notifyOwnershipChange
// and the handover notify() follow the same shape).
//
// Trigger and exactly-once. Notifications fire only from the SLA sweeper
// (slaSweeper.js), immediately after it records an approaching_breach/breach
// TicketSlaEvent. Event recording is itself exactly-once per clock per cycle
// (an optimistic claim on the cycle row gates the insert), and the
// notification rides that claim — so no sweep, however often it runs, can
// notify twice for the same SLA event. Cycles that were answered or ended
// never reach the sweeper's scans, so resolved/closed tickets are
// structurally silent. Service-layer breach events (resolution latched while
// finalizing an ended cycle, a late first response the agent just wrote) are
// deliberately not notified: those clocks are already settled and there is
// nobody who could still act on them.
//
// Recipients. The ticket's CURRENT assigned agent plus the lead of its
// CURRENT assignment group (TeamMembership.isLead), deduplicated by agent id
// — an agent who leads their own group receives one notification, not two.
// Agents must be isActive (an inactive account cannot act on the alert);
// a ticket with neither an active assignee nor an active lead notifies
// nobody. The requester never receives SLA alerts: recipients are agent
// rows only.
//
// Emails follow the shared outbound conventions (src/email/outbound.js):
// greeting, aligned context block and the portal footer every other
// notification uses.

const prisma = require('./lib/prisma');
const slaService = require('./slaService');
const { createMailer } = require('./mailer');
const { stateLabel, greeting, ticketSubject, ticketFooter, toRecipient } = require('./email/outbound');

const defaultMailer = createMailer();

// Notification.type values, snake_case like ticket_reassigned / handover_expired.
const EVENT_TYPE = { approaching: 'sla_approaching_breach', breach: 'sla_breach' };
const CLOCK_LABEL = { response: 'Response', resolution: 'Resolution' };

// Working-time leftover, human-sized (the calendar only accrues whole
// minutes' worth of granularity in practice).
function formatWorkingMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'less than a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (!rest) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours} hour${hours === 1 ? '' : 's'} ${rest} minute${rest === 1 ? '' : 's'}`;
}

// The applicable target for this clock, from the configured SLA settings.
function targetLabel(clock, priority, policy) {
  if (clock === 'response') {
    const ms = policy.responseTargetMs;
    const label =
      ms % 3600000 === 0
        ? `${ms / 3600000} working hour${ms / 3600000 === 1 ? '' : 's'}`
        : `${Math.round(ms / 60000)} working minutes`;
    return `Response target — ${label}`;
  }
  const hours = policy.resolutionTargetHours[priority] || policy.resolutionTargetHours.moderate;
  return `Resolution target — ${hours} working hour${hours === 1 ? '' : 's'} (${priority} priority)`;
}

function statusLine(kind, clock) {
  if (kind === 'approaching') {
    return clock === 'response'
      ? 'Approaching breach — 25% of the response window remains'
      : 'Approaching breach — 25% of the resolution window remains';
  }
  return clock === 'response'
    ? 'Breached — the target passed with no agent response recorded'
    : 'Breached — the target passed without resolution';
}

function introLine(kind, clock) {
  if (kind === 'approaching') {
    return clock === 'response'
      ? 'The response SLA on this ticket is approaching its breach threshold — a first public response is needed before the target passes.'
      : 'The resolution SLA on this ticket is approaching its breach threshold — the ticket should be resolved before the target passes.';
  }
  return clock === 'response'
    ? 'The response SLA on this ticket has been breached — no first public response was recorded before the target passed.'
    : 'The resolution SLA on this ticket has been breached — the target passed without resolution.';
}

/**
 * Who receives an SLA alert for this ticket: the current assignee and the
 * current group lead, active agents only, deduplicated by agent id (an agent
 * leading their own group is one recipient, not two).
 */
async function recipientsFor(ticket, client = prisma) {
  const seen = new Set();
  const out = [];
  const consider = (agent) => {
    if (!agent || !agent.isActive || !agent.email || seen.has(agent.id)) return;
    seen.add(agent.id);
    out.push(agent);
  };
  if (ticket.assignedAgentId) {
    consider(await client.agent.findUnique({ where: { id: ticket.assignedAgentId } }));
  }
  if (ticket.teamId) {
    const membership = await client.teamMembership.findFirst({
      where: { teamId: ticket.teamId, isLead: true },
      include: { agent: true },
    });
    if (membership) consider(membership.agent);
  }
  return out;
}

/**
 * Notify one SLA moment. `kind` is 'approaching' | 'breach', `clock` is
 * 'response' | 'resolution', `dueAt` is the cycle's frozen due instant and
 * `now` the detection instant. Never throws — losing a notification must not
 * fail the sweep — and returns how many in-app notifications were created.
 * `mailer` is injectable so tests can capture what would have been sent.
 */
async function notifySlaEvent({
  client = prisma,
  ticket,
  kind,
  clock,
  dueAt,
  now = new Date(),
  mailer = defaultMailer,
} = {}) {
  if (!ticket || !dueAt || !EVENT_TYPE[kind] || !CLOCK_LABEL[clock]) return 0;
  const recipients = await recipientsFor(ticket, client);
  if (recipients.length === 0) return 0;
  // Configured targets + calendar, so remaining-time math and target labels
  // always describe the SLA settings currently in force.
  const policy = await slaService.loadSlaPolicy(client);

  const due = new Date(dueAt);
  let remainingMs = null;
  if (kind === 'approaching') {
    const holidays = await slaService.loadHolidaysBetween(now, due, client, policy);
    remainingMs = policy.calendar.workingMsBetween(now, due, holidays);
  }

  const statePhrase = kind === 'approaching' ? 'approaching breach' : 'breached';
  const title = `${CLOCK_LABEL[clock]} SLA ${statePhrase} on ${ticket.ticketNumber}`;
  const subject = ticketSubject(ticket, `${CLOCK_LABEL[clock]} SLA ${statePhrase}: ${ticket.shortDescription}`);
  const inAppBody =
    kind === 'approaching'
      ? `"${ticket.shortDescription}" — ${formatWorkingMs(remainingMs)} of working time left before the ${clock} target (due ${due.toUTCString()}).`
      : `"${ticket.shortDescription}" — the ${clock} target passed at ${due.toUTCString()}.`;

  let notified = 0;
  for (const agent of recipients) {
    try {
      await client.notification.create({
        data: {
          agentId: agent.id,
          ticketId: ticket.id,
          type: EVENT_TYPE[kind],
          title,
          body: inAppBody,
        },
      });
      notified += 1;
    } catch (err) {
      console.error(`[sla] in-app notification failed for ${agent.email}: ${err.message}`);
    }
    try {
      const body = [
        greeting(agent.name),
        '',
        introLine(kind, clock),
        '',
        `Ticket:     ${ticket.ticketNumber}`,
        `Subject:    ${ticket.shortDescription}`,
        `State:      ${stateLabel(ticket.state)}`,
        `SLA:        ${targetLabel(clock, ticket.priority, policy)}`,
        `Status:     ${statusLine(kind, clock)}`,
        `Due:        ${due.toUTCString()}`,
        ...(kind === 'approaching'
          ? [`Remaining:  ${formatWorkingMs(remainingMs)} of working time`]
          : []),
        ticketFooter(ticket),
      ].join('\r\n');
      await mailer.sendMailSafe({
        subject,
        body,
        toRecipients: [toRecipient(agent.email)],
      });
    } catch (err) {
      console.error(`[sla] email notification failed for ${agent.email}: ${err.message}`);
    }
  }
  return notified;
}

module.exports = {
  EVENT_TYPE,
  notifySlaEvent,
  recipientsFor,
  formatWorkingMs,
};
