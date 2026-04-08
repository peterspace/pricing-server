'use strict';
const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  adminName: { type: String },
  action:    { type: String, required: true },
  resource:  { type: String },
  resourceId:{ type: String },
  meta:      { type: mongoose.Schema.Types.Mixed },
  ip:        { type: String },
}, { timestamps: true });

AuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
