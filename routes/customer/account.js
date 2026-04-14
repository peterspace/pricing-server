'use strict';
const express  = require('express');
const router   = express.Router();
const User     = require('../../models/User');
const { customerProtect } = require('../../middleware/customerAuth');

router.use(customerProtect);

// PUT /api/customer/account
router.put('/', async (req, res) => {
  const { name, company } = req.body;
  try {
    const user = await User.findByIdAndUpdate(
      req.customer._id,
      {
        ...(name    !== undefined && { name:    name.trim() }),
        ...(company !== undefined && { company: company.trim() }),
      },
      { new: true }
    );
    res.json({ customer: user.toPublic() });
  } catch (err) {
    console.error('Customer account update error:', err.message);
    res.status(500).json({ message: 'Failed to update account.' });
  }
});

module.exports = router;
