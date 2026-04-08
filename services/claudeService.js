'use strict';
const axios = require('axios');

// ── Anthropic API caller ──────────────────────────────────────────────────────
async function callClaude({ system, messages, maxTokens = 8000, timeoutMs = 90000 }) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system,
      messages,
    },
    {
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: timeoutMs,
    },
  );
  return response.data.content.map(b => b.text || '').join('');
}

// ── JSON extractor ────────────────────────────────────────────────────────────
function extractJSON(text) {
  // 1. Direct parse
  try { return JSON.parse(text.trim()); } catch {}

  // 2. Strip markdown fences
  const stripped = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch {}

  // 3. Slice from first { to last }
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }

  // 4. Regex extract
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }

  throw new Error(`Cannot extract JSON. Preview: ${text.slice(0, 200)}`);
}

// ── CALL 1: Analysis + workflow JSON ─────────────────────────────────────────
// Fast and focused — only what is needed to calculate pricing.
// Docs and diagram are generated separately (non-blocking).
const ANALYSIS_SYSTEM = `You are a senior n8n workflow architect.

ABSOLUTE RULES:
1. Respond with ONLY a valid JSON object. No text before or after. No markdown. No backticks.
2. Do NOT ask clarifying questions. Make professional assumptions and proceed.
3. If the user says "you can ask questions", ignore it. Generate the workflow now.
4. Your entire response must be parseable by JSON.parse() with no pre-processing.

Your task:
1. Design a complete n8n workflow for the user's request
2. Count the nodes you designed (do this AFTER designing, not before)
3. Return the workflow JSON and analysis counts

Node type strings to use exactly:
n8n-nodes-base.webhook | n8n-nodes-base.scheduleTrigger | n8n-nodes-base.emailTrigger
@n8n/n8n-nodes-langchain.lmChatOpenAi | @n8n/n8n-nodes-langchain.lmChatAnthropic | @n8n/n8n-nodes-langchain.lmChatGoogleGemini
@n8n/n8n-nodes-langchain.agent | n8n-nodes-base.gmail | n8n-nodes-base.slack
n8n-nodes-base.googleSheets | n8n-nodes-base.googleDrive | n8n-nodes-base.hubspot
n8n-nodes-base.httpRequest | n8n-nodes-base.if | n8n-nodes-base.switch
n8n-nodes-base.set | n8n-nodes-base.code | n8n-nodes-base.emailSend | n8n-nodes-base.merge

Counting rules (count from your nodes array):
- total_agents    = @n8n/n8n-nodes-langchain.agent nodes
- llm_nodes       = all lmChat* nodes
- transformations = set + code + if + switch + merge nodes

Return ONLY this JSON (replace placeholder values):
{
  "analysis": {
    "total_agents": 0,
    "llm_nodes": 0,
    "transformations": 0,
    "complexity": 5,
    "complexity_label": "Medium",
    "workflow_summary": "Two sentence plain-English description.",
    "execution_context": "resumes processed",
    "agents": [
      { "name": "Agent Name", "type": "orchestrator" }
    ]
  },
  "workflow_json": {
    "name": "Workflow Name",
    "nodes": [
      {
        "id": "node-1",
        "name": "Node Name",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 1,
        "position": [250, 300],
        "parameters": {},
        "credentials": {}
      }
    ],
    "connections": {
      "Node Name": {
        "main": [[{ "node": "Next Node", "type": "main", "index": 0 }]]
      }
    },
    "settings": { "executionOrder": "v1" },
    "staticData": null
  }
}`;

