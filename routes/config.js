'use strict';
const express       = require('express');
const router        = express.Router();
const PricingConfig = require('../models/PricingConfig');

// GET /api/config — public, no auth needed
// Returns the live pricing config so the client can display accurate tier costs
router.get('/', async (req, res) => {
  try {
    let config = await PricingConfig.findOne().lean();
    if (!config) {
      config = (await PricingConfig.create({})).toObject();
    }
    // Strip internal Mongoose fields before sending
    const { _id, __v, createdAt, updatedAt, ...publicConfig } = config;
    res.json(publicConfig);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load config' });
  }
});

module.exports = router;
