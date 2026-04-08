'use strict';
const express    = require('express');
const router     = express.Router();
const { protect }= require('../../middleware/auth');
const audit      = require('../../middleware/audit');
const User       = require('../../models/User');
const Quote      = require('../../models/Quote');
const { sendWelcomeEmail } = require('../../services/emailService');

// GET /api/admin/users
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 50, filter = 'all', search } = req.query;
    const query = {};

    if (filter === 'verified')   query.verified  = true;
    if (filter === 'unverified') query.verified  = false;
    if (filter === 'deleted')    query.deletedAt = { $ne: null };
    else if (filter !== 'all')   query.deletedAt = null;

    if (search) {
      query.$or = [
        { name:    { $regex: search, $options: 'i' } },
        { email:   { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      User.countDocuments(query),
    ]);

    res.json({ users, total, page: parseInt(page) });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/users/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    const quotes = await Quote.find({ userId: user._id }).select('quoteId plan price status createdAt').lean();
    res.json({ ...user, quotes });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/admin/users/:id/verify
router.patch('/:id/verify', protect, audit('verify_user', 'User'), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { verified: true }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user.toPublic());
  } catch {
    res.status(500).json({ message: 'Verify failed' });
  }
});

// DELETE /api/admin/users/:id — soft delete
router.delete('/:id', protect, audit('delete_user', 'User'), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { deletedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted', userId: user._id });
  } catch {
    res.status(500).json({ message: 'Delete failed' });
  }
});

// PATCH /api/admin/users/:id/restore
router.patch('/:id/restore', protect, audit('restore_user', 'User'), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { deletedAt: null }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user.toPublic());
  } catch {
    res.status(500).json({ message: 'Restore failed' });
  }
});

// POST /api/admin/users/claim — client claims a quote and creates account
router.post('/claim', async (req, res) => {
  const { quoteId, name, email, password } = req.body;
  if (!quoteId || !email || !password) return res.status(400).json({ message: 'quoteId, email, and password required' });

  try {
    const quote = await Quote.findOne({ quoteId: quoteId.toUpperCase() });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.clientEmail !== email.toLowerCase()) return res.status(403).json({ message: 'Email does not match quote' });

    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await User.create({ name: name || quote.clientName, email, password, company: quote.clientCompany });
    }

    // Link all quotes for this email to user
    await Quote.updateMany({ clientEmail: email.toLowerCase() }, { userId: user._id });
    await User.findByIdAndUpdate(user._id, { quoteCount: await Quote.countDocuments({ userId: user._id }) });

    sendWelcomeEmail({ name: user.name, email, quoteId }).catch(() => {});

    res.json({ message: 'Account created and quotes linked', userId: user._id });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Email already has an account' });
    res.status(500).json({ message: 'Claim failed' });
  }
});

module.exports = router;
