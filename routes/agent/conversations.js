'use strict';
const express = require('express');
const router = express.Router();
const axios = require('axios');
const AgentConversation = require('../../models/AgentConversation');
const AgentUser = require('../../models/AgentUser');
const { agentProtect } = require('../../middleware/agentAuth');

// router.use(agentProtect);

// GET /api/agent/conversations
router.get('/', async (req, res) => {
  try {
    const conversations = await AgentConversation.find({
      agentUserId: req.agent._id,
      status: 'active',
    })
      .select('_id title model analysisStatus updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ conversations });
  } catch {
    res.status(500).json({ message: 'Failed to load conversations.' });
  }
});

// POST /api/agent/conversations
router.post('/', async (req, res) => {
  const { title = 'New conversation', model = 'default' } = req.body;
  try {
    const conv = await AgentConversation.create({
      agentUserId: req.agent._id,
      title,
      model,
    });
    res.status(201).json({ conversation: conv.toObject() });
  } catch {
    res.status(500).json({ message: 'Failed to create conversation.' });
  }
});

// GET /api/agent/conversations/:id
router.get('/:id', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id,
      agentUserId: req.agent._id,
    }).lean();
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ conversation: conv });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// PATCH /api/agent/conversations/:id
router.patch('/:id', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim())
    return res.status(400).json({ message: 'Title is required.' });
  try {
    const conv = await AgentConversation.findOneAndUpdate(
      { _id: req.params.id, agentUserId: req.agent._id },
      { title: title.trim() },
      { new: true },
    ).lean();
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ conversation: conv });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/agent/conversations/:id
router.delete('/:id', async (req, res) => {
  try {
    await AgentConversation.findOneAndUpdate(
      { _id: req.params.id, agentUserId: req.agent._id },
      { status: 'archived' },
    );
    res.json({ message: 'Conversation archived.' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/agent/conversations/:id/message
router.post('/:id/message', async (req, res) => {
  const { content, model } = req.body;
  if (!content?.trim())
    return res.status(400).json({ message: 'Message content is required.' });

  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id,
      agentUserId: req.agent._id,
    });
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });

    // ── Quota check ──────────────────────────────────────────────────────────
    req.agent.resetQuotaIfNeeded();
    if (!req.agent.hasQuotaRemaining()) {
      return res.status(429).json({
        message: `You've used all ${req.agent.quotaLimit()} quotes this month. Upgrade to continue.`,
      });
    }

    // Save user message + reset clarification for new run
    conv.messages.push({ role: 'user', content: content.trim() });
    if (model) conv.model = model;
    conv.clarification = null;
    conv.analysisStatus = 'clarifying';
    await conv.save();

    // Respond immediately — client polls
    res.status(202).json({ status: 'thinking', conversationId: conv._id });

    // ── Fire WF1-Agent ────────────────────────────────────────────────────────
    const n8nBase = process.env.N8N_BASE_URL;
    const secret = process.env.N8N_WEBHOOK_SECRET;
    const wf1Path =
      process.env.N8N_WF1_AGENT_PATH || '/webhook-test/agent-quote-request';
    if (!n8nBase) {
      console.warn('N8N_BASE_URL not set — skipping WF1-Agent');
      return;
    }

    const modelInfo = getModelInfo(conv.model, req.agent);
    const history = conv.messages.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.clarification ? JSON.stringify(m.clarification) : m.content,
    }));

    axios
      .post(
        `${n8nBase}${wf1Path}`,
        {
          conversationId: conv._id.toString(),
          prompt: content.trim(),
          history,
          model: modelInfo.model,
          provider: modelInfo.provider,
          apiKey: modelInfo.apiKey,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-webhook-secret': secret } : {}),
          },
          timeout: 120000,
        },
      )
      .then(async (response) => {
        const body = response.data;
        if (body && typeof body === 'object') {
          const data = Array.isArray(body) ? body[0] : body;
          const clarification =
            data?.json?.clarification || data?.clarification;
          if (clarification?.understood) {
            await AgentConversation.findByIdAndUpdate(conv._id, {
              clarification,
              analysisStatus: 'idle',
              $push: {
                messages: {
                  role: 'assistant',
                  content: clarification.greeting,
                  clarification,
                },
              },
            });
            // ── FIX: increment quota by agentUserId (not by conversations field)
            await AgentUser.findByIdAndUpdate(req.agent._id, {
              $inc: { quotesUsedThisMonth: 1 },
            });
            console.log(
              'WF1-Agent clarification saved (direct) for conv:',
              conv._id,
            );
            return;
          }
        }
        console.log(
          'WF1-Agent (noData mode), waiting for callback for conv:',
          conv._id,
        );
      })
      .catch(async (err) => {
        console.error('WF1-Agent failed for conv', conv._id, ':', err.message);
        await AgentConversation.findByIdAndUpdate(conv._id, {
          analysisStatus: 'failed',
        });
      });
  } catch (err) {
    console.error('Agent message error:', err.message);
    res.status(500).json({ message: 'Failed to process message.' });
  }
});

