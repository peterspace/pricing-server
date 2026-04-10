'use strict';
const express    = require('express');
const router     = express.Router();
const AgentUser  = require('../../models/AgentUser');
const { agentProtect, signAgentToken } = require('../../middleware/agentAuth');

// POST /api/agent/auth/signup
router.post('/signup', async (req, res) => {
  const { name, email, password, company = '', plan = 'free' } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  if (!['free','starter','growth','pro','agency'].includes(plan)) {
    return res.status(400).json({ message: 'Invalid plan.' });
  }

  try {
    const existing = await AgentUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const agent = await AgentUser.create({ name: name.trim(), email, password, company: company.trim(), plan });
    const token = signAgentToken(agent._id);

    res.status(201).json({ token, agent: agent.toPublic() });
  } catch (err) {
    console.error('Agent signup error:', err.message);
    res.status(500).json({ message: 'Signup failed. Please try again.' });
  }
});

// POST /api/agent/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const agent = await AgentUser.findOne({ email: email.toLowerCase() }).select('+password');
    if (!agent || !(await agent.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    agent.lastLogin = new Date();
    await agent.save();

    const token = signAgentToken(agent._id);
    res.json({ token, agent: agent.toPublic() });
  } catch (err) {
    console.error('Agent login error:', err.message);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

// GET /api/agent/auth/me
router.get('/me', agentProtect, (req, res) => {
  res.json(req.agent.toPublic());
});

// POST /api/agent/auth/logout
router.post('/logout', agentProtect, (req, res) => {
  res.json({ message: 'Logged out.' });
});

// POST /api/agent/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required.' });
  // Always return success to prevent email enumeration
  // TODO: implement email sending with a reset token
  console.log('Password reset requested for:', email);
  res.json({ message: 'If an account exists, a reset link has been sent.' });
});

module.exports = router;
