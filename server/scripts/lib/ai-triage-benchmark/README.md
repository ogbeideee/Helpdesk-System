# Email relevance benchmark

This benchmark is separate from the existing category/priority classifier
benchmark. It measures the narrow decision:

```text
ticket | skip | review
```

## Offline smoke set

From `server/`:

```bash
npm run bench:ai:triage -- --mock
```

The built-in cases are synthetic and only verify the CLI/prompt plumbing.

## Labeled Groq run

Create a JSON array (or `{ "cases": [...] }`) with one object per message:

```json
{
  "id": "hr-001",
  "subject": "Annual HR policy update",
  "cleanBody": "Redacted sender text...",
  "from": "hr-announcements@example.com",
  "expected": "skip"
}
```

`expected` must be `ticket`, `skip`, or `review`. Use synthetic or redacted
messages for a hosted provider. Run:

```bash
GROQ_API_KEY=... npm run bench:ai:triage -- --file labels.json --json report.json
```

The report contains metrics and per-case dispositions, confidence, reason code,
policy result and latency. It never writes the input body or raw provider
response.

The production launch gate remains administrator-labeled data, not this smoke
set: at least 200 messages, including obvious non-tickets, genuine requests,
adversarial cases and borderline cases. Measure ticket recall and skip precision
against those labels; do not treat model confidence as the score.
