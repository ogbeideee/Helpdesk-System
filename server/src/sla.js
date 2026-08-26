// Resolution-target hours by priority (calendar hours from ticket creation).
const SLA_HOURS = {
  critical: 4,
  high: 8,
  moderate: 24,
  low: 72,
};

const DEFAULT_SLA_HOURS = SLA_HOURS.moderate;

function slaHoursFor(priority) {
  return SLA_HOURS[priority] || DEFAULT_SLA_HOURS;
}

function computeDueAt(priority, from = new Date()) {
  return new Date(from.getTime() + slaHoursFor(priority) * 60 * 60 * 1000);
}

function isOpen(state) {
  return ['NEW', 'IN_PROGRESS'].includes(state);
}

function isOverdue(ticket, now = new Date()) {
  if (!ticket || !ticket.dueAt || !isOpen(ticket.state)) return false;
  return new Date(ticket.dueAt).getTime() < now.getTime();
}

function slaSummary(ticket, now = new Date()) {
  if (!ticket || !ticket.dueAt) return null;
  const dueMs = new Date(ticket.dueAt).getTime();
  const remainingMs = dueMs - now.getTime();
  return { overdue: remainingMs < 0, remainingMs };
}

module.exports = { SLA_HOURS, slaHoursFor, computeDueAt, isOverdue, slaSummary };