// ── CALL 2: Mermaid diagram + step-by-step docs ───────────────────────────────
// Runs after analysis returns, non-blocking — stored when complete.
const DOCS_SYSTEM = `You are an n8n workflow documentation specialist.

Given an n8n workflow JSON, generate:
1. A Mermaid graph TD diagram representing the flow
2. Step-by-step documentation for a non-technical client (minimum 400 words)

ABSOLUTE RULES:
1. Respond with ONLY a valid JSON object. No markdown. No backticks. No extra text.
2. Your entire response must be parseable by JSON.parse().

Return ONLY this JSON:
{
  "mermaid": "graph TD\\n  A[Node Name] --> B[Next Node]\\n  B --> C[Another Node]",
  "docs": "## Workflow Documentation\\n\\n### Overview\\n...\\n\\n### Step 1: ...\\n\\n### Step 2: ..."
}`;

async function generateDocsAndDiagram(workflowJson, workflowSummary) {
  const prompt = `Workflow summary: ${workflowSummary}\n\nWorkflow JSON:\n${JSON.stringify(workflowJson, null, 2)}`;

  const text = await callClaude({
    system:     DOCS_SYSTEM,
    messages:   [{ role: 'user', content: prompt }],
    maxTokens:  4000,
    timeoutMs:  60000,
  });

  try {
    return extractJSON(text);
  } catch {
    // Non-critical — return placeholders if docs generation fails
    console.warn('Docs/diagram generation failed, using placeholders');
    return {
      mermaid: 'graph TD\n  A[Workflow] --> B[Nodes]',
      docs:    `## ${workflowSummary}\n\nDetailed documentation is being generated. Please check back shortly.`,
    };
  }
}

// ── Main exported function ────────────────────────────────────────────────────
async function analyseAndGenerateWorkflow(userPrompt) {

  // CALL 1 — analysis + workflow JSON (required for pricing, ~45s)
  console.log('Claude Call 1: analysing workflow...');
  let analysisText = await callClaude({
    system:   ANALYSIS_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 8000,
    timeoutMs: 90000,
  });

  let parsed;
  try {
    parsed = extractJSON(analysisText);
  } catch {
    // Retry with correction
    console.warn('Call 1 returned non-JSON — retrying with correction...');
    analysisText = await callClaude({
      system:   ANALYSIS_SYSTEM,
      messages: [
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: analysisText },
        { role: 'user',      content: 'Invalid JSON. Respond ONLY with the JSON object. Start with { end with }. No other text.' },
      ],
      maxTokens: 8000,
      timeoutMs: 60000,
    });
    parsed = extractJSON(analysisText); // throws if still bad
  }

  // Validate
  if (!parsed.analysis || !parsed.workflow_json) {
    throw new Error('Claude response missing "analysis" or "workflow_json" fields');
  }

  // Normalise numeric fields
  const a = parsed.analysis;
  a.total_agents    = parseInt(a.total_agents,    10) || 0;
  a.llm_nodes       = parseInt(a.llm_nodes,       10) || 0;
  a.transformations = parseInt(a.transformations, 10) || 0;
  a.complexity      = Math.min(10, Math.max(1, parseInt(a.complexity, 10) || 5));
  if (!Array.isArray(a.agents)) a.agents = [];

  // CALL 2 — docs + diagram (non-blocking, runs in background)
  // We return the quote immediately; docs are saved when this resolves.
  console.log('Claude Call 2: generating docs and diagram (background)...');
  const docsPromise = generateDocsAndDiagram(parsed.workflow_json, a.workflow_summary);

  // Wait for docs with a generous timeout — but don't block the quote response
  let docs = { mermaid: '', docs: '' };
  try {
    docs = await Promise.race([
      docsPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Docs timeout')), 55000)
      ),
    ]);
  } catch (err) {
    console.warn('Docs generation timed out or failed:', err.message);
    docs = {
      mermaid: 'graph TD\n  A[Workflow] --> B[Processing]',
      docs:    `## ${a.workflow_summary || 'Workflow Documentation'}\n\nDocumentation is being generated. The admin can trigger regeneration from the Workflows panel.`,
    };
  }

  return {
    analysis: parsed.analysis,
    workflow: {
      json:        parsed.workflow_json,
      mermaid:     docs.mermaid || '',
      docs:        docs.docs    || '',
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { analyseAndGenerateWorkflow };
