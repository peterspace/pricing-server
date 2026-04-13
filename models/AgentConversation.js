'use strict';
const mongoose = require('mongoose');

// Mirrors Quote.js structure — minus client info, Stripe, and pricing config.
// Adds agentUserId, title, model, and messages for conversation history.

const AgentSchema = new mongoose.Schema({
  name: String,
  type: { type: String, enum: ['orchestrator', 'llm', 'transform'] },
}, { _id: false });

// ── Message thread (kept for multi-turn refinement context) ──────────────────
const MessageSchema = new mongoose.Schema({
  role:    { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, default: '' },
  // Attached structured data when relevant
  clarification: { type: mongoose.Schema.Types.Mixed, default: null },
  analysis:      { type: mongoose.Schema.Types.Mixed, default: null },
  timestamp:     { type: Date, default: Date.now },
}, { _id: false });

const AgentConversationSchema = new mongoose.Schema({

  // ── Agent identity ──────────────────────────────────────────────────────────
  agentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentUser', required: true },
  title:       { type: String, default: 'New conversation' },
  model:       { type: String, default: 'qwen3-5-397b' },

  // ── Original request text ───────────────────────────────────────────────────
  request: { type: String, default: '' },

  // ── WF1 output — clarification from Agent 1 ────────────────────────────────
  clarification: { type: mongoose.Schema.Types.Mixed, default: null },

  // ── WF23 output — analysis metrics ─────────────────────────────────────────
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

  // ── WF23 output — the actual n8n workflow JSON ──────────────────────────────
  workflow: {
    json:        { type: mongoose.Schema.Types.Mixed, default: null },
    mermaid:     { type: String, default: '' },
    docs:        { type: String, default: '' },
    generatedAt: { type: Date, default: null },
  },

  // ── Conversation message thread (supports multi-turn refinement) ────────────
  messages: [MessageSchema],

  // ── Status ──────────────────────────────────────────────────────────────────
  analysisStatus: {
    type:    String,
    default: 'processing',
    enum:    ['processing', 'ready', 'failed'],
  },
  status: {
    type:    String,
    enum:    ['new', 'clarified', 'analysing', 'draft', 'delivered', 'archived'],
    default: 'new',
  },

  // ── Timing — for stuck-conversation cleanup ─────────────────────────────────
  wf1SentAt:      { type: Date, default: null },
  wf1CompletedAt: { type: Date, default: null },
  wf23SentAt:     { type: Date, default: null },

}, { timestamps: true });

AgentConversationSchema.index({ agentUserId: 1, updatedAt: -1 });
AgentConversationSchema.index({ status: 1 });

module.exports = mongoose.model('AgentConversation', AgentConversationSchema);
