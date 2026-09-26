// Self-service account settings: display name and password.
//
// Every authenticated user may change their OWN profile here — nothing in
// this router touches another account. The admin-governed fields (role,
// activation, assignment group, skill) stay in routes/agents.js behind
// userService.checkUserUpdate; this router deliberately has no path to them.
//
// Both writes go through userService.applyUserUpdate so the audit trail is
// identical in shape to an administrator making the change — the trail
// records THAT the credential changed, never the credential itself.
const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, sanitizeAgent } = require('../src/authMiddleware');
const userService = require('../src/services/userService');
const { rateLimit } = require('../src/rateLimit');

const router = express.Router();
router.use(requireAuth);

// Throttle current-password guessing: the endpoint verifies the existing
// password, so without a limit it is a second online-guessing surface that
// bypasses the login throttle. Keyed by account, not IP — a hijacked session
// may come from anywhere.
const passwordLimiter = rateLimit({
  windowMs: Number(process.env.PASSWORD_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000,
  max: Number(process.env.PASSWORD_RATE_LIMIT_MAX) || 10,
  keyFn: (req) => (req.agent ? `agent:${req.agent.id}` : ''),
  message: 'Too many password attempts — wait a few minutes and try again',
});

const NAME_MAX = 80;
const PASSWORD_MIN = 8; // same policy as routes/agents.js

// PATCH /api/profile — change your own display name.
router.patch('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Display name is required' });
    if (name.length > NAME_MAX) {
      return res.status(400).json({ error: `Display name must be at most ${NAME_MAX} characters` });
    }
    if (name === req.agent.name) {
      // No-op: answer success without writing or adding audit noise.
      return res.json(sanitizeAgent(req.agent));
    }
    const { user } = await userService.applyUserUpdate(req.agent, req.agent, { name });
    res.json(sanitizeAgent(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/profile/password — change your own password. The current password
// is required: a hijacked session must not be able to lock the owner out.
router.post('/password', passwordLimiter, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters` });
    }
    if (!req.agent.passwordHash) {
      return res.status(409).json({
        error: 'This account has no password set — ask an administrator to set one',
      });
    }
    if (!bcrypt.compareSync(currentPassword, req.agent.passwordHash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    if (bcrypt.compareSync(newPassword, req.agent.passwordHash)) {
      return res.status(400).json({ error: 'New password must differ from the current password' });
    }
    // applyUserUpdate also stamps Agent.passwordChangedAt, and requireAuth
    // rejects any token issued before that instant — so every session other
    // than the one being established next is invalidated immediately.
    await userService.applyUserUpdate(req.agent, req.agent, {
      passwordHash: bcrypt.hashSync(newPassword, 10),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
