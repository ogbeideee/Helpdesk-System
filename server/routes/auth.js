const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { signToken, requireAuth, sanitizeAgent } = require('../src/authMiddleware');
const { rateLimit } = require('../src/rateLimit');

const router = express.Router();

// Throttle online password guessing. Keyed by IP + target email so one
// attacked account is capped without punishing colleagues behind the same
// NAT. Env-tunable; the defaults let a human mistype all day long.
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20,
  keyFn: (req) => `${req.ip}|${String(req.body && req.body.email || '').trim().toLowerCase()}`,
  message: 'Too many sign-in attempts — wait a few minutes and try again',
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const agent = await prisma.agent.findUnique({ where: { email }, include: { team: true } });
    if (!agent || !agent.passwordHash || !bcrypt.compareSync(password, agent.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!agent.isActive) {
      return res.status(403).json({ error: 'This account has been disabled' });
    }
    res.json({ token: signToken(agent), agent: sanitizeAgent(agent) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(sanitizeAgent(req.agent));
});

module.exports = router;
