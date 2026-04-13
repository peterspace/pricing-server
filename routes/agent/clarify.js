'use strict';
const express           = require('express');
const router            = express.Router();
const axios             = require('axios');
const AgentConversation = require('../../models/AgentConversation');
const AgentUser         = require('../../models/AgentUser');
const { agentProtect }  = require('../../middleware/agentAuth');

router.use(agentProtect);

// POST /api/agent/clarify
// Requires conversationId (created by POST /api/agent/conversations/init first).
// Triggers WF1-Agent fire-and-forget. Agent polls GET /api/agent/conversations/:id/clarification.
router.post('/', async (req, res) => {
  const { conversationId, prompt } = req.body;

  if (!conversationId) {
    return res.status(400).json({ message: 'conversationId is required. Call /api/agent/conversations/init first.' });
  }
  if (!prompt || prompt.trim().length < 10) {
    return res.status(400).json({ message: 'Please provide a more detailed request (at least 10 characters).' });
  }

  const n8nBase = process.env.N8N_BASE_URL;
  const secret  = process.env.N8N_WEBHOOK_SECRET;
  const wf1Path = process.env.N8N_WF1_AGENT_PATH || '/webhook/agent-quote-request';

  if (!n8nBase) {
    return res.status(503).json({ message: 'n8n integration not configured.' });
  }

  try {
    const conv = await AgentConversation.findOne({
      _id: conversationId, agentUserId: req.agent._id,
    });
    if (!conv) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    // If clarification already exists and prompt hasn't changed — return cached
    if (conv.clarification?.understood && conv.request === prompt.trim()) {
      console.log('Returning cached clarification for conv:', conversationId);
      return res.json({ conversationId, status: 'ready', clarification: conv.clarification });
    }

    // Quota check — only on the FIRST clarification of a new workflow.
    // Refinements (going back to clarify an existing conversation) don't consume quota.
    const isRefinement = !!(conv.clarification?.understood || conv.request);
    if (!isRefinement) {
      req.agent.resetQuotaIfNeeded();
      if (!req.agent.hasQuotaRemaining()) {
        return res.status(429).json({
          message: `You've used all ${req.agent.quotaLimit()} workflows this month. Upgrade to continue.`,
        });
      }
    }

    // Reset for new WF1 run
    conv.request        = prompt.trim();
    conv.status         = 'new';
    conv.analysisStatus = 'processing';
    conv.clarification  = null;
    conv.wf1SentAt      = new Date();
    // Save user message to thread
    conv.messages.push({ role: 'user', content: prompt.trim() });
    if (!conv.title || conv.title === 'New conversation') {
      conv.title = prompt.trim().slice(0, 60);
    }
    await conv.save();

    // Respond immediately — agent polls
    res.status(202).json({ conversationId, status: 'thinking' });

    // Build model info for n8n
    const modelInfo = getModelInfo(conv.model, req.agent);

    // Build conversation history (last 6 messages for context)
    const history = conv.messages.slice(-6).map(m => ({
      role:    m.role,
      content: m.clarification ? JSON.stringify(m.clarification) : m.content,
    }));

    // Fire WF1 in background
    const payload = {
      conversationId: conv._id.toString(),
      prompt:         prompt.trim(),
      history,
      model:          modelInfo.model,
      provider:       modelInfo.provider,
      apiKey:         modelInfo.apiKey,
    };
    const headers = {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    };

    axios.post(`${n8nBase}${wf1Path}`, payload, { headers, timeout: 120000 })
      .then(async response => {
        const body = response.data;
        if (body && typeof body === 'object') {
          const data = Array.isArray(body) ? body[0] : body;
          const clarification = data?.json?.clarification || data?.clarification;
          if (clarification?.understood) {
            await AgentConversation.findByIdAndUpdate(conv._id, {
              clarification,
              status:         'clarified',
              analysisStatus: 'processing',
              wf1CompletedAt: new Date(),
              $push: { messages: { role: 'assistant', content: clarification.greeting, clarification } },
            });
            await AgentUser.findByIdAndUpdate(req.agent._id, { $inc: { quotesUsedThisMonth: 1 } });
            console.log('WF1-Agent clarification saved (direct) for conv:', conv._id);
            return;
          }
        }
        console.log('WF1-Agent (noData mode), waiting for callback for conv:', conv._id);
      })
      .catch(async err => {
        console.error('WF1-Agent failed for conv', conv._id, ':', err.message);
        await AgentConversation.findByIdAndUpdate(conv._id, {
          status: 'new', analysisStatus: 'failed',
        });
      });

  } catch (err) {
    console.error('Agent clarify error:', err.message);
    res.status(500).json({ message: 'Failed to start analysis. Please try again.' });
  }
});

// ── Helper: build model info from conversation model ID + agent keys ──────────
function getModelInfo(model, agent) {
  const map = {
    'claude-sonnet-4-6':  { provider: 'claude',  model: 'claude-sonnet-4-6' },
    'claude-opus-4-6':    { provider: 'claude',  model: 'claude-opus-4-6' },
    'claude-haiku-4-5':   { provider: 'claude',  model: 'claude-haiku-4-5-20251001' },
    'gpt-5.4-pro':        { provider: 'openai',  model: 'gpt-5.4-pro' },
    'gpt-5.1':            { provider: 'openai',  model: 'gpt-5.1' },
    'gpt-5-mini':         { provider: 'openai',  model: 'gpt-5-mini' },
    'gpt-4o':             { provider: 'openai',  model: 'gpt-4o' },
    'gemma4-31b':         { provider: 'ollama',  model: 'gemma4:31b-cloud' },
    'qwen3-vl-235b':      { provider: 'ollama',  model: 'qwen3-vl:235b-cloud' },
    'qwen3-5-397b':       { provider: 'ollama',  model: 'qwen3.5:397b-cloud' },
  };
  const info = map[model] || { provider: 'ollama', model: 'qwen3.5:397b-cloud' };
  const paidProviders = ['claude', 'openai'];
  let apiKey = null;
  if (paidProviders.includes(info.provider)) {
    const keyObj = agent?.aiKeys?.[info.provider];
    apiKey = keyObj?.enabled && keyObj?.key ? keyObj.key : null;
  }
  return { ...info, apiKey };
}

module.exports = router;
module.exports.getModelInfo = getModelInfo;
