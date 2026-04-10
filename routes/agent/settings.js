'use strict';
const express          = require('express');
const router           = express.Router();
const AgentUser        = require('../../models/AgentUser');
const { agentProtect } = require('../../middleware/agentAuth');

router.use(agentProtect);

// GET /api/agent/settings
router.get('/', async (req, res) => {
  const agent = req.agent.toPublic();
  res.json({
    settings: {
      ...agent,
      quotesRemaining: Math.max(0, req.agent.quotaLimit() - req.agent.quotesUsedThisMonth),
      quotaLimit:      req.agent.quotaLimit(),
    }
  });
});

// PUT /api/agent/settings/ai-keys
router.put('/ai-keys', async (req, res) => {
  const { openai, claude, gemini } = req.body;
  try {
    const update = {};
    if (openai !== undefined) {
      update['aiKeys.openai.enabled'] = openai.enabled ?? false;
      if (openai.key) update['aiKeys.openai.key'] = openai.key; // TODO: encrypt
    }
    if (claude !== undefined) {
      update['aiKeys.claude.enabled'] = claude.enabled ?? false;
      if (claude.key) update['aiKeys.claude.key'] = claude.key;
    }
    if (gemini !== undefined) {
      update['aiKeys.gemini.enabled'] = gemini.enabled ?? false;
      if (gemini.key) update['aiKeys.gemini.key'] = gemini.key;
    }

    const updated = await AgentUser.findByIdAndUpdate(
      req.agent._id, { $set: update }, { new: true }
    );
    res.json({ message: 'Keys saved.', settings: updated.toPublic() });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save keys.' });
  }
});

// PUT /api/agent/settings/pricing
router.put('/pricing', async (req, res) => {
  const { pricingConfig, showPricingToClients, priceCapEnabled, priceCap } = req.body;
  try {
    await AgentUser.findByIdAndUpdate(req.agent._id, {
      ...(pricingConfig          !== undefined && { pricingConfig }),
      ...(showPricingToClients   !== undefined && { showPricingToClients }),
      ...(priceCapEnabled        !== undefined && { priceCapEnabled }),
      ...(priceCap               !== undefined && { priceCap }),
    });
    res.json({ message: 'Pricing config saved.' });
  } catch {
    res.status(500).json({ message: 'Failed to save pricing config.' });
  }
});

// PUT /api/agent/settings/model
router.put('/model', async (req, res) => {
  const { defaultModel } = req.body;
  if (!defaultModel) return res.status(400).json({ message: 'defaultModel is required.' });
  try {
    await AgentUser.findByIdAndUpdate(req.agent._id, { defaultModel });
    res.json({ message: 'Default model saved.' });
  } catch {
    res.status(500).json({ message: 'Failed to save model.' });
  }
});

module.exports = router;
