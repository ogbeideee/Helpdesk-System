// Who a message is ADDRESSED TO — read from the sender's own greeting.
//
// An employee who needs one specific person writes "Dear Dare, …" or
// "Hi Yemi, …" and nobody else should have to guess. When the greeting names
// an agent, the ticket should go to them — provided they can actually take it.
//
// The problem is that nothing in the schema records a nickname: `Agent` has a
// full `name` and an `email` and nothing else. So the match has to be DERIVED
// from the name, which is why this module is careful about being boring:
//
//   1. Only the FIRST block of the body is read. A salutation opens a message;
//      a "Dear X," at the bottom is a sign-off. Quoted history and signatures
//      are already out of `cleanBody` (see email/signature.js), so the block
//      that remains is the sender's own opening.
//   2. The addressee must be one of a small set of greeting openers. Anything
//      else is not a salutation, however much it looks like a name.
//   3. Greetings that are not people ("Dear all", "Dear IT", "Dear Sir") never
//      resolve, whatever an agent is called.
//   4. A greeting matching more than one agent resolves to NOBODY. A wrong
//      assignment is worse than normal routing, so ambiguity always fails open.
//   5. Matching is deterministic string work: an exact name part first, then a
//      nickname-style fragment — one the name ENDS with ("Yemi" inside
//      "Ibiyemi") or one it BEGINS with ("Bash" inside "Bashir") — and only
//      then a loose interior fragment. No model, no clock, no network — the
//      same body always yields the same answer.
//   6. An administrator may PIN the answer for a nickname the derived rules
//      cannot separate ("yemi" also ends "Adeyemi"): the intake alias list is
//      consulted first and, unlike the derived tiers, it is not narrowed by
//      availability. An alias says who the message was written FOR — the
//      assignment engine still decides who may take the work, and says why.
//
// This module decides only WHO WAS ADDRESSED. Whether that person may take the
// ticket — active, available, skilled enough, under the workload cap — is the
// assignment engine's existing gate, which is applied afterwards. Splitting it
// that way is deliberate: this file is pure, and the engine keeps sole
// ownership of eligibility.
'use strict';

/** Greeting openers that may be followed by a person. */
const GREETING_RE =
  /^\s*(?:dear|hi|hello|hey|yo|good\s+(?:morning|afternoon|evening)|greetings)\b[\s,.:;!-]*(.*)$/i;

/** Honorifics that may precede the name inside a greeting. */
const TITLES = new Set([
  'mr', 'mister', 'mrs', 'ms', 'miss', 'madam', 'maam', 'dr', 'prof', 'professor',
  'engr', 'engineer', 'chief', 'pastor', 'sir', 'lord', 'lady', 'rev', 'fr',
]);

/**
 * Greetings that address nobody in particular. "Dear All," is the single most
 * common opening in a helpdesk mailbox and must never become an assignment,
 * however the token happens to look. Compared as compact tokens, so "everyone"
 * and "every one" are both covered.
 */
const NON_PERSON_GREETINGS = new Set([
  'all', 'everyone', 'everybody', 'anybody', 'anyone', 'team', 'staff', 'crew',
  'folks', 'guys', 'ladies', 'gentlemen', 'gentlefolk', 'sir', 'sirs', 'madam',
  'maam', 'miss', 'mister', 'mr', 'mrs', 'ms', 'dr', 'boss', 'manager', 'lead',
  'colleague', 'colleagues', 'customer', 'customers', 'user', 'users', 'client',
  'clients', 'member', 'members', 'there', 'you', 'it', 'its', 'helpdesk',
  'help desk', 'service desk', 'desk', 'support', 'services', 'service',
  'admin', 'admins', 'administrator', 'administrators', 'itteam', 'it support',
  'info', 'information', 'human', 'humans', 'person', 'people', 'owner',
  'requestor', 'requester', 'sender', 'friend', 'friends', 'folks',
]);

/** Below this length a substring match is noise, not a nickname. */
const MIN_NICKNAME_LENGTH = 3;

/**
 * Name-match tiers, strongest first. Reported on every resolution so an audit
 * trail can say HOW a greeting became an assignment.
 */
const TIERS = ['exact', 'suffix', 'prefix', 'interior'];

/** How each tier reads in a reason string. */
const TIER_LABELS = {
  exact: 'exact name',
  suffix: 'the name ends with it',
  prefix: 'the name begins with it',
  interior: 'a loose fragment of the name',
};

