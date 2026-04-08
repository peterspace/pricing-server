'use strict';
const express    = require('express');
const router     = express.Router();
const Admin      = require('../../models/Admin');
const { protect, signToken } = require('../../middleware/auth');
const { authLimiter }        = require('../../middleware/rateLimiter');

// POST /api/admin/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

  try {
    const admin = await Admin.findOne({ email: email.toLowerCase() }).select('+password');
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await Admin.findByIdAndUpdate(admin._id, { online: true, lastLogin: new Date() });
    const token = signToken(admin._id);

    res.json({ token, admin: admin.toPublic() });
  } catch {
    res.status(500).json({ message: 'Login failed' });
  }
});

// GET /api/admin/auth/me
router.get('/me', protect, (req, res) => {
  res.json(req.admin.toPublic());
});

// POST /api/admin/auth/logout
router.post('/logout', protect, async (req, res) => {
  await Admin.findByIdAndUpdate(req.admin._id, { online: false });
  res.json({ message: 'Logged out' });
});

module.exports = router;
