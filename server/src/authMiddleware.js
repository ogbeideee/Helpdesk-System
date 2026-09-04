const jwt = require('jsonwebtoken');
const prisma = require('./lib/prisma');

// JWT signing secret. Production must be started with a real JWT_SECRET set in
// the environment; we fail safely (refuse to start) rather than silently run on
// the known, publicly-documented development fallback. The fallback exists only
// for the local/test workflow and is never an acceptable production secret.
const NODE_ENV = process.env.NODE_ENV || 'development';
const DEV_JWT_FALLBACK = 'dev-insecure-secret-change-me';

if (!process.env.JWT_SECRET) {
  if (NODE_ENV === 'production') {
    throw new Error(
      '[auth] Refusing to start in production without JWT_SECRET. ' +
        'Set a strong random secret in server/.env, e.g. ' +
        "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
  }
  console.warn(
    `[auth] JWT_SECRET not set (NODE_ENV=${NODE_ENV}) — using the DEVELOPMENT-only fallback. ` +
      'Set JWT_SECRET in server/.env before any production deployment.'
  );
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_FALLBACK;
const TOKEN_TTL = '12h';

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
