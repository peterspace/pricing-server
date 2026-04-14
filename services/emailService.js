'use strict';
const nodemailer = require('nodemailer');
const Settings   = require('../models/Settings');

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function getSettings() {
  let s = await Settings.findOne();
  if (!s) { s = await Settings.create({}); }
  return s;
}

// ── Generic send (also exported for portal magic link emails) ────────────────
async function sendEmail({ to, subject, body, attachments = [] }) {
  const transport = createTransport();
  await transport.sendMail({
    from:        `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    text:        body,
    html:        body.replace(/\n/g, '<br>'),
    attachments,
  });
}

// ── Quote delivery ──────────────────────────────────────────────────────────
async function sendQuoteDelivery({ name, email, quoteId, price, company }) {
  const s   = await getSettings();
  const tpl = s.emailTemplates.quoteDelivery;
  const vars = { name, quoteId, price, company: s.companyName || company || 'n8n Pricing' };
  await sendEmail({
    to:      email,
    subject: interpolate(tpl.subject, vars),
    body:    interpolate(tpl.body, vars),
  });
}

// ── Workflow unlock (after payment) ─────────────────────────────────────────
async function sendWorkflowUnlock({ name, email, quoteId, workflowJson, docs }) {
  const s    = await getSettings();
  const tpl  = s.emailTemplates.workflowUnlock;
  const downloadLink = `${process.env.CLIENT_URL}/workflow/${quoteId}`;
  const vars = { name, quoteId, downloadLink, company: s.companyName || 'n8n Pricing' };

  const attachments = [
    {
      filename:    `workflow-${quoteId}.json`,
      content:     JSON.stringify(workflowJson, null, 2),
      contentType: 'application/json',
    },
    {
      filename:    `workflow-docs-${quoteId}.md`,
      content:     docs || '',
      contentType: 'text/markdown',
    },
  ];

  await sendEmail({
    to:          email,
    subject:     interpolate(tpl.subject, vars),
    body:        interpolate(tpl.body, vars),
    attachments,
  });
}

// ── LLM usage alert ─────────────────────────────────────────────────────────
async function sendUsageAlert({ name, email, quoteId, pct, tier }) {
  const s   = await getSettings();
  const tpl = s.emailTemplates.usageAlert;
  const vars = { name, quoteId, pct: Math.round(pct), tier, company: s.companyName || 'n8n Pricing' };
  await sendEmail({
    to:      email,
    subject: interpolate(tpl.subject, vars),
    body:    interpolate(tpl.body, vars),
  });
}

// ── Welcome email (account claimed) ─────────────────────────────────────────
async function sendWelcomeEmail({ name, email, quoteId }) {
  const s   = await getSettings();
  const tpl = s.emailTemplates.welcomeEmail;
  const vars = { name, quoteId, company: s.companyName || 'n8n Pricing' };
  await sendEmail({
    to:      email,
    subject: interpolate(tpl.subject, vars),
    body:    interpolate(tpl.body, vars),
  });
}

module.exports = {
  sendEmail,          // generic — used by portal magic link
  sendQuoteDelivery,
  sendWorkflowUnlock,
  sendUsageAlert,
  sendWelcomeEmail,
};
