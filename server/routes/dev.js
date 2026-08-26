// Development-only routes for exercising the email parsing layer.
//
// Nothing here touches the database. In particular POST /email/parse does NOT
// create a ticket — it runs the parser and returns the normalized email so the
// parsing layer can be developed and tested independently of any email
// provider.
//
// The whole router is disabled when NODE_ENV=production.
const express = require('express');
const {
  parseEmail,
  tryParseEmail,
  extractTicketNumberFromSubject,
  stripReplyPrefixes,
} = require('../src/email/emailParser');

const router = express.Router();

const isProduction = () => process.env.NODE_ENV === 'production';

// Refuse to exist in production, whatever else is mounted.
router.use((req, res, next) => {
  if (isProduction()) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

/**
 * POST /api/dev/email/parse
 *
 * Body: raw email in any shape the parser accepts.
 * Returns: { parsed: NormalizedEmail, subjectInfo: {...} }
 *
 * Creates nothing. Stores nothing. Sends nothing.
 */
router.post('/email/parse', (req, res) => {
  const result = tryParseEmail(req.body);

  if (!result.ok) {
    return res.status(400).json({
      error: 'Could not parse email',
      errors: result.errors,
    });
  }

  const parsed = result.email;

  res.json({
    parsed,
    // Provided for convenience while testing. The parser itself does not
    // decide new-ticket vs reply — that stays in ticket ingestion.
    subjectInfo: {
      original: parsed.subject,
      withoutReplyPrefix: stripReplyPrefixes(parsed.subject),
      ticketNumber: extractTicketNumberFromSubject(parsed.subject),
    },
  });
});

/**
 * POST /api/dev/email/parse-batch
 * Body: { emails: RawEmailInput[] } — parses each independently so one bad
 * message does not hide the rest.
 */
router.post('/email/parse-batch', (req, res) => {
  const list = Array.isArray(req.body && req.body.emails) ? req.body.emails : null;
  if (!list) {
    return res.status(400).json({ error: 'expected { emails: [...] }' });
  }

  const results = list.map((raw, index) => {
    const r = tryParseEmail(raw);
    return r.ok
      ? { index, ok: true, parsed: r.email }
      : { index, ok: false, errors: r.errors };
  });

  res.json({
    total: results.length,
    parsed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

/**
 * GET /api/dev/email/ticket-number?subject=...
 * Quick check of the subject utility.
 */
router.get('/email/ticket-number', (req, res) => {
  const subject = String(req.query.subject || '');
  res.json({
    subject,
    withoutReplyPrefix: stripReplyPrefixes(subject),
    ticketNumber: extractTicketNumberFromSubject(subject),
  });
});

module.exports = router;
module.exports.parseEmail = parseEmail;
