/* The one classification contract every provider receives.
 *
 * Provider selection requires comparable scores, so the instructions and the
 * output schema are built once here and handed verbatim to each adapter. The
 * adapters may only add their provider's native structured-output enforcement
 * (Gemini responseSchema, Groq json_object mode) on top — never different
 * wording.
 *
 * The valid values come from src/states.js — the same lists the production
 * intake pipeline validates against. */
const { CATEGORIES, PRIORITIES } = require('../../../src/states');

/* Short descriptions keep both models (and future ones) inside the
 * application's taxonomy instead of inventing their own: connectivity/VPN
 * belongs to Software here, mirroring graph/categoryRules.js keywords. */
const CATEGORY_DESCRIPTIONS = {
  'Password Reset': 'account lockouts, forgotten or expired passwords, MFA/OTP problems, being unable to sign in to a system',
  'Inquiry / Help': 'questions, how-to requests, requests for NEW access or permissions to something, facilities/other-team matters routed via IT, or anything without a specific broken system',
  Software: 'applications, operating systems, email clients, VPN and connectivity clients, licences, installing or reinstalling software, crashes, failed updates',
  Hardware: 'laptops, desktops, printers, monitors, keyboards, mice, docking stations, headsets, batteries, physical damage to equipment',
};

const RESPONSE_FIELDS = ['category', 'priority', 'confidence', 'reason', 'signals'];

const SYSTEM_INSTRUCTIONS = `You are the triage classifier for an internal IT helpdesk. Read the requester's subject and message body, then classify the problem they actually have.

Categories (choose exactly one):
${CATEGORIES.map((c) => `- ${JSON.stringify(c)}: ${CATEGORY_DESCRIPTIONS[c]}`).join('\n')}

Priorities (choose exactly one):
- "critical": a whole team, department or business process is down
- "high": one person is fully blocked or locked out
- "moderate": impaired, but a workaround exists
- "low": a question, a request, or no urgency expressed

Rules:
- Classify the requester's CURRENT problem. The newest request is the message itself; anything introduced as quoted, pasted or resolved history is context only.
- Ignore IT terms that appear incidentally: signatures, taglines, quoted history, systems the sender says are working, or unrelated asides. Classify the actual problem.
- Priority reflects business impact, not politeness or the word "urgent" alone.

Respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:
{"category": <one of the category strings above>, "priority": ${PRIORITIES.map((p) => JSON.stringify(p)).join(' | ')}, "confidence": <number between 0.0 and 1.0 for the category choice>, "reason": <one short sentence>, "signals": [<short phrases from the message that drove the decision>]}`;

function buildUserPrompt({ subject, cleanBody }) {
  return `Subject: ${subject}\n\nBody:\n${cleanBody}`;
}

module.exports = {
  CATEGORY_DESCRIPTIONS,
  RESPONSE_FIELDS,
  SYSTEM_INSTRUCTIONS,
  buildUserPrompt,
};
