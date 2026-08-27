const jwt = require('jsonwebtoken');
const prisma = require('./lib/prisma');

const JWT_SECRET =
  process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const TOKEN_TTL = '12h';

if (!process.env.JWT_SECRET) {
  console.warn(
    '[auth] JWT_SECRET not set — using an insecure development default. Set JWT_SECRET in server/.env before production.'
  );
}

function sanitizeAgent(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    isActive: agent.isActive,
    isAvailable: agent.isAvailable,
    skillLevel: agent.skillLevel,
    teamId: agent.teamId,
    team: agent.team ? { id: agent.team.id, key: agent.team.key, name: agent.team.name } : null,
  };
}

function signToken(agent) {
  return jwt.sign({ sub: agent.id, email: agent.email, role: agent.role }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
  const agent = await prisma.agent.findUnique({
    where: { id: payload.sub },
    include: { team: true },
  });
  if (!agent || !agent.isActive) {
    return res.status(401).json({ error: 'Account is disabled or no longer exists' });
  }
  req.agent = agent;
  next();
}

function requireAgent(req, res, next) {
  requireAuth(req, res, next);
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.agent.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator role required' });
    }
    next();
  });
}

module.exports = { signToken, requireAuth, requireAdmin, sanitizeAgent };
