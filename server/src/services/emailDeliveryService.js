// Durable delivery state uses the existing Notification table. Payloads contain
// requester text and confirmation links, so they are encrypted, never logged or
// returned to the administration API, and deleted after success.
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const MAX_ATTEMPTS = 5;
const DELAYS = [60000, 300000, 1800000, 7200000];
function key() {
  if (!process.env.JWT_SECRET) throw new Error('Delivery encryption unavailable');
  return crypto.createHash('sha256').update(`ticketdesk-delivery:${process.env.JWT_SECRET}`).digest();
}
function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
}
function decrypt(payload) {
  const [iv, tag, bytes] = payload.split('.').map(p => Buffer.from(p, 'base64'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8'));
}
async function enqueue(mail, kind, client = prisma) {
  return client.notification.create({ data: {
    type: 'email_delivery', title: String(mail.subject || 'Outbound email').slice(0, 200), emailKind: kind,
    emailPayload: encrypt(mail), emailStatus: 'pending', emailNextAttemptAt: new Date(),
  } });
}
async function deliver(row, send, client = prisma, now = new Date()) {
  const leaseUntil = new Date(now.getTime() + 10 * 60000);
  const claimed = await client.notification.updateMany({ where: {
    id: row.id, emailStatus: { in: ['pending', 'sending'] },
    OR: [{ emailLeaseUntil: null }, { emailLeaseUntil: { lt: now } }],
    emailAttempts: { lt: MAX_ATTEMPTS },
  }, data: { emailStatus: 'sending', emailLeaseUntil: leaseUntil, emailAttempts: { increment: 1 } } });
  if (!claimed.count) return false;
  const current = await client.notification.findUnique({ where: { id: row.id } });
  try {
    await send(decrypt(current.emailPayload), current.emailKind);
  } catch (error) {
    const terminal = current.emailAttempts >= MAX_ATTEMPTS;
    await client.notification.updateMany({ where: { id: row.id, emailStatus: 'sending', emailLeaseUntil: leaseUntil }, data: {
      emailStatus: terminal ? 'failed' : 'pending', emailLeaseUntil: null,
      emailNextAttemptAt: terminal ? null : new Date(now.getTime() + DELAYS[current.emailAttempts - 1]),
      // Provider error text can contain recipients, tokens or request content.
      emailError: 'Email transport failed',
    } });
    return false;
  }
  // Never treat a persistence failure AFTER sending as a transport failure.
  // The lease remains for recovery; providers offer no exactly-once guarantee.
  await client.notification.updateMany({ where: { id: row.id, emailStatus: 'sending', emailLeaseUntil: leaseUntil }, data: {
    emailStatus: 'delivered', emailLeaseUntil: null, emailNextAttemptAt: null,
    emailDeliveredAt: new Date(), emailError: null, emailPayload: null,
  } });
  return true;
}
async function retryDue(send, client = prisma, now = new Date()) {
  await client.notification.updateMany({ where: { type: 'email_delivery', emailStatus: 'failed', createdAt: { lt: new Date(now.getTime() - 7 * 86400000) } }, data: {
    emailStatus: 'expired', emailPayload: null, emailError: 'Retry content expired after seven days',
  } });
  await client.notification.deleteMany({ where: { type: 'email_delivery', emailStatus: { in: ['delivered', 'expired'] }, createdAt: { lt: new Date(now.getTime() - 30 * 86400000) } } });
  const rows = await client.notification.findMany({ where: {
    OR: [{ emailStatus: 'pending', emailNextAttemptAt: { lte: now } },
      { emailStatus: 'sending', emailLeaseUntil: { lt: now } }],
    emailAttempts: { lt: MAX_ATTEMPTS },
  }, orderBy: { id: 'asc' }, take: 25 });
  for (const row of rows) await deliver(row, send, client, now);
  // Expired final attempts need an explicit failed status, rather than a stuck
  // sending row. Delivery may have succeeded before the process was interrupted.
  await client.notification.updateMany({ where: { emailStatus: 'sending', emailLeaseUntil: { lt: now }, emailAttempts: { gte: MAX_ATTEMPTS } }, data: {
    emailStatus: 'failed', emailLeaseUntil: null, emailError: 'Delivery outcome unknown after interruption',
  } });
}
async function list(client = prisma) {
  return client.notification.findMany({ where: { type: 'email_delivery' }, orderBy: { id: 'desc' }, take: 100,
    select: { id: true, title: true, emailKind: true, emailStatus: true, emailAttempts: true, emailNextAttemptAt: true, emailDeliveredAt: true, emailError: true, createdAt: true } });
}
async function requestRetry(id, client = prisma) {
  return client.notification.updateMany({ where: { id, type: 'email_delivery', emailStatus: 'failed', emailPayload: { not: null } }, data: {
    emailStatus: 'pending', emailAttempts: 0, emailError: null, emailNextAttemptAt: new Date(), emailLeaseUntil: null,
  } });
}
module.exports = { enqueue, deliver, retryDue, list, requestRetry, MAX_ATTEMPTS };
