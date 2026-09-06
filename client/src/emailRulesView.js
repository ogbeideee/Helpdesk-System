// Email parsing rules — pure display model for the admin screen. No fetching,
// no React: every function is deterministic and checked by email-rules-check.

// The priorities the API accepts (mirrors server/src/states.js PRIORITIES).
export const PRIORITIES = ['low', 'moderate', 'high', 'critical'];

export const SCOPES = [
  { value: 'both', label: 'Subject + body' },
  { value: 'subject', label: 'Subject only' },
  { value: 'body', label: 'Body only' },
];

export const EMPTY_FORM = {
  name: '',
  keywordsText: '',
  scope: 'both',
  category: '',
  priority: '',
  teamKey: '',
  precedence: '100',
  enabled: true,
};

/** Rule row -> { keywordsText } so the form can edit the stored JSON array. */
export function ruleToForm(rule) {
  return {
    name: rule?.name || '',
    keywordsText: (rule?.keywords || []).join('\n'),
    scope: rule?.scope || 'both',
    category: rule?.category || '',
    priority: rule?.priority || '',
    teamKey: rule?.teamKey || '',
    precedence: String(rule?.precedence ?? 100),
    enabled: rule?.enabled !== false,
  };
}

/**
 * Split the keywords textarea into a clean phrase list. One phrase per line,
 * or comma/semicolon separated; duplicates collapse case-insensitively and
 * each phrase is trimmed. Never throws on odd input.
 */
export function parseKeywordsText(text, { max = 25 } = {}) {
  const out = [];
  const seen = new Set();
  for (const item of String(text ?? '').split(/[\n,;]+/)) {
    const keyword = item.trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Validate the form. Returns { errors: string[], payload: object } — payload
 * only carries the fields the server accepts, and only when there are no
 * errors.
 */
export function validateForm(form, { groups = [] } = {}) {
  const errors = [];
  const name = String(form.name || '').trim();
  if (!name) errors.push('Name is required.');

  const keywords = parseKeywordsText(form.keywordsText);
  if (!keywords.length) errors.push('At least one keyword or phrase is required.');

  const scope = SCOPES.some((s) => s.value === form.scope) ? form.scope : 'both';

  const precedence = Number(String(form.precedence ?? '').trim() || '100');
  if (!Number.isInteger(precedence) || precedence < 0 || precedence > 10000) {
    errors.push('Precedence must be a whole number between 0 and 10000.');
  }

  if (form.priority && !PRIORITIES.includes(form.priority)) {
    errors.push('Priority is not a valid priority.');
  }

  let teamKey = String(form.teamKey || '').trim();
  if (teamKey && groups.length && !groups.some((g) => g.key === teamKey)) {
    errors.push('Assignment group is not a known group.');
  }

  return {
    errors,
    payload: errors.length
      ? null
      : {
          name,
          keywords,
          scope,
          category: String(form.category || '').trim() || null,
          priority: form.priority || null,
          teamKey: teamKey || null,
          precedence,
          enabled: form.enabled !== false,
        },
  };
}

/** Rules -> table rows, ordered the way the API evaluates them. */
export function ruleRows(rules) {
  const list = Array.isArray(rules) ? [...rules] : [];
  list.sort((a, b) => (a.precedence - b.precedence) || (a.id - b.id));
  return list.map((rule) => ({
    id: rule.id,
    name: rule.name,
    keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
    scope: rule.scope,
    scopeLabel: (SCOPES.find((s) => s.value === rule.scope) || SCOPES[0]).label,
    sets: [
      rule.category ? `category → ${rule.category}` : null,
      rule.priority ? `priority → ${rule.priority}` : null,
      rule.teamKey ? `group → ${rule.teamKey}` : null,
    ].filter(Boolean),
    setsLabel: rule.category || rule.priority || rule.teamKey
      ? [
          rule.category ? rule.category : null,
          rule.priority ? rule.priority : null,
          rule.teamKey || null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null,
    precedence: rule.precedence,
    enabled: rule.enabled !== false,
    updatedAt: rule.updatedAt,
  }));
}

/** True when the two rule forms differ in any managed field. */
export function formsDiffer(a, b) {
  return ['name', 'keywordsText', 'scope', 'category', 'priority', 'teamKey', 'precedence', 'enabled']
    .some((key) => String(a?.[key] ?? '') !== String(b?.[key] ?? ''));
}
