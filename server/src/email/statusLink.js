// Requester self-service status links.
//
// The acknowledgement and status-update emails sent to a requester carry a
// "check progress" link. It must work WITHOUT a portal account — requesters
// are employees whose account may be the very thing that is broken — so the
// link authenticates itself: an HMAC over `ticketId:requesterEmail`, signed
// with a server secret. Possession of the link is proof of access to the
// requester's mailbox, the same trust level as "reply to this email".
//
// The token is stateless (nothing to store, expire or revoke) and reveals
// nothing by itself: the public endpoint only answers for a valid signature,
// and only with the ticket's public face (number, subject, state, dates) —
// never bodies, comments or agent details.
const crypto = require('crypto');

// Distinct secret from the session JWT when provided, so a link token can
// never be confused with a login token even if the signing inputs collided.
// The dev fallback matches authMiddleware's: safe only outside production.
const NODE_ENV = process.env.NODE_ENV || 'development';
const SECRET =
  process.env.STATUS_LINK_SECRET || process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

if (NODE_ENV === 'production' && !process.env.STATUS_LINK_SECRET && !process.env.JWT_SECRET) {
  throw new Error(
    '[status-link] Refusing to run in production without STATUS_LINK_SECRET or JWT_SECRET.'
  );
}

const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || '').replace(/\/+$/, '');

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** Stateless, URL-safe token binding this ticket id to this requester email. */
function makeToken(ticketId, requesterEmail) {
  const payload = `${ticketId}.${String(requesterEmail || '').trim().toLowerCase()}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** Returns { ticketId, email } for a valid token, else null. */
function verifyToken(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const sep = payload.indexOf('.');
  if (sep <= 0) return null;
  const ticketId = Number(payload.slice(0, sep));
  const email = payload.slice(sep + 1);
  if (!Number.isInteger(ticketId) || !email) return null;
  return { ticketId, email };
}

/**
 * Absolute portal URL for the requester status page, or null when unknown.
 *
 * The status page is read-only history; nothing emits a link to it any more
 * (see confirmUrl for the one link the system does send).
 */
function statusUrl(ticket) {
  if (!PORTAL_BASE_URL || !ticket.requesterEmail) return null;
  return `${PORTAL_BASE_URL}/#/status/${makeToken(ticket.id, ticket.requesterEmail)}`;
}

/**
 * Absolute portal URL for the resolution-confirmation page, or null when
 * unknown. Carried by exactly ONE email — the resolve notification — and is
 * the deliberate exception to the no-links rule: closing a ticket is the one
 * action a requester cannot safely express by replying ("yes" is ambiguous),
 * while the two-step page (GET shows the ticket, a button POSTs) keeps mail
 * scanners that prefetch links from closing anything. Same signed token as
 * the status page: possession of the link is proof of mailbox access.
 */
function confirmUrl(ticket) {
  if (!PORTAL_BASE_URL || !ticket.requesterEmail) return null;
  return `${PORTAL_BASE_URL}/#/confirm/${makeToken(ticket.id, ticket.requesterEmail)}`;
}

module.exports = { makeToken, verifyToken, statusUrl, confirmUrl };
