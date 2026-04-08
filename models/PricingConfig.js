'use strict';
const mongoose = require('mongoose');

const LLMTierSchema = new mongoose.Schema({
  id:            String,
  label:         String,
  maxExec:       Number,
  tokensPerExec: Number,
  costPerMToken: Number,
  markup:        Number,
}, { _id: false });

const SupportContractSchema = new mongoose.Schema({
  enabled:       Boolean,
  months:        Number,
  hoursPerMonth: Number,
}, { _id: false });

const PricingConfigSchema = new mongoose.Schema({
  version:   { type: Number, default: 1 },
  updatedBy: { type: String, default: 'system' },

  rates: {
    agentBase:     { type: Number, default: 120 },
    llmNodeBase:   { type: Number, default: 85  },
    transformBase: { type: Number, default: 35  },
  },

  cogs: {
    hourlyRate:           { type: Number, default: 95   },
    hoursPerAgent:        { type: Number, default: 3    },
    hoursPerLLMNode:      { type: Number, default: 2    },
    hoursPerTransform:    { type: Number, default: 1    },
    overheadMultiplier:   { type: Number, default: 1.25 },
    targetMarginPct:      { type: Number, default: 0.40 },
    paygSetupFeeEnabled:  { type: Boolean, default: true },
  },

  plans: {
    whitelabel: {
      enabled:    { type: Boolean, default: true },
      multiplier: { type: Number,  default: 4.0  },
      minPrice:   { type: Number,  default: 3500 },
      supportContracts: {
        '3mo':  { type: SupportContractSchema, default: () => ({ enabled: true, months: 3,  hoursPerMonth: 3 }) },
        '6mo':  { type: SupportContractSchema, default: () => ({ enabled: true, months: 6,  hoursPerMonth: 4 }) },
        '12mo': { type: SupportContractSchema, default: () => ({ enabled: true, months: 12, hoursPerMonth: 5 }) },
      },
    },
    recurring: {
      enabled:              { type: Boolean, default: true  },
      multiplier:           { type: Number,  default: 1.0   },
      annualDiscount:       { type: Number,  default: 0.20  },
      minPrice:             { type: Number,  default: 349   },
      supportHoursPerMonth: { type: Number,  default: 3     },
    },
    payg: {
      enabled:                 { type: Boolean, default: true  },
      perRunRate:              { type: Number,  default: 0.08  },
      minPerRun:               { type: Number,  default: 2     },
      supportRetainerEnabled:  { type: Boolean, default: true  },
      supportRetainerPerMonth: { type: Number,  default: 199   },
    },
  },

  llmTiers: {
    type: [LLMTierSchema],
    default: () => [
      { id: 't1', label: '0 – 100',     maxExec: 100,     tokensPerExec: 2000, costPerMToken: 3.0, markup: 1.40 },
      { id: 't2', label: '100 – 1,000', maxExec: 1000,    tokensPerExec: 2000, costPerMToken: 3.0, markup: 1.35 },
      { id: 't3', label: '1k – 10k',    maxExec: 10000,   tokensPerExec: 2000, costPerMToken: 3.0, markup: 1.30 },
      { id: 't4', label: '10k – 100k',  maxExec: 100000,  tokensPerExec: 2000, costPerMToken: 2.5, markup: 1.25 },
      { id: 't5', label: '100k – 1M',   maxExec: 1000000, tokensPerExec: 2000, costPerMToken: 2.0, markup: 1.20 },
    ],
  },

  llm: {
    alertThresholdPct: { type: Number,  default: 0.80 },
    ownKeyDiscount:    { type: Number,  default: 0.20 },
    maxOwnKeys:        { type: Number,  default: 3    },
    hostedEnabled:     { type: Boolean, default: true },
  },

  complexity: {
    low:      { range: { type: [Number], default: [1, 3]  }, surcharge: { type: Number, default: 0.00 } },
    medium:   { range: { type: [Number], default: [4, 6]  }, surcharge: { type: Number, default: 0.10 } },
    high:     { range: { type: [Number], default: [7, 8]  }, surcharge: { type: Number, default: 0.20 } },
    veryHigh: { range: { type: [Number], default: [9, 10] }, surcharge: { type: Number, default: 0.35 } },
  },

  global: {
    minQuoteFloor:   { type: Number, default: 500  },
    currency:        { type: String, default: 'USD' },
    vatPercent:      { type: Number, default: 0    },
    quoteExpiryDays: { type: Number, default: 30   },
  },

  scopeClause: {
    type: String,
    default: 'This quote covers exactly the agents, LLM nodes, and transformations listed. Any scope changes generate a formal change order billed at standard rates.',
  },
}, { timestamps: true });

module.exports = mongoose.model('PricingConfig', PricingConfigSchema);
