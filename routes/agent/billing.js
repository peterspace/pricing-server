'use strict';
const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const AgentUser = require('../../models/AgentUser');
const { agentProtect } = require('../../middleware/agentAuth');

// ── Stripe Price IDs ──────────────────────────────────────────────────────────
const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth:  process.env.STRIPE_PRICE_GROWTH,
  pro:     process.env.STRIPE_PRICE_PRO,
  agency:  process.env.STRIPE_PRICE_AGENCY,
};

const PRICE_TO_PLAN = () => ({
  [process.env.STRIPE_PRICE_STARTER]: 'starter',
  [process.env.STRIPE_PRICE_GROWTH]:  'growth',
  [process.env.STRIPE_PRICE_PRO]:     'pro',
  [process.env.STRIPE_PRICE_AGENCY]:  'agency',
});

// ── Helper: get or create Stripe customer ─────────────────────────────────────
async function getOrCreateCustomer(agent) {
  if (agent.stripeCustomerId) return agent.stripeCustomerId;
  const customer = await stripe.customers.create({
    email: agent.email,
    name:  agent.name,
    metadata: { agentUserId: agent._id.toString() },
  });
  await AgentUser.findByIdAndUpdate(agent._id, { stripeCustomerId: customer.id });
  return customer.id;
}

// ── POST /api/agent/billing/checkout ─────────────────────────────────────────
router.post('/checkout', agentProtect, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ message: `Invalid plan: ${plan}` });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Billing not configured.' });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    const customerId = await getOrCreateCustomer(agent);
    const appUrl = process.env.AGENT_URL || process.env.APP_URL || 'http://localhost:5175';

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: `${appUrl}/settings/billing?upgraded=${plan}`,
      cancel_url:  `${appUrl}/settings/billing?cancelled=1`,
      metadata: { agentUserId: agent._id.toString(), plan },
      subscription_data: { metadata: { agentUserId: agent._id.toString(), plan } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ message: 'Failed to create checkout session.' });
  }
});

// ── POST /api/agent/billing/switch-plan ───────────────────────────────────────
// Upgrade or downgrade between paid plans in-place (no new checkout needed).
router.post('/switch-plan', agentProtect, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ message: `Invalid plan: ${plan}` });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Billing not configured.' });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    if (!agent.stripeSubscriptionId) {
      return res.status(400).json({ message: 'No active subscription found. Please subscribe first.' });
    }

    // Get the current subscription and update its item to the new price
    const subscription = await stripe.subscriptions.retrieve(agent.stripeSubscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) return res.status(400).json({ message: 'Could not find subscription item.' });

    await stripe.subscriptions.update(agent.stripeSubscriptionId, {
      items: [{ id: itemId, price: PRICE_IDS[plan] }],
      proration_behavior: 'create_prorations',
      metadata: { agentUserId: agent._id.toString(), plan },
    });

    // Update locally immediately (webhook will also confirm)
    await AgentUser.findByIdAndUpdate(agent._id, { plan });

    res.json({ message: `Plan switched to ${plan}.`, plan });
  } catch (err) {
    console.error('Switch plan error:', err.message);
    res.status(500).json({ message: 'Failed to switch plan. Please try again.' });
  }
});

