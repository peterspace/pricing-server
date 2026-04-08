'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const Quote      = require('../../models/Quote');

// GET /api/admin/change-orders
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [orders, total] = await Promise.all([
      Quote.find({ isChangeOrder: true })
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
        .select('-workflow.json -workflow.docs -workflow.mermaid').lean(),
      Quote.countDocuments({ isChangeOrder: true }),
    ]);
    res.json({ quotes: orders, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
