const router = require('express').Router();
const { requireAdmin } = require('../src/authMiddleware');
const service = require('../src/services/operationsService');
router.use(requireAdmin);
router.get('/', async (req, res, next) => {
  try { res.json(await service.management()); } catch (error) { next(error); }
});
router.patch('/settings', async (req, res, next) => {
  try {
    const result = await service.update(req.body, req.agent);
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json(await service.management());
  } catch (error) { next(error); }
});
router.post('/greeting-preview', async (req, res, next) => {
  if (typeof req.body.greeting !== 'string' || req.body.greeting.length > 300) return res.status(400).json({ error: 'Enter an opening greeting of up to 300 characters' });
  try { res.json(await service.preview(req.body.greeting)); } catch (error) { next(error); }
});
router.post('/deliveries/:id/retry', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid delivery' });
  try {
    if (!await service.retry(id, req.agent)) return res.status(409).json({ error: 'Only a failed delivery with a retained payload can be retried' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
module.exports = router;
