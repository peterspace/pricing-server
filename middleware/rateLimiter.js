'use strict';
const rateLimit = require('express-rate-limit');

// General API limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again in 15 minutes.' },
});

// Strict limiter for analyse endpoint (Anthropic API calls are expensive)
const analyseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by email domain to catch abuse from same org
    const email = req.body?.clientEmail || req.ip;
    const domain = email.includes('@') ? email.split('@')[1] : email;
    return domain;
  },
  message: { message: 'Quote generation limit reached. Please contact us directly for more quotes.' },
  skip: (req) => {
    // Skip for admin-initiated regenerations (they have auth header)
    return !!req.headers.authorization;
  },
});

// Auth limiter — slow down brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again in 15 minutes.' },
});

module.exports = { apiLimiter, analyseLimiter, authLimiter };
