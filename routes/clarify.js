'use strict';
const express   = require('express');
const router    = express.Router();
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const Quote     = require('../models/Quote');

// IP-based rate limiter — 5 clarify requests per IP per hour
const clarifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { message: 'Too many requests from this IP. Please try again in an hour.' },
  skip: (req) => !!req.headers.authorization, // admin/agent bypass
});

// POST /api/clarify
router.post('/', clarifyLimiter, async (req, res) => {
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
  // Note: clientEmail/Name/Company are optional at this stage — collected in Your Info step

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

    // Return cached clarification if prompt hasn't changed
    if (quote.clarification?.understood && quote.request === prompt.trim()) {
      console.log('Returning cached clarification for:', quoteId);
      return res.json({ quoteId, status: 'ready', clarification: quote.clarification });
    }

    // Reset quote for new WF1 run
    await Quote.findOneAndUpdate(
      { quoteId: quoteId.toUpperCase() },
      {
        request:        prompt.trim(),
        status:         'new',
        analysisStatus: 'processing',
        clarification:  null,
        wf1SentAt:      new Date(),
        $push: { messages: { role: 'user', content: prompt.trim() } },
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
      axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 120000 })
        .then(async response => {
          const body = response.data;
          if (body && typeof body === 'object') {
            const data = Array.isArray(body) ? body[0] : body;
            const clarification = data?.json?.clarification || data?.clarification;
            if (clarification?.understood) {
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
