'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const Quote   = require('../models/Quote');

// ── Pending promise map ───────────────────────────────────────────────────────
// When /api/clarify is called, we store a { resolve, reject, timer } keyed by
// quoteId. When WF1 calls back on /:quoteId/clarification, we look it up and
// resolve the original client request. Auto-cleans after 90s timeout.
const pending = new Map();

// POST /api/clarify
// Client sends { prompt, quoteId, clientName, clientEmail, clientCompany }
// We save a draft quote, trigger WF1, and wait for the callback (max 65s).
router.post('/', async (req, res) => {
  const {
    prompt,
    quoteId,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
  } = req.body;

  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a more detailed request.' });
  }
  if (!quoteId) {
    return res.status(400).json({ message: 'quoteId is required.' });
  }
  if (!clientEmail || !clientEmail.includes('@')) {
    return res.status(400).json({ message: 'A valid email is required.' });
  }

  const n8nBase   = process.env.N8N_BASE_URL;
  const secret    = process.env.N8N_WEBHOOK_SECRET;
  const wf1Path   = process.env.N8N_WF1_PATH || '/webhook/quote-request';

  if (!n8nBase) {
    return res.status(503).json({ message: 'n8n integration not configured.' });
  }

  try {
    // 1. Save draft quote immediately so it exists when WF1 callbacks
    await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        quoteId:       quoteId.toUpperCase(),
        clientName:    clientName.trim(),
        clientEmail:   clientEmail.trim().toLowerCase(),
        clientCompany: clientCompany.trim(),
        request:       prompt.trim(),
        status:        'new',
        analysisStatus:'processing',
        workflowLocked: true,
        plan:          'recurring', // default — updated at /api/analyse
        wf1SentAt:     new Date(),
      },
      { upsert: true, new: true }
    );

    // 2. Register a pending promise — WF1 callback will resolve it
    const clarificationPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(quoteId);
        reject(new Error('WF1 timed out after 65 seconds.'));
      }, 65000);
      pending.set(quoteId, { resolve, reject, timer });
    });

    // 3. Trigger WF1 (non-blocking call, WF1 will callback when done)
    axios.post(
      `${n8nBase}${wf1Path}`,
      { prompt: prompt.trim(), quoteId, clientName, clientEmail, clientCompany },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-webhook-secret': secret } : {}),
        },
        timeout: 5000, // just needs to acknowledge receipt
      }
    ).catch(err => {
      // WF1 didn't even acknowledge — reject immediately
      const p = pending.get(quoteId);
      if (p) { clearTimeout(p.timer); pending.delete(quoteId); p.reject(err); }
    });

    // 4. Wait for WF1 to call back with the clarification
    const clarification = await clarificationPromise;

    res.json({ quoteId, clarification });

  } catch (err) {
    console.error('Clarify error:', err.message);
    await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      { analysisStatus: 'failed', status: 'cancelled' }
    ).catch(() => {});

    if (err.message.includes('timed out')) {
      return res.status(504).json({ message: 'Analysis is taking longer than expected. Please try again.' });
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      return res.status(502).json({ message: 'Could not reach the AI service. Please try again in a moment.' });
    }
    res.status(502).json({ message: 'Something went wrong. Please try again.' });
  }
});

// POST /api/quotes/:quoteId/clarification
// Called by WF1 when Agent 1 finishes — resolves the pending promise
router.post('/:quoteId/clarification', async (req, res) => {
  const quoteId = req.params.quoteId.toUpperCase();
  const secret  = process.env.N8N_WEBHOOK_SECRET;

  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { clarification } = req.body;

  if (!clarification || !clarification.understood) {
    return res.status(400).json({ message: 'clarification.understood is required.' });
  }

  try {
    // Save clarification to MongoDB so it survives page refreshes
    await Quote.findOneAndUpdate(
      { quoteId },
      {
        clarification,
        status: 'clarified',
        wf1CompletedAt: new Date(),
      }
    );

    // Resolve the waiting client request
    const p = pending.get(quoteId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(quoteId);
      p.resolve(clarification);
    }

    res.json({ message: 'Clarification saved.', quoteId });
  } catch (err) {
    console.error('Clarification callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

module.exports = router;
