'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const audit      = require('../../middleware/audit');
const Admin      = require('../../models/Admin');

// GET /api/admin/admins
router.get('/', protect, async (req, res) => {
  try {
    const admins = await Admin.find().sort({ createdAt: -1 }).lean();
    res.json({ admins });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/admin/admins
router.post('/', protect, audit('create_admin', 'Admin'), async (req, res) => {
  try {
    const { name, email, password, position, phone, location } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'name, email, password required' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'Admin with this email already exists' });

    const admin = await Admin.create({ name, email, password, position, phone, location });
    res.status(201).json(admin.toPublic());
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/admin/admins/:id
router.delete('/:id', protect, audit('delete_admin', 'Admin'), async (req, res) => {
  try {
    if (req.admin._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    const admin = await Admin.findByIdAndDelete(req.params.id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    res.json({ message: 'Admin removed' });
  } catch {
    res.status(500).json({ message: 'Delete failed' });
  }
});

module.exports = router;
