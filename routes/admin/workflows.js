'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const Quote      = require('../../models/Quote');

// GET /api/admin/workflows
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [workflows, total] = await Promise.all([
      Quote.find({ 'workflow.generatedAt': { $exists: true } })
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
        .select('quoteId clientName clientEmail plan analysis workflowLocked workflow.generatedAt createdAt status')
        .lean(),
      Quote.countDocuments({ 'workflow.generatedAt': { $exists: true } }),
    ]);
    res.json({ workflows, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/workflows/:id — full workflow including JSON, docs, mermaid
router.get('/:id', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({
      $or: [
        { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null },
        { quoteId: req.params.id.toUpperCase() },
      ],
    }).lean();
    if (!quote) return res.status(404).json({ message: 'Workflow not found' });
    res.json(quote);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/workflows/:id/export — returns workflow JSON for download
router.get('/:id/export', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({
      $or: [
        { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null },
        { quoteId: req.params.id.toUpperCase() },
      ],
    }).select('quoteId workflow').lean();

    if (!quote) return res.status(404).json({ message: 'Not found' });

    res.json({
      quoteId:  quote.quoteId,
      workflow: quote.workflow?.json || null,
      docs:     quote.workflow?.docs || '',
      mermaid:  quote.workflow?.mermaid || '',
    });
  } catch {
    res.status(500).json({ message: 'Export failed' });
  }
});

module.exports = router;