// ── POST /api/agent/billing/portal ────────────────────────────────────────────
router.post('/portal', agentProtect, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Billing not configured.' });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    if (!agent.stripeCustomerId) return res.status(400).json({ message: 'No billing account found.' });

    const appUrl = process.env.AGENT_URL || process.env.APP_URL || 'http://localhost:5175';
    const session = await stripe.billingPortal.sessions.create({
      customer:   agent.stripeCustomerId,
      return_url: `${appUrl}/settings/billing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal session error:', err.message);
    res.status(500).json({ message: 'Failed to open billing portal.' });
  }
});

// ── GET /api/agent/billing/invoices ───────────────────────────────────────────
// Fetches from Stripe and caches on AgentUser for fast subsequent loads.
router.get('/invoices', agentProtect, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ invoices: [] });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    if (!agent.stripeCustomerId) return res.json({ invoices: [] });

    // Return cached invoices if fresh (< 10 minutes old)
    if (agent.invoicesCache?.length && agent.invoicesCachedAt) {
      const age = Date.now() - new Date(agent.invoicesCachedAt).getTime();
      if (age < 10 * 60 * 1000) {
        return res.json({ invoices: agent.invoicesCache });
      }
    }

    const stripeInvoices = await stripe.invoices.list({
      customer: agent.stripeCustomerId,
      limit:    24,
      expand:   ['data.payment_intent'],
    });

    const invoices = stripeInvoices.data.map(inv => ({
      id:          inv.id,
      number:      inv.number,
      status:      inv.status,           // draft | open | paid | void | uncollectible
      amount:      inv.amount_paid / 100,
      currency:    inv.currency,
      period: {
        start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
        end:   inv.period_end   ? new Date(inv.period_end   * 1000).toISOString() : null,
      },
      dueDate:     inv.due_date     ? new Date(inv.due_date * 1000).toISOString() : null,
      createdAt:   new Date(inv.created * 1000).toISOString(),
      pdfUrl:      inv.invoice_pdf,
      hostedUrl:   inv.hosted_invoice_url,
      description: inv.description || 'Monthly invoice',
      lines: inv.lines?.data?.map(l => ({
        description: l.description,
        amount:      l.amount / 100,
        period:      l.period,
      })) || [],
      subtotal:   inv.subtotal   / 100,
      tax:        (inv.tax || 0) / 100,
      total:      inv.total      / 100,
      amountDue:  inv.amount_due / 100,
    }));

    // Cache on user record
    await AgentUser.findByIdAndUpdate(agent._id, {
      invoicesCache:    invoices,
      invoicesCachedAt: new Date(),
    });

    res.json({ invoices });
  } catch (err) {
    console.error('Invoices fetch error:', err.message);
    res.status(500).json({ message: 'Failed to fetch invoices.' });
  }
});

// ── GET /api/agent/billing/payment-methods ────────────────────────────────────
router.get('/payment-methods', agentProtect, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ paymentMethods: [], defaultId: null });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    if (!agent.stripeCustomerId) return res.json({ paymentMethods: [], defaultId: null });

    const [pmList, customer] = await Promise.all([
      stripe.paymentMethods.list({ customer: agent.stripeCustomerId, type: 'card' }),
      stripe.customers.retrieve(agent.stripeCustomerId),
    ]);

    const defaultId = customer.invoice_settings?.default_payment_method || null;

    const paymentMethods = pmList.data.map(pm => ({
      id:      pm.id,
      brand:   pm.card.brand,
      last4:   pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear:  pm.card.exp_year,
      isDefault: pm.id === defaultId,
    }));

    res.json({ paymentMethods, defaultId });
  } catch (err) {
    console.error('Payment methods error:', err.message);
    res.status(500).json({ message: 'Failed to fetch payment methods.' });
  }
});

// ── POST /api/agent/billing/set-default-payment-method ───────────────────────
router.post('/set-default-payment-method', agentProtect, async (req, res) => {
  const { paymentMethodId } = req.body;
  if (!paymentMethodId) return res.status(400).json({ message: 'paymentMethodId is required.' });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    if (!agent.stripeCustomerId) return res.status(400).json({ message: 'No billing account.' });

    await stripe.customers.update(agent.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    res.json({ message: 'Default payment method updated.' });
  } catch (err) {
    console.error('Set default PM error:', err.message);
    res.status(500).json({ message: 'Failed to update payment method.' });
  }
});

// ── DELETE /api/agent/billing/payment-methods/:pmId ──────────────────────────
router.delete('/payment-methods/:pmId', agentProtect, async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.pmId);
    res.json({ message: 'Payment method removed.' });
  } catch (err) {
    console.error('Remove PM error:', err.message);
    res.status(500).json({ message: 'Failed to remove payment method.' });
  }
});

// ── POST /api/agent/billing/setup-intent ─────────────────────────────────────
// Creates a SetupIntent so the frontend can securely add a new card via Stripe.js
router.post('/setup-intent', agentProtect, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Billing not configured.' });

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    const customerId = await getOrCreateCustomer(agent);

    const intent = await stripe.setupIntents.create({
      customer:            customerId,
      payment_method_types: ['card'],
      usage:               'off_session',
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('Setup intent error:', err.message);
    res.status(500).json({ message: 'Failed to create setup intent.' });
  }
});

// ── PUT /api/agent/billing/address ────────────────────────────────────────────
// Updates billing address on both Stripe customer and AgentUser model.
router.put('/address', agentProtect, async (req, res) => {
  const { name, line1, line2, city, state, postalCode, country } = req.body;
  if (!line1 || !city || !country) {
    return res.status(400).json({ message: 'Address line 1, city, and country are required.' });
  }

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();
    const customerId = await getOrCreateCustomer(agent);

    const address = { line1, line2: line2 || '', city, state: state || '', postal_code: postalCode || '', country };

    await stripe.customers.update(customerId, {
      name:    name || agent.name,
      address,
    });

    await AgentUser.findByIdAndUpdate(agent._id, {
      billingAddress: { name, line1, line2, city, state, postalCode, country },
    });

    res.json({ message: 'Billing address updated.' });
  } catch (err) {
    console.error('Billing address error:', err.message);
    res.status(500).json({ message: 'Failed to update billing address.' });
  }
});

// ── POST /api/agent/billing/webhook ──────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — webhook ignored');
    return res.status(400).json({ message: 'Webhook secret not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ message: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const { agentUserId, plan } = session.metadata || {};
        if (!agentUserId || !plan) break;
        await AgentUser.findByIdAndUpdate(agentUserId, {
          plan,
          stripeCustomerId:     session.customer,
          stripeSubscriptionId: session.subscription,
          invoicesCache:        [], // clear cache so next load fetches fresh
        });
        console.log(`Plan activated: ${plan} for agent ${agentUserId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan = PRICE_TO_PLAN()[priceId];
        if (!plan) break;
        await AgentUser.findOneAndUpdate(
          { stripeCustomerId: sub.customer },
          { plan, stripeSubscriptionId: sub.id, invoicesCache: [] }
        );
        console.log(`Subscription updated → ${plan} for customer ${sub.customer}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await AgentUser.findOneAndUpdate(
          { stripeCustomerId: sub.customer },
          { plan: 'free', stripeSubscriptionId: null, invoicesCache: [] }
        );
        console.log(`Subscription cancelled — free for customer ${sub.customer}`);
        break;
      }

      case 'invoice.payment_succeeded':
      case 'invoice.paid': {
        // Clear invoice cache so it refreshes on next load
        const inv = event.data.object;
        await AgentUser.findOneAndUpdate(
          { stripeCustomerId: inv.customer },
          { invoicesCache: [], invoicesCachedAt: null }
        );
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ message: 'Webhook processing failed.' });
  }
});

module.exports = router;
