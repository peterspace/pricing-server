'use strict';
const jwt       = require('jsonwebtoken');
const AgentUser = require('../models/AgentUser');

async function agentProtect(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'agent') {
      return res.status(401).json({ message: 'Invalid token type' });
    }
    const agent = await AgentUser.findById(decoded.id);
    if (!agent) return res.status(401).json({ message: 'Agent not found' });
    req.agent = agent;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function signAgentToken(id) {
  return jwt.sign({ id, type: 'agent' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

module.exports = { agentProtect, signAgentToken };
