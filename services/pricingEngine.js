'use strict';

function calcCOGS(analysis, cogs) {
  const { total_agents = 0, llm_nodes = 0, transformations = 0 } = analysis;
  const rawHours =
    total_agents    * cogs.hoursPerAgent +
    llm_nodes       * cogs.hoursPerLLMNode +
    transformations * cogs.hoursPerTransform;
  const totalHours   = rawHours * cogs.overheadMultiplier;
  const deliveryCost = totalHours * cogs.hourlyRate;
  const cogsFloor    = deliveryCost / (1 - cogs.targetMarginPct);
  return { rawHours, totalHours, deliveryCost, cogsFloor };
}

function calcLLMTierCost(tier, llmNodes) {
  if (!tier) return { rawCost: 0, markedUpCost: 0, alertAt: 0 };
  const totalTokens  = tier.maxExec * tier.tokensPerExec * (llmNodes || 1);
  const rawCost      = (totalTokens / 1_000_000) * tier.costPerMToken;
  const markedUpCost = rawCost * tier.markup;
  const alertAt      = Math.round(tier.maxExec * 0.8);
  return {
    rawCost:      Math.round(rawCost),
    markedUpCost: Math.round(markedUpCost),
    alertAt,
  };
}

function calcSupportCost(plan, contractKey, hourlyRate, plans) {
  if (plan === 'whitelabel' && contractKey) {
    const sc = plans.whitelabel.supportContracts[contractKey];
    if (!sc || !sc.enabled) return 0;
    return Math.round(sc.months * sc.hoursPerMonth * hourlyRate);
  }
  if (plan === 'recurring') {
    return Math.round((plans.recurring.supportHoursPerMonth || 0) * hourlyRate);
  }
  return 0;
}

/**
 * Calculate full price from analysis + config.
 * Returns { display, period, range, annualDisplay, lineItems, buildPrice,
 *           setupFee, vatAmt, totalHours, cogsFloor, llmTierAlert, savings, cogsWarning }
 */
