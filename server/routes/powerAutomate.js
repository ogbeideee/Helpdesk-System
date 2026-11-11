const express = require('express');
const crypto = require('crypto');
const { readConfig } = require('../src/powerAutomate/config');
const { rateLimit } = require('../src/rateLimit');

function authorized(req, res, next) {
  const expected = readConfig().intakeKey;
  const actual = req.get('x-ticketdesk-key') || '';
  if (expected.length < 32) return res.status(503).json({ error: 'Integration is not configured' });
  const hash = value => crypto.createHash('sha256').update(value).digest();
  if (!crypto.timingSafeEqual(hash(expected), hash(actual))) return res.status(401).json({ error: 'Invalid integration credential' });
  next();
}
function buildRouter(deps = {}) {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 60000, max: 120, keyFn: req => `power-automate:${req.ip}`, message: 'Too many integration requests' }));
  // Authenticate before parsing a potentially large MIME payload.
  router.use(authorized);
  router.use(express.json({ limit: '36mb' }));
  router.post('/email', async (req, res, next) => {
    try {
      const { email, attachments } = await require('../src/powerAutomate/mime').parseExport(req.body);
      const ingest = deps.ingest || require('../src/services/emailIngestion').ingestNormalizedEmail;
      const result = await ingest(email, { channel: 'power_automate', attachments });
      res.status(result.status === 'created' ? 201 : 200).json({
        status: result.status,
        duplicate: result.status === 'duplicate',
        ticket: result.ticket ? { id: result.ticket.id, ticketNumber: result.ticket.ticketNumber } : null,
      });
    } catch (err) {
      const { EmailParseError } = require('../src/email/emailParser');
      const { IntakeValidationError } = require('../src/services/emailIngestion');
      if (err instanceof EmailParseError || err instanceof IntakeValidationError) {
        return res.status(400).json({ error: 'Email is missing required message fields' });
      }
      next(err);
    }
  });
  return router;
}
module.exports = { buildRouter };
