'use strict';
/**
 * Google OAuth for Agent users
 * Uses simple redirect flow — no passport session needed.
 *
 * Flow:
 *   1. GET /api/agent/auth/google  → redirect to Google
 *   2. Google → GET /api/agent/auth/google/callback
 *   3. Server upserts AgentUser, signs JWT, redirects to agent app with token
 */
const express    = require('express');
const router     = express.Router();
const axios      = require('axios');
const AgentUser  = require('../../models/AgentUser');
const { signAgentToken } = require('../../middleware/agentAuth');

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USER_URL  = 'https://www.googleapis.com/oauth2/v3/userinfo'

function getCallbackUrl() {
  return process.env.AGENT_GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/agent/auth/google/callback'
}

function getClientUrl() {
  return process.env.AGENT_APP_URL || 'http://localhost:5175'
}

// GET /api/agent/auth/google — redirect to Google consent screen
router.get('/', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri:  getCallbackUrl(),
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  })
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`)
})

// GET /api/agent/auth/google/callback — Google redirects here with code
router.get('/callback', async (req, res) => {
  const { code, error } = req.query

  if (error || !code) {
    return res.redirect(`${getClientUrl()}/login?error=google_denied`)
  }

  try {
    // 1. Exchange code for tokens
    const tokenRes = await axios.post(GOOGLE_TOKEN_URL, {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  getCallbackUrl(),
      grant_type:    'authorization_code',
    })

    // 2. Get user info
    const userRes = await axios.get(GOOGLE_USER_URL, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    })

    const { email, name, sub: googleId } = userRes.data

    if (!email) {
      return res.redirect(`${getClientUrl()}/login?error=no_email`)
    }

    // 3. Upsert agent user
    let agent = await AgentUser.findOne({ email: email.toLowerCase() })

    if (!agent) {
      // New user — create with free plan, no password needed for OAuth
      const crypto = require('crypto');
      agent = await AgentUser.create({
        name:     name || email.split('@')[0],
        email:    email.toLowerCase(),
        password: crypto.randomBytes(32).toString('hex'), // OAuth stub — never used for login
        plan:     'free',
        googleId,
      })
    }

    // 4. Sign JWT and redirect to agent app
    const token = signAgentToken(agent._id)
    res.redirect(`${getClientUrl()}/auth/callback?token=${token}`)

  } catch (err) {
    console.error('Google OAuth error:', err.message)
    res.redirect(`${getClientUrl()}/login?error=oauth_failed`)
  }
})

module.exports = router
