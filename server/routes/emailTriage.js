// Administrator management surface for email relevance triage.
//
// The Groq key is never accepted or returned here. It is an environment
// secret; this endpoint only exposes whether one is configured and manages the
// database-backed policy/mode and the sanitized decision metrics.

const express = require('express');
const prisma = require('../src/lib/prisma');
const { requireAdmin } = require('../src/authMiddleware');
const settingsService = require('../src/services/settingsService');
const triageService = require('../src/services/emailTriageService');

const router = express.Router();
router.use(requireAdmin);

const TRIAGE_SETTING_KEYS = new Set([
  'intakeRelevanceMode',
  'intakeRelevanceSkipThreshold',
  'intakeRelevanceRequireApprovedSender',
  'intakeRelevanceApprovedSenders',
  'intakeRelevanceSkipReasonCodes',
]);

function onlyTriageSettings(body) {
  const changes = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (TRIAGE_SETTING_KEYS.has(key)) changes[key] = value;
  }
  return changes;
}

async function managementPayload() {
  return triageService.getManagementSnapshot(prisma);
}

// GET /api/email-triage/management — policy, provider readiness, metrics and
// recent sanitized decisions. No subject/body/evidence is returned.
router.get('/management', async (req, res) => {
  try {
    res.json(await managementPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/email-triage/settings — change mode, threshold, approved senders
// or the allowlisted reason codes. The shared settings service validates and
// audits the write.
router.patch('/settings', async (req, res) => {
  try {
    const changes = onlyTriageSettings(req.body);
    if (!Object.keys(changes).length) {
      return res.status(400).json({ error: 'No recognised email triage setting supplied' });
    }
    const result = await settingsService.update(changes, req.agent, prisma);
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json(await managementPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-triage/kill-switch — runtime emergency stop. This changes
// the database mode to disabled immediately. The environment-level
// INTAKE_TRIAGE_KILL_SWITCH remains an independent, non-UI-overridable stop.
router.post('/kill-switch', async (req, res) => {
  try {
    const result = await settingsService.update(
      { intakeRelevanceMode: 'disabled' },
      req.agent,
      prisma,
    );
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json(await managementPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-triage/test — send only a fixed synthetic message to Groq.
// It never reads or stores a real email and does not change intake behavior.
router.post('/test', async (req, res) => {
  try {
    const result = await triageService.testProvider();
    // A provider check is a diagnostic result, not an API failure. Returning
    // 200 lets the admin UI display the precise sanitized error code.
    res.status(200).json(result);
  } catch {
    res.status(503).json({ ok: false, errorCode: 'provider_error' });
  }
});

module.exports = router;
