'use strict';
const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  quoteId:          { type: String },
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  clientName:       { type: String },
  clientEmail:      { type: String, lowercase: true },
  amount:           { type: Number, required: true },
  currency:         { type: String, default: 'usd' },
  type:             { type: String, enum: ['one-time', 'recurring', 'setup-fee', 'refund'], default: 'one-time' },
  status:           { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  stripePaymentId:  { type: String, default: '' },
  stripeInvoiceId:  { type: String, default: '' },
  refundedAmount:   { type: Number, default: 0 },
  refundedAt:       { type: Date, default: null },
  paidAt:           { type: Date, default: null },
}, { timestamps: true });

PaymentSchema.index({ clientEmail: 1 });
PaymentSchema.index({ stripePaymentId: 1 });

module.exports = mongoose.model('Payment', PaymentSchema);
