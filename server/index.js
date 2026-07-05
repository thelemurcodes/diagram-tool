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

   Deploy: see deploy.sh / SETUP.md

   Required env vars (set in deploy.sh alongside ANTHROPIC_API_KEY):
     ANTHROPIC_API_KEY  — Anthropic API key
     RESEND_API_KEY     — Resend API key for confirmation emails (lead capture)
     FUNCTION_URL       — public base URL of this Cloud Function (e.g. https://...run.app),
                          used to build the confirmation link in opt-in emails
     INSIGHTS_PASSWORD  — shared secret for the usage_intel endpoint; must be set at deploy
                          time like ANTHROPIC_API_KEY/RESEND_API_KEY/LEAD_CAPTURE_ENABLED */

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
  LEAD_GLOBAL_PER_DAY: 500,

  LEAD_CONFIRM_PER_IP_PER_DAY:  20,
  LEAD_CONFIRM_GLOBAL_PER_DAY:  1000
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

/* ---- lead capture Firestore write ----
   IMPORTANT for whoever reviews/exports this collection: rows start status:'pending' and only
   become status:'confirmed' when the recipient clicks their emailed confirmation link (see the
   lead_confirm handler below). A 'pending' row's email was never verified and could belong to
   anyone — never contact or export a lead unless status === 'confirmed'. There is no admin/export
   tool that enforces this yet; it's a manual requirement until one exists. */
async function writeLead(doc) {
  if (!db) return null;
  return db.collection('leads').add({
    ...doc,
    createdAt: new Date()
  });
}

/* ---- send double opt-in confirmation email via Resend ---- */
async function sendConfirmEmail(email, token) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('RESEND_API_KEY not set — confirmation email not sent');
    return;
  }
  const functionUrl = process.env.FUNCTION_URL || '';
  const confirmLink = `${functionUrl}?action=lead_confirm&token=${token}`;
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Senior Care Diagram Maker <noreply@mail.seniorcarediagram.com>',
        to: email,
        subject: 'Please confirm your email',
        html: `<p>Thanks for signing up! Please confirm your email address:</p><p><a href="${confirmLink}">Confirm my email</a></p>`
      })
    });
    if (!emailRes.ok) {
      const detail = await emailRes.text().catch(() => '');
      console.warn('Resend API error:', emailRes.status, detail.slice(0, 200));
    }
  } catch (e) {
    console.warn('Confirmation email send failed:', e.message);
  }
}

