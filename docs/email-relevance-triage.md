# Email relevance triage

## Purpose

The relevance gate is a narrow, fail-open filter for new inbound email. It asks:

> Does this message require helpdesk action?

It does **not** choose a category, priority, assignment group, or agent. Those
remain deterministic application responsibilities.

## Runtime order

```text
normalize → deduplicate → resolve existing-ticket replies
→ deterministic automated-mail screening
→ Groq relevance triage
→ existing category classification
→ existing routing and assignment
→ SLA, audit and notifications
```

A reply that resolves to an existing ticket never reaches the relevance gate.
A provider error, timeout, malformed response, missing key, decision-log
failure, low-confidence result, `review`, or policy veto always creates a
ticket. Transient provider failures get one bounded retry; repeated failures
open a short in-memory circuit and subsequent messages continue through ticket
creation until it closes.

## Safe auto-skip policy

A message is suppressed only when all of the following are true:

1. Mode is `auto_skip`.
2. The environment kill switch is not engaged.
3. Groq returns valid JSON with `disposition: "skip"`.
4. Confidence meets the configured threshold (minimum 95%).
5. The reason code is in the administrator's allowlist.
6. The sender matches the approved-sender list when that requirement is on.
7. No attachment is present. Attachment bytes are never sent to Groq, and any
   attachment currently vetoes auto-skip until a later policy explicitly
   classifies it as safe.
8. The local action-signal guard finds no request, incident, access, password,
   outage, installation, repair, or similar signal.

The model is advisory. The local policy makes the final decision.

## Configuration

Secrets are environment/Fly secrets and must never enter the database, browser,
logs, or source control:

```text
GROQ_API_KEY
GROQ_TRIAGE_MODEL
GROQ_TRIAGE_TIMEOUT_MS
GROQ_TRIAGE_MAX_BODY_CHARS
GROQ_TRIAGE_MAX_OUTPUT_TOKENS
INTAKE_TRIAGE_KILL_SWITCH
```

For the Fly deployment, set the key and the initial stop through Fly secrets,
then deploy and apply the committed migration:

```bash
fly secrets set GROQ_API_KEY=...
fly secrets set INTAKE_TRIAGE_KILL_SWITCH=true
fly deploy
fly ssh console -C "cd /app/server && npx prisma migrate deploy"
```

Do not remove the environment stop until the admin has reviewed the policy and
provider check.

Administrators manage the effective policy from **Profile → Settings** while
signed in as an admin:
- `Disabled` — no model calls
- `Shadow` — record recommendations but always create tickets
- `Auto-skip` — allow only policy-approved skips
- Minimum confidence
- Approved sender list
- Allowed reason codes
- Metrics and recent sanitized decisions
- Provider check
- Immediate **Disable auto-skip now** action

The environment-level `INTAKE_TRIAGE_KILL_SWITCH=true` is independent of the
database setting and cannot be cleared from the UI.

## Data handling

`EmailTriageDecision` stores message identity, channel, provider/model/prompt
version, disposition, final action, confidence, policy/error code, latency and
timestamp. It deliberately stores no email body, subject, attachment, evidence
excerpt, raw model response, or API key.

## Benchmark

The existing category/priority AI benchmark is separate. Run the relevance
smoke set with:

```bash
cd server
npm run bench:ai:triage -- --mock
```

For a real provider run, use a redacted/synthetic administrator-labeled JSON
file:

```bash
GROQ_API_KEY=... npm run bench:ai:triage -- --file labels.json --json report.json
```

The launch decision must be based on labeled ticket recall and skip precision,
not model self-confidence. The synthetic smoke set is only a wiring check.