/** "Punctuation and case carry no meaning in a name." */
function compact(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The name part of the opening greeting, or null when the message does not open
 * with a salutation naming somebody.
 *
 * Strict on purpose: the greeting must be the first non-empty line, and it must
 * match a known opener. A message that starts straight into its request has no
 * addressee, and neither has one whose first line is "Dear colleagues,".
 *
 * @param {string|null|undefined} cleanBody the sender's own words (no quoted
 *   history, no signature). Null/empty yields null — a caller with no clean
 *   view of the body has no evidence and must not guess.
 * @returns {{ addressee: string, greeting: string, raw: string }|null}
 */
function extractAddressee(cleanBody) {
  if (typeof cleanBody !== 'string' || !cleanBody.trim()) return null;

  // The first block only — everything up to the first blank line. This is what
  // makes a trailing "Dear Yemi," sign-off unreachable, on top of the fact
  // that the salutation is the first line and not the last.
  const block = cleanBody.split(/\n\s*\n/, 1)[0] || '';
  const firstLine = block.split('\n').find((line) => line.trim());
  if (!firstLine) return null;

  const match = GREETING_RE.exec(firstLine);
  if (!match) return null;

  const rest = String(match[1] || '').trim();
  // Drop a leading "to" and any honorific, then take what is left as the name.
  // "Dear Mr. Dare," and "Hello Dare," must both yield "Dare".
  const withoutTo = rest.replace(/^to\b[\s,]+/i, '');
  const tokens = withoutTo
    .split(/[\s,;:!?.–—-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  while (tokens.length > 1 && TITLES.has(compact(tokens[0]))) tokens.shift();
  // "Dear Dare to," / "Hello to Yemi," — a dangling preposition, not a name.
  while (tokens.length > 1 && /^(?:to|for|from)$/i.test(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return null;

  const name = tokens.join(' ').replace(/[.,]+$/, '').trim();
  if (!name) return null;
  const key = compact(name);
  // "Dear all," / "Dear IT," / "Dear Sir," address nobody, whatever an agent
  // happens to be called.
  if (!key || NON_PERSON_GREETINGS.has(key)) return null;
  // One or two words is a name; a whole sentence is not.
  if (tokens.length > 3) return null;

  return { addressee: name, greeting: rest, raw: firstLine.trim() };
}

/**
 * Every comparable form of an agent's name: the whole name, each of its parts,
 * and each part stripped of a leading honorific. "Dare Ojo", "Ojo Dare" and
 * "Mr Dare Ojo" all yield `dare` and `ojo`.
 */
function nameKeys(name) {
  const keys = new Set();
  const whole = compact(name);
  if (whole) keys.add(whole);
  for (const part of String(name || '').split(/[\s,]+/)) {
    const c = compact(part);
    if (!c) continue;
    keys.add(c);
    if (TITLES.has(c)) continue;
  }
  // A part carrying its own honorific — "mr dare" -> "dare".
  for (const part of String(name || '').split(/[\s,]+/)) {
    const c = compact(part);
    if (!c) continue;
    for (const title of TITLES) {
      if (c.length > title.length && c.startsWith(title)) {
        keys.add(c.slice(title.length));
        break;
      }
    }
  }
  return keys;
}

/** The name parts of `name`, with honorifics removed — what a nickname matches in. */
function nameParts(name) {
  return String(name || '')
    .split(/[\s,]+/)
    .map(compact)
    .filter((part) => part && !TITLES.has(part));
}

/**
 * Parse the administrator's alias list into `{ nickname, target }` entries.
 *
 * Grammar, because it is typed by a human into one field:
 *
 *     bash = Bashir Oladipo, yemi = y.aboyewa@example.com
 *
 * Entries are separated by a comma, a semicolon or a newline; the FIRST "="
 * splits the nickname from the target, so an alias list is readable in one
 * glance. The nickname is compacted (case- and punctuation-insensitive, the
 * same way a greeting is read); the target is an agent's sign-in address or
 * their name as stored, matched by the same name keys the derived tiers use.
 * The first occurrence of a nickname wins, malformed entries are skipped rather
 * than fatal — a mistyped list must never stop a message being a ticket.
 */
function parseAliases(value) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(value === null || value === undefined ? '' : value).split(/[,;\n]+/)) {
    const text = chunk.trim();
    if (!text) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) continue;
    const nickname = compact(text.slice(0, eq));
    const target = text.slice(eq + 1).trim();
    if (!nickname || !target) continue;
    if (seen.has(nickname)) continue;
    seen.add(nickname);
    out.push({ nickname, target });
  }
  return out;
}

/**
 * Accept the alias list in any of the shapes a caller may hold: the setting's
 * string, an array of `{ nickname, target }`, or a plain `{ nickname: target }`
 * map (handy in a test).
 */
function aliasList(value) {
  if (!value) return [];
  if (typeof value === 'string') return parseAliases(value);
  if (Array.isArray(value)) return parseAliases(value.map((e) => e && `${e.nickname || e.key || ''} = ${e.target || e.value || ''}`).join('\n'));
  if (typeof value === 'object') {
    return parseAliases(Object.entries(value).map(([nickname, target]) => `${nickname} = ${target}`).join('\n'));
  }
  return [];
}

/** True when the agent is the one an alias entry names. */
function agentMatchesAliasTarget(agent, target) {
  const wanted = String(target || '').trim().toLowerCase();
  if (!wanted) return false;
  if (wanted.includes('@')) {
    return String(agent.email || '').trim().toLowerCase() === wanted;
  }
  return nameKeys(agent.name).has(compact(wanted));
}

/**
 * A staff role for the purpose of narrowing the candidate list. An UNDESCRIBED
 * role is not evidence against the agent — see resolveAddressee().
 */
function isStaffRole(role) {
  if (role === undefined || role === null || role === '') return true;
  const { STAFF_ROLES } = require('./userService');
  return Array.isArray(role)
    ? role.some((r) => STAFF_ROLES.includes(r))
    : STAFF_ROLES.includes(role);
}

/**
 * Match an addressee against the agents.
 *
 * In order, and the first step that finds exactly one agent wins:
 *   1. ALIAS — the administrator pinned this nickname to one person. It is
 *      checked first and is matched against every agent the caller supplied,
 *      because it states who the message was written for; whether that person
 *      may take the work is the assignment engine's call, and it explains the
 *      refusal in the audit trail.
 *   2. EXACT — the addressee equals a name key (whole name or a name part).
 *      Checked before any fragment match so that a "Dear Chris" who is
 *      somebody's actual first name never loses to a nickname match on a
 *      different Chris.
 *   3. SUFFIX — a name part ENDS with the addressee: "Yemi" in "Ibiyemi".
 *   4. PREFIX — a name part BEGINS with the addressee: "Bash" in "Bashir".
 *   5. INTERIOR — a loose fragment either way ("yemi" inside "adeyemi").
 * Steps 3–5 need at least MIN_NICKNAME_LENGTH characters.
 *
 * Any step finding MORE THAN ONE agent is ambiguous and yields nobody: a wrong
 * assignment is worse than an ordinary one.
 *
 * @param {{addressee: string}|null} extracted from extractAddressee(), or null
 * @param {Array<{id:number, name:string, email?:string, role?:string,
 *   isActive?:boolean, isAvailable?:boolean}>} agents agents worth considering
 * @param {{aliases?: string|Array|object}} [options] administrator-pinned
 *   nicknames, in any shape aliasList() accepts
 * @returns {{agentId:number|null, agentName:string|null, matchedName:string|null,
 *   matchType:'exact'|'nickname'|null, tier:string|null, reason:string}}
 */
function resolveAddressee(extracted, agents, options = {}) {
  const nobody = (reason) => ({
    agentId: null,
    agentName: null,
    matchedName: null,
    matchType: null,
    tier: null,
    reason,
  });

  if (!extracted || !Array.isArray(agents) || !agents.length) {
    return nobody('no greeting addressee');
  }

  const needle = compact(extracted.addressee);
  if (!needle) return nobody('greeting carries no name');

  const usable = agents.filter((a) => a && a.id !== undefined && a.id !== null);

  // Candidates for the DERIVED tiers are narrowed to people who could actually
  // receive the ticket — active, available and a staff role. That is what makes
  // the match checkable by eye: "Dear Yemi" resolves to Ibiyemi because among
  // the people who can be given work there is exactly one whose name contains
  // it, and a deactivated namesake cannot create a false ambiguity.
  //
  // A field the caller did NOT describe is kept, never treated as a rejection.
  // A caller that has not loaded `role` is not telling us the agent is not
  // staff — and dropping every candidate on that reading is exactly how this
  // feature goes quietly inert instead of failing loudly (the intake query that
  // forgot to select these columns did precisely that).
  //
  // The engine re-checks all of this (and the skill bar and the workload cap)
  // before it hands anything over, so narrowing the list here only removes
  // names that could never have been assigned anyway.
  const eligible = usable.filter(
    (a) => a.isActive !== false && a.isAvailable !== false && isStaffRole(a.role),
  );

  // 1) The administrator's own answer, when there is one.
  const notes = [];
  const pinned = aliasList(options.aliases).find((entry) => entry.nickname === needle);
  if (pinned) {
    const named = usable.filter((a) => agentMatchesAliasTarget(a, pinned.target));
    if (named.length === 1) {
      return {
        agentId: named[0].id,
        agentName: named[0].name,
        matchedName: extracted.addressee,
        matchType: 'exact',
        tier: 'alias',
        reason: `the greeting "${extracted.addressee}" is an administrator alias for ${named[0].name}`,
      };
    }
    notes.push(
      named.length
        ? `the alias "${extracted.addressee}" names ${named.length} agents (${named.map((a) => a.name).join(', ')})`
        : `the alias "${extracted.addressee}" names nobody on this installation`,
    );
  }

  // 2–5) The derived tiers, strongest first.
  const byTier = { exact: [], suffix: [], prefix: [], interior: [] };
  for (const agent of eligible) {
    if (nameKeys(agent.name).has(needle)) {
      byTier.exact.push(agent);
      continue;
    }
    if (needle.length < MIN_NICKNAME_LENGTH) continue;
    const parts = nameParts(agent.name);
    if (parts.some((part) => part.length >= MIN_NICKNAME_LENGTH && part.endsWith(needle))) {
      byTier.suffix.push(agent);
      continue;
    }
    if (parts.some((part) => part.length >= MIN_NICKNAME_LENGTH && part.startsWith(needle))) {
      byTier.prefix.push(agent);
      continue;
    }
    const interiorHit = parts.some(
      (part) =>
        part.length >= MIN_NICKNAME_LENGTH &&
        (part.includes(needle) || needle.includes(part)),
    );
    if (interiorHit) byTier.interior.push(agent);
  }

  const withNote = (reason) => nobody(notes.length ? `${reason}; ${notes.join('; ')}` : reason);

  for (const tier of TIERS) {
    const chosen = byTier[tier];
    if (!chosen.length) continue;
    if (chosen.length > 1) {
      // Fail open. Normal routing picks somebody sensible; guessing between two
      // real people is how the wrong person gets a ticket about somebody else.
      return withNote(
        `"${extracted.addressee}" matches ${chosen.length} agents by ${TIER_LABELS[tier]} (${chosen
          .map((a) => a.name)
          .join(', ')}) — not assigning by greeting`,
      );
    }
    const matchType = tier === 'exact' ? 'exact' : 'nickname';
    // An alias that did NOT settle this name is reported alongside the match
    // that did: a stale or mistyped entry is invisible otherwise, and the person
    // who wrote it is exactly the person who needs to know it missed.
    const reason = `greeting addresses ${chosen[0].name} ("${extracted.addressee}", ${TIER_LABELS[tier]})`;
    return {
      agentId: chosen[0].id,
      agentName: chosen[0].name,
      matchedName: extracted.addressee,
      matchType,
      tier,
      reason: notes.length ? `${reason}; ${notes.join('; ')}` : reason,
    };
  }

  return withNote(`no agent matches "${extracted.addressee}"`);
}

/**
 * The whole read: greeting -> agent. Convenience wrapper for callers that hold
 * a clean body and the agent list and want one answer.
 *
 * @param {string|null|undefined} cleanBody
 * @param {Array<{id:number, name:string}>} agents
 * @param {{aliases?: string|Array|object}} [options]
 */
function resolveAddressedAgent(cleanBody, agents, options) {
  return resolveAddressee(extractAddressee(cleanBody), agents, options);
}

module.exports = {
  extractAddressee,
  resolveAddressee,
  resolveAddressedAgent,
  parseAliases,
  aliasList,
  agentMatchesAliasTarget,
  nameKeys,
  nameParts,
  compact,
  NON_PERSON_GREETINGS,
  GREETING_RE,
  MIN_NICKNAME_LENGTH,
  TIERS,
};

