// Email parsing-rule matching — the pure, provider-independent half of the
// admin-configurable keyword rules.
//
// A rule says: when one of these literal phrases appears in the subject
// (and/or the body), optionally set the ticket's category, priority and/or
// assignment group. The engine evaluates rules in the order the caller
// supplies them (the service orders by precedence, then id, so results are
// deterministic) and reports exactly which rule matched, which keyword hit and
// where — as structured metadata, never as free text.
//
// Matching guarantees:
//   - case-insensitive
//   - whitespace-tolerant (any run of whitespace in the text or the phrase
//     counts as one separator)
//   - word-bounded: "vpn" matches "the VPN drops", not "svpngate"
//   - literal only: keywords are plain phrases. There is deliberately NO
//     regular-expression support — an admin cannot write "a.*b" and make the
//     engine execute it; it would only ever match that literal text.
//   - every input degrades safely: null/undefined/huge/odd content simply
//     never matches, and cannot throw.
//
// Field resolution is per-field first-wins in rule order: the first rule
// (lowest precedence) that sets category wins category; the same for priority
// and group. A rule that sets nothing contributes nothing.

/** Lowercase, collapse all whitespace runs to single spaces, trim. */
function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Unicode-aware letter/number test — the word boundary for phrase matching.
// (A developer-authored character class, not a user-supplied pattern.)
function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * True when `phrase` occurs in `haystack` on word boundaries. Both are
 * already normalized. Non-word phrases (e.g. "c++") match on the same
 * boundary rule: the neighbouring character must not be a letter/number.
 */
function containsPhrase(haystack, phrase) {
  if (!haystack || !phrase) return false;
  const start = haystack.indexOf(phrase);
  if (start === -1) return false;
  const end = start + phrase.length - 1;
  return !isWordChar(haystack[start - 1]) && !isWordChar(haystack[end + 1]);
}

/** Parse the stored JSON keyword array defensively. */
function parseKeywords(keywords) {
  try {
    const parsed = JSON.parse(keywords);
    return Array.isArray(parsed) ? parsed.map((k) => String(k)) : [];
  } catch {
    return [];
  }
}

/**
 * Evaluate one rule against the message. Returns the match descriptor or
 * null when nothing hit.
 */
function matchRule(rule, { subject, body }) {
  const keywords = parseKeywords(rule.keywords);
  if (!keywords.length) return null;

  const normalizedSubject = normalizeText(subject);
  const normalizedBody = normalizeText(body);
  const scope = rule.scope === 'subject' || rule.scope === 'body' ? rule.scope : 'both';

  const matched = [];
  for (const keyword of keywords) {
    const phrase = normalizeText(keyword);
    if (!phrase) continue;
    const hit =
      (scope !== 'body' && containsPhrase(normalizedSubject, phrase)) ||
      (scope !== 'subject' && containsPhrase(normalizedBody, phrase));
    if (hit && !matched.includes(keyword)) matched.push(keyword);
  }

  if (!matched.length) return null;
  return { id: rule.id, name: rule.name, scope, matched };
}

/**
 * Evaluate every enabled rule (already ordered by precedence, then id).
 *
 * @returns {{
 *   matches: { id: number, name: string, scope: string, matched: string[] }[],
 *   effective: { category: string|null, priority: string|null, teamKey: string|null },
 *   effectiveBy: { category: number|null, priority: number|null, teamKey: number|null },
 * }}
 */
function evaluateRules({ subject, body, rules }) {
  const list = Array.isArray(rules) ? rules : [];
  const matches = [];
  const effective = { category: null, priority: null, teamKey: null };
  const effectiveBy = { category: null, priority: null, teamKey: null };

  for (const rule of list) {
    if (!rule || rule.enabled === false) continue;
    const match = matchRule(rule, { subject, body });
    if (!match) continue;
    matches.push(match);
    for (const field of ['category', 'priority', 'teamKey']) {
      // Per-field first-wins in rule order; a later rule never overrides an
      // earlier one, and an unset field falls through to the normal pipeline.
      if (effective[field] === null && rule[field] != null && rule[field] !== '') {
        effective[field] = rule[field];
        effectiveBy[field] = rule.id;
      }
    }
  }

  return { matches, effective, effectiveBy };
}

module.exports = { normalizeText, containsPhrase, matchRule, evaluateRules, parseKeywords };