/* ---- usage_intel aggregation ---- */
async function handleUsageIntel(req, res) {
  const providedKey = req.body && req.body.insightsKey ? String(req.body.insightsKey) : '';
  const expectedKey = process.env.INSIGHTS_PASSWORD || '';

  if (!expectedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let snapshot;
  try {
    snapshot = await db.collection('diagram_logs')
      .orderBy('timestamp', 'desc')
      .limit(500)
      .get();
  } catch (e) {
    console.warn('usage_intel Firestore query failed:', e.message);
    return res.status(502).json({ error: 'Could not retrieve usage data' });
  }

  const docs = snapshot.docs.map(d => d.data());
  const totalFetched = docs.length;

  let successCount = 0;
  const byType = {};
  const byMode = {};
  const byTemplateId = {};
  const byReferrerAll = {};
  const dailyVolume = {};

  for (const doc of docs) {
    if (doc.success === true) successCount++;

    if (doc.type) byType[doc.type] = (byType[doc.type] || 0) + 1;
    if (doc.mode) byMode[doc.mode] = (byMode[doc.mode] || 0) + 1;

    if (doc.template_id != null) {
      byTemplateId[doc.template_id] = (byTemplateId[doc.template_id] || 0) + 1;
    }

    const ref = doc.referer || '';
    byReferrerAll[ref] = (byReferrerAll[ref] || 0) + 1;

    if (doc.timestamp) {
      const ts = doc.timestamp.toDate ? doc.timestamp.toDate() : new Date(doc.timestamp);
      const day = ts.toISOString().slice(0, 10);
      dailyVolume[day] = (dailyVolume[day] || 0) + 1;
    }
  }

  const successRate = totalFetched > 0 ? successCount / totalFetched : 0;

  const byReferrer = Object.entries(byReferrerAll)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

  return res.status(200).json({
    totalFetched,
    successRate,
    byType,
    byMode,
    byTemplateId,
    byReferrer,
    dailyVolume
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

  // Lead confirm GET path — gated by LEAD_CAPTURE_ENABLED
  if (
    req.method === 'GET' &&
    process.env.LEAD_CAPTURE_ENABLED === 'true' &&
    req.query &&
    req.query.action === 'lead_confirm' &&
    req.query.token
  ) {
    const rawIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = hashIp(rawIp);
    const day = new Date().toISOString().slice(0, 10);

    if (!allow(`lgc:${day}`, LIMITS.LEAD_CONFIRM_GLOBAL_PER_DAY, 86400000)) {
      return res.status(503).send('Service temporarily unavailable. Please try again later.');
    }
    if (!allow(`confirm:${ipHash}`, LIMITS.LEAD_CONFIRM_PER_IP_PER_DAY, 86400000)) {
      return res.status(429).send('Too many confirmation attempts. Please try again later.');
    }

    const token = String(req.query.token);
    if (!db) return res.status(502).send('Service unavailable');
    let snapshot;
    try {
      snapshot = await db.collection('leads').where('confirmToken', '==', token).limit(1).get();
    } catch (e) {
      console.warn('Lead confirm Firestore query failed:', e.message);
      return res.status(502).send('Could not look up confirmation token');
    }
    if (snapshot.empty) {
      return res.status(400).send('This confirmation link is invalid or has already been used.');
    }
    const docSnap = snapshot.docs[0];
    const data = docSnap.data();
    if (data.status === 'confirmed') {
      return res.status(200).send('You are already confirmed. No further action needed.');
    }
    try {
      await db.collection('leads').doc(docSnap.id).update({ status: 'confirmed', confirmToken: null });
    } catch (e) {
      console.warn('Lead confirm Firestore update failed:', e.message);
      return res.status(502).send('Could not confirm your email. Please try again.');
    }
    return res.status(200).send('Your email is confirmed. Thank you!');
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Usage intel action — authenticated internal endpoint, not rate-limited
  if (req.body && req.body.action === 'usage_intel') {
    if (!db) return res.status(502).json({ error: 'Could not retrieve usage data' });
    return handleUsageIntel(req, res);
  }

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

    const confirmToken = crypto.randomBytes(24).toString('hex');

    const leadDoc = {
      email: String(email),
      interestedWorkflow: interestedWorkflow ? String(interestedWorkflow) : null,
      sourcePage: sourcePage ? String(sourcePage) : null,
      consentTermsVersion: String(termsVersion),
      ipHash,
      status: 'pending',
      confirmToken
    };

    try {
      await writeLead(leadDoc);
    } catch (e) {
      console.warn('Lead Firestore write failed:', e.message);
      return res.status(502).json({ error: 'Could not save lead' });
    }

    await sendConfirmEmail(String(email), confirmToken);

    return res.status(200).json({ received: true });
  }

  // Parse + validate input
  const prompt = (req.body && req.body.prompt ? String(req.body.prompt) : '').trim();
  const type   = (req.body && req.body.type   ? String(req.body.type)   : 'flowchart');
  let   mode   = (req.body && req.body.mode   ? String(req.body.mode)   : 'describe');
  if (mode !== 'policy' && mode !== 'describe') mode = 'describe';

  const templateId = (req.body && req.body.templateId != null)
    ? String(req.body.templateId)
    : null;

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
  const logBase = { mode, type, prompt, prompt_chars: prompt.length, ip_hash: ipHash, referer, template_id: templateId };

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