// GET /api/agent/conversations/:id/clarification — poll for WF1 result
router.get('/:id/clarification', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id,
      agentUserId: req.agent._id,
    })
      .select('clarification analysisStatus updatedAt')
      .lean();
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });

    if (conv.clarification?.understood) {
      return res.json({ status: 'ready', clarification: conv.clarification });
    }
    if (conv.analysisStatus === 'failed') {
      return res.json({ status: 'failed' });
    }

    // Auto-expire: if stuck in clarifying for > 12 min (n8n probably crashed),
    // reset to idle so a refreshed client doesn't resume polling indefinitely
    if (conv.analysisStatus === 'clarifying') {
      const stuckMs = Date.now() - new Date(conv.updatedAt).getTime();
      if (stuckMs > 12 * 60 * 1000) {
        await AgentConversation.findByIdAndUpdate(req.params.id, {
          analysisStatus: 'idle',
        });
        return res.json({ status: 'expired' });
      }
    }

    res.json({ status: 'thinking' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/agent/conversations/:id/clarification — poll for WF1 result
router.post('/:conversationId/clarification', async (req, res) => {
  const conversationId = req.params.conversationId.toUpperCase();

  console.log({ conversationId });
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.conversationId,
    })
      .select('clarification analysisStatus updatedAt')
      .lean();
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });

    if (conv.clarification?.understood) {
      return res.json({ status: 'ready', clarification: conv.clarification });
    }
    if (conv.analysisStatus === 'failed') {
      return res.json({ status: 'failed' });
    }

    // Auto-expire: if stuck in clarifying for > 12 min (n8n probably crashed),
    // reset to idle so a refreshed client doesn't resume polling indefinitely
    if (conv.analysisStatus === 'clarifying') {
      const stuckMs = Date.now() - new Date(conv.updatedAt).getTime();
      if (stuckMs > 12 * 60 * 1000) {
        await AgentConversation.findByIdAndUpdate(req.params.conversationId, {
          analysisStatus: 'idle',
        });
        return res.json({ status: 'expired' });
      }
    }

    res.json({ status: 'thinking' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/quotes/:quoteId/clarification — WF1 production callback
router.post('/:id/clarificationTest', async (req, res) => {
  const conversationId = req.params.id.toUpperCase();
  const secret = process.env.N8N_WEBHOOK_SECRET;

  // if (secret && req.headers['x-webhook-secret'] !== secret) {
  //   return res.status(401).json({ message: 'Unauthorized' });
  // }

  const { clarification } = req.body;
  if (!clarification?.understood) {
    return res
      .status(400)
      .json({ message: 'clarification.understood is required.' });
  }

  try {
    // ── FIX: reset analysisStatus to 'processing' so polling doesn't return 'failed'
    // when this quote had a previous failed attempt
    await AgentConversation.findOneAndUpdate(
      { _id: req.params.id },
      {
        clarification,
        status: 'clarified',
        analysisStatus: 'processing',
        wf1CompletedAt: new Date(),
      },
    );
    console.log('WF1 callback saved clarification for:', conversationId);
    res.json({ message: 'Clarification saved.', conversationId });
  } catch (err) {
    console.error('Clarification callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

// POST /api/agent/conversations/:id/cancel — client-side cancel, resets stuck status
router.post('/:id/cancel', async (req, res) => {
  try {
    const conv = await AgentConversation.findOneAndUpdate(
      {
        _id: req.params.id,
        agentUserId: req.agent._id,
        analysisStatus: { $in: ['clarifying', 'generating'] }, // only reset if in-progress
      },
      { analysisStatus: 'idle', clarification: null },
      { new: true },
    );
    // Return 200 even if not found — cancel is idempotent
    res.json({ message: 'Cancelled.', cancelled: !!conv });
  } catch (err) {
    console.error('Cancel error:', err.message);
    res.status(500).json({ message: 'Failed to cancel.' });
  }
});

// POST /api/agent/conversations/:id/generate — trigger WF23-Agent
router.post('/:id/generate', async (req, res) => {
  const { model } = req.body;
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id,
      agentUserId: req.agent._id,
    });
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });
    if (!conv.clarification?.understood) {
      return res
        .status(400)
        .json({ message: 'No clarification yet. Send a message first.' });
    }

    conv.analysisStatus = 'generating';
    if (model) conv.model = model;
    await conv.save();

    res.status(202).json({ status: 'generating', conversationId: conv._id });

    const n8nBase = process.env.N8N_BASE_URL;
    const secret = process.env.N8N_WEBHOOK_SECRET;
    const wf23Path =
      process.env.N8N_WF23_AGENT_PATH ||
      '/webhook-test/agent-confirm-clarification';
    if (!n8nBase) return;

    const modelInfo = getModelInfo(conv.model, req.agent);
    const enrichedPrompt = buildEnrichedPrompt(conv);

    axios
      .post(
        `${n8nBase}${wf23Path}`,
        {
          conversationId: conv._id.toString(),
          enrichedPrompt,
          clarification: conv.clarification,
          model: modelInfo.model,
          provider: modelInfo.provider,
          apiKey: modelInfo.apiKey,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-webhook-secret': secret } : {}),
          },
          timeout: 300000,
        },
      )
      .catch(async (err) => {
        console.error('WF23-Agent failed for conv', conv._id, ':', err.message);
        await AgentConversation.findByIdAndUpdate(conv._id, {
          analysisStatus: 'failed',
        });
      });
  } catch (err) {
    console.error('Agent generate error:', err.message);
    res.status(500).json({ message: 'Failed to start workflow generation.' });
  }
});

