'use strict';
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const Quote    = require('../models/Quote');
const User     = require('../models/User');
const { signCustomerToken } = require('../middleware/customerAuth');
const { sendQuoteDelivery, sendEmail } = require('../services/emailService');

// POST /api/quotes/init
// Creates the quote record and returns quoteId immediately.
// Email not required here — collected in Your Info step (step 6).
router.post('/init', async (req, res) => {
  const {
    quoteId: clientQuoteId,
    clientName    = '',
    clientEmail   = '',
    clientCompany = '',
    request       = '',
  } = req.body;

  console.log({userQuoteData:req.body})

  try {
    if (clientQuoteId) {
      const existing = await Quote.findOne({
        quoteId: clientQuoteId.toUpperCase()
      }).select('quoteId status clarification').lean();

      if (existing) {
        return res.json({
          quoteId:          existing.quoteId,
          isExisting:       true,
          hasClarification: !!(existing.clarification?.understood),
        });
      }
    }

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

    console.log('Quote created:', quoteId);
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
    }).select('quoteId analysisStatus analysis workflow status expiresAt').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    if (quote.analysisStatus === 'ready') {
      return res.json({
        quoteId:        quote.quoteId,
        status:         'ready',
        analysisStatus: 'ready',
        analysis:       quote.analysis,
        workflowJson:   quote.workflow?.json || null,
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
    }).select('quoteId status analysisStatus clarification analysis workflow clientName clientEmail clientCompany plan selectedTierId hostedLLMs ownKeys expiresAt').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    // New flow: 1=Describe, 2=Clarify, 3=Analyse, 4=Configure, 5=Quote, 6=YourInfo
    let resumeStep = 2;
    if (quote.status === 'clarified' && quote.clarification?.understood) resumeStep = 2;
    if (quote.status === 'analysing')         resumeStep = 3;
    if (quote.analysisStatus === 'ready')     resumeStep = 5;
    if (quote.status === 'info_collected')    resumeStep = 5;
    if (quote.analysisStatus === 'failed' && quote.status !== 'clarified') resumeStep = 2;

    res.json({
      quoteId:        quote.quoteId,
      resumeStep,
      status:         quote.status,
      analysisStatus: quote.analysisStatus,
      clarification:  quote.clarification  || null,
      analysis:       quote.analysis       || null,
      workflowJson:   quote.workflow?.json || null,
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

// GET /api/quotes/:quoteId  — full quote (change order lookup)
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

// POST /api/quotes/:quoteId/info
// Collects client details after they've seen the quote.
// Creates or finds a User account, sends quote delivery + portal access emails.
router.post('/:quoteId/info', async (req, res) => {
  const { clientName, clientEmail, clientCompany = '' } = req.body;
  const quoteId = req.params.quoteId.toUpperCase();

  if (!clientName?.trim())         return res.status(400).json({ message: 'Name is required.' });
  if (!clientEmail?.includes('@')) return res.status(400).json({ message: 'A valid email is required.' });

  try {
    // 1. Update quote with client info
    const quote = await Quote.findOneAndUpdate(
      { quoteId },
      {
        clientName:    clientName.trim(),
        clientEmail:   clientEmail.trim().toLowerCase(),
        clientCompany: clientCompany.trim(),
        status:        'info_collected',
        $push: {
          messages: {
            role:    'user',
            content: `Contact info: ${clientName.trim()} <${clientEmail.trim().toLowerCase()}>`,
          },
        },
      },
      { new: true }
    );
    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    // 2. Create or find User account
    const email  = clientEmail.trim().toLowerCase();
    let user     = await User.findOne({ email });
    const isNew  = !user;

    if (!user) {
      user = await User.create({
        name:     clientName.trim(),
        email,
        company:  clientCompany.trim(),
        verified: true,
      });
    } else {
      // Update name/company if not already set
      let changed = false;
      if (!user.name && clientName.trim())    { user.name    = clientName.trim();    changed = true; }
      if (!user.company && clientCompany.trim()) { user.company = clientCompany.trim(); changed = true; }
      if (changed) await user.save();
    }

    // 3. Generate 48h magic link for portal first login
    const magicToken  = crypto.randomBytes(32).toString('hex');
    const magicExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await User.findByIdAndUpdate(user._id, {
      magicLinkToken:  magicToken,
      magicLinkExpiry: magicExpiry,
    });

    const portalUrl  = process.env.PORTAL_URL || 'http://localhost:5176';
    const portalLink = `${portalUrl}/auth/verify?token=${magicToken}`;

    // 4. Send quote delivery email
    const priceDisplay = quote.analysis
      ? `Complexity: ${quote.analysis.complexity_label} (${quote.analysis.complexity}/10)`
      : 'See your dashboard for full details';

    sendQuoteDelivery({
      name:    clientName.trim(),
      email,
      quoteId,
      price:   priceDisplay,
      company: clientCompany.trim() || 'n8n Pricing',
    }).catch(err => console.error('Quote delivery email failed:', err.message));

    // 5. Send portal access email
    sendEmail({
      to:      email,
      subject: `Access your tKle Business Dashboard — ${quoteId}`,
      body: [
        `Hi ${clientName.trim()},`,
        '',
        isNew
          ? `Thank you for your workflow request (${quoteId}). We've created your tKle Business Dashboard where you can track your order status.`
          : `Thank you for your new workflow request (${quoteId}). Track it in your tKle Business Dashboard.`,
        '',
        'Sign in to your dashboard:',
        portalLink,
        '',
        'This link expires in 48 hours.',
        `You can also sign in any time at: ${portalUrl}`,
        '',
        'What happens next:',
        '1. Our team will review your requirements',
        '2. You\'ll receive a full quote PDF by email',
        '3. Once approved, your workflow will be delivered via the dashboard',
        '',
        `Quote reference: ${quoteId}`,
        '',
        '— The tKle Team',
      ].join('\n'),
    }).catch(err => console.error('Portal access email failed:', err.message));

    console.log(`Info collected for ${quoteId}: ${email} (${isNew ? 'new' : 'existing'} user)`);
    res.json({ message: 'Info saved. Confirmation emails sent.', quoteId });

  } catch (err) {
    console.error('Quote info error:', err.message);
    res.status(500).json({ message: 'Failed to save info.' });
  }
});


// ── n8n Callbacks ─────────────────────────────────────────────────────────────

// GET /api/quotes/:quoteId/clarification — client polls for WF1 result
router.get('/:quoteId/clarification', async (req, res) => {
  try {
    const quote = await Quote.findOne({
      quoteId: req.params.quoteId.toUpperCase()
    }).select('quoteId status analysisStatus clarification').lean();

    if (!quote) return res.status(404).json({ message: 'Quote not found.' });

    if (quote.status === 'clarified' && quote.clarification?.understood) {
      return res.json({ quoteId: quote.quoteId, status: 'ready', clarification: quote.clarification });
    }
    if (quote.analysisStatus === 'failed' && !quote.clarification?.understood) {
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
  // const secret = process.env.N8N_WEBHOOK_SECRET;
  // if (secret && req.headers['x-webhook-secret'] !== secret) {
  //   return res.status(401).json({ message: 'Unauthorized' });
  // }

  const { clarification } = req.body;
  if (!clarification?.understood) {
    return res.status(400).json({ message: 'clarification.understood is required.' });
  }

  try {
    await Quote.findOneAndUpdate(
      { quoteId },
      {
        clarification,
        status:         'clarified',
        analysisStatus: 'processing',
        wf1CompletedAt: new Date(),
      }
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
  // const secret = process.env.N8N_WEBHOOK_SECRET;
  // if (secret && req.headers['x-webhook-secret'] !== secret) {
  //   return res.status(401).json({ message: 'Unauthorized' });
  // }

  const bodyRaw = Array.isArray(req.body) ? req.body[0] : req.body;

  let { analysis, workflow_json, summary } = bodyRaw;

  function safeParse(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return val; }
  }
  analysis      = safeParse(analysis);
  workflow_json = safeParse(workflow_json);
  summary       = safeParse(summary);

  if (!analysis || !workflow_json) {
    return res.status(400).json({ message: 'analysis and workflow_json are required.' });
  }

  try {
    const enrichedAnalysis = {
      ...analysis,
      workflow_summary: analysis.workflow_summary || summary?.description || '',
      workflow_name:    summary?.workflow_name    || analysis.workflow_name || '',
      node_count:       summary?.node_count       || analysis.node_count   || 0,
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
