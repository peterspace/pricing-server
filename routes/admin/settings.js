'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const Settings   = require('../../models/Settings');

// GET /api/admin/settings
router.get('/', protect, async (req, res) => {
  try {
    let s = await Settings.findOne();
    if (!s) s = await Settings.create({});
    res.json(s);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/settings
router.put('/', protect, async (req, res) => {
  try {
    const s = await Settings.findOneAndUpdate({}, req.body, { upsert: true, new: true });
    res.json(s);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
