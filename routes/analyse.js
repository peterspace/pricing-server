'use strict';
const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const Quote    = require('../models/Quote');
const { analyseLimiter } = require('../middleware/rateLimiter');

// POST /api/analyse
// quoteId comes from the client (returned by /api/clarify)
// Updates the existing quote record then fires WF23 in background
router.post('/', analyseLimiter, async (req, res) => {
  const {
    quoteId,
    prompt,
    clarification,
    clientName      = '',
    clientEmail     = '',
    clientCompany   = '',
    plan            = 'recurring',
    selectedTierId  = 't2',
    supportContract = null,
    hostedLLMs      = true,
    ownKeys         = { openai: false, claude: false, gemini: false },
  } = req.body;

  if (!quoteId) {
    return res.status(400).json({ message: 'quoteId is required.' });
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    return res.status(400).json({ message: 'Please provide a detailed automation description.' });
  }
  if (!clientEmail || !clientEmail.includes('@')) {
    return res.status(400).json({ message: 'A valid client email is required.' });
  }

  try {
    // Update the existing quote (created by /api/clarify) with config options
    const updated = await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        plan,
        selectedTierId,
        supportContract,
        hostedLLMs,
        ownKeys,
        status:         'analysing',
        analysisStatus: 'processing',
        wf23SentAt:     new Date(),
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Quote not found. Please start over.' });
    }

    // Respond immediately — client starts polling
    res.status(202).json({
      quoteId,
      status:  'processing',
      message: 'Analysis started. Poll /api/quotes/:quoteId/status for updates.',
    });

    // Fire WF23 in background after response is sent
    const n8nBase  = process.env.N8N_BASE_URL;
    const secret   = process.env.N8N_WEBHOOK_SECRET;
    const wf23Path = process.env.N8N_WF23_PATH || '/webhook-test/confirm-clarification';

    if (!n8nBase) {
      console.warn('N8N_BASE_URL not set — skipping WF23 trigger');
      return;
    }

    axios.post(
      `${n8nBase}${wf23Path}`,
      {
        quoteId,
        prompt:        prompt.trim(),
        clarification: clarification || null,
        clientName:    clientName.trim(),
        clientEmail:   clientEmail.trim().toLowerCase(),
        clientCompany: clientCompany.trim(),
        plan,
        selectedTierId,
        hostedLLMs,
        ownKeys,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-webhook-secret': secret } : {}),
        },
        timeout: 180000,
      }
    ).catch(err => {
      console.error(`WF23 trigger failed for ${quoteId}:`, err.message);
      Quote.findOneAndUpdate(
        { quoteId },
        { analysisStatus: 'failed', status: 'cancelled' }
      ).catch(() => {});
    });

  } catch (err) {
    console.error('Analyse route error:', err.message);
    res.status(500).json({ message: 'Failed to start analysis. Please try again.' });
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
    // summary may be an object { workflow_name, node_count, description, ... }
    // or a plain string — extract just the description string for workflow.summary
    const summaryStr = typeof summary === 'object' && summary !== null
      ? (summary.description || summary.workflow_name || JSON.stringify(summary))
      : (summary || analysis.workflow_summary || '');

    const updated = await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        analysis,
        workflow: {
          json:        workflow_json,
          summary:     summaryStr,
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
