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
  EmailParseError,
} = require('../src/email/emailParser');
const {
  ingestNormalizedEmail,
  IntakeValidationError,
} = require('../src/services/emailIngestion');

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

/**
 * POST /api/dev/email/ingest
 *
 * Same request body as /email/parse, but the parsed email continues into the
 * existing ticket pipeline:
 *
 *   parse -> dedupe by messageId -> new ticket or reply activity
 *   -> classification -> assignment group -> agent -> audit log
 *
 * No ticket logic lives here: this handler validates, delegates, and shapes
 * the response. Everything else is intakeEmailMessage() and the assignment
 * engine, unchanged.
 */
router.post('/email/ingest', async (req, res) => {
  // 1) Parse + validate the raw email.
  let email;
  try {
    email = parseEmail(req.body);
  } catch (err) {
    if (err instanceof EmailParseError) {
      return res.status(400).json({ error: 'Could not parse email', errors: err.errors });
    }
    throw err;
  }

  // 2) Hand the normalized email to the existing pipeline.
  let outcome;
  try {
    outcome = await ingestNormalizedEmail(email, { logger: console });
  } catch (err) {
    if (err instanceof IntakeValidationError) {
      // Parsed fine, but cannot become a ticket (e.g. no subject).
      return res.status(422).json({
        error: 'Email could not be turned into a ticket',
        errors: err.errors,
        parsed: email,
      });
    }
    console.error(`[dev-ingest] ingestion failed for ${email.messageId}: ${err.message}`);
    return res.status(500).json({ error: 'Ingestion failed', message: err.message });
  }

  const { status, ticket, comment, assignment, attachments } = outcome;

  // 3) Describe what happened, without re-deriving any of it.
  const httpStatus = status === 'created' ? 201 : 200;

  res.status(httpStatus).json({
    status,
    // "created" -> brand new ticket; "comment_added"/"reopened" -> activity on
    // an existing ticket; "duplicate" -> this messageId was already processed.
    duplicate: status === 'duplicate',
    parsed: email,
    ticket: ticket
      ? {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          shortDescription: ticket.shortDescription,
          category: ticket.category,
          priority: ticket.priority,
          state: ticket.state,
          requesterEmail: ticket.requesterEmail,
          requesterName: ticket.requesterName,
          graphMessageId: ticket.graphMessageId,
          graphConversationId: ticket.graphConversationId,
          teamId: ticket.teamId,
          team: ticket.team ? { id: ticket.team.id, key: ticket.team.key, name: ticket.team.name } : null,
          assignedAgentId: ticket.assignedAgentId,
          assignedAgent: ticket.assignedAgent
            ? {
                id: ticket.assignedAgent.id,
                name: ticket.assignedAgent.name,
                email: ticket.assignedAgent.email,
                skillLevel: ticket.assignedAgent.skillLevel,
              }
            : null,
          dueAt: ticket.dueAt,
          createdAt: ticket.createdAt,
        }
      : null,
    activity: comment
      ? {
          id: comment.id,
          ticketId: comment.ticketId,
          authorName: comment.authorName,
          authorEmail: comment.authorEmail,
          isRequester: comment.isRequester,
          viaEmail: comment.viaEmail,
          graphMessageId: comment.graphMessageId,
          body: comment.body,
          createdAt: comment.createdAt,
        }
      : null,
    assignment: assignment
      ? {
          group: assignment.groupName,
          groupKey: assignment.groupKey,
          minSkillLevel: assignment.minSkillLevel,
          assignedAgentId: assignment.agent ? assignment.agent.id : null,
          awaitingAssignment: assignment.awaitingAssignment,
          reason: assignment.reason,
        }
      : null,
    // Carried through from the parser; nothing is stored yet.
    attachments,
  });
});

module.exports = router;
module.exports.parseEmail = parseEmail;
