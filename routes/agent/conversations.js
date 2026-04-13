'use strict';
const express           = require('express');
const router            = express.Router();
const AgentConversation = require('../../models/AgentConversation');
const AgentUser         = require('../../models/AgentUser');
const { agentProtect }  = require('../../middleware/agentAuth');

router.use(agentProtect);

// ── Conversation CRUD ─────────────────────────────────────────────────────────

// GET /api/agent/conversations
router.get('/', async (req, res) => {
  try {
    const convs = await AgentConversation.find({
      agentUserId: req.agent._id,
      status: { $ne: 'archived' },
    })
    .select('_id title model status analysisStatus updatedAt createdAt')
    .sort({ updatedAt: -1 })
    .lean();
    res.json({ conversations: convs });
  } catch {
    res.status(500).json({ message: 'Failed to load conversations.' });
  }
});

// POST /api/agent/conversations/init
// Creates a new conversation record. Idempotent — returns existing if id provided.
router.post('/init', async (req, res) => {
  const { conversationId, request = '', model = 'qwen3-5-397b' } = req.body;

  try {
    // Return existing if client already has an id
    if (conversationId) {
      const existing = await AgentConversation.findOne({
        _id: conversationId, agentUserId: req.agent._id,
      }).select('_id title status analysisStatus clarification model').lean();

      if (existing) {
        return res.json({
          conversationId:   existing._id,
          isExisting:       true,
          hasClarification: !!(existing.clarification?.understood),
          model:            existing.model,
        });
      }
    }

    const conv = await AgentConversation.create({
      agentUserId:    req.agent._id,
      title:          request.trim().slice(0, 60) || 'New conversation',
      model:          model,
      request:        request.trim(),
      status:         'new',
      analysisStatus: 'processing',
    });

    res.status(201).json({
      conversationId:   conv._id,
      isExisting:       false,
      hasClarification: false,
      model:            conv.model,
    });
  } catch (err) {
    console.error('Agent conversations init error:', err.message);
    res.status(500).json({ message: 'Failed to initialise conversation.' });
  }
});

// GET /api/agent/conversations/:id
router.get('/:id', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id, agentUserId: req.agent._id,
    }).lean();
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ conversation: conv });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// PATCH /api/agent/conversations/:id — rename
router.patch('/:id', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: 'Title is required.' });
  try {
    const conv = await AgentConversation.findOneAndUpdate(
      { _id: req.params.id, agentUserId: req.agent._id },
      { title: title.trim() },
      { new: true }
    ).lean();
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ conversation: conv });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/agent/conversations/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    await AgentConversation.findOneAndUpdate(
      { _id: req.params.id, agentUserId: req.agent._id },
      { status: 'archived' }
    );
    res.json({ message: 'Conversation archived.' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// ── Status & polling ──────────────────────────────────────────────────────────

// GET /api/agent/conversations/:id/clarification — poll for WF1 result
router.get('/:id/clarification', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id, agentUserId: req.agent._id,
    }).select('status analysisStatus clarification updatedAt').lean();
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });

    if (conv.status === 'clarified' && conv.clarification?.understood) {
      return res.json({ conversationId: req.params.id, status: 'ready', clarification: conv.clarification });
    }
    if (conv.analysisStatus === 'failed' && !conv.clarification?.understood) {
      return res.json({ conversationId: req.params.id, status: 'failed' });
    }

    // Auto-expire stuck clarifications (> 12 min)
    if (conv.analysisStatus === 'processing') {
      const stuckMs = Date.now() - new Date(conv.updatedAt).getTime();
      if (stuckMs > 12 * 60 * 1000) {
        await AgentConversation.findByIdAndUpdate(req.params.id, {
          analysisStatus: 'failed', status: 'new',
        });
        return res.json({ conversationId: req.params.id, status: 'expired' });
      }
    }

    res.json({ conversationId: req.params.id, status: 'thinking' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/agent/conversations/:id/status — poll for WF23 result
router.get('/:id/status', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id, agentUserId: req.agent._id,
    }).select('status analysisStatus analysis workflow updatedAt').lean();
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });

    if (conv.analysisStatus === 'ready' && conv.workflow?.json) {
      return res.json({
        conversationId: req.params.id,
        status:         'ready',
        analysisStatus: 'ready',
        analysis:       conv.analysis,
        workflowJson:   conv.workflow.json,
      });
    }
    if (conv.analysisStatus === 'failed') {
      return res.json({ conversationId: req.params.id, status: 'failed' });
    }

    // Auto-expire stuck WF23 (> 15 min)
    if (conv.status === 'analysing') {
      const stuckMs = Date.now() - new Date(conv.updatedAt).getTime();
      if (stuckMs > 15 * 60 * 1000) {
        await AgentConversation.findByIdAndUpdate(req.params.id, {
          analysisStatus: 'failed', status: 'clarified',
        });
        return res.json({ conversationId: req.params.id, status: 'failed' });
      }
    }

    res.json({ conversationId: req.params.id, status: 'processing', analysisStatus: 'processing' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/agent/conversations/:id/resume — restore step state after page refresh
router.get('/:id/resume', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id, agentUserId: req.agent._id,
    }).select('_id title model status analysisStatus clarification analysis workflow request').lean();
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });

    // Determine which step to resume at (mirrors client resumeQuote logic)
    let resumeStep = 1;
    if (conv.request)                          resumeStep = 2; // has request → Clarify
    if (conv.status === 'clarified')           resumeStep = 2; // clarified → still on Clarify (accept not yet hit)
    if (conv.status === 'analysing')           resumeStep = 3; // analysing → Analyse step (polling)
    if (conv.analysisStatus === 'ready')       resumeStep = 4; // done → Quote
    if (conv.analysisStatus === 'failed' && conv.status !== 'clarified') resumeStep = 2;

    res.json({
      conversationId: conv._id,
      resumeStep,
      title:          conv.title,
      model:          conv.model,
      status:         conv.status,
      analysisStatus: conv.analysisStatus,
      request:        conv.request || '',
      clarification:  conv.clarification || null,
      analysis:       conv.analysis || null,
      workflowJson:   conv.workflow?.json || null,
    });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/agent/conversations/:id/cancel — reset stuck status
