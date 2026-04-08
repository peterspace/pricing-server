'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const PricingConfig = require('../models/PricingConfig');
const Settings = require('../models/Settings');

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  // Create default pricing config if none exists
  const configCount = await PricingConfig.countDocuments();
  if (configCount === 0) {
    await PricingConfig.create({});
    console.log('✓ Default pricing config created');
  }

  // Create default settings if none exists
  const settingsCount = await Settings.countDocuments();
  if (settingsCount === 0) {
    await Settings.create({});
    console.log('✓ Default settings created');
  }

  // Create super admin if none exists
  const adminCount = await Admin.countDocuments();
  if (adminCount === 0) {
    const admin = await Admin.create({
      name: process.env.SEED_ADMIN_NAME || 'Super Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@example.com',
      password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!',
      position: 'Super Admin',
    });
    console.log(`✓ Admin created: ${admin.email}`);
    console.log('  → Remember to change the password immediately!');
  } else {
    console.log(`ℹ  ${adminCount} admin(s) already exist — skipping`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

module.exports = { seed };
// seed().catch((err) => {
//   console.error("Seed error:", err.message);
//   process.exit(1);
// });
