'use strict';
const express = require('express');
const router  = express.Router();
const Quote   = require('../models/Quote');

// GET /api/quotes/:quoteId/status  — client polls while on Analyse step
router.get('/:quoteId/status', async (req, res) => {
  try {
    const quote = await Quote.findOne({
      quoteId: req.params.quoteId.toUpperCase()
    }).select('quoteId analysisStatus analysis workflow.summary status expiresAt').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    if (quote.analysisStatus === 'ready') {
      return res.json({
        quoteId:        quote.quoteId,
        status:         'ready',
        analysisStatus: 'ready',
        analysis:       quote.analysis,
        summary:        quote.workflow?.summary || '',
        expiresAt:      quote.expiresAt,
      });
    }
    if (quote.analysisStatus === 'failed') {
      return res.json({ quoteId: quote.quoteId, status: 'failed', analysisStatus: 'failed' });
    }
    res.json({ quoteId: quote.quoteId, status: 'processing', analysisStatus: 'processing' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/quotes/:quoteId/resume  — restores client state after page refresh
router.get('/:quoteId/resume', async (req, res) => {
  try {
    const quote = await Quote.findOne({
      quoteId: req.params.quoteId.toUpperCase()
    }).select('quoteId status analysisStatus clarification analysis workflow.summary clientName clientEmail clientCompany plan selectedTierId hostedLLMs ownKeys expiresAt').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    // Map DB status to client step
    let resumeStep = 1;
    if (quote.status === 'new')        resumeStep = 3; // back to clarify (WF1 still running)
    if (quote.status === 'clarified')  resumeStep = 3; // show saved clarification
    if (quote.status === 'analysing')  resumeStep = 5; // polling
    if (quote.analysisStatus === 'ready') resumeStep = 6; // quote ready
    if (quote.analysisStatus === 'failed') resumeStep = 3; // retry from clarify

    res.json({
      quoteId:        quote.quoteId,
      resumeStep,
      status:         quote.status,
      analysisStatus: quote.analysisStatus,
      clarification:  quote.clarification || null,
      analysis:       quote.analysis      || null,
      summary:        quote.workflow?.summary || '',
      clientName:     quote.clientName,
      clientEmail:    quote.clientEmail,
      clientCompany:  quote.clientCompany,
      plan:           quote.plan,
      selectedTierId: quote.selectedTierId,
      hostedLLMs:     quote.hostedLLMs,
      ownKeys:        quote.ownKeys,
      expiresAt:      quote.expiresAt,
    });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/quotes/:quoteId  — full quote (used on Quote step)
router.get('/:quoteId', async (req, res) => {
  try {
    const quote = await Quote.findOne({
      quoteId: req.params.quoteId.toUpperCase()
    }).select('-workflow.json').lean();
    if (!quote) return res.status(404).json({ message: 'Quote not found.' });
    res.json(quote);
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/quotes/change-order
router.post('/change-order', async (req, res) => {
  const { originalQuoteId, request } = req.body;
  if (!originalQuoteId || !request) {
    return res.status(400).json({ message: 'originalQuoteId and request are required.' });
  }
  try {
    const original = await Quote.findOne({ quoteId: originalQuoteId.toUpperCase() }).lean();
    if (!original) return res.status(404).json({ message: 'Original quote not found.' });
    res.json({ message: 'Change order received.', original });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
