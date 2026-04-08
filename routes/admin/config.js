'use strict';
const express       = require('express');
const router        = express.Router();
const { protect }   = require('../../middleware/auth');
const audit         = require('../../middleware/audit');
const PricingConfig = require('../../models/PricingConfig');

// GET /api/admin/config
router.get('/', protect, async (req, res) => {
  try {
    let config = await PricingConfig.findOne().lean();
    if (!config) config = (await PricingConfig.create({})).toObject();
    res.json(config);
  } catch {
    res.status(500).json({ message: 'Failed to load config' });
  }
});

// PUT /api/admin/config
router.put('/', protect, audit('update_pricing_config', 'PricingConfig'), async (req, res) => {
  try {
    const existing = await PricingConfig.findOne();
    const newVersion = (existing?.version || 0) + 1;

    const config = await PricingConfig.findOneAndUpdate(
      {},
      { ...req.body, version: newVersion, updatedBy: req.admin.name },
      { upsert: true, new: true, runValidators: true },
    );
    res.json(config);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
