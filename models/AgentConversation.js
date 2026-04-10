'use strict';
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  role:          { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content:       { type: String, default: '' },
  clarification: { type: mongoose.Schema.Types.Mixed, default: null },
  workflow:      { type: mongoose.Schema.Types.Mixed, default: null },
  analysis:      { type: mongoose.Schema.Types.Mixed, default: null },
  timestamp:     { type: Date, default: Date.now },
}, { _id: false });

const AgentConversationSchema = new mongoose.Schema({
  agentUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentUser', required: true },
  title:       { type: String, default: 'New conversation' },
  model:       { type: String, default: 'default' },
  messages:    [MessageSchema],

  // Linked quote data
  quoteId:        { type: String, default: null },
  clarification:  { type: mongoose.Schema.Types.Mixed, default: null },
  analysisStatus: { type: String, enum: ['idle', 'clarifying', 'generating', 'ready', 'failed'], default: 'idle' },
  analysis:       { type: mongoose.Schema.Types.Mixed, default: null },
  workflowJson:   { type: mongoose.Schema.Types.Mixed, default: null },

  status: { type: String, enum: ['active', 'archived'], default: 'active' },
}, { timestamps: true });

AgentConversationSchema.index({ agentUserId: 1, updatedAt: -1 });

module.exports = mongoose.model('AgentConversation', AgentConversationSchema);
