export const STATES = [
  { value: 'NEW', label: 'New' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
];

export const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

export const OPEN_STATES = ['NEW', 'IN_PROGRESS'];

// Mirrors server/src/states.js
export const STATE_TRANSITIONS = {
  NEW: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  // CLOSED is final. Reopening happens only when the requester replies by
  // email, which the backend handles - there is no manual reopen action.
  CLOSED: [],
};

export const CATEGORIES = ['Password Reset', 'Inquiry / Help', 'Software', 'Hardware'];

export const stateLabel = (v) =>
  STATES.find((s) => s.value === v)?.label || v;
export const priorityLabel = (v) =>
  PRIORITIES.find((p) => p.value === v)?.label || v;

export const isOpenState = (v) => OPEN_STATES.includes(v);
export const canTransition = (from, to) =>
  Boolean(STATE_TRANSITIONS[from]?.includes(to));

export function isOverdue(ticket, now = new Date()) {
  if (!ticket?.dueAt || !isOpenState(ticket.state)) return false;
  return new Date(ticket.dueAt).getTime() < now.getTime();
}

export function dueDisplay(ticket) {
  if (!ticket?.dueAt) return null;
  const due = new Date(ticket.dueAt);
  const diffMs = due.getTime() - Date.now();
  const hours = diffMs / 3600000;
  const overdue = diffMs < 0 && isOpenState(ticket.state);
  let text;
  if (overdue) {
    const h = Math.abs(hours);
    text = h >= 24 ? `Overdue ${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : `Overdue ${Math.max(1, Math.round(h))}h`;
  } else if (hours >= 1) {
    text = hours >= 24 ? `Due in ${Math.floor(hours / 24)}d` : `Due in ${Math.round(hours)}h`;
  } else {
    text = `Due in ${Math.max(1, Math.round(diffMs / 60000))}m`;
  }
  if (!isOpenState(ticket.state)) text = `Was due ${due.toLocaleDateString()}`;
  return { text, overdue };
}
