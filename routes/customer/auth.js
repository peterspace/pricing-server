'use strict';
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const User     = require('../../models/User');
const { customerProtect, signCustomerToken } = require('../../middleware/customerAuth');
const { authLimiter } = require('../../middleware/rateLimiter');
const { sendEmail } = require('../../services/emailService');

// POST /api/customer/auth/magic-link
router.post('/magic-link', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email?.includes('@')) {
    return res.status(400).json({ message: 'A valid email is required.' });
  }

  try {
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    let user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      user = await User.create({ email: email.trim().toLowerCase(), verified: false });
    }

    await User.findByIdAndUpdate(user._id, {
      magicLinkToken:  token,
      magicLinkExpiry: expiry,
    });

    const portalUrl = process.env.PORTAL_URL || 'http://localhost:5176';
    const link      = `${portalUrl}/auth/verify?token=${token}`;

    sendEmail({
      to:      email.trim().toLowerCase(),
      subject: 'Your tKle Portal sign-in link',
      body: [
        `Hi${user.name ? ` ${user.name}` : ''},`,
        '',
        'Click the link below to sign in to your tKle Business Dashboard:',
        '',
        link,
        '',
        'This link expires in 15 minutes and can only be used once.',
        '',
        'If you did not request this, you can safely ignore this email.',
        '',
        '— The tKle Team',
      ].join('\n'),
    }).catch(err => console.error('Magic link email failed:', err.message));

    // Always 200 — never reveal whether email exists
    res.json({ message: 'Sign-in link sent.' });
  } catch (err) {
    console.error('Magic link error:', err.message);
    res.json({ message: 'Sign-in link sent.' });
  }
});

// GET /api/customer/auth/verify?token=xxx
router.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ message: 'Token is required.' });

  try {
    const user = await User.findOne({ magicLinkToken: token }).select('+magicLinkToken +magicLinkExpiry +password');
    if (!user) {
      return res.status(401).json({ message: 'This link is invalid or has already been used.' });
    }
    if (new Date() > user.magicLinkExpiry) {
      return res.status(401).json({ message: 'This link has expired. Please request a new one.' });
    }

    // Consume the token — one-time use
    user.magicLinkToken  = null;
    user.magicLinkExpiry = null;
    user.verified        = true;
    await user.save();

    const jwtToken = signCustomerToken(user._id);
    res.json({ token: jwtToken, customer: user.toPublic() });
  } catch (err) {
    console.error('Magic link verify error:', err.message);
    res.status(500).json({ message: 'Verification failed.' });
  }
});

// POST /api/customer/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !user.password) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    user.lastSeen = new Date();
    await user.save();

    const token = signCustomerToken(user._id);
    res.json({ token, customer: user.toPublic() });
  } catch (err) {
    console.error('Customer login error:', err.message);
    res.status(500).json({ message: 'Login failed.' });
  }
});

// GET /api/customer/auth/me
router.get('/me', customerProtect, (req, res) => {
  res.json({ customer: req.customer.toPublic() });
});

// POST /api/customer/auth/logout
router.post('/logout', customerProtect, (req, res) => {
  res.json({ message: 'Logged out.' });
});

// POST /api/customer/auth/set-password
router.post('/set-password', customerProtect, async (req, res) => {
  const { password, currentPassword } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }

  try {
    const user = await User.findById(req.customer._id).select('+password');

    // If user already has a password, verify current one first
    if (user.password && currentPassword) {
      const match = await user.comparePassword(currentPassword);
      if (!match) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
    }

    user.password = password; // pre-save hook hashes it
    await user.save();

    res.json({ message: 'Password updated.', customer: user.toPublic() });
  } catch (err) {
    console.error('Set password error:', err.message);
    res.status(500).json({ message: 'Failed to update password.' });
  }
});

module.exports = router;
