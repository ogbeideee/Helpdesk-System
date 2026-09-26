// Configurable routing rules: which assignment group (and optionally which
// agent and minimum skill) a ticket should go to.
//
// Deterministic string matching only — no LLM, no network, no randomness.
// The same ticket text always produces the same routing decision.
//
// ---------------------------------------------------------------------------
// RULE PRECEDENCE
// ---------------------------------------------------------------------------
// Only active rules are considered. Among the rules that match, the winner is
// chosen by, in order:
//
//   1. Subject evidence. A rule whose keyword matched in the ticket SUBJECT
//      beats one that only matched in the body. The subject is the sender's
//      own summary; body text is noise-prone (signatures, quoted threads,
//      incidental mentions), so a subject hit is the stronger signal.
//   2. `priority` ascending. Lower number wins, so 10 beats 100. This is the
//      administrator's explicit ordering and dominates within an evidence
//      class.
//   3. Category-specific beats category-agnostic. A rule naming this ticket's
//      category beats one with `category = null`, at equal priority.
//   4. More matched keywords wins. A rule that matched three of the ticket's
//      words is more specific than one that matched a single generic word.
//   5. Longer matched keyword wins. "docking station" is more specific than
//      "dock".
//   6. Lower id wins. A stable, arbitrary tie-break so the outcome never
//      depends on row ordering.
//
// A rule matches when its category (if set) equals the ticket's category AND
// at least one of its keywords appears in the ticket text. A rule with no
// keywords matches on category alone, which is how a catch-all per-category
// rule is expressed.
const prisma = require('../lib/prisma');

/** Skill levels, as stored (Int) and as named in the admin UI. */
const SKILL_LEVELS = { JUNIOR: 1, MID: 2, SENIOR: 3 };
const SKILL_NAMES = { 1: 'JUNIOR', 2: 'MID', 3: 'SENIOR' };

function skillName(level) {
  return SKILL_NAMES[level] || `L${level}`;
}
function skillValue(nameOrNumber) {
  if (typeof nameOrNumber === 'number') return nameOrNumber;
  const key = String(nameOrNumber || '').trim().toUpperCase();
  return SKILL_LEVELS[key] !== undefined ? SKILL_LEVELS[key] : null;
}

/**
 * Reduce a string to comparable form: lower-case, punctuation and separators
 * collapsed to single spaces.
 *
 * This is what makes "Wi-Fi", "WiFi", "wi fi" and "WI-FI!" all match the
 * keyword "wifi": the separators are removed for the compact form and
 * normalised to spaces for the spaced form, and both are checked.
 */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The same text with all separators removed ("wi fi" -> "wifi"). */
function compact(text) {
  return normalise(text).replace(/ /g, '');
}

