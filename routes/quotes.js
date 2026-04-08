'use strict';
const express = require('express');
const router  = express.Router();
const Quote   = require('../models/Quote');

// POST /api/quotes/init
// Called once when user enters Step 3.
// Creates the quote record and returns quoteId immediately.
// Idempotent — if quoteId already exists, returns it unchanged.
router.post('/init', async (req, res) => {
  const {
    quoteId: clientQuoteId,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
    request       = '',
  } = req.body;

  if (!clientEmail || !clientEmail.includes('@')) {
    return res.status(400).json({ message: 'A valid email is required.' });
  }

  try {
    if (clientQuoteId) {
      // Already have a quoteId — check it exists
      const existing = await Quote.findOne({
        quoteId: clientQuoteId.toUpperCase()
      }).select('quoteId status clarification').lean();

      if (existing) {
        return res.json({
          quoteId:    existing.quoteId,
          isExisting: true,
          hasClarification: !!(existing.clarification?.understood),
        });
      }
    }

    // Generate new quoteId and create record
    const quoteId = 'QT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
    await Quote.create({
      quoteId,
      clientName:     clientName.trim(),
      clientEmail:    clientEmail.trim().toLowerCase(),
      clientCompany:  clientCompany.trim(),
      request:        request.trim(),
      status:         'new',
      analysisStatus: 'processing',
      workflowLocked: true,
      plan:           'recurring',
    });

    res.status(201).json({ quoteId, isExisting: false, hasClarification: false });
  } catch (err) {
    console.error('Quote init error:', err.message);
    res.status(500).json({ message: 'Failed to initialise quote.' });
  }
});

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

    let resumeStep = 3;
    if (quote.status === 'clarified' && quote.clarification?.understood) resumeStep = 3; // show clarification
    if (quote.status === 'analysing')   resumeStep = 5;
    if (quote.analysisStatus === 'ready') resumeStep = 6;
    if (quote.analysisStatus === 'failed' && quote.status !== 'clarified') resumeStep = 3;

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

// GET /api/quotes/:quoteId  — full quote
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


// ── n8n Callbacks ─────────────────────────────────────────────────────────────

// GET /api/quotes/:quoteId/clarification — client polls for WF1 result
router.get('/:quoteId/clarification', async (req, res) => {
  try {
    const quote = await Quote.findOne({
      quoteId: req.params.quoteId.toUpperCase()
    }).select('quoteId status clarification').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    if (quote.status === 'clarified' && quote.clarification?.understood) {
      return res.json({ quoteId: quote.quoteId, status: 'ready', clarification: quote.clarification });
    }
    if (quote.status === 'cancelled') {
      return res.json({ quoteId: quote.quoteId, status: 'failed' });
    }
    res.json({ quoteId: quote.quoteId, status: 'thinking' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/quotes/:quoteId/clarification — WF1 production callback
router.post('/:quoteId/clarification', async (req, res) => {
  const quoteId = req.params.quoteId.toUpperCase();
  const secret  = process.env.N8N_WEBHOOK_SECRET;

  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { clarification } = req.body;
  if (!clarification?.understood) {
    return res.status(400).json({ message: 'clarification.understood is required.' });
  }

  try {
    await Quote.findOneAndUpdate(
      { quoteId },
      { clarification, status: 'clarified', wf1CompletedAt: new Date() }
    );
    console.log('WF1 callback saved clarification for:', quoteId);
    res.json({ message: 'Clarification saved.', quoteId });
  } catch (err) {
    console.error('Clarification callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

// POST /api/quotes/:quoteId/result — WF23 callback
router.post('/:quoteId/result', async (req, res) => {
  const { quoteId } = req.params;
  const secret = process.env.N8N_WEBHOOK_SECRET;

  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // n8n sometimes wraps the body in an array — unwrap if needed
  const bodyRaw = Array.isArray(req.body) ? req.body[0] : req.body;

  let { analysis, workflow_json, summary } = bodyRaw;

  // n8n may send objects as JSON strings — parse defensively
  function safeParse(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return val; }
  }
  analysis     = safeParse(analysis);
  workflow_json = safeParse(workflow_json);
  summary       = safeParse(summary);

  if (!analysis || !workflow_json) {
    return res.status(400).json({ message: 'analysis and workflow_json are required.' });
  }

  try {
    // Merge summary metadata into analysis so everything lives in one place
    // summary = { workflow_name, node_count, description, complexity, agent_list }
    const enrichedAnalysis = {
      ...analysis,
      workflow_summary:  analysis.workflow_summary || (summary?.description) || '',
      workflow_name:     summary?.workflow_name    || analysis.workflow_name  || '',
      node_count:        summary?.node_count       || analysis.node_count     || 0,
    };

    const updated = await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        analysis: enrichedAnalysis,
        workflow: {
          json:        workflow_json,
          generatedAt: new Date(),
        },
        analysisStatus: 'ready',
        status:         'draft',
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: `Quote ${quoteId} not found.` });
    }

    console.log(`WF23 result saved for ${quoteId} — ${analysis.total_agents} agents, complexity ${analysis.complexity}`);
    res.json({ message: 'Result saved.', quoteId });
  } catch (err) {
    console.error('Save WF23 result error:', err.message);
    res.status(500).json({ message: 'Failed to save result.' });
  }
});

module.exports = router;
