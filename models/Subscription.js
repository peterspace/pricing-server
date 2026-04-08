'use strict';
const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  userId:                 { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  quoteId:                { type: String },
  clientName:             { type: String },
  userEmail:              { type: String, lowercase: true },
  plan:                   { type: String, enum: ['recurring', 'payg', 'whitelabel'] },
  interval:               { type: String, enum: ['monthly', 'annually'], default: 'monthly' },
  amount:                 { type: Number },
  status:                 { type: String, enum: ['active', 'cancelled', 'past_due', 'trialing', 'unpaid'], default: 'active' },
  stripeCustomerId:       { type: String },
  stripeSubscriptionId:   { type: String },
  stripePriceId:          { type: String },
  currentPeriodStart:     { type: Date },
  currentPeriodEnd:       { type: Date },
  cancelledAt:            { type: Date, default: null },
  trialEnd:               { type: Date, default: null },
}, { timestamps: true });

SubscriptionSchema.index({ userEmail: 1 });
SubscriptionSchema.index({ stripeSubscriptionId: 1 });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
