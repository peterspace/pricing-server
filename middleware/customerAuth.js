'use strict';
const jwt  = require('jsonwebtoken');
const User = require('../models/User');

async function customerProtect(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'customer') {
      return res.status(401).json({ message: 'Invalid token type' });
    }
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.customer = user;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function signCustomerToken(id) {
  return jwt.sign({ id, type: 'customer' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

module.exports = { customerProtect, signCustomerToken };
