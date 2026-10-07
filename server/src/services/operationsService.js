const prisma = require('../lib/prisma');
const settings = require('./settingsService');
const addressed = require('./addressedRecipient');
const audit = require('./auditService');
const delivery = require('./emailDeliveryService');
const KEYS = new Set(['intakeAddressedRouting', 'intakeAddressedAliases', 'intakeInternalCopies', 'intakeMailboxAddresses']);
async function management(client = prisma) {
  const all = await settings.getAll(client, 'intake');
  const decisions = await client.auditEvent.findMany({ where: { entityType: 'EmailIntake' }, orderBy: { id: 'desc' }, take: 100 });
  return { settings: Object.fromEntries([...KEYS].map(key => [key, all[key]])),
    deliveries: await delivery.list(client), decisions: decisions.map(audit.serialize) };
}
async function update(changes, actor, client = prisma) {
  if (!changes || Object.keys(changes).some(key => !KEYS.has(key))) return { ok: false, errors: ['Unsupported intake setting'] };
  if (changes.intakeAddressedAliases !== undefined) {
    const aliases = addressed.parseAliases(changes.intakeAddressedAliases);
    const agents = await client.agent.findMany({ select: { id: true, name: true, email: true } });
    const parts = String(changes.intakeAddressedAliases).split(/[,;\n]+/).filter(p => p.trim());
    if (parts.length !== aliases.length || aliases.some(alias => {
      const match = addressed.resolveAddressee({ addressee: alias.nickname }, agents, { aliases });
      return match.tier !== 'alias';
    })) return { ok: false, errors: ['Every nickname must appear once and identify exactly one saved account'] };
  }
  return settings.update(changes, actor, client);
}
async function preview(greeting, client = prisma) {
  const all = await settings.getAll(client, 'intake');
  const agents = await client.agent.findMany({ select: { id: true, name: true, email: true, role: true, isActive: true, isAvailable: true } });
  return { enabled: String(all.intakeAddressedRouting) !== '0',
    match: addressed.resolveAddressee(addressed.extractAddressee(greeting), agents, { aliases: all.intakeAddressedAliases }) };
}
async function retry(id, actor, client = prisma) {
  return client.$transaction(async tx => {
    const result = await delivery.requestRetry(id, tx);
    if (result.count) await audit.record(tx, { action: 'email.retry_requested', entityType: 'Notification', entityId: id, actor,
      description: 'Administrator requested another email delivery attempt' });
    return result.count === 1;
  });
}
module.exports = { management, update, preview, retry };
