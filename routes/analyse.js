'use strict';
const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const Quote    = require('../models/Quote');
const { analyseLimiter } = require('../middleware/rateLimiter');

// POST /api/analyse
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
  // clientEmail is optional — collected later in Your Info step

  try {
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
        $push: { messages: { role: 'user', content: `[Analysis triggered] ${prompt.trim().slice(0, 200)}` } },
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

    // Fire WF23 in background
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
        timeout: 360000, // 6 minutes — WF23 can take 3-5 min for complex workflows
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

module.exports = router;
