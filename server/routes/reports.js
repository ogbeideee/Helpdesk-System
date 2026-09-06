// Operational reports — administrator-only, read-only.
//
// Mounted behind requireAdmin (see server.js), exactly like the SLA and audit
// routers. The aggregate itself lives in src/reports.js; this router only
// validates the optional date range and shapes the call. SLA performance is
// delegated inside the service to the existing SLA reporting service — this
// endpoint is deliberately separate from GET /api/sla/report, whose contract
// is unchanged.
const express = require('express');
const reports = require('../src/reports');

const router = express.Router();

/** Strict ISO bound parsing, identical contract to the other report routers. */
function parseBound(name, raw) {
  if (raw === undefined || raw === '') return { value: null };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { error: `${name} must be an ISO date (e.g. 2026-09-01 or 2026-09-01T00:00:00Z)` };
  }
  return { value: date };
}

// GET /api/reports?from=ISO&to=ISO — volume, breakdowns, resolution and
// first-response metrics over the optional range; the current-queue snapshot
// and the SLA section's live figures ignore the range by design.
router.get('/', async (req, res) => {
  try {
    const from = parseBound('from', req.query.from);
    if (from.error) return res.status(400).json({ error: from.error });
    const to = parseBound('to', req.query.to);
    if (to.error) return res.status(400).json({ error: to.error });
    if (from.value && to.value && from.value > to.value) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    res.json(await reports.reportsOverview({ from: from.value, to: to.value }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