function calculatePrice({ analysis, ownKeys = {}, hostedLLMs = true, plan, selectedTier, supportContract, config }) {
  const { rates: r, cogs: c, plans: p, llm, complexity, global: g } = config;
  const {
    total_agents = 0, llm_nodes = 0, transformations = 0, complexity: cScore = 5,
    complexity_label = 'Medium',
  } = analysis;

  const agentCost     = total_agents    * r.agentBase;
  const llmCost       = llm_nodes       * r.llmNodeBase;
  const transformCost = transformations * r.transformBase;
  const base          = agentCost + llmCost + transformCost;

  // Complexity surcharge
  let complexSurchargePct = 0;
  for (const tier of Object.values(complexity)) {
    const [lo, hi] = tier.range;
    if (cScore >= lo && cScore <= hi) { complexSurchargePct = tier.surcharge; break; }
  }
  const complexityAdd = Math.round(base * complexSurchargePct);

  // COGS
  const { cogsFloor, totalHours } = calcCOGS(analysis, c);

  // Own key discount
  const ownKeyCount    = Object.values(ownKeys).filter(Boolean).length;
  const keyDiscount    = (ownKeyCount / (llm.maxOwnKeys || 3)) * (llm.ownKeyDiscount || 0.2);
  const keyDiscountAmt = Math.round(base * keyDiscount);

  // LLM tier cost
  const tierData    = hostedLLMs && selectedTier ? calcLLMTierCost(selectedTier, llm_nodes) : { markedUpCost: 0, alertAt: 0 };
  const llmTierCost = tierData.markedUpCost;

  // Support
  const supportCost = calcSupportCost(plan, supportContract, c.hourlyRate, p);

  const pl = p[plan];
  let buildPrice, display, period, range, annualDisplay = null, setupFee = null;

  if (plan === 'payg') {
    const perRun = Math.max(
      pl.minPerRun,
      Math.round(base * pl.perRunRate * (1 - keyDiscount) + complexityAdd * pl.perRunRate),
    );
    buildPrice = perRun;
    if (c.paygSetupFeeEnabled) {
      setupFee = Math.max(g.minQuoteFloor, Math.round(cogsFloor * 0.5));
    }
    display = `$${perRun.toLocaleString()}/run`;
    period  = 'per execution (pay as you go)';
    range   = `One-time setup fee: $${setupFee ? setupFee.toLocaleString() : 'waived'}`;
  } else if (plan === 'whitelabel') {
    const raw  = Math.round((base + complexityAdd - keyDiscountAmt) * pl.multiplier + llmTierCost + supportCost);
    buildPrice = Math.max(pl.minPrice, Math.max(g.minQuoteFloor, raw), Math.round(cogsFloor));
    display    = `$${Math.round(buildPrice * 0.9).toLocaleString()} – $${Math.round(buildPrice * 1.1).toLocaleString()}`;
    period     = 'one-time payment';
    range      = `Includes build, docs, handover${supportContract ? ` + ${supportContract} support` : ''}`;
  } else {
    const raw    = Math.round((base + complexityAdd - keyDiscountAmt) * pl.multiplier + llmTierCost + supportCost);
    buildPrice   = Math.max(pl.minPrice, Math.max(g.minQuoteFloor, raw), Math.round(cogsFloor / 12));
    const annual = Math.round(buildPrice * 12 * (1 - pl.annualDiscount));
    display      = `$${buildPrice.toLocaleString()}/mo`;
    period       = 'per month, billed monthly';
    range        = `Includes ${pl.supportHoursPerMonth || 0}h support/mo`;
    annualDisplay = `$${annual.toLocaleString()}/yr (save ${Math.round(pl.annualDiscount * 100)}%)`;
  }

  const vatAmt = g.vatPercent > 0 && plan !== 'payg'
    ? Math.round(buildPrice * (g.vatPercent / 100)) : 0;

  const lineItems = [
    { label: 'Agent nodes',     detail: `${total_agents} × $${r.agentBase}`,      value: agentCost },
    { label: 'LLM nodes',       detail: `${llm_nodes} × $${r.llmNodeBase}`,        value: llmCost },
    { label: 'Transformations', detail: `${transformations} × $${r.transformBase}`, value: transformCost },
    ...(complexSurchargePct > 0 ? [{ label: `Complexity (${complexity_label})`, detail: `+${Math.round(complexSurchargePct * 100)}%`, value: complexityAdd }] : []),
    ...(ownKeyCount > 0 ? [{ label: 'Own API key discount', detail: `-${Math.round(keyDiscount * 100)}%`, value: -keyDiscountAmt, isDiscount: true }] : []),
    ...(llmTierCost > 0 ? [{ label: `Hosted LLM (${selectedTier?.label})`, detail: `${Math.round((selectedTier?.markup || 1) * 100 - 100)}% markup`, value: llmTierCost }] : []),
    ...(supportCost > 0 ? [{ label: plan === 'whitelabel' ? `Support (${supportContract})` : `Support (${pl.supportHoursPerMonth}h/mo)`, detail: `$${c.hourlyRate}/hr`, value: supportCost }] : []),
    ...(setupFee ? [{ label: 'One-time setup fee', detail: 'build + deployment', value: setupFee }] : []),
    ...(vatAmt > 0 ? [{ label: `VAT (${g.vatPercent}%)`, detail: '', value: vatAmt }] : []),
  ];

  return {
    display, period, range, annualDisplay, lineItems,
    savings:      ownKeyCount > 0 ? `Saving ~${Math.round(keyDiscount * 100)}% with own API keys` : null,
    cogsWarning:  buildPrice < cogsFloor ? `Quote near delivery cost floor ($${Math.round(cogsFloor).toLocaleString()})` : null,
    buildPrice,
    setupFee,
    vatAmt,
    totalHours:   Math.round(totalHours * 10) / 10,
    cogsFloor:    Math.round(cogsFloor),
    llmTierAlert: tierData.alertAt,
  };
}

function diffQuotes(original, updated) {
  return ['total_agents', 'llm_nodes', 'transformations'].map(f => ({
    field:  f,
    label:  f === 'total_agents' ? 'Agents' : f === 'llm_nodes' ? 'LLM nodes' : 'Transformations',
    before: original[f] ?? 0,
    after:  updated[f]  ?? 0,
    delta:  (updated[f] ?? 0) - (original[f] ?? 0),
  })).filter(d => d.delta !== 0);
}

function generateQuoteId() {
  return 'QT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

module.exports = { calculatePrice, calcCOGS, calcLLMTierCost, diffQuotes, generateQuoteId };
