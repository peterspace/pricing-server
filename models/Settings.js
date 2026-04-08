'use strict';
const mongoose = require('mongoose');

const EmailTemplateSchema = new mongoose.Schema({
  subject: { type: String, default: '' },
  body:    { type: String, default: '' },
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  companyName:  { type: String, default: '' },
  supportEmail: { type: String, default: '' },
  fromEmail:    { type: String, default: '' },
  n8nUrl:       { type: String, default: '' },
  n8nApiKey:    { type: String, default: '', select: false },

  emailTemplates: {
    quoteDelivery:  { type: EmailTemplateSchema, default: () => ({
      subject: 'Your automation quote is ready — {{quoteId}}',
      body: 'Hi {{name}},\n\nYour quote {{quoteId}} is ready.\n\nEstimated price: {{price}}\n\nYour Quote ID: {{quoteId}}\n\nSave this ID — you can use it to update your requirements or track your order.\n\nBest,\n{{company}}',
    })},
    workflowUnlock: { type: EmailTemplateSchema, default: () => ({
      subject: 'Your n8n workflow is ready — {{quoteId}}',
      body: 'Hi {{name}},\n\nPayment confirmed. Your n8n automation workflow is ready.\n\nDownload your workflow JSON here: {{downloadLink}}\n\nImport it directly into n8n: File → Import from File.\n\nYour step-by-step documentation is attached.\n\nBest,\n{{company}}',
    })},
    usageAlert: { type: EmailTemplateSchema, default: () => ({
      subject: "You've used {{pct}}% of your AI tier — {{quoteId}}",
      body: "Hi {{name}},\n\nYour workflow {{quoteId}} has used {{pct}}% of your monthly AI execution tier ({{tier}}).\n\nIf you exceed your limit, executions will pause. Upgrade your tier anytime by contacting us.\n\nBest,\n{{company}}",
    })},
    welcomeEmail: { type: EmailTemplateSchema, default: () => ({
      subject: 'Welcome to n8n Pricing — your account is ready',
      body: 'Hi {{name}},\n\nYour account has been created and your quote {{quoteId}} is now linked to it.\n\nYou can view all your quotes and track order status in your dashboard.\n\nBest,\n{{company}}',
    })},
  },

  infra: {
    monthlyServerCost:     { type: Number, default: 120 },
    monthlyDBCost:         { type: Number, default: 30  },
    monthlyMonitoringCost: { type: Number, default: 20  },
    otherMonthlyCost:      { type: Number, default: 30  },
  },
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
