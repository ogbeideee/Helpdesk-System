// SLA settings — administrator-only configuration of the SLA engine.
//
// Mounted behind requireAdmin (see server.js): reading and writing alike
// require the administrator role. The targets, working days, daily hours and
// timezone live in the Setting table through the shared settingsService
// (group 'sla'); public holidays are data rows in the SlaHoliday table, which
// the schema calls out as the supported way to maintain the calendar without
// a deployment.
//
// Saving settings never touches existing cycles: their targets are frozen
// instants on the TicketSlaCycle row. Only cycles started afterwards compute
// from the policy that is in force when they start.
const express = require('express');
const prisma = require('../src/lib/prisma');
const settingsService = require('../src/services/settingsService');
const auditService = require('../src/services/auditService');
const { slaReport } = require('../src/slaReport');

const router = express.Router();

const SLA_GROUP = 'sla';
const HOLIDAY_NAME_MAX = 80;

async function holidaysAll() {
  return prisma.slaHoliday.findMany({ orderBy: { date: 'asc' } });
}

async function settingsPayload() {
  const [settings, holidays] = await Promise.all([
    settingsService.getAll(prisma, SLA_GROUP),
    holidaysAll(),
  ]);
  return { settings, definitions: settingsService.describe(SLA_GROUP), holidays };
}

// Strict calendar-day parsing: YYYY-MM-DD, a real date, kept to a sane
// window so a typo cannot plant holidays far outside any meaningful calendar.
// Returns the Date at UTC midnight — the same encoding Postgres DATE and the
// working calendar use for holiday comparison.
function parseHolidayDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  if (y < 2000 || y > 2100) return null;
  return date;
}

// GET /api/sla/report?from=ISO&to=ISO — read-only SLA reporting aggregate.
// The router is mounted behind requireAdmin (see server.js), so only
// administrators can read reports. Optional `from`/`to` bound the completed
// metrics by cycle end and the volume series by cycle start; live/open
// counts are the current state and ignore the range by design.
router.get('/report', async (req, res) => {
  try {
    const parseBound = (name) => {
      const raw = req.query[name];
      if (raw === undefined || raw === '') return { value: null };
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        return { error: `${name} must be an ISO date (e.g. 2026-09-01 or 2026-09-01T00:00:00Z)` };
      }
      return { value: date };
    };
    const from = parseBound('from');
    if (from.error) return res.status(400).json({ error: from.error });
    const to = parseBound('to');
    if (to.error) return res.status(400).json({ error: to.error });
    if (from.value && to.value && from.value > to.value) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    res.json(await slaReport({ from: from.value, to: to.value }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sla/settings — effective settings, field metadata and holidays
router.get('/settings', async (req, res) => {
  try {
    res.json(await settingsPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sla/settings — validate against the definitions (and the
// cross-key rules), then save. Nothing is written when anything fails.
router.patch('/settings', async (req, res) => {
  try {
    const result = await settingsService.update(req.body || {}, req.agent, prisma);
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json(await settingsPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sla/holidays — add a holiday { date: 'YYYY-MM-DD', name? }. A
// date that already exists has its name updated (the calendar day itself is
// the identity; there is never a second row for the same day).
router.post('/holidays', async (req, res) => {
  try {
    const date = parseHolidayDate(req.body && req.body.date);
    if (!date) {
      return res
        .status(400)
        .json({ error: 'date must be a real calendar day in YYYY-MM-DD format (2000–2100)' });
    }
    let name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
    if (name.length > HOLIDAY_NAME_MAX) {
      return res.status(400).json({ error: `name must be at most ${HOLIDAY_NAME_MAX} characters` });
    }
    const existing = await prisma.slaHoliday.findUnique({ where: { date } });
    const holiday = await prisma.slaHoliday.upsert({
      where: { date },
      create: { date, name: name || null },
      update: { name: name || null },
    });
    const day = holiday.date.toISOString().slice(0, 10);
    await auditService.record(prisma, {
      action: existing ? 'sla.holiday_updated' : 'sla.holiday_added',
      entityType: 'SlaHoliday',
      entityId: holiday.id,
      entityLabel: `${day}${holiday.name ? ` — ${holiday.name}` : ''}`,
      actor: req.agent,
      ...(existing ? { from: { name: existing.name } } : {}),
      to: { name: holiday.name },
      description: existing
        ? `Public holiday ${day} updated to "${holiday.name || day}"`
        : `Public holiday ${day} added${holiday.name ? ` (${holiday.name})` : ''}`,
    });
    res.status(existing ? 200 : 201).json({
      holiday,
      updated: Boolean(existing),
      holidays: await holidaysAll(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sla/holidays/:id — remove a holiday; the day becomes a normal
// working day for cycles whose targets are still being computed from it.
router.delete('/holidays/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Holiday not found' });
    const existing = await prisma.slaHoliday.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Holiday not found' });
    await prisma.slaHoliday.delete({ where: { id } });
    await auditService.record(prisma, {
      action: 'sla.holiday_removed',
      entityType: 'SlaHoliday',
      entityId: existing.id,
      entityLabel: `${existing.date.toISOString().slice(0, 10)}${existing.name ? ` — ${existing.name}` : ''}`,
      actor: req.agent,
      from: { name: existing.name },
      description: `Public holiday ${existing.date.toISOString().slice(0, 10)} removed`,
    });
    res.json({ deleted: existing, holidays: await holidaysAll() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
