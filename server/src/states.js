// Ticket lifecycle: NEW -> IN_PROGRESS -> RESOLVED -> CLOSED
//
// CLOSED is final: no agent-driven transition leaves it. A closed ticket comes
// back only through the requester-reply workflow in services/ticketIntake.js,
// which reopens it to IN_PROGRESS and writes its own audit entry. That path
// deliberately does not consult this map, so "final for people, reopenable by
// the requester" is expressed in exactly one place.
//
// RESOLVED -> IN_PROGRESS stays available as rework before closure.
const STATES = ['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['low', 'moderate', 'high', 'critical'];
const CATEGORIES = ['Password Reset', 'Inquiry / Help', 'Software', 'Hardware'];
const OPEN_STATES = ['NEW', 'IN_PROGRESS'];

const STATE_TRANSITIONS = {
  NEW: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], // close or send back / rework
  CLOSED: [], // final — see the note above
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
