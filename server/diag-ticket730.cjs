'use strict';
// Read-only diagnosis of migrated ticket #730 (id 730). Never writes.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// --- SQLite source (read-only) ---
const { DatabaseSync } = require('node:sqlite');
const src = new DatabaseSync(path.join(__dirname, 'prisma', 'dev.db'), { readOnly: true });
const cols = src.prepare('PRAGMA table_info("Ticket")').all();
console.log('=== SQLite source: Ticket columns (name, type, notnull) ===');
cols.forEach(c => console.log(`  ${c.name}  ${c.type}  notnull=${c.notnull}`));

console.log('\n=== SQLite source: Ticket id=730 ===');
const row = src.prepare('SELECT * FROM "Ticket" WHERE id = 730').get();
console.log(JSON.stringify(row, null, 2));

console.log('\n=== SQLite source: all Ticket rows (id, ticketNumber, shortDescription) ===');
for (const r of src.prepare('SELECT id, ticketNumber, shortDescription FROM "Ticket"').all()) {
  console.log(`  id=${r.id} ticketNumber=${JSON.stringify(r.ticketNumber)} shortDescription=${JSON.stringify(r.shortDescription)}`);
}

console.log('\n=== SQLite source: TicketAuditLog for ticket 730 ===');
for (const r of src.prepare('SELECT * FROM "TicketAuditLog" WHERE ticketId = 730').all()) {
  console.log(JSON.stringify(r));
}
console.log('\n=== SQLite source: Comment for ticket 730 ===');
for (const r of src.prepare('SELECT * FROM "Comment" WHERE ticketId = 730').all()) {
  console.log(JSON.stringify(r));
}
console.log('\n=== SQLite source: AuditEvent for ticket 730 ===');
for (const r of src.prepare('SELECT * FROM "AuditEvent" WHERE ticketId = 730').all()) {
  console.log(JSON.stringify(r));
}
src.close();

// --- PostgreSQL target (read-only) ---
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  console.log('\n=== PostgreSQL: Ticket id=730 ===');
  const t = await prisma.ticket.findUnique({ where: { id: 730 } });
  console.log(JSON.stringify(t, null, 2));

  console.log('\n=== PostgreSQL: TicketAuditLog for ticket 730 ===');
  for (const r of await prisma.ticketAuditLog.findMany({ where: { ticketId: 730 }, orderBy: { id: 'asc' } })) console.log(JSON.stringify(r));

  console.log('\n=== PostgreSQL: Comment for ticket 730 ===');
  for (const r of await prisma.comment.findMany({ where: { ticketId: 730 }, orderBy: { id: 'asc' } })) console.log(JSON.stringify(r));

  console.log('\n=== PostgreSQL: AuditEvent for ticket 730 ===');
  for (const r of await prisma.auditEvent.findMany({ where: { ticketId: 730 }, orderBy: { id: 'asc' } })) console.log(JSON.stringify(r));
})().catch(e => { console.error('PG READ ERROR:', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());