'use strict';
const mongoose = require('mongoose');

const AgentSchema = new mongoose.Schema({
  name: String,
  type: { type: String, enum: ['orchestrator', 'llm', 'transform'] },
}, { _id: false });

const LineItemSchema = new mongoose.Schema({
  label:      String,
  detail:     String,
  value:      Number,
  isDiscount: { type: Boolean, default: false },
}, { _id: false });

const QuoteSchema = new mongoose.Schema({
  quoteId:       { type: String, required: true, unique: true, uppercase: true },

  // Client info
  clientName:    { type: String, required: true },
  clientEmail:   { type: String, required: true, lowercase: true },
  clientCompany: { type: String, default: '' },
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Original request text
  request: { type: String, required: true },

  // WF1 output — clarification from Agent 1
  clarification: { type: mongoose.Schema.Types.Mixed, default: null },

  // WF23 output — analysis metrics from Agent 2
  // workflow_summary: plain-English description shown to the client
  // execution_context: e.g. "Booking requests processed per client inquiry"
  // workflow_name: friendly name for the generated workflow
  // node_count: total nodes in the generated workflow JSON
  analysis: {
    total_agents:      Number,
    llm_nodes:         Number,
    transformations:   Number,
    complexity:        Number,
    complexity_label:  String,
    workflow_summary:  String,
    execution_context: String,
    workflow_name:     String,
    node_count:        Number,
    agents:            [AgentSchema],
  },

  // WF23 output — the actual n8n workflow JSON, locked until payment
  workflow: {
    json:        { type: mongoose.Schema.Types.Mixed, default: null },
    mermaid:     { type: String, default: '' },
    docs:        { type: String, default: '' },
    generatedAt: { type: Date, default: null },
  },
  workflowLocked: { type: Boolean, default: true },

  // Pricing configuration (set at StepConfigure)
  plan:            { type: String, enum: ['whitelabel', 'recurring', 'payg'], required: true },
  supportContract: { type: String, default: null },
  selectedTierId:  { type: String, default: 't2' },
  hostedLLMs:      { type: Boolean, default: true },
  ownKeys: {
    openai:  { type: Boolean, default: false },
    claude:  { type: Boolean, default: false },
    gemini:  { type: Boolean, default: false },
  },

  // Calculated pricing (stored for admin reference — source of truth is client-side calc)
  price:         { type: String },
  buildPrice:    { type: Number },
  setupFee:      { type: Number, default: null },
  lineItems:     [LineItemSchema],
  configVersion: { type: Number },

  // Status
  analysisStatus: {
    type: String,
    default: 'processing',
    enum: ['processing', 'ready', 'failed'],
  },
  status: {
    type: String,
    enum: ['new', 'clarified', 'analysing', 'draft', 'pending', 'paid', 'delivered', 'cancelled'],
    default: 'new',
  },

  // Timing — for stuck-quote cleanup job
  wf1SentAt:      { type: Date, default: null },
  wf1CompletedAt: { type: Date, default: null },
  wf23SentAt:     { type: Date, default: null },

  // Stripe
  stripePaymentIntentId: { type: String, default: '' },
  stripeSessionId:       { type: String, default: '' },
  paidAt:                { type: Date, default: null },

  // Expiry
  expiresAt: { type: Date },

  // Change order
  isChangeOrder:   { type: Boolean, default: false },
  originalQuoteId: { type: String, default: null },
  diff:            { type: mongoose.Schema.Types.Mixed, default: null },

}, { timestamps: true });

QuoteSchema.pre('save', function (next) {
  if (!this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }
  next();
});

QuoteSchema.index({ clientEmail: 1 });
QuoteSchema.index({ status: 1 });
QuoteSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Quote', QuoteSchema);
