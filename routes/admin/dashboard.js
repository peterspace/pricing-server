'use strict';
const express      = require('express');
const router       = express.Router();
const { protect }  = require('../../middleware/auth');
const Quote        = require('../../models/Quote');
const User         = require('../../models/User');
const Subscription = require('../../models/Subscription');
const Payment      = require('../../models/Payment');
const Settings     = require('../../models/Settings');

function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'week':    return new Date(now - 7  * 86400000);
    case 'quarter': return new Date(now - 90 * 86400000);
    case 'year':    return new Date(now - 365* 86400000);
    default:        return new Date(now - 30 * 86400000); // month
  }
}

router.get('/', protect, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    const since = periodStart(period);

    const [
      totalRevenue,
      activeQuotes,
      activeSubs,
      newUsers,
      recentOrders,
      planBreakdown,
      revenueChart,
      settings,
    ] = await Promise.all([
      Payment.aggregate([
        { $match: { status: 'paid', paidAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Quote.countDocuments({ status: { $in: ['draft', 'pending'] }, createdAt: { $gte: since } }),
      Subscription.countDocuments({ status: 'active' }),
      User.countDocuments({ createdAt: { $gte: since }, deletedAt: null }),
      Quote.find().sort({ createdAt: -1 }).limit(8).lean(),
      Quote.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$plan', count: { $sum: 1 } } },
        { $project: { plan: '$_id', count: 1, _id: 0 } },
      ]),
      // Revenue chart — group by day
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
      Settings.findOne().lean(),
    ]);

    // Infra profitability
    const infra    = settings?.infra || {};
    const totalCost = (infra.monthlyServerCost || 0) + (infra.monthlyDBCost || 0) +
                      (infra.monthlyMonitoringCost || 0) + (infra.otherMonthlyCost || 0);
    const avgMonthly     = 349; // Fallback — ideally calculated from active subscriptions
    const recurringRev   = activeSubs * avgMonthly;
    const breakEvenClients = totalCost > 0 ? Math.ceil(totalCost / avgMonthly) : 0;

    res.json({
      revenue:       { total: totalRevenue[0]?.total || 0, trend: 0 },
      quotes:        { active: activeQuotes, trend: 0 },
      subscriptions: { active: activeSubs, trend: 0 },
      users:         { new: newUsers, trend: 0 },
      recentOrders:  recentOrders,
      planBreakdown,
      revenueChart,
      infra: {
        totalCost,
        recurringRevenue: recurringRev,
        breakEvenClients,
        activeClients:    activeSubs,
      },
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ message: 'Failed to load dashboard stats' });
  }
});

module.exports = router;
