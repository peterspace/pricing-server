'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const Payment    = require('../../models/Payment');
const Subscription = require('../../models/Subscription');
const Stripe       = require('stripe');
const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);

function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'week':    return new Date(now - 7   * 86400000);
    case 'quarter': return new Date(now - 90  * 86400000);
    case 'year':    return new Date(now - 365 * 86400000);
    default:        return new Date(now - 30  * 86400000);
  }
}

// GET /api/admin/accounting/revenue
router.get('/revenue', protect, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    const since = periodStart(period);

    const [totals, refunds, mrr, chart] = await Promise.all([
      Payment.aggregate([
        { $match: { status: 'paid', paidAt: { $gte: since } } },
        {
          $group: {
            _id:     '$type',
            total:   { $sum: '$amount' },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { status: 'refunded', refundedAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$refundedAmount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, mrr: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { status: 'paid', paidAt: { $gte: since } } },
        {
          $group: {
            _id:     { $dateToString: { format: '%m/%d', date: '$paidAt' } },
            revenue: { $sum: '$amount' },
            quotes:  { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { label: '$_id', revenue: 1, quotes: 1, _id: 0 } },
      ]),
    ]);

    const total   = totals.reduce((s, t) => s + t.total, 0);
    const oneTime = totals.find(t => t._id === 'one-time')?.total || 0;

    res.json({
      total,
      mrr:     mrr[0]?.mrr || 0,
      oneTime,
      refunds: refunds[0]?.total || 0,
      chart,
    });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/accounting/invoices
router.get('/invoices', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [invoices, total] = await Promise.all([
      Payment.find().sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Payment.countDocuments(),
    ]);
    res.json({ invoices, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/accounting/refund/:id
router.post('/refund/:id', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    if (payment.status !== 'paid') return res.status(400).json({ message: 'Payment not eligible for refund' });

    const refundAmt = Math.min(parseFloat(amount), payment.amount);

    if (payment.stripePaymentId) {
      await stripe.refunds.create({
        payment_intent: payment.stripePaymentId,
        amount:         Math.round(refundAmt * 100),
      });
    }

    await Payment.findByIdAndUpdate(req.params.id, {
      status:         'refunded',
      refundedAmount: refundAmt,
      refundedAt:     new Date(),
    });

    res.json({ message: `Refund of $${refundAmt} issued` });
  } catch (err) {
    console.error('Refund error:', err.message);
    res.status(500).json({ message: 'Refund failed' });
  }
});

module.exports = router;
