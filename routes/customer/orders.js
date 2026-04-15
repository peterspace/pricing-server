'use strict';
const express  = require('express');
const router   = express.Router();
const Quote    = require('../../models/Quote');
const { customerProtect } = require('../../middleware/customerAuth');

router.use(customerProtect);

// GET /api/customer/orders — list, newest first
router.get('/', async (req, res) => {
  try {
    const orders = await Quote.find({
      clientEmail: req.customer.email,
      status:      { $ne: 'cancelled' },
    })
    .select('quoteId status analysisStatus request analysis createdAt updatedAt plan price hostedLLMs ownKeys selectedTierId workflowLocked')
    .sort({ createdAt: -1 })
    .lean();

    res.json({ orders });
  } catch (err) {
    console.error('Customer orders error:', err.message);
    res.status(500).json({ message: 'Failed to load orders.' });
  }
});

// GET /api/customer/orders/:quoteId — full detail (no workflow JSON)
router.get('/:quoteId', async (req, res) => {
  try {
    const order = await Quote.findOne({
      quoteId:     req.params.quoteId.toUpperCase(),
      clientEmail: req.customer.email,
    })
    .select('-workflow.json -workflow.mermaid -workflow.docs -messages')  // strip internal fields
    .lean();

    if (!order) return res.status(404).json({ message: 'Order not found.' });

    res.json({ order });
  } catch (err) {
    console.error('Customer order detail error:', err.message);
    res.status(500).json({ message: 'Failed to load order.' });
  }
});

module.exports = router;
