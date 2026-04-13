'use strict';
const express           = require('express');
const router            = express.Router();
const axios             = require('axios');
const AgentConversation = require('../../models/AgentConversation');
const { agentProtect }  = require('../../middleware/agentAuth');
const { getModelInfo }  = require('./clarify');

router.use(agentProtect);

// POST /api/agent/analyse
// conversationId comes from the agent (returned by /api/agent/clarify).
// Updates the existing conversation record then fires WF23-Agent in background.
router.post('/', async (req, res) => {
  const { conversationId, prompt, clarification } = req.body;

  if (!conversationId) {
    return res.status(400).json({ message: 'conversationId is required.' });
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a detailed automation description.' });
  }

  try {
    const conv = await AgentConversation.findOne({
      _id: conversationId, agentUserId: req.agent._id,
    });
    if (!conv) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    conv.status         = 'analysing';
    conv.analysisStatus = 'processing';
    conv.wf23SentAt     = new Date();
    if (clarification) conv.clarification = clarification;
    await conv.save();

    // Respond immediately — agent starts polling
    res.status(202).json({
      conversationId,
      status:  'processing',
      message: 'Analysis started. Poll /api/agent/conversations/:id/status for updates.',
    });

    // Fire WF23 in background
    const n8nBase  = process.env.N8N_BASE_URL;
    const secret   = process.env.N8N_WEBHOOK_SECRET;
    const wf23Path = process.env.N8N_WF23_AGENT_PATH || '/webhook/agent-confirm-clarification';

    if (!n8nBase) {
      console.warn('N8N_BASE_URL not set — skipping WF23-Agent trigger');
      return;
    }

    const modelInfo = getModelInfo(conv.model, req.agent);

    axios.post(
      `${n8nBase}${wf23Path}`,
      {
        conversationId: conv._id.toString(),
        prompt:         prompt.trim(),
        clarification:  clarification || conv.clarification || null,
        model:          modelInfo.model,
        provider:       modelInfo.provider,
        apiKey:         modelInfo.apiKey,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-webhook-secret': secret } : {}),
        },
        timeout: 300000,
      }
    ).catch(async err => {
      console.error(`WF23-Agent trigger failed for conv ${conversationId}:`, err.message);
      await AgentConversation.findByIdAndUpdate(conversationId, {
        analysisStatus: 'failed', status: 'new',
      });
    });

  } catch (err) {
    console.error('Agent analyse route error:', err.message);
    res.status(500).json({ message: 'Failed to start analysis. Please try again.' });
  }
});

module.exports = router;
