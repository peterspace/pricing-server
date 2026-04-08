'use strict';
const jwt   = require('jsonwebtoken');
const Admin = require('../models/Admin');

async function protect(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin   = await Admin.findById(decoded.id);
    if (!admin) return res.status(401).json({ message: 'Admin not found' });
    req.admin = admin;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

module.exports = { protect, signToken };
