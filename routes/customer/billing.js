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

// GET /api/customer/billing/payment-methods
router.get('/payment-methods', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ paymentMethods: [], defaultId: null });
  try {
    const user = await User.findById(req.customer._id).lean();
    if (!user.stripeCustomerId) return res.json({ paymentMethods: [], defaultId: null });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const [pmList, customer] = await Promise.all([
      stripe.paymentMethods.list({ customer: user.stripeCustomerId, type: 'card' }),
      stripe.customers.retrieve(user.stripeCustomerId),
    ]);
    const defaultId = customer.invoice_settings?.default_payment_method || null;
    res.json({
      paymentMethods: pmList.data.map(pm => ({
        id: pm.id, brand: pm.card.brand, last4: pm.card.last4,
        expMonth: pm.card.exp_month, expYear: pm.card.exp_year,
        isDefault: pm.id === defaultId,
      })),
      defaultId,
    });
  } catch (err) {
    console.error('Portal payment methods error:', err.message);
    res.status(500).json({ message: 'Failed to fetch payment methods.' });
  }
});

// POST /api/customer/billing/set-default-payment-method
router.post('/set-default-payment-method', async (req, res) => {
  const { paymentMethodId } = req.body;
  if (!paymentMethodId) return res.status(400).json({ message: 'paymentMethodId required.' });
  try {
    const user = await User.findById(req.customer._id).lean();
    if (!user.stripeCustomerId) return res.status(400).json({ message: 'No billing account.' });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    await stripe.customers.update(user.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    res.json({ message: 'Default payment method updated.' });
  } catch (err) {
    console.error('Portal set default PM error:', err.message);
    res.status(500).json({ message: 'Failed to update.' });
  }
});

// DELETE /api/customer/billing/payment-methods/:pmId
router.delete('/payment-methods/:pmId', async (req, res) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    await stripe.paymentMethods.detach(req.params.pmId);
    res.json({ message: 'Removed.' });
  } catch (err) {
    console.error('Portal remove PM error:', err.message);
    res.status(500).json({ message: 'Failed to remove.' });
  }
});

// POST /api/customer/billing/portal — opens Stripe billing portal
router.post('/portal', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Billing not configured.' });
  try {
    const user = await User.findById(req.customer._id).lean();
    if (!user.stripeCustomerId) return res.status(400).json({ message: 'No billing account.' });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const portalUrl = process.env.PORTAL_URL || 'http://localhost:5176';
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${portalUrl}/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal billing portal error:', err.message);
    res.status(500).json({ message: 'Failed to open billing portal.' });
  }
});

// PUT /api/customer/billing/address
router.put('/address', async (req, res) => {
  const { name, line1, line2, city, state, postalCode, country } = req.body;
  if (!line1 || !city || !country) {
    return res.status(400).json({ message: 'Address line 1, city, and country are required.' });
  }
  try {
    const user = await User.findById(req.customer._id).lean();
    if (!user.stripeCustomerId) return res.status(400).json({ message: 'No billing account.' });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    await stripe.customers.update(user.stripeCustomerId, {
      name: name || user.name,
      address: { line1, line2: line2 || '', city, state: state || '', postal_code: postalCode || '', country },
    });
    await User.findByIdAndUpdate(user._id, {
      billingAddress: { name, line1, line2, city, state, postalCode, country },
    });
    res.json({ message: 'Billing address updated.' });
  } catch (err) {
    console.error('Portal billing address error:', err.message);
    res.status(500).json({ message: 'Failed to update billing address.' });
  }
});