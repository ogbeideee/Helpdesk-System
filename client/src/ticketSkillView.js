// The skill requirement of one ticket, in one place.
//
// The ENGINE decides it: `GET /api/tickets/:id` returns `requiredSkillLevel`
// (the bar of the routing rule that governs THIS ticket inside the group that
// owns it, plus the priority boost) and `requiredSkillRule` (which rule that
// was). The group's own `minSkillLevel` from /api/assignment-groups is a
// summary for the whole group, not this ticket's requirement, so it is only a
// fallback for payloads that predate those fields — a blanket group bar read
// as a per-ticket requirement is what made an L1 software request read "L2".
//
// Pure: no React, no DOM — pinned by ticket-skill-check.mjs.

/** Skill levels as the API stores them (Int) and as this UI names them. */
export const SKILL_LABEL = { 1: 'L1 \u00b7 Junior', 2: 'L2 \u00b7 Standard', 3: 'L3 \u00b7 Senior' };

/** "L2 · Standard" for 2, a bare "L4" for anything the vocabulary lacks. */
export function skillLabel(level) {
  if (level === null || level === undefined) return '\u2014';
  return SKILL_LABEL[level] || `L${level}`;
}

/**
 * What this ticket requires, and where the figure came from.
 *
 * @param {object} ticket  the ticket payload (`requiredSkillLevel`, `requiredSkillRule`)
 * @param {object} [group] the ticket's assignment group (`minSkillLevel`)
 * @returns {{level:number, ruleName:string|null, fromGroup:boolean}|null}
 */
export function requiredSkillOf(ticket, group) {
  if (ticket && Number.isInteger(ticket.requiredSkillLevel)) {
    return {
      level: ticket.requiredSkillLevel,
      ruleName: ticket.requiredSkillRule || null,
      // The engine's own answer for this ticket.
      fromGroup: false,
    };
  }
  if (group && Number.isInteger(group.minSkillLevel)) {
    return { level: group.minSkillLevel, ruleName: null, fromGroup: true };
  }
  return null;
}

/** Is the assignee below the level this ticket requires? */
export function assigneeBelowRequired(ticket, required) {
  const level = ticket && ticket.assignedAgent ? ticket.assignedAgent.skillLevel : null;
  return Boolean(required && Number.isInteger(level) && level < required.level);
}
