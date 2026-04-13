'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const audit      = require('../../middleware/audit');
const Subscription = require('../../models/Subscription');
const Stripe       = require('stripe');
const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);

// GET /api/admin/subscriptions
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Subscription.countDocuments(filter),
    ]);
    res.json({ subscriptions, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/subscriptions/:id/cancel
router.post('/:id/cancel', protect, audit('cancel_subscription', 'Subscription'), async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });

    if (sub.stripeSubscriptionId) {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    }

    await Subscription.findByIdAndUpdate(req.params.id, {
      status:      'cancelled',
      cancelledAt: new Date(),
    });

    res.json({ message: 'Subscription cancelled' });
  } catch (err) {
    console.error('Cancel subscription error:', err.message);
    res.status(500).json({ message: 'Cancellation failed' });
  }
});

module.exports = router;
