/* Pins the ticket skill requirement the inspector shows: which figure wins
   (the engine's per-ticket answer over the group's blanket bar), its
   vocabulary, and the "assignee is below" warning. Pure module, checked the
   same way the other client view modules are (plain node, no DOM).
   Usage: node ticket-skill-check.mjs */

import {
  SKILL_LABEL, skillLabel, requiredSkillOf, assigneeBelowRequired,
} from './src/ticketSkillView.js';

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

/* --- A. vocabulary ---------------------------------------------------- */
eq('A1 level 1 is L1 junior', skillLabel(1), 'L1 \u00b7 Junior');
eq('A2 level 2 is L2 standard', skillLabel(2), 'L2 \u00b7 Standard');
eq('A3 level 3 is L3 senior', skillLabel(3), 'L3 \u00b7 Senior');
eq('A4 an unknown level still reads as a level', skillLabel(4), 'L4');
eq('A5 no level reads as a dash, never "undefined"', skillLabel(null), '\u2014');
eq('A6 exactly three levels exist', Object.keys(SKILL_LABEL).length, 3);

/* --- B. which figure wins --------------------------------------------- */
{
  // The regression this module exists for: a software request whose own rule
  // requires L1 must not inherit the group's blanket L2.
  const ticket = { id: 1704, requiredSkillLevel: 1, requiredSkillRule: 'Software & Applications' };
  const group = { key: 'software', minSkillLevel: 2 };
  const own = requiredSkillOf(ticket, group);
  eq('B1 the ticket\'s own requirement wins over the group bar', own.level, 1);
  eq('B2 the deciding rule travels with it', own.ruleName, 'Software & Applications');
  eq('B3 the ticket figure is not flagged as the group\'s', own.fromGroup, false);
  eq('B4 that ticket renders L1 · Junior', skillLabel(own.level), 'L1 \u00b7 Junior');

  const advanced = { requiredSkillLevel: 2, requiredSkillRule: 'Software (Advanced)' };
  eq('B5 an advanced ticket keeps its L2', requiredSkillOf(advanced, group).level, 2);
  eq('B6 and names its own rule', requiredSkillOf(advanced, group).ruleName, 'Software (Advanced)');
}

/* --- C. fallbacks ------------------------------------------------------ */
{
  const group = { key: 'software', minSkillLevel: 2 };
  const old = requiredSkillOf({ id: 1 }, group);
  eq('C1 a payload without the field falls back to the group bar', old.level, 2);
  eq('C2 the fallback is flagged as the group\'s figure', old.fromGroup, true);
  eq('C3 the fallback names no rule', old.ruleName, null);
  eq('C4 no ticket and no group is null, not zero', requiredSkillOf(null, null), null);
  eq('C5 a group without a bar is null too', requiredSkillOf({ id: 2 }, { key: 'x' }), null);
  eq('C6 a non-integer value is ignored', requiredSkillOf({ requiredSkillLevel: '2' }, group).fromGroup, true);
  eq('C7 a fully-formed ticket needs no group at all',
    requiredSkillOf({ requiredSkillLevel: 1 }, null).level, 1);
}

/* --- D. is the assignee good enough ------------------------------------ */
{
  const required = { level: 2 };
  eq('D1 an L1 assignee on an L2 ticket warns',
    assigneeBelowRequired({ assignedAgent: { skillLevel: 1 } }, required), true);
  eq('D2 an L2 assignee on an L2 ticket does not',
    assigneeBelowRequired({ assignedAgent: { skillLevel: 2 } }, required), false);
  eq('D3 an L3 assignee on an L2 ticket does not',
    assigneeBelowRequired({ assignedAgent: { skillLevel: 3 } }, required), false);
  eq('D4 an unassigned ticket never warns',
    assigneeBelowRequired({ assignedAgent: null }, required), false);
  eq('D5 an assignee without a skill level never warns',
    assigneeBelowRequired({ assignedAgent: {} }, required), false);
  eq('D6 no requirement, no warning',
    assigneeBelowRequired({ assignedAgent: { skillLevel: 1 } }, null), false);
  eq('D7 a missing ticket is safe', assigneeBelowRequired(null, required), false);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
