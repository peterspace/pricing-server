'use strict';
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const AiKeySchema = new mongoose.Schema({
  key:     { type: String, default: '' }, // encrypted
  enabled: { type: Boolean, default: false },
}, { _id: false });

const SeatSchema = new mongoose.Schema({
  email:    String,
  role:     { type: String, enum: ['owner', 'member'], default: 'member' },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const AgentUserSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  email:   { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:{ type: String, required: true, select: false },
  company: { type: String, default: '' },

  plan: {
    type: String,
    enum: ['free', 'starter', 'growth', 'pro', 'agency'],
    default: 'free',
  },

  // Quota tracking
  quotesUsedThisMonth: { type: Number, default: 0 },
  quotesResetAt:       { type: Date, default: () => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(1); return d;
  }},

  // Seats (Agency plan)
  seats: [SeatSchema],

  // AI Keys (stored encrypted)
  aiKeys: {
    openai: { type: AiKeySchema, default: () => ({ key: '', enabled: false }) },
    claude: { type: AiKeySchema, default: () => ({ key: '', enabled: false }) },
    gemini: { type: AiKeySchema, default: () => ({ key: '', enabled: false }) },
  },

  // Preferences
  defaultModel: { type: String, default: 'default' },

  // Pricing config (agent's own rates for client quotes)
  pricingConfig:       { type: mongoose.Schema.Types.Mixed, default: null },
  showPricingToClients:{ type: Boolean, default: true },
  priceCapEnabled:     { type: Boolean, default: false },
  priceCap:            { type: Number, default: null },

  // Stripe
  stripeCustomerId:     { type: String, default: '' },
  stripeSubscriptionId: { type: String, default: '' },

  // Billing address (synced to Stripe customer)
  billingAddress: {
    name:       { type: String, default: '' },
    line1:      { type: String, default: '' },
    line2:      { type: String, default: '' },
    city:       { type: String, default: '' },
    state:      { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country:    { type: String, default: '' },
  },

  // Invoice cache (populated by billing route, cleared on payment events)
  invoicesCache:    { type: Array,  default: [] },
  invoicesCachedAt: { type: Date,   default: null },

  googleId:  { type: String, default: null },
  lastLogin: { type: Date, default: null },
}, { timestamps: true });

AgentUserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  // Skip hashing if this is a Google OAuth stub (already bcrypt-hashed or marked)
  if (this.googleId && this.password.startsWith('$2')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

AgentUserSchema.methods.comparePassword = function(candidate) {
  // Google OAuth users have no usable password
  if (this.googleId && !candidate) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

AgentUserSchema.methods.toPublic = function() {
  const o = this.toObject();
  delete o.password;
  // Never expose raw key values
  if (o.aiKeys) {
    Object.keys(o.aiKeys).forEach(p => {
      if (o.aiKeys[p]) { o.aiKeys[p] = { enabled: o.aiKeys[p].enabled }; }
    });
  }
  return o;
};

// Quota limits per plan
AgentUserSchema.methods.quotaLimit = function() {
  return { free: 1, starter: 5, growth: 20, pro: Infinity, agency: Infinity }[this.plan] || 1;
};

AgentUserSchema.methods.hasQuotaRemaining = function() {
  this.resetQuotaIfNeeded();
  return this.quotesUsedThisMonth < this.quotaLimit();
};

AgentUserSchema.methods.resetQuotaIfNeeded = function() {
  if (new Date() >= this.quotesResetAt) {
    this.quotesUsedThisMonth = 0;
    const d = new Date();
    d.setMonth(d.getMonth() + 1); d.setDate(1);
    this.quotesResetAt = d;
  }
};

module.exports = mongoose.model('AgentUser', AgentUserSchema);