router.post('/:id/cancel', async (req, res) => {
  try {
    const conv = await AgentConversation.findOneAndUpdate(
      {
        _id: req.params.id,
        agentUserId: req.agent._id,
        analysisStatus: 'processing',
      },
      { analysisStatus: 'failed', status: 'new' },
      { new: true }
    );
    res.json({ message: 'Cancelled.', cancelled: !!conv });
  } catch (err) {
    console.error('Cancel error:', err.message);
    res.status(500).json({ message: 'Failed to cancel.' });
  }
});

// ── n8n Callbacks ─────────────────────────────────────────────────────────────

// POST /api/agent/conversations/:id/clarification — WF1-Agent callback
router.post('/:id/clarification', async (req, res) => {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { clarification } = req.body;
  if (!clarification?.understood) {
    return res.status(400).json({ message: 'clarification.understood is required.' });
  }

  try {
    const conv = await AgentConversation.findByIdAndUpdate(
      req.params.id,
      {
        clarification,
        status:         'clarified',
        analysisStatus: 'processing',
        wf1CompletedAt: new Date(),
        $push: { messages: { role: 'assistant', content: clarification.greeting, clarification } },
      },
      { new: true }
    );
    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });

    await AgentUser.findByIdAndUpdate(conv.agentUserId, { $inc: { quotesUsedThisMonth: 1 } });
    console.log('WF1-Agent callback saved clarification for conv:', req.params.id);
    res.json({ message: 'Clarification saved.', conversationId: req.params.id });
  } catch (err) {
    console.error('WF1-Agent callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

// POST /api/agent/conversations/:id/result — WF23-Agent callback
router.post('/:id/result', async (req, res) => {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const bodyRaw = Array.isArray(req.body) ? req.body[0] : req.body;
  let { analysis, workflow_json, summary } = bodyRaw;

  function safeParse(v) {
    if (!v || typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return v; }
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

    const conv = await AgentConversation.findByIdAndUpdate(
      req.params.id,
      {
        analysis:       enrichedAnalysis,
        workflow:       {
          json:        workflow_json,
          generatedAt: new Date(),
        },
        analysisStatus: 'ready',
        status:         'delivered',
        $push: {
          messages: {
            role:     'assistant',
            content:  `Workflow ready: ${enrichedAnalysis.workflow_name || 'Automation Workflow'}`,
            analysis: enrichedAnalysis,
          },
        },
      },
      { new: true }
    );

    if (!conv) return res.status(404).json({ message: 'Conversation not found.' });
    console.log(`WF23-Agent result saved for conv ${req.params.id}`);
    res.json({ message: 'Result saved.', conversationId: req.params.id });
  } catch (err) {
    console.error('WF23-Agent result error:', err.message);
    res.status(500).json({ message: 'Failed to save result.' });
  }
});

module.exports = router;
