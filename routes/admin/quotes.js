'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const audit      = require('../../middleware/audit');
const Quote      = require('../../models/Quote');
const { analyseAndGenerateWorkflow } = require('../../services/claudeService');
const { sendWorkflowUnlock }         = require('../../services/emailService');

// GET /api/admin/quotes
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { quoteId:      { $regex: search, $options: 'i' } },
        { clientName:   { $regex: search, $options: 'i' } },
        { clientEmail:  { $regex: search, $options: 'i' } },
        { clientCompany:{ $regex: search, $options: 'i' } },
      ];
    }
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const [quotes, total] = await Promise.all([
      Quote.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
        .select('-workflow.json -workflow.docs -workflow.mermaid').lean(),
      Quote.countDocuments(filter),
    ]);
    res.json({ quotes, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/quotes/:id — full quote including workflow
router.get('/:id', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({
      $or: [{ _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null }, { quoteId: req.params.id.toUpperCase() }],
    }).lean();
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    res.json(quote);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/admin/quotes/:id/status
router.patch('/:id/status', protect, audit('update_quote_status', 'Quote'), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['draft', 'pending', 'paid', 'delivered', 'cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const quote = await Quote.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    res.json(quote);
  } catch {
    res.status(500).json({ message: 'Update failed' });
  }
});

// POST /api/admin/quotes/:id/unlock — manually unlock workflow after payment
router.post('/:id/unlock', protect, audit('unlock_workflow', 'Quote'), async (req, res) => {
  try {
    const quote = await Quote.findByIdAndUpdate(
      req.params.id,
      { workflowLocked: false, status: 'paid' },
      { new: true },
    );
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    // Send delivery email
    sendWorkflowUnlock({
      name:         quote.clientName,
      email:        quote.clientEmail,
      quoteId:      quote.quoteId,
      workflowJson: quote.workflow?.json,
      docs:         quote.workflow?.docs,
    }).catch(err => console.error('Unlock email error:', err.message));

    res.json({ message: 'Workflow unlocked and email sent', quote });
  } catch {
    res.status(500).json({ message: 'Unlock failed' });
  }
});

// POST /api/admin/quotes/:id/regenerate — re-run Claude on the original request
router.post('/:id/regenerate', protect, audit('regenerate_workflow', 'Quote'), async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    const claudeResult = await analyseAndGenerateWorkflow(quote.request);
    const { analysis, workflow } = claudeResult;

    await Quote.findByIdAndUpdate(req.params.id, {
      analysis,
      workflow: { ...workflow, generatedAt: new Date() },
    });

    res.json({ message: 'Workflow regenerated successfully', analysis });
  } catch (err) {
    console.error('Regenerate error:', err.message);
    res.status(500).json({ message: 'Regeneration failed' });
  }
});

// GET /api/admin/workflows — same as quotes but returns workflow-specific view
router.get('/workflows/all', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [workflows, total] = await Promise.all([
      Quote.find({ 'workflow.generatedAt': { $exists: true } })
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
        .select('quoteId clientName clientEmail plan analysis workflowLocked workflow.generatedAt createdAt')
        .lean(),
      Quote.countDocuments({ 'workflow.generatedAt': { $exists: true } }),
    ]);
    res.json({ workflows, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
