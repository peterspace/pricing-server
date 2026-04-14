'use strict';
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:       { type: String, trim: true, default: '' },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, minlength: 8, select: false },
  company:    { type: String, default: '' },
  city:       { type: String, default: '' },
  country:    { type: String, default: '' },
  phone:      { type: String, default: '' },
  plan:       { type: String, enum: ['free', 'recurring', 'whitelabel', 'payg'], default: 'free' },
  verified:   { type: Boolean, default: false },
  online:     { type: Boolean, default: false },
  lastSeen:   { type: Date },
  deletedAt:  { type: Date, default: null },

  // ── Portal auth — magic link (passwordless first login) ──────────────────
  magicLinkToken:  { type: String, default: null, select: false },
  magicLinkExpiry: { type: Date,   default: null },

  // Stripe
  stripeCustomerId: { type: String, default: '' },

  // Stats
  quoteCount: { type: Number, default: 0 },
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Virtual: has the user set a password yet?
UserSchema.virtual('hasPassword').get(function () {
  return !!this.password;
});

UserSchema.methods.toPublic = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  delete obj.magicLinkToken;
  delete obj.magicLinkExpiry;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
