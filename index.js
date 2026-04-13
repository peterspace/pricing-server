'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const { apiLimiter } = require('./middleware/rateLimiter');
const { seed } = require('./utils/seed');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Render, Heroku, etc.)

// ── Connect MongoDB ───────────────────────────────────────────────────────────
connectDB();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      process.env.ADMIN_URL,
      process.env.AGENT_URL,
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
    ],
    credentials: true,
  }),
);

// ── Stripe webhook MUST use raw body — mount BEFORE express.json() ────────────
const stripeRouter = require('./routes/stripe');
app.use('/api/stripe', stripeRouter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ── Global rate limiter ───────────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/config', require('./routes/config'));
app.use('/api/clarify', require('./routes/clarify'));
app.use('/api/analyse', require('./routes/analyse'));
app.use('/api/quotes', require('./routes/quotes')); // includes all /api/quotes/* + n8n callbacks

// ── Agent routes ──────────────────────────────────────────────────────────────
// Google must be mounted before /api/agent/auth to avoid route conflict
app.use('/api/agent/auth/google', require('./routes/agent/google'));
app.use('/api/agent/auth', require('./routes/agent/auth'));
app.use('/api/agent/conversations', require('./routes/agent/conversations'));
app.use('/api/agent/clarify', require('./routes/agent/clarify'));
app.use('/api/agent/analyse', require('./routes/agent/analyse'));
app.use('/api/agent/settings', require('./routes/agent/settings'));
app.use('/api/agent/billing', require('./routes/agent/billing'));

// ── Admin routes (all protected by JWT in individual routers) ─────────────────
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/dashboard', require('./routes/admin/dashboard'));
app.use('/api/admin/quotes', require('./routes/admin/quotes'));
app.use('/api/admin/workflows', require('./routes/admin/workflows'));
app.use('/api/admin/users', require('./routes/admin/users'));
app.use('/api/admin/admins', require('./routes/admin/admins'));
app.use('/api/admin/subscriptions', require('./routes/admin/subscriptions'));
app.use('/api/admin/accounting', require('./routes/admin/accounting'));
app.use('/api/admin/config', require('./routes/admin/config'));
app.use('/api/admin/settings', require('./routes/admin/settings'));
app.use('/api/admin/change-orders', require('./routes/admin/changeOrders'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res
    .status(404)
    .json({ message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    message:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
  });
});

//======{Run seed only once to setup admin user}======
// seed().catch((err) => {
//   console.error("Seed error:", err.message);
//   process.exit(1);
// });

// ── To generate a strong webhook secret ──────────────────────────────────────
// node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`,
  );
});

// Allow up to 3 minutes for AI analysis endpoints
server.timeout = 180000;
server.keepAliveTimeout = 180000;

// ── Stuck-quote cleanup job ───────────────────────────────────────────────────
// Runs every 5 minutes. Marks quotes stuck in 'processing' for > 8 minutes as
// failed so clients stop polling. Covers n8n crashes and network failures.
const Quote = require('./models/Quote');
setInterval(
  async () => {
    try {
      const cutoff = new Date(Date.now() - 8 * 60 * 1000);
      const result = await Quote.updateMany(
        {
          analysisStatus: 'processing',
          $or: [
            { wf23SentAt: { $lt: cutoff } },
            { wf1SentAt: { $lt: cutoff }, status: 'new' },
            {
              createdAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) },
              analysisStatus: 'processing',
            },
          ],
        },
        { analysisStatus: 'failed', status: 'cancelled' },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `Cleanup: marked ${result.modifiedCount} stuck quote(s) as failed`,
        );
      }
    } catch (err) {
      console.error('Cleanup job error:', err.message);
    }
  },
  5 * 60 * 1000,
);

module.exports = app;
