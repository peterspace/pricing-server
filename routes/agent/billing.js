'use strict';
const express        = require('express');
const router         = express.Router();
const Stripe         = require('stripe');
const stripe         = new Stripe(process.env.STRIPE_SECRET_KEY);
const AgentUser      = require('../../models/AgentUser');
const { agentProtect } = require('../../middleware/agentAuth');

// ── Stripe Price IDs — set these in your environment ─────────────────────────
// e.g. STRIPE_PRICE_STARTER=price_xxx  STRIPE_PRICE_GROWTH=price_xxx etc.
const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth:  process.env.STRIPE_PRICE_GROWTH,
  pro:     process.env.STRIPE_PRICE_PRO,
  agency:  process.env.STRIPE_PRICE_AGENCY,
};

const PLAN_NAMES = {
  starter: 'Starter',
  growth:  'Growth',
  pro:     'Pro',
  agency:  'Agency',
};

// POST /api/agent/billing/checkout
// Logged-in user upgrades directly — no re-signup needed.
// Creates a Stripe Checkout Session and returns the URL.
router.post('/checkout', agentProtect, async (req, res) => {
  const { plan } = req.body;

  if (!PRICE_IDS[plan]) {
    return res.status(400).json({ message: `Invalid plan: ${plan}` });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ message: 'Billing not configured.' });
  }

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();

    // Create or reuse Stripe customer
    let customerId = agent.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agent.email,
        name:  agent.name,
        metadata: { agentUserId: agent._id.toString() },
      });
      customerId = customer.id;
      await AgentUser.findByIdAndUpdate(req.agent._id, { stripeCustomerId: customerId });
    }

    const appUrl = process.env.APP_URL || 'https://bwing-api.onrender.com';

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price:    PRICE_IDS[plan],
        quantity: 1,
      }],
      success_url: `${appUrl}/settings/billing?upgraded=${plan}`,
      cancel_url:  `${appUrl}/settings/billing?cancelled=1`,
      metadata: {
        agentUserId: agent._id.toString(),
        plan,
      },
      subscription_data: {
        metadata: {
          agentUserId: agent._id.toString(),
          plan,
        },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ message: 'Failed to create checkout session.' });
  }
});

// POST /api/agent/billing/portal
// Opens Stripe Customer Portal for paid users to manage their subscription.
router.post('/portal', agentProtect, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ message: 'Billing not configured.' });
  }

  try {
    const agent = await AgentUser.findById(req.agent._id).lean();

    if (!agent.stripeCustomerId) {
      return res.status(400).json({ message: 'No billing account found.' });
    }

    const appUrl = process.env.APP_URL || 'https://bwing-api.onrender.com';

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

// POST /api/agent/billing/webhook
// Stripe calls this directly — NOT protected by agentProtect (no JWT).
// Must verify the Stripe signature using the raw body.
// NOTE: This route is mounted in index.js BEFORE express.json() middleware
//       so that req.body contains the raw Buffer needed for signature verification.
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

  // ── Reverse map: Stripe Price ID → plan name ───────────────────────────────
  const PRICE_TO_PLAN = {
    [process.env.STRIPE_PRICE_STARTER]: 'starter',
    [process.env.STRIPE_PRICE_GROWTH]:  'growth',
    [process.env.STRIPE_PRICE_PRO]:     'pro',
    [process.env.STRIPE_PRICE_AGENCY]:  'agency',
  };

  try {
    switch (event.type) {

      // ── User completes checkout — activate their plan immediately ───────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;

        const agentUserId = session.metadata?.agentUserId;
        const plan        = session.metadata?.plan;

        if (!agentUserId || !plan) {
          console.error('checkout.session.completed: missing metadata', session.metadata);
          break;
        }

        await AgentUser.findByIdAndUpdate(agentUserId, {
          plan,
          stripeCustomerId:     session.customer,
          stripeSubscriptionId: session.subscription,
          planActivatedAt:      new Date(),
        });
        console.log(`Plan activated: ${plan} for agent ${agentUserId}`);
        break;
      }

      // ── Subscription updated (e.g. plan change via portal) ─────────────────
      case 'customer.subscription.updated': {
        const sub   = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan    = PRICE_TO_PLAN[priceId];

        if (!plan) {
          console.log('subscription.updated: unrecognised price', priceId);
          break;
        }

        // Find agent by stripeCustomerId
        await AgentUser.findOneAndUpdate(
          { stripeCustomerId: sub.customer },
          { plan, stripeSubscriptionId: sub.id, planActivatedAt: new Date() }
        );
        console.log(`Subscription updated → ${plan} for customer ${sub.customer}`);
        break;
      }

      // ── Subscription cancelled — downgrade to free ──────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await AgentUser.findOneAndUpdate(
          { stripeCustomerId: sub.customer },
          { plan: 'free', stripeSubscriptionId: null }
        );
        console.log(`Subscription cancelled — downgraded to free for customer ${sub.customer}`);
        break;
      }

      default:
        // Ignore all other events
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ message: 'Webhook processing failed.' });
  }
});

module.exports = router;
