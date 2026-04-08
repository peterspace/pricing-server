'use strict';
const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const Quote    = require('../models/Quote');
const { analyseLimiter } = require('../middleware/rateLimiter');

function generateQuoteId() {
  return 'QT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
}

// POST /api/analyse
// Fire-and-forget: saves a draft Quote, then triggers WF23 in the background.
// Returns 202 immediately with the quoteId so the client can start polling.
router.post('/', analyseLimiter, async (req, res) => {
  const {
    prompt,
    clarification,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
    plan          = 'recurring',
    selectedTierId = 't2',
    supportContract = null,
    hostedLLMs    = true,
    ownKeys       = { openai: false, claude: false, gemini: false },
  } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    return res.status(400).json({ message: 'Please provide a detailed automation description.' });
  }
  if (!clientEmail || !clientEmail.includes('@')) {
    return res.status(400).json({ message: 'A valid client email is required.' });
  }

  try {
    const quoteId = generateQuoteId();

    // 1. Save draft Quote immediately so the client can start polling
    await Quote.create({
      quoteId,
      clientName:    clientName.trim(),
      clientEmail:   clientEmail.trim().toLowerCase(),
      clientCompany: clientCompany.trim(),
      request:       prompt.trim(),
      plan,
      selectedTierId,
      supportContract,
      hostedLLMs,
      ownKeys,
      status:         'analysing',
      workflowLocked: true,
      analysisStatus: 'processing',
      wf23SentAt:     new Date(),
    });

    // 2. Respond immediately — client gets quoteId and starts polling
    res.status(202).json({
      quoteId,
      status: 'processing',
      message: 'Analysis started. Poll /api/quotes/:quoteId/status for updates.',
    });

    // 3. Fire WF23 in background (after response is sent)
    const n8nBase    = process.env.N8N_BASE_URL;
    const secret     = process.env.N8N_WEBHOOK_SECRET;
    const wf23Path   = process.env.N8N_WF23_PATH || '/webhook/confirm-clarification';

    if (!n8nBase) {
      console.warn('N8N_BASE_URL not set — skipping WF23 trigger');
      return;
    }

    const wf23Payload = {
      quoteId,
      prompt:          prompt.trim(),
      clarification:   clarification || null,
      clientName:      clientName.trim(),
      clientEmail:     clientEmail.trim().toLowerCase(),
      clientCompany:   clientCompany.trim(),
      plan,
      selectedTierId,
      hostedLLMs,
      ownKeys,
    };

    axios.post(
      `${n8nBase}${wf23Path}`,
      wf23Payload,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-webhook-secret': secret } : {}),
        },
        timeout: 180000, // WF23 can take up to 3 min
      }
    ).catch(err => {
      console.error(`WF23 trigger failed for ${quoteId}:`, err.message);
      // Mark quote as failed so client stops polling
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

// POST /api/quotes/:quoteId/result
// Called by WF23 when it finishes — saves analysis + workflow_json to the Quote
router.post('/:quoteId/result', async (req, res) => {
  const { quoteId } = req.params;
  const secret = process.env.N8N_WEBHOOK_SECRET;

  // Verify the secret so only n8n can call this
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { analysis, workflow_json, summary } = req.body;

  if (!analysis || !workflow_json) {
    return res.status(400).json({ message: 'analysis and workflow_json are required.' });
  }

  try {
    const updated = await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        analysis,
        workflow: {
          json:        workflow_json,
          summary:     summary || analysis.workflow_summary || '',
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