/** Split a stored keyword blob into individual keywords. */
function parseKeywords(blob) {
  return String(blob || '')
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Store keywords in a stable, readable form. */
function serialiseKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : parseKeywords(list)) {
    const k = String(raw).trim();
    if (!k) continue;
    const key = normalise(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out.join('\n');
}

/**
 * Does `keyword` occur in the ticket text?
 *
 * Matching is on whole words in the normalised form, so "van" does not match
 * "advance". Multi-word keywords are matched as a phrase. The separator-free
 * form is also checked so "wi-fi" / "wi fi" in the text matches the keyword
 * "wifi" — see compactWindowMatch for why it is not a plain substring test.
 */
function keywordMatches(keyword, haystackNorm, haystackCompact) {
  const needle = normalise(keyword);
  if (!needle) return false;

  // Whole-word / phrase match on the spaced form.
  const bounded = new RegExp(`(^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  if (bounded.test(haystackNorm)) return true;

  // Separator-insensitive match: "wifi" vs "wi fi", "wi-fi".
  const needleCompact = needle.replace(/ /g, '');
  if (needleCompact.length >= 4 && compactWindowMatch(needleCompact, haystackNorm)) return true;

  return false;
}

/**
 * Separator-insensitive equality, bounded by word boundaries.
 *
 * Concatenating the whole separator-stripped text turns this into a substring
 * test, which is wrong: the keyword "physical" would match "physically" and
 * "lan" would match "clandestine". Instead only consecutive words are joined —
 * a window of at most MAX_WORDS words — and the join must equal the keyword
 * exactly. That keeps "wi" + "fi" -> "wifi" working while "physically" stays a
 * different word from "physical".
 */
const MAX_WORDS = 3;
function compactWindowMatch(needleCompact, haystackNorm) {
  const words = haystackNorm.split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && j < i + MAX_WORDS; j++) {
      joined += words[j];
      if (joined === needleCompact) return true;
      if (joined.length >= needleCompact.length) break;
    }
  }
  return false;
}

/**
 * Evaluate one rule against the ticket text.
 *
 * Keyword hits are counted twice: against the whole ticket text and against
 * the subject alone. The subject count drives precedence (a keyword the
 * sender wrote in the subject is the stronger signal — see the header).
 *
 * @returns {{matched:boolean, keywords:string[], subjectKeywords:string[], longest:number}}
 */
function evaluateRule(rule, { category, subjectNorm, subjectCompact, haystackNorm, haystackCompact }) {
  if (rule.category && rule.category !== category) {
    return { matched: false, keywords: [], subjectKeywords: [], longest: 0 };
  }

  const keywords = parseKeywords(rule.keywords);
  if (!keywords.length) {
    // Category-only rule: matches whenever the category matches. A rule with
    // neither category nor keywords is a catch-all and is allowed.
    return { matched: true, keywords: [], subjectKeywords: [], longest: 0 };
  }

  const hits = keywords.filter((k) => keywordMatches(k, haystackNorm, haystackCompact));
  const subjectHits = hits.filter((k) => keywordMatches(k, subjectNorm, subjectCompact));
  const longest = hits.reduce((m, k) => Math.max(m, normalise(k).length), 0);
  return { matched: hits.length > 0, keywords: hits, subjectKeywords: subjectHits, longest };
}

/** Order two matches by the documented precedence. Returns <0 if a wins. */
function compareMatches(a, b, category) {
  // 1. subject evidence beats body-only matches
  const aSubject = a.subjectKeywords.length > 0 ? 1 : 0;
  const bSubject = b.subjectKeywords.length > 0 ? 1 : 0;
  if (aSubject !== bSubject) return bSubject - aSubject;
  // 2. explicit administrator priority
  if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
  // 3. category-specific beats category-agnostic
  const aSpecific = a.rule.category === category ? 1 : 0;
  const bSpecific = b.rule.category === category ? 1 : 0;
  if (aSpecific !== bSpecific) return bSpecific - aSpecific;
  // 4. more matched keywords
  if (a.keywords.length !== b.keywords.length) return b.keywords.length - a.keywords.length;
  // 5. longer matched keyword
  if (a.longest !== b.longest) return b.longest - a.longest;
  // 6. stable tie-break
  return a.rule.id - b.rule.id;
}

/**
 * Find the routing rule that should govern this ticket.
 *
 * `subject` is optional. Callers that already hold the subject pass it
 * explicitly; otherwise the first line of `text` is treated as the subject,
 * which is exactly how the intake pipeline composes it (`subject + "\n" + body`).
 *
 * @param {{category:string, text:string, subject?:string}} ticket
 * @returns {Promise<{rule:object|null, matchedKeywords:string[], considered:number}>}
 */
async function matchRule({ category, text, subject }, client = prisma) {
  const rules = await client.routingRule.findMany({
    where: { isActive: true, team: { isActive: true } },
    include: { team: true, preferredAgent: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });

  const haystackNorm = normalise(text);
  const haystackCompact = compact(text);

  const subjectText = subject !== undefined && subject !== null
    ? String(subject)
    : String(text || '').split('\n', 1)[0];
  const subjectNorm = normalise(subjectText);
  const subjectCompact = compact(subjectText);

  const matches = [];
  for (const rule of rules) {
    const result = evaluateRule(rule, {
      category,
      subjectNorm,
      subjectCompact,
      haystackNorm,
      haystackCompact,
    });
    if (result.matched) {
      matches.push({
        rule,
        keywords: result.keywords,
        subjectKeywords: result.subjectKeywords,
        longest: result.longest,
      });
    }
  }

  if (!matches.length) return { rule: null, matchedKeywords: [], considered: rules.length };

  matches.sort((a, b) => compareMatches(a, b, category));
  const winner = matches[0];
  return {
    rule: winner.rule,
    matchedKeywords: winner.keywords,
    matchedInSubject: winner.subjectKeywords,
    considered: rules.length,
    alternatives: matches.length - 1,
  };
}

/** The configured fallback group (General IT Support). */
async function defaultGroup(client = prisma) {
  const flagged = await client.team.findFirst({ where: { isDefault: true, isActive: true } });
  if (flagged) return flagged;
  // Fall back to the historical default key so an un-migrated database still
  // routes somewhere sensible.
  return client.team.findFirst({ where: { key: 'service_desk' } });
}

/* ---- audit ---------------------------------------------------------- */

async function recordRuleAudit({ rule, action, changes, actor }, client = prisma) {
  return client.routingRuleAuditLog.create({
    data: {
      ruleId: rule && rule.id ? rule.id : null,
      ruleName: (rule && rule.name) || '(unknown)',
      action,
      changes: changes ? JSON.stringify(changes) : null,
      actor: typeof actor === 'string' ? actor : actor ? `${actor.name} <${actor.email}>` : 'system',
    },
  });
}

module.exports = {
  SKILL_LEVELS,
  SKILL_NAMES,
  skillName,
  skillValue,
  normalise,
  compact,
  parseKeywords,
  serialiseKeywords,
  keywordMatches,
  evaluateRule,
  compareMatches,
  matchRule,
  defaultGroup,
  recordRuleAudit,
};
