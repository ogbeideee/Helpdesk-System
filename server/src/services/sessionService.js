const crypto = require('crypto');
const prisma = require('../lib/prisma');
const COOKIE = 'td_session';
const options = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api', maxAge: 12 * 60 * 60 * 1000 });
function cookieToken(req) {
  const value = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  try { return value ? decodeURIComponent(value.slice(COOKIE.length + 1)) : null; } catch { return null; }
}
function extractToken(req) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' && token ? token : cookieToken(req);
}
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
async function isRevoked(token) { return Boolean(await prisma.revokedSession.findUnique({ where: { tokenHash: digest(token) } })); }
async function revoke(token, expiresAt) {
  await prisma.revokedSession.upsert({ where: { tokenHash: digest(token) }, create: { tokenHash: digest(token), expiresAt }, update: {} });
  await prisma.revokedSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
function setCookie(res, token, expiresAt) {
  res.cookie(COOKIE, token, { ...options(), ...(expiresAt ? { maxAge: Math.max(0, expiresAt.getTime() - Date.now()) } : {}) });
}
function clearCookie(res) { const { maxAge, ...rest } = options(); res.clearCookie(COOKIE, rest); }
// SameSite is the first barrier. Origin/Fetch Metadata also reject foreign
// browser mutations, including sibling-site origins. Bearer clients do not
// depend on ambient authority and retain their existing API contract.
function sameOriginMutation(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^Bearer \S+$/.test(req.headers.authorization || '') || !cookieToken(req)) return true;
  const origin = req.get('origin');
  if (origin) return origin === `${req.protocol}://${req.get('host')}`;
  return req.get('sec-fetch-site') === 'same-origin';
}
module.exports = { cookieToken, extractToken, isRevoked, revoke, setCookie, clearCookie, sameOriginMutation };
