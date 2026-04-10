'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const Quote   = require('../models/Quote');

// POST /api/clarify
// Requires quoteId (created by /api/quotes/init before this is called).
// Triggers WF1 fire-and-forget. Client polls GET /api/quotes/:quoteId/clarification.
router.post('/', async (req, res) => {
  const {
    quoteId,
    prompt,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
  } = req.body;

  if (!quoteId) {
    return res.status(400).json({ message: 'quoteId is required. Call /api/quotes/init first.' });
  }
  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a more detailed request.' });
  }

  const n8nBase = process.env.N8N_BASE_URL;
  const secret  = process.env.N8N_WEBHOOK_SECRET;
  const wf1Path = process.env.N8N_WF1_PATH || '/webhook-test/quote-request';

  if (!n8nBase) {
    return res.status(503).json({ message: 'n8n integration not configured.' });
  }

  try {
    const quote = await Quote.findOne({ quoteId: quoteId.toUpperCase() });
    if (!quote) {
      return res.status(404).json({ message: 'Quote not found. Please start over.' });
    }

    // If clarification already exists and prompt hasn't changed — return cached
    if (quote.clarification?.understood && quote.request === prompt.trim()) {
      console.log('Returning cached clarification for:', quoteId);
      return res.json({ quoteId, status: 'ready', clarification: quote.clarification });
    }

    // For refinement rounds, the enriched prompt differs from original request
    // so it always falls through to reset + re-trigger WF1 — correct behaviour
    // Reset quote for new WF1 run (also resets cancelled/failed quotes from previous attempts)
    await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        request:        prompt.trim(),
        status:         'new',
        analysisStatus: 'processing',
        clarification:  null,
        wf1SentAt:      new Date(),
      }
    );

    // Respond immediately — client will poll
    res.status(202).json({ quoteId, status: 'thinking' });

    // Fire WF1 in background
    const payload = { prompt: prompt.trim(), quoteId, clientName, clientEmail, clientCompany };
    const headers = {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    };
    const isTestUrl = wf1Path.includes('/webhook-test/');

    if (isTestUrl) {
      // webhook-test URL — WF1 is configured with responseData: noData so body is empty.
      // The actual clarification arrives via the callback POST /api/quotes/:quoteId/clarification.
      // We just need to fire and let the callback handle the result.
      axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 120000 })
        .then(async response => {
          const body = response.data;
          // If n8n returns actual clarification data (non-empty), save it directly
          if (body && typeof body === 'object') {
            const data = Array.isArray(body) ? body[0] : body;
            const clarification = data?.json?.clarification || data?.clarification;
            if (clarification?.understood) {
              // ── FIX: reset analysisStatus so polling doesn't return 'failed'
              await Quote.findOneAndUpdate(
                { quoteId },
                {
                  clarification,
                  status:         'clarified',
                  analysisStatus: 'processing',
                  wf1CompletedAt: new Date(),
                }
              );
              console.log('WF1 clarification saved (direct response) for:', quoteId);
              return;
            }
          }
          // Empty body (noData mode) — callback route will save the clarification
          console.log('WF1 triggered (noData mode), waiting for callback for:', quoteId);
        })
        .catch(async err => {
          console.error('WF1 failed for', quoteId, ':', err.message);
          await Quote.findOneAndUpdate(
            { quoteId },
            { status: 'cancelled', analysisStatus: 'failed' }
          );
        });
    } else {
      // Production — n8n calls back to POST /api/quotes/:quoteId/clarification
      axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 15000 })
        .catch(async err => {
          console.error('WF1 trigger failed for', quoteId, ':', err.message);
          await Quote.findOneAndUpdate(
            { quoteId },
            { status: 'cancelled', analysisStatus: 'failed' }
          );
        });
    }

  } catch (err) {
    console.error('Clarify error:', err.message);
    res.status(500).json({ message: 'Failed to start analysis. Please try again.' });
  }
});

module.exports = router;
