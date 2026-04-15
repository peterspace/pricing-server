'use strict';
const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const User     = require('../../models/User');
const { customerProtect } = require('../../middleware/customerAuth');

router.use(customerProtect);

// GET /api/customer/billing/invoices
// Fetches Stripe invoices for this customer, cached on User record for 10 min.
router.get('/invoices', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ invoices: [] });

  try {
    const user = await User.findById(req.customer._id).lean();

    // Return cached if fresh (< 10 min)
    if (user.invoicesCache?.length && user.invoicesCachedAt) {
      const age = Date.now() - new Date(user.invoicesCachedAt).getTime();
      if (age < 10 * 60 * 1000) return res.json({ invoices: user.invoicesCache });
    }

    if (!user.stripeCustomerId) return res.json({ invoices: [] });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const stripeInvoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit:    24,
    });

    const invoices = stripeInvoices.data.map(inv => ({
      id:          inv.id,
      number:      inv.number,
      status:      inv.status,
      amount:      inv.amount_paid / 100,
      currency:    inv.currency,
      period: {
        start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
        end:   inv.period_end   ? new Date(inv.period_end   * 1000).toISOString() : null,
      },
      dueDate:    inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
      createdAt:  new Date(inv.created * 1000).toISOString(),
      pdfUrl:     inv.invoice_pdf,
      hostedUrl:  inv.hosted_invoice_url,
      description: inv.description || 'Invoice',
      lines: (inv.lines?.data || []).map(l => ({
        description: l.description,
        amount:      l.amount / 100,
      })),
      subtotal: inv.subtotal / 100,
      tax:      (inv.tax || 0) / 100,
      total:    inv.total / 100,
    }));

    // Cache on user
    await User.findByIdAndUpdate(user._id, {
      invoicesCache:    invoices,
      invoicesCachedAt: new Date(),
    });

    res.json({ invoices });
  } catch (err) {
    console.error('Portal invoices error:', err.message);
    res.status(500).json({ message: 'Failed to fetch invoices.' });
  }
});

module.exports = router;
