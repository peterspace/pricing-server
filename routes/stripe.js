'use strict';
const express  = require('express');
const router   = express.Router();
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Quote    = require('../models/Quote');
const Payment  = require('../models/Payment');
const Subscription = require('../models/Subscription');
const User     = require('../models/User');
const { sendWorkflowUnlock } = require('../services/emailService');

// POST /api/stripe/checkout — create a Stripe Checkout session
router.post('/checkout', async (req, res) => {
  const { quoteId, billingInterval } = req.body;

  try {
    const quote = await Quote.findOne({ quoteId: quoteId?.toUpperCase() });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.status === 'paid') return res.status(400).json({ message: 'Quote already paid' });

    const isRecurring = quote.plan === 'recurring';
    const amount      = Math.round((quote.buildPrice || 0) * 100); // Stripe uses cents
    const setupFee    = quote.setupFee ? Math.round(quote.setupFee * 100) : 0;

    let session;

    if (isRecurring) {
      // Recurring subscription via Stripe
      const interval = billingInterval === 'annually' ? 'year' : 'month';
      const lineItems = [{
        price_data: {
          currency:    'usd',
          unit_amount: amount,
          recurring:   { interval },
          product_data: { name: `n8n Automation — ${quote.plan} plan`, description: quote.analysis?.workflow_summary || '' },
        },
        quantity: 1,
      }];
      // Add setup fee if PAYG
      if (setupFee > 0) {
        lineItems.push({
          price_data: {
            currency:    'usd',
            unit_amount: setupFee,
            product_data: { name: 'One-time setup fee' },
          },
          quantity: 1,
        });
      }
      session = await stripe.checkout.sessions.create({
        mode:                'subscription',
        payment_method_types:['card'],
        line_items:          lineItems,
        success_url:         `${process.env.CLIENT_URL}/?quote=${quoteId}&paid=true`,
        cancel_url:          `${process.env.CLIENT_URL}/?quote=${quoteId}`,
        customer_email:      quote.clientEmail,
        metadata:            { quoteId, plan: quote.plan, billingInterval: interval },
      });
    } else {
      // One-time payment (white label or PAYG setup fee)
      const totalAmount = amount + setupFee;
      session = await stripe.checkout.sessions.create({
        mode:                'payment',
        payment_method_types:['card'],
        line_items: [{
          price_data: {
            currency:    'usd',
            unit_amount: totalAmount,
            product_data: { name: `n8n Automation — ${quote.plan}`, description: quote.analysis?.workflow_summary || '' },
          },
          quantity: 1,
        }],
        success_url:    `${process.env.CLIENT_URL}/?quote=${quoteId}&paid=true`,
        cancel_url:     `${process.env.CLIENT_URL}/?quote=${quoteId}`,
        customer_email: quote.clientEmail,
        metadata:       { quoteId, plan: quote.plan },
      });
    }

    // Store session ID on quote
    await Quote.findOneAndUpdate({ quoteId: quote.quoteId }, { stripeSessionId: session.id });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ message: 'Failed to create checkout session' });
  }
});

// POST /api/stripe/webhook — Stripe webhook (raw body required)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const { quoteId, plan } = session.metadata || {};
        if (!quoteId) break;

        const quote = await Quote.findOne({ quoteId: quoteId.toUpperCase() });
        if (!quote) break;

        // Unlock workflow + mark paid
        await Quote.findOneAndUpdate(
          { quoteId: quoteId.toUpperCase() },
          {
            status:                'paid',
            workflowLocked:        false,
            paidAt:                new Date(),
            stripePaymentIntentId: session.payment_intent || '',
          },
        );

        // Record payment
        await Payment.create({
          quoteId:        quoteId.toUpperCase(),
          clientName:     quote.clientName,
          clientEmail:    quote.clientEmail,
          amount:         session.amount_total / 100,
          currency:       session.currency,
          type:           plan === 'recurring' ? 'recurring' : 'one-time',
          status:         'paid',
          stripePaymentId:session.payment_intent || session.id,
          paidAt:         new Date(),
        });

        // Update user plan if linked
        if (quote.userId) {
          await User.findByIdAndUpdate(quote.userId, { plan });
        }

        // Send workflow delivery email with JSON + docs attached
        sendWorkflowUnlock({
          name:         quote.clientName,
          email:        quote.clientEmail,
          quoteId,
          workflowJson: quote.workflow?.json,
          docs:         quote.workflow?.docs,
        }).catch(err => console.error('Workflow unlock email failed:', err.message));

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const quoteId = sub.metadata?.quoteId;
        const quote   = quoteId ? await Quote.findOne({ quoteId: quoteId.toUpperCase() }) : null;

        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: sub.id },
          {
            stripeSubscriptionId: sub.id,
            stripeCustomerId:     sub.customer,
            plan:                 quote?.plan || 'recurring',
            amount:               (sub.items.data[0]?.price?.unit_amount || 0) / 100,
            interval:             sub.items.data[0]?.price?.recurring?.interval === 'year' ? 'annually' : 'monthly',
            status:               sub.status,
            currentPeriodStart:   new Date(sub.current_period_start * 1000),
            currentPeriodEnd:     new Date(sub.current_period_end   * 1000),
            clientName:           quote?.clientName   || '',
            userEmail:            quote?.clientEmail  || '',
            quoteId:              quoteId?.toUpperCase() || '',
          },
          { upsert: true, new: true },
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: sub.id },
          { status: 'cancelled', cancelledAt: new Date() },
        );
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await Subscription.findOneAndUpdate(
          { stripeCustomerId: inv.customer },
          { status: 'past_due' },
        );
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).json({ message: 'Webhook processing failed' });
  }
});

module.exports = router;
