/* Senior Care Diagram Maker — serverless proxy (Google Cloud Function, gen2)
   What this does
   - Holds the Anthropic API key server-side (never exposed to the browser).
   - Accepts two input modes:
       • "describe"  — short natural-language description (up to 1,500 chars)
       • "policy"    — pasted policy/procedure text       (up to 8,000 chars)
   - Routes to Claude Haiku with a mode-appropriate system prompt and returns
     a single valid Mermaid diagram.
   - Enforces cost guards:
        1) per-IP rate limits (per-minute + per-day, in-memory soft limits)
        2) global soft daily cap (in-memory, per warm instance)
        3) hard caps on prompt size and output tokens
      Backed by two platform guarantees you set during deploy:
        • Cloud Function --max-instances=3 (caps concurrency)
        • an Anthropic Console monthly spend limit (the hard $ ceiling)
   - When LOG_PROMPTS=true, writes one record per request to Firestore
     collection `diagram_logs` so you can analyse what facilities are mapping.
     IP addresses are SHA-256 hashed before storage (never raw IPs).

   Deploy: see deploy.sh / SETUP.md */

const functions = require('@google-cloud/functions-framework');
const crypto    = require('crypto');

/* Lazy Firestore init — only loaded if the module is present. Keeps unit
   tests (which stub out functions-framework) from needing the dep. */
let db = null;
try {
  const { Firestore } = require('@google-cloud/firestore');
  db = new Firestore();
} catch (e) {
  console.warn('Firestore client unavailable — logging disabled:', e.message);
}

const LIMITS = {
  MODEL:            'claude-haiku-4-5-20251001',
  MAX_TOKENS:       1100,

  MAX_PROMPT_LENGTH:  10000,  // absolute ceiling across all modes; returns 400
  MAX_DESCRIBE_CHARS: 1500,   // describe mode
  MAX_POLICY_CHARS:   8000,   // policy mode (pasted policy text)

  PER_IP_PER_MIN:   5,
  PER_IP_PER_DAY:   40,
  GLOBAL_PER_DAY:   2000,     // soft per-instance daily ceiling

  LEAD_PER_IP_PER_DAY: 3,
  LEAD_GLOBAL_PER_DAY: 500
};

// Basic RFC-5322-ish email regex — rejects obvious non-emails, not exhaustive
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---- in-memory soft rate limiter (per warm instance) ---- */
const hits = new Map(); // key -> { count, resetAt }
function allow(key, limit, windowMs) {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now > e.resetAt) { hits.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (e.count >= limit) return false;
  e.count++;
  return true;
}
function sweep() { const now = Date.now(); for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k); }

/* ---- diagram-type hint, mode-aware system prompt ---- */
function systemPrompt(type, mode) {
  const hint = ({
    flowchart: 'a top-down flowchart (`flowchart TD`)',
    org:       'a top-down organizational chart using `flowchart TD` with boxes and reporting lines',
    sequence:  'a `sequenceDiagram`',
    mindmap:   'a `mindmap`',
    timeline:  'a `timeline`',
    decision:  'a decision tree using `flowchart TD` with diamond decision nodes and Yes/No labels'
  })[type] || 'the most appropriate Mermaid diagram';

  const base = mode === 'policy'
    ? [
        'You are a diagramming assistant for senior care and assisted living teams.',
        'The user has pasted a policy, procedure, or guideline document.',
        'Read it carefully, extract the operational steps, decisions, roles, and escalation paths, and turn THAT into a single valid Mermaid.js diagram.',
        'Ignore preamble, legal boilerplate, definitions, and citations — focus on what someone actually does, step by step.',
        `Prefer ${hint}.`
      ]
    : [
        'You are a diagramming assistant for senior care and assisted living teams.',
        "Turn the user's description into a single valid Mermaid.js diagram.",
        `Prefer ${hint}.`
      ];

  const rules = [
    'Rules:',
    '- Output ONLY the Mermaid code. No explanation, no markdown fences, no backticks.',
    '- Keep node labels short and clear; wrap long text in double quotes.',
    '- Use simple, ASCII-safe characters in IDs; put readable text in the labels.',
    '- Avoid parentheses, semicolons, and special characters inside labels that break Mermaid.',
    '- Keep it readable: aim for 6-20 nodes unless more are clearly needed.',
    '- It must parse on the first try.'
  ];

  return [...base, ...rules].join('\n');
}

/* ---- strip code fences / stray backticks ---- */
function cleanMermaid(raw) {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/^`+|`+$/g, '').trim();
}

/* ---- one-way IP hash (so we never store raw IPs) ---- */
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 16);
}

/* ---- Firestore logging (gated by LOG_PROMPTS env) ---- */
async function logEvent(doc) {
  if (!db || process.env.LOG_PROMPTS !== 'true') return;
  try {
    await db.collection('diagram_logs').add({
      ...doc,
      timestamp: new Date()
    });
  } catch (e) {
    // Never let logging failures break the user request.
    console.warn('Firestore write failed:', e.message);
  }
}

/* ---- lead capture Firestore write ---- */
async function writeLead(doc) {
  if (!db) return null;
  return db.collection('leads').add({
    ...doc,
    createdAt: new Date()
  });
}

