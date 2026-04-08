'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const Quote   = require('../models/Quote');

// ── Pending promise map — used only for production /webhook/ path ─────────────
const pending = new Map();

// POST /api/clarify
// quoteId is optional — server generates one on first visit, reuses on return
router.post('/', async (req, res) => {
  const {
    quoteId: clientQuoteId,
    prompt,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
  } = req.body;

  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a more detailed request.' });
  }
  if (!clientEmail || !clientEmail.includes('@')) {
    return res.status(400).json({ message: 'A valid email is required.' });
  }

  const n8nBase = process.env.N8N_BASE_URL;
  const secret  = process.env.N8N_WEBHOOK_SECRET;
  const wf1Path = process.env.N8N_WF1_PATH || '/webhook-test/quote-request';
  const isTestUrl = wf1Path.includes('/webhook-test/');

  if (!n8nBase) {
    return res.status(503).json({ message: 'n8n integration not configured.' });
  }

  try {
    let quoteId;
    let existingQuote = null;

    if (clientQuoteId) {
      existingQuote = await Quote.findOne({ quoteId: clientQuoteId.toUpperCase() });
    }

    if (existingQuote) {
      // Resuming — update existing record with new prompt
      quoteId = existingQuote.quoteId;
      await Quote.findOneAndUpdate(
        { quoteId },
        {
          request:        prompt.trim(),
          status:         'new',
          analysisStatus: 'processing',
          clarification:  null,
          wf1SentAt:      new Date(),
        }
      );
      console.log('Resuming quote:', quoteId);
    } else {
      // First visit — create new quote
      quoteId = 'QT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
      await Quote.create({
        quoteId,
        clientName:     clientName.trim(),
        clientEmail:    clientEmail.trim().toLowerCase(),
        clientCompany:  clientCompany.trim(),
        request:        prompt.trim(),
        status:         'new',
        analysisStatus: 'processing',
        workflowLocked: true,
        plan:           'recurring',
        wf1SentAt:      new Date(),
      });
      console.log('Created quote:', quoteId);
    }

    const payload = { prompt: prompt.trim(), quoteId, clientName, clientEmail, clientCompany };
    const headers = {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    };

    let clarification;

    if (isTestUrl) {
      // webhook-test: synchronous — await response directly
      console.log('Calling WF1 (test mode)...');
      const response = await axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 65000 });
      const data = Array.isArray(response.data) ? response.data[0] : response.data;
      clarification = data?.json?.clarification || data?.clarification || data;

      if (!clarification?.understood) {
        console.error('Unexpected WF1 response:', JSON.stringify(data).slice(0, 300));
        return res.status(502).json({ message: 'WF1 returned an unexpected response. Please try again.' });
      }

      await Quote.findOneAndUpdate(
        { quoteId },
        { clarification, status: 'clarified', wf1CompletedAt: new Date() }
      );

    } else {
      // Production /webhook/: async callback via pending promise map
      console.log('Calling WF1 (production mode)...');
      const clarificationPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(quoteId);
          reject(new Error('WF1 timed out after 65 seconds.'));
        }, 65000);
        pending.set(quoteId, { resolve, reject, timer });
      });

      axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 15000 })
        .catch(err => {
          console.error('WF1 trigger error:', err.response?.status, err.message);
          const p = pending.get(quoteId);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(quoteId);
          p.reject(err);
        });

      clarification = await clarificationPromise;
    }

    res.json({ quoteId, clarification });

  } catch (err) {
    console.error('Clarify error:', err.message);
    await Quote.findOneAndUpdate(
      { quoteId: (clientQuoteId || '').toUpperCase() },
      { analysisStatus: 'failed', status: 'cancelled' }
    ).catch(() => {});

    if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.message.includes('timed out')) {
      return res.status(504).json({ message: 'Analysis is taking longer than expected. Please try again.' });
    }
    if (err.response?.status === 404) {
      return res.status(502).json({ message: 'Workflow not found. Make sure WF1 is active in n8n.' });
    }
    if (err.code === 'ECONNREFUSED') {
      return res.status(502).json({ message: 'Could not reach the AI service. Please try again in a moment.' });
    }
    res.status(502).json({ message: 'Something went wrong. Please try again.' });
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
  if (!clarification || !clarification.understood) {
    return res.status(400).json({ message: 'clarification.understood is required.' });
  }

  try {
    await Quote.findOneAndUpdate(
      { quoteId },
      { clarification, status: 'clarified', wf1CompletedAt: new Date() }
    );
    const p = pending.get(quoteId);
    if (p) { clearTimeout(p.timer); pending.delete(quoteId); p.resolve(clarification); }
    res.json({ message: 'Clarification saved.', quoteId });
  } catch (err) {
    console.error('Clarification callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

module.exports = router;
