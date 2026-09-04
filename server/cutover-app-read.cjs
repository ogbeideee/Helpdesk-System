// App-level read verification against PostgreSQL, using the SAME Prisma client
// the running Express app uses (src/lib/prisma reads DATABASE_URL from .env).
// Read-only: never creates/updates/deletes application records.
const prisma = require('./src/lib/prisma');

(async () => {
  console.log('connected via:', (await prisma.$queryRawUnsafe('SELECT current_database() AS db, inet_server_addr() AS addr')).map(r => `${r.db}`).join(''));

  const teams = await prisma.team.findMany({ orderBy: { key: 'asc' }, select: { key: true, name: true } });
  console.log(`\nTEAM rows: ${teams.length}`);
  teams.forEach(t => console.log(`  ${t.key} — ${t.name}`));

  const agents = await prisma.agent.findMany({ select: { email: true, role: true, isActive: true } });
  console.log(`\nAGENT rows: ${agents.length}`);
  agents.forEach(a => console.log(`  ${a.email} [${a.role}] active=${a.isActive}`));

  const tickets = await prisma.ticket.findMany({ orderBy: { id: 'asc' } });
  console.log(`\nTICKET rows: ${tickets.length}`);
  tickets.forEach(t => console.log(`  #${t.id} ${t.ticketNumber || '(no number)'} ${t.shortDescription} [${t.state}] team=${t.teamId ?? 'none'}`));

  const seq = await prisma.ticketSequence.findMany({ orderBy: { year: 'asc' } });
  console.log('\nTICKET SEQUENCE:');
  seq.forEach(s => console.log(`  year=${s.year} last=${s.last}`));
  const global = seq.find(s => s.year === 0);
  if (global) {
    const next = global.last + 1;
    console.log(`  -> next global ticket number (not written): INC-${String(next).padStart(6, '0')}`);
  }
})().catch(e => { console.error('READ ERROR:', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());