/* HTTP handler  (entry point name = "diagram", referenced in deploy.sh) */
functions.http('diagram', async (req, res) => {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Lead capture action — only active when kill switch is on.
  // When LEAD_CAPTURE_ENABLED is not 'true', this branch is skipped entirely
  // and the request falls through to the existing diagram handler, which
  // returns the same 400 "Empty prompt" any other unrecognized action gets.
  if (process.env.LEAD_CAPTURE_ENABLED === 'true' && req.body && req.body.action === 'lead_capture') {
    const rawIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = hashIp(rawIp);
    const day = new Date().toISOString().slice(0, 10);

    if (Math.random() < 0.05) sweep();

    if (!allow(`lg:${day}`, LIMITS.LEAD_GLOBAL_PER_DAY, 86400000)) {
      return res.status(503).json({ error: 'Daily limit reached' });
    }
    if (!allow(`lead:${ipHash}`, LIMITS.LEAD_PER_IP_PER_DAY, 86400000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    const { email, consent, termsVersion, interestedWorkflow, sourcePage } = req.body;

    if (!email || !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (consent !== true) {
      return res.status(400).json({ error: 'Consent required' });
    }
    if (!termsVersion || !String(termsVersion).trim()) {
      return res.status(400).json({ error: 'termsVersion required' });
    }

    const leadDoc = {
      email: String(email),
      interestedWorkflow: interestedWorkflow ? String(interestedWorkflow) : null,
      sourcePage: sourcePage ? String(sourcePage) : null,
      consentTermsVersion: String(termsVersion),
      ipHash,
      status: 'pending'
    };

    try {
      await writeLead(leadDoc);
    } catch (e) {
      console.warn('Lead Firestore write failed:', e.message);
      return res.status(502).json({ error: 'Could not save lead' });
    }

    return res.status(200).json({ received: true });
  }

  // Parse + validate input
  const prompt = (req.body && req.body.prompt ? String(req.body.prompt) : '').trim();
  const type   = (req.body && req.body.type   ? String(req.body.type)   : 'flowchart');
  let   mode   = (req.body && req.body.mode   ? String(req.body.mode)   : 'describe');
  if (mode !== 'policy' && mode !== 'describe') mode = 'describe';

  if (!prompt) return res.status(400).json({ error: 'Empty prompt' });

  // MAX_PROMPT_LENGTH must exceed MAX_POLICY_CHARS or the absolute 400 path is unreachable
  // before the per-mode 413 path; keep MAX_PROMPT_LENGTH > MAX_POLICY_CHARS.
  if (prompt.length > LIMITS.MAX_PROMPT_LENGTH) {
    return res.status(400).json({ error: 'Prompt too long', max: LIMITS.MAX_PROMPT_LENGTH });
  }

  const cap = mode === 'policy' ? LIMITS.MAX_POLICY_CHARS : LIMITS.MAX_DESCRIBE_CHARS;
  if (prompt.length > cap) return res.status(413).json({ error: 'Prompt too long', cap });

  // Cost guards
  if (Math.random() < 0.05) sweep();
  const rawIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ipHash = hashIp(rawIp);
  const day = new Date().toISOString().slice(0, 10);

  if (!allow(`g:${day}`,        LIMITS.GLOBAL_PER_DAY,    86400000)) return res.status(503).json({ error: 'Daily limit reached' });
  if (!allow(`m:${ipHash}`,     LIMITS.PER_IP_PER_MIN,    60000))    return res.status(429).json({ error: 'Rate limited' });
  if (!allow(`d:${ipHash}:${day}`, LIMITS.PER_IP_PER_DAY, 86400000)) return res.status(429).json({ error: 'Rate limited' });

  // Call Anthropic
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server not configured' });

  const referer = String(req.headers['referer'] || req.headers['referrer'] || '').slice(0, 300);
  const logBase = { mode, type, prompt, prompt_chars: prompt.length, ip_hash: ipHash, referer };

  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: LIMITS.MODEL,
        max_tokens: LIMITS.MAX_TOKENS,
        system: systemPrompt(type, mode),
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (e) {
    await logEvent({ ...logBase, success: false, error: 'upstream_unreachable' });
    return res.status(502).json({ error: 'Upstream unreachable' });
  }

  if (!aiRes.ok) {
    const detail = await aiRes.text().catch(() => '');
    await logEvent({ ...logBase, success: false, error: 'upstream_' + aiRes.status });
    return res.status(502).json({ error: 'Upstream error', status: aiRes.status, detail: detail.slice(0, 300) });
  }

  const data = await aiRes.json();
  const mermaid = cleanMermaid(data && data.content && data.content[0] ? data.content[0].text : '');
  if (!mermaid) {
    await logEvent({ ...logBase, success: false, error: 'empty_result' });
    return res.status(502).json({ error: 'Empty result' });
  }

  // success path
  await logEvent({
    ...logBase,
    success: true,
    mermaid_chars: mermaid.length,
    usage_in:  data?.usage?.input_tokens  || null,
    usage_out: data?.usage?.output_tokens || null
  });

  return res.status(200).json({ mermaid });
});

// exported for unit tests
module.exports = { systemPrompt, cleanMermaid, allow, hashIp, _hits: hits, LIMITS };
