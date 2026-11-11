const router = require('express').Router();
const dashboard = require('../src/services/dashboardService');
router.get('/', async (req, res) => {
  try { res.json(await dashboard.snapshot(undefined, req.agent)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
module.exports = router;
