'use strict';
// ==========================================================================
// migrate-sqlite-to-pg.cjs
// One-way, FK-ordered SQLite -> PostgreSQL (Supabase) data copy.
//   SOURCE: server/prisma/dev.db  — opened STRICTLY READ-ONLY (node:sqlite).
//   TARGET: Supabase PostgreSQL via PrismaClient on DIRECT_URL (session
//           pooler + interactive transaction, so the copy is atomic).
//
// Modes (no argument = --dry-run):
//   --dry-run              inspect + validate + target-emptiness + report;
//                          ZERO writes to PostgreSQL.
//   --migrate              guarded real copy (refuses if target is NOT empty).
//   --source <path>        override the SQLite source path.
// ==========================================================================
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SOURCE_DEFAULT = path.join(__dirname, '..', 'prisma', 'dev.db');

const argv = process.argv.slice(2);
const MODE = argv.includes('--migrate') ? 'migrate' : 'dry-run';
const srcIdx = argv.indexOf('--source');
const SOURCE = path.resolve(srcIdx >= 0 ? argv[srcIdx + 1] : SOURCE_DEFAULT);
const REPORT_FILE = path.join(__dirname, '..',
  MODE === 'migrate' ? 'data-migration-verify-report.txt' : 'data-migration-dryrun-report.txt');

if (!fs.existsSync(SOURCE)) { console.error(`FATAL: source database not found: ${SOURCE}`); process.exit(2); }

const DIRECT_URL = process.env.DIRECT_URL;
if (!DIRECT_URL) { console.error('FATAL: DIRECT_URL is not set in .env'); process.exit(2); }

// Redacted copy of the target URL — credentials are NEVER printed/logged.
const URL_REDACTED = DIRECT_URL.replace(/(:\/\/)[^@/]+@/, '$1***@');

// FK-safe insert order (parents before children).
const TABLES = [
  { sql: 'Team', prisma: 'team' },
  { sql: 'Agent', prisma: 'agent' },
  { sql: 'UserAuditLog', prisma: 'userAuditLog' },
  { sql: 'TeamMembership', prisma: 'teamMembership' },
  { sql: 'RoutingRule', prisma: 'routingRule' },
  { sql: 'RoutingRuleAuditLog', prisma: 'routingRuleAuditLog' },
  { sql: 'TicketSequence', prisma: 'ticketSequence' },
  { sql: 'Ticket', prisma: 'ticket' },
  { sql: 'TicketAuditLog', prisma: 'ticketAuditLog' },
  { sql: 'Comment', prisma: 'comment' },
  { sql: 'GraphSubscription', prisma: 'graphSubscription' },
  { sql: 'Notification', prisma: 'notification' },
  { sql: 'HandoverRequest', prisma: 'handoverRequest' },
  { sql: 'AuditEvent', prisma: 'auditEvent' },
  { sql: 'Setting', prisma: 'setting' },
];
const AUTOINCREMENT_TABLES = TABLES.filter((t) => t.sql !== 'Setting' && t.sql !== 'TicketSequence');

const UNIQUE_CHECKS = [
  { sql: 'Team', columns: ['key'] },
  { sql: 'Agent', columns: ['email'] },
  { sql: 'Agent', columns: ['externalId'] },
  { sql: 'Ticket', columns: ['ticketNumber'] },
  { sql: 'Ticket', columns: ['graphMessageId'] },
  { sql: 'Comment', columns: ['graphMessageId'] },
  { sql: 'GraphSubscription', columns: ['subscriptionId'] },
  { sql: 'Setting', columns: ['key'] },
  { sql: 'TeamMembership', columns: ['agentId', 'teamId'] },
];

const JSON_STRING_COLUMNS = [
  { sql: 'AuditEvent', columns: ['fromValue', 'toValue', 'metadata'] },
  { sql: 'RoutingRuleAuditLog', columns: ['changes'] },
];

const CHUNK = 200;

// --- SQLite read-only -------------------------------------------------------
const { DatabaseSync } = require('node:sqlite');
let db;
function openSource() {
  try { db = new DatabaseSync(SOURCE, { readOnly: true }); }
  catch { db = new DatabaseSync(SOURCE); }
  db.exec('PRAGMA query_only = 1;'); // any accidental write now fails loudly
  return db;
}
function tableInfo(sqlName) { return db.prepare(`PRAGMA table_info("${sqlName}")`).all(); }
function readAll(sqlName) { return db.prepare(`SELECT * FROM "${sqlName}"`).all(); }
function scalar(sql, ...a) { return db.prepare(sql).get(...a); }

