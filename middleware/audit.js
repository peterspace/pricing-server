'use strict';
const AuditLog = require('../models/AuditLog');

function audit(action, resource) {
  return async (req, res, next) => {
    // Store original json to intercept after response
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400 && req.admin) {
        AuditLog.create({
          adminId:    req.admin._id,
          adminName:  req.admin.name,
          action,
          resource,
          resourceId: req.params.id || body?._id || null,
          ip:         req.ip,
          meta:       { method: req.method, path: req.path },
        }).catch(() => {}); // Non-blocking
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = audit;
