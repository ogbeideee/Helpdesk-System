// Ticket lifecycle: NEW -> IN_PROGRESS -> RESOLVED -> CLOSED
// (RESOLVED/CLOSED -> IN_PROGRESS is the supported reopen path; CLOSED -> NEW
// and other backwards jumps are rejected.)
const STATES = ['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['low', 'moderate', 'high', 'critical'];
const CATEGORIES = ['Password Reset', 'Inquiry / Help', 'Software', 'Hardware'];
const OPEN_STATES = ['NEW', 'IN_PROGRESS'];

const STATE_TRANSITIONS = {
  NEW: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], // close or send back / rework
  CLOSED: ['IN_PROGRESS'], // reopen path used by requester replies
};

function isValidState(v) {
  return STATES.includes(v);
}

function canTransition(fromState, toState) {
  if (fromState === toState) return false;
  const allowed = STATE_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(toState));
}

function isOpenState(v) {
  return OPEN_STATES.includes(v);
}

function isValidPriority(v) {
  return PRIORITIES.includes(v);
}

module.exports = {
  STATES,
  PRIORITIES,
  CATEGORIES,
  OPEN_STATES,
  STATE_TRANSITIONS,
  isValidState,
  canTransition,
  isOpenState,
  isValidPriority,
};