// --- value conversion (SQLite -> PostgreSQL semantics) ----------------------
function convertRow(colDefs, row) {
  const out = {};
  for (const c of colDefs) {
    const v = row[c.name];
    if (v === null || v === undefined) { out[c.name] = null; continue; }
    const type = String(c.type || '').toUpperCase();
    if (type === 'BOOLEAN') { out[c.name] = (v === 1 || v === true || v === '1' || v === 'true'); }
    else if (type.includes('DATETIME') || type.includes('TIMESTAMP')) {
      out[c.name] = toDate(v, c.name);
    } else { out[c.name] = v; }
  }
  return out;
}

// SQLite stores DateTime in a mix of formats; normalize all to a Date.
function toDate(v, colName) {
  let d;
  if (typeof v === 'number') { d = new Date(v); }
  else {
    const s = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) d = new Date(Number(s));                                     // epoch ms (Prisma SQLite engine storage)
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) d = new Date(s.replace(' ', 'T') + 'Z'); // bare UTC (SQLite CURRENT_TIMESTAMP / Prisma UTC)
    else d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable DATETIME in ${colName}: ${JSON.stringify(v)}`);
  return d;
}

// --- source inspection -----------------------------------------------------
function sourceCounts() { const o = {}; for (const t of TABLES) o[t.sql] = scalar(`SELECT COUNT(*) AS n FROM "${t.sql}"`).n; return o; }

function findDuplicates() {
  const issues = [];
  for (const c of UNIQUE_CHECKS) {
    const cols = c.columns.map((x) => `"${x}"`).join(', ');
    // PostgreSQL (and SQLite) UNIQUE indexes treat NULLs as distinct, so any
    // group containing a NULL is NOT a violation — exclude it explicitly here.
    const where = c.columns.map((x) => `"${x}" IS NOT NULL`).join(' AND ');
    const rows = db.prepare(`SELECT ${cols}, COUNT(*) AS n FROM "${c.sql}" WHERE ${where} GROUP BY ${cols} HAVING n > 1`).all();
    if (rows.length) issues.push({ table: c.sql, columns: c.columns, dupRows: rows.length });
  }
  return issues;
}

function notNullNulls() {
  const issues = [];
  for (const t of TABLES) for (const c of tableInfo(t.sql).filter((x) => x.notnull === 1)) {
    const n = scalar(`SELECT COUNT(*) AS n FROM "${t.sql}" WHERE "${c.name}" IS NULL`).n;
    if (n > 0) issues.push({ table: t.sql, column: c.name, nulls: n });
  }
  return issues;
}

function fkViolations() { return db.prepare('PRAGMA foreign_key_check').all(); }

function booleanDistincts() {
  const out = [];
  for (const t of TABLES) for (const c of tableInfo(t.sql).filter((x) => String(x.type || '').toUpperCase() === 'BOOLEAN')) {
    const vals = db.prepare(`SELECT DISTINCT "${c.name}" AS v FROM "${t.sql}"`).all().map((r) => r.v);
    out.push({ table: t.sql, column: c.name, distinctValues: vals });
  }
  return out;
}

function jsonStringSamples() {
  const out = [];
  for (const jc of JSON_STRING_COLUMNS) for (const col of jc.columns) {
    const sv = scalar(`SELECT "${col}" AS v FROM "${jc.sql}" WHERE "${col}" IS NOT NULL LIMIT 1`);
    out.push({ table: jc.sql, column: col, sample: sv && sv.v !== null && sv.v !== undefined ? String(sv.v).slice(0, 120) : null });
  }
  return out;
}

function leadViolations() {
  return db.prepare('SELECT "teamId", COUNT(*) AS n FROM "TeamMembership" WHERE "isLead" = 1 GROUP BY "teamId" HAVING n > 1').all();
}

function singleLeadIndexInSource() {
  try { return db.prepare("PRAGMA index_list('TeamMembership')").all().find((i) => i.name === 'TeamMembership_single_lead') || null; }
  catch { return null; }
}

function fkOrderCheck() {
  const orderIdx = new Map(TABLES.map((t, i) => [t.sql, i]));
  const issues = [];
  for (const t of TABLES) {
    let parents = [];
    try { parents = db.prepare(`PRAGMA foreign_key_list("${t.sql}")`).all(); } catch { continue; }
    for (const fk of parents) {
      if (!orderIdx.has(fk.table)) { issues.push(`${t.sql} references unknown parent ${fk.table}`); continue; }
      if (orderIdx.get(fk.table) > orderIdx.get(t.sql)) issues.push(`${t.sql} -> ${fk.table} (parent after child)`);
    }
  }
  return issues;
}

function sequencePlan() {
  const plan = { tables: [], sqliteSeqRows: [] };
  try { plan.sqliteSeqRows = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all(); } catch { /* no AUTOINCREMENT tables yet */ }
  for (const t of AUTOINCREMENT_TABLES) {
    const m = scalar(`SELECT MAX("id") AS m FROM "${t.sql}"`).m;
    const seqRow = plan.sqliteSeqRows.find((r) => r.name === t.sql);
    const maxId = m === null || m === undefined ? 0 : Number(m);
    const seq = seqRow ? Number(seqRow.seq) : 0;
    plan.tables.push({ table: t.sql, maxId, sqliteSeq: seq, next: Math.max(maxId, seq) });
  }
  return plan;
}

// --- target (PostgreSQL) ----------------------------------------------------
const { PrismaClient } = require('@prisma/client');
let prisma = null;
function targetClient() {
  if (!prisma) {
    process.env.DATABASE_URL = DIRECT_URL; // session pooler: interactive transactions supported
    prisma = new PrismaClient();
  }
  return prisma;
}
async function targetCounts() {
  const o = {};
  for (const t of TABLES) o[t.sql] = await prisma[t.prisma].count();
  return o;
}
async function targetSerialNames(write) {
  for (const t of AUTOINCREMENT_TABLES) {
    try {
      const r = await prisma.$queryRawUnsafe(`SELECT pg_get_serial_sequence('"public"."${t.sql}"','id') AS seqname`);
      write(`  ${t.sql}: ${r[0] && r[0].seqname ? r[0].seqname : 'NOT FOUND'}`);
    } catch (e) { write(`  ${t.sql}: ERROR ${mask(e.message)}`); }
  }
}
const mask = (m) => String(m || '').replace(/(postgres(?:ql)?:\/\/)[^\s'"]+/gi, '$1***');

// --- report rendering -------------------------------------------------------
function renderReport(write) {
  write('='.repeat(74));
  write(`SQLite -> PostgreSQL DATA MIGRATION ${MODE === 'migrate' ? 'VERIFICATION' : 'DRY-RUN/VALIDATION'} REPORT`);
  write('='.repeat(74));
  write(`SOURCE: ${SOURCE}  (opened READ-ONLY; never modified)`);
  write(`TARGET: ${URL_REDACTED}`);
  write('');

  const counts = sourceCounts();
  write(`[1] SOURCE ROW COUNTS (${TABLES.length} application tables)`);
  write('  ' + 'Table'.padEnd(24) + 'Rows');
  for (const t of TABLES) write('  ' + t.sql.padEnd(24) + String(counts[t.sql]));
  write('');

  let integ = 'ERROR';
  try { integ = db.prepare('PRAGMA integrity_check').all()[0].integrity_check; } catch {}
  write('[2] SQLite integrity                   : ' + integ);
  write('[3] Duplicate values vs UNIQUE         : ' + (findDuplicates().length ? JSON.stringify(findDuplicates()) : 'NONE'));
  write('[4] NULLs in NOT NULL columns          : ' + (notNullNulls().length ? JSON.stringify(notNullNulls()) : 'NONE'));
  write('[5] FK violations (foreign_key_check)  : ' + (fkViolations().length ? JSON.stringify(fkViolations()) : 'NONE'));
  write('[6] Multiple leads per team            : ' + (leadViolations().length ? JSON.stringify(leadViolations()) : 'NONE'));
  write('[7] TeamMembership_single_lead index   : ' + (singleLeadIndexInSource() ? 'present in source' : 'ABSENT in source'));
  write('');

  write('[8] Boolean columns (distinct raw values)');
  for (const b of booleanDistincts()) write(`  ${b.table}.${b.column}: [${b.distinctValues.join(', ')}]  (0/1 -> false/true)`);
  write('');

  write('[9] DATETIME columns (sample + parseability)');
  const dt = [];
  for (const t of TABLES) for (const c of tableInfo(t.sql).filter((x) => String(x.type || '').toUpperCase().includes('DATETIME'))) {
    const v = scalar(`SELECT "${c.name}" AS v FROM "${t.sql}" WHERE "${c.name}" IS NOT NULL LIMIT 1`);
    if (v && v.v !== null && v.v !== undefined && !dt.some((x) => x.table === t.sql && x.column === c.name)) {
      const s = String(v.v);
      let iso;
      try { iso = toDate(v.v, c.name).toISOString(); } catch { iso = 'UNPARSEABLE'; }
      dt.push({ table: t.sql, column: c.name, sample: s, iso });
    }
  }
  for (const x of dt) write(`  ${x.table}.${x.column}: "${x.sample}" -> ${x.iso}`);
  write('');

  write('[10] JSON-as-string columns (first sample each, truncated)');
  for (const s of jsonStringSamples()) write(`  ${s.table}.${s.column}: ${s.sample === null ? '(all NULL)' : '"' + s.sample + '"'}`);
  write('');

  write('[11] TicketSequence rows (year=0 = global ticket-number continuity)');
  for (const r of readAll('TicketSequence')) write(`  year=${r.year}  last=${r.last}`);
  write('');

  write('[12] GraphSubscription records          : ' + counts.GraphSubscription + (counts.GraphSubscription ? ' (imported as-is so renewal continues)' : ''));
  write('');

  write('[13] SEQUENCE PLAN (setval statements PREPARED, NOT executed)');
  for (const p of sequencePlan().tables) write(`  setval(pg_get_serial_sequence('"public"."${p.table}"','id'), ${p.next}, true)   [maxId=${p.maxId}, sqliteSeq=${p.sqliteSeq}]`);
  write('');

  write('[14] FK-SAFE INSERT ORDER');
  write('  ' + TABLES.map((t) => t.sql).join(' -> '));
  write('[14b] FK order vs insert order         : ' + (fkOrderCheck().length ? JSON.stringify(fkOrderCheck()) : 'OK — every parent is inserted before its children'));
  write('');
}

async function dryRun(write) {
  const p = targetClient();
  renderReport(write);
  write('[15] TARGET EMPTINESS (read-only counts on Supabase)');
  const tc = await targetCounts();
  for (const t of TABLES) write(`  ${t.sql.padEnd(24)} ${tc[t.sql]}`);
  write('  -> target ' + (Object.values(tc).every((c) => c === 0) ? 'is EMPTY — a real --migrate is currently safe.' : 'HAS DATA — --migrate will refuse to run.'));
  write('');
  write('[16] TARGET SERIAL SEQUENCE NAMES (exist for setval)');
  await targetSerialNames(write);
  write('');
  write('DRY-RUN COMPLETE. ZERO writes performed. No changes made to source or target.');
}

async function realMigrate(write) {
  const p = targetClient();
  renderReport(write);
  write('[15] TARGET EMPTINESS + GUARD');
  const before = await targetCounts();
  const nonEmpty = TABLES.filter((t) => before[t.sql] > 0);
  for (const t of TABLES) write(`  ${t.sql.padEnd(24)} ${before[t.sql]}`);
  if (nonEmpty.length) { write(`\nABORT: target is NOT empty (${nonEmpty.map((t) => t.sql).join(', ')}). No data was written.`); return false; }
  write('  -> target is EMPTY. Proceeding inside ONE transaction.\n');

  const plan = sequencePlan();
  write(`[16] COPYING (single transaction, chunks of ${CHUNK})`);
  let ok = true;
  try {
    await prisma.$transaction(async (tx) => {
      for (const t of TABLES) {
        const colDefs = tableInfo(t.sql);
        const rows = readAll(t.sql).map((r) => convertRow(colDefs, r));
        write(`  inserting ${t.sql}: ${rows.length}`);
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx[t.prisma].createMany({ data: rows.slice(i, i + CHUNK) });
        }
      }
      write('  restoring sequences via setval(...)');
      for (const q of plan.tables) {
        if (q.next > 0) {
          await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"public"."${q.table}"','id'), ${q.next}, true)`);
        }
      }
    }, { timeout: 600000, maxWait: 20000 });
  } catch (e) {
    write(`\nFATAL during transaction: ${mask(e.message)}`);
    write('Transaction ROLLED BACK. Source and target are unchanged (source was never written to).');
    return false;
  }
  write('');
  write('[17] VERIFICATION (source vs target)');
  const sc = sourceCounts();
  const after = await targetCounts();
  let okAll = true;
  for (const t of TABLES) {
    const match = sc[t.sql] === after[t.sql];
    if (!match) okAll = false;
    write(`  ${t.sql.padEnd(24)} source=${sc[t.sql]}  target=${after[t.sql]}  ${match ? 'OK' : 'MISMATCH!'}`);
  }
  write('');
  write(okAll ? 'ALL TABLES MATCH. Migration committed successfully.' : 'WARNING: count mismatch — investigate before switching the app.');
  return okAll;
}

async function main() {
  openSource();
  const out = [];
  const write = (s = '') => out.push(String(s));
  let ok = true;
  try {
    if (MODE === 'migrate') ok = await realMigrate(write);
    else await dryRun(write);
  } catch (e) {
    write(`\nFATAL: ${mask(e.message)}`);
    ok = false;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    try { db.close(); } catch {}
    const report = out.join('\n');
    console.log(report);
    fs.writeFileSync(REPORT_FILE, report, 'utf8');
    console.log(`\nreport written -> ${REPORT_FILE}`);
    if (!ok) process.exitCode = 1;
  }
}
main();