// GET /api/agent/conversations/:id/status — poll for WF23 result
router.get('/:id/status', async (req, res) => {
  try {
    const conv = await AgentConversation.findOne({
      _id: req.params.id,
      agentUserId: req.agent._id,
    })
      .select('analysisStatus analysis workflowJson')
      .lean();
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });

    if (conv.analysisStatus === 'ready' && conv.workflowJson) {
      return res.json({
        status: 'ready',
        analysis: conv.analysis,
        workflow_json: conv.workflowJson,
      });
    }
    if (conv.analysisStatus === 'failed') return res.json({ status: 'failed' });
    res.json({ status: 'generating' });
  } catch {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/agent/conversations/:id/result — WF23-Agent callback from n8n
router.post('/:id/result', async (req, res) => {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  // if (secret && req.headers['x-webhook-secret'] !== secret) {
  //   return res.status(401).json({ message: 'Unauthorized' });
  // }

  const bodyRaw = Array.isArray(req.body) ? req.body[0] : req.body;
  let { analysis, workflow_json, summary } = bodyRaw;

  function safeParse(v) {
    if (!v || typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  analysis = safeParse(analysis);
  workflow_json = safeParse(workflow_json);
  summary = safeParse(summary);

  if (!analysis || !workflow_json) {
    return res
      .status(400)
      .json({ message: 'analysis and workflow_json are required.' });
  }

  try {
    const enrichedAnalysis = {
      ...analysis,
      workflow_summary: analysis.workflow_summary || summary?.description || '',
      workflow_name: summary?.workflow_name || analysis.workflow_name || '',
      node_count: summary?.node_count || analysis.node_count || 0,
    };

    const conv = await AgentConversation.findByIdAndUpdate(
      req.params.id,
      {
        analysis: enrichedAnalysis,
        workflowJson: workflow_json,
        analysisStatus: 'ready',
        $push: {
          messages: {
            role: 'assistant',
            content: `Here's your workflow: ${enrichedAnalysis.workflow_name || 'Automation Workflow'}`,
            workflow: workflow_json,
            analysis: enrichedAnalysis,
          },
        },
      },
      { new: true },
    );

    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });
    console.log(`WF23-Agent result saved for conv ${req.params.id}`);
    res.json({ message: 'Result saved.', conversationId: req.params.id });
  } catch (err) {
    console.error('WF23-Agent result error:', err.message);
    res.status(500).json({ message: 'Failed to save result.' });
  }
});

// POST /api/agent/conversations/:id/clarification — WF1-Agent production callback
router.post('/:id/clarification', async (req, res) => {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  // if (secret && req.headers['x-webhook-secret'] !== secret) {
  //   return res.status(401).json({ message: 'Unauthorized' });
  // }

  const { clarification, agentUserId } = req.body;
  if (!clarification?.understood) {
    return res
      .status(400)
      .json({ message: 'clarification.understood is required.' });
  }

  try {
    const conv = await AgentConversation.findByIdAndUpdate(
      req.params.id,
      {
        clarification,
        analysisStatus: 'idle',
        $push: {
          messages: {
            role: 'assistant',
            content: clarification.greeting,
            clarification,
          },
        },
      },
      { new: true },
    );
    if (!conv)
      return res.status(404).json({ message: 'Conversation not found.' });

    // ── FIX: use agentUserId from conv (reliable) not from body
    await AgentUser.findByIdAndUpdate(conv.agentUserId, {
      $inc: { quotesUsedThisMonth: 1 },
    });

    res.json({
      message: 'Clarification saved.',
      conversationId: req.params.id,
    });
  } catch (err) {
    console.error('WF1-Agent callback error:', err.message);
    res.status(500).json({ message: 'Failed to save clarification.' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getModelInfo(model, agent) {
  // Keys must match the ROUTE_MAP in WF1 Set Route node: "provider:model"
  const map = {
    // ── Anthropic Claude ────────────────────────────────────────────────────
    'claude-sonnet-4-6': { provider: 'claude', model: 'claude-sonnet-4-6' },
    'claude-opus-4-6': { provider: 'claude', model: 'claude-opus-4-6' },
    'claude-haiku-4-5': {
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
    },
    // ── OpenAI ──────────────────────────────────────────────────────────────
    'gpt-5.4-pro': { provider: 'openai', model: 'gpt-5.4-pro' },
    'gpt-5.1': { provider: 'openai', model: 'gpt-5.1' },
    'gpt-5-mini': { provider: 'openai', model: 'gpt-5-mini' },
    'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
    // ── Google Gemini ────────────────────────────────────────────────────────
    // 'gemini-1.5-pro':             { provider: 'gemini',  model: 'gemini-1.5-pro' },
    // 'gemini-1.5-flash':           { provider: 'gemini',  model: 'gemini-1.5-flash' },
    // ── Ollama (your server credentials — no user key needed) ───────────────
    'gemma4-31b': { provider: 'ollama', model: 'gemma4:31b-cloud' },
    'qwen3-vl-235b': { provider: 'ollama', model: 'qwen3-vl:235b-cloud' },
    'qwen3-5-397b': { provider: 'ollama', model: 'qwen3.5:397b-cloud' },
    // 'gemini-3-flash-preview':     { provider: 'ollama',  model: 'gemini-3-flash-preview:cloud' },
  };

  const info = map[model] || {
    provider: 'ollama',
    model: 'qwen3.5:397b-cloud',
  }; // unknown → Qwen fallback

  // Only attach apiKey for paid providers (Claude, OpenAI, Gemini)
  const paidProviders = ['claude', 'openai', 'gemini'];
  let apiKey = null;
  if (paidProviders.includes(info.provider)) {
    const keyObj = agent?.aiKeys?.[info.provider];
    apiKey = keyObj?.enabled && keyObj?.key ? keyObj.key : null;
  }

  return { ...info, apiKey };
}

function buildEnrichedPrompt(conv) {
  const parts = [];
  const userMsgs = conv.messages.filter((m) => m.role === 'user');
  if (userMsgs[0]) parts.push('## Original request\n' + userMsgs[0].content);
  if (conv.clarification?.steps?.length) {
    parts.push('\n## Confirmed workflow understanding');
    conv.clarification.steps.forEach((s) => {
      parts.push(`\n### Step ${s.number}: ${s.title}\n${s.description}`);
    });
  }
  if (userMsgs.length > 1) {
    parts.push('\n## Additional context from conversation');
    userMsgs.slice(1).forEach((m) => parts.push(m.content));
  }
  return parts.join('\n');
}

module.exports = router;
