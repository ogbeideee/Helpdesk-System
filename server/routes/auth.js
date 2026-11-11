const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const { signToken, requireAuth, sanitizeAgent } = require('../src/authMiddleware');
const { rateLimit } = require('../src/rateLimit');

const router = express.Router();
const sessions = require('../src/services/sessionService');
const ipLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 100,
  keyFn: req => `login-ip:${req.ip}`, message: 'Too many sign-in attempts — wait a few minutes and try again' });

// Throttle online password guessing. Keyed by IP + target email so one
// attacked account is capped without punishing colleagues behind the same
// NAT. Env-tunable; the defaults let a human mistype all day long.
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20,
  keyFn: (req) => `${req.ip}|${String(req.body && req.body.email || '').trim().toLowerCase()}`,
  message: 'Too many sign-in attempts — wait a few minutes and try again',
});

router.post('/login', ipLimiter, loginLimiter, async (req, res) => {
  try {
    if (req.body.session === 'cookie' &&
      ((req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) ||
       ['cross-site', 'same-site'].includes(req.get('sec-fetch-site')))) {
      return res.status(403).json({ error: 'Sign in from the helpdesk page' });
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const agent = await prisma.agent.findUnique({ where: { email }, include: { team: true } });
    if (!agent || !agent.passwordHash || !(await bcrypt.compare(password, agent.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!agent.isActive) {
      return res.status(403).json({ error: 'This account has been disabled' });
    }
    const token = signToken(agent);
    if (req.body.session === 'cookie') {
      sessions.setCookie(res, token);
      res.set('Cache-Control', 'no-store');
      return res.json({ session: 'cookie', agent: sanitizeAgent(agent) });
    }
    res.json({ token, agent: sanitizeAgent(agent) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await sessions.revoke(req.sessionToken, req.sessionExpiresAt);
    sessions.clearCookie(res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Upgrade an existing browser bearer session without a password prompt. The
// token's existing expiry is retained; conversion never extends its lifetime.
router.post('/session', requireAuth, (req, res) => {
  sessions.setCookie(res, req.sessionToken, req.sessionExpiresAt);
  res.set('Cache-Control', 'no-store');
  res.json({ session: 'cookie' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(sanitizeAgent(req.agent));
});

module.exports = router;
