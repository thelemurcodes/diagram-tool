/* ============================================================================
   Senior Care Diagram Maker — serverless proxy (Google Cloud Function, gen2)
   ----------------------------------------------------------------------------
   WHY THIS EXISTS
   - Your Anthropic API key must NEVER live in the front-end (it's public on
     GitHub Pages). This function holds the key server-side on Google Cloud.
   - The tool is fully open (no login), which is great for reach/backlinks but
     means you need guards so nobody can drain your budget. Cost protection here:
        1) per-IP rate limits (per-minute + per-day)
        2) a global soft daily cap
        3) hard caps on prompt size and output tokens
     ...backed by two platform-level guarantees you set during deploy:
        • Cloud Function `--max-instances` (caps concurrency)
        • an Anthropic Console monthly spend limit (your absolute $ ceiling)

   NOTE on the rate limits: they're held in memory, so they reset on a cold
   start and aren't shared across instances. With --max-instances=3 that's a
   fine soft guard for a prototype. For durable, exact limits, see the Firestore
   upgrade note in SETUP.md. The Anthropic spend cap is your real backstop.

   Deploy: see deploy.sh / SETUP.md
   ============================================================================ */

const functions = require('@google-cloud/functions-framework');

const LIMITS = {
  MODEL:            'claude-haiku-4-5-20251001', // cheap + good at structured output
  MAX_TOKENS:       1100,   // hard cap on output size per diagram (cost control)
  MAX_PROMPT_CHARS: 1500,   // reject oversized prompts (cost + abuse control)

  PER_IP_PER_MIN:   5,      // bursts
  PER_IP_PER_DAY:   40,     // one person can't hammer it all day
  GLOBAL_PER_DAY:   2000    // soft per-instance daily ceiling (see note above)
};

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

/* ---- diagram-type hint (mirrors the front-end so behavior is identical) ---- */
function systemPrompt(type) {
  const hint = ({
    flowchart: 'a top-down flowchart (`flowchart TD`)',
    org:       'a top-down organizational chart using `flowchart TD` with boxes and reporting lines',
    sequence:  'a `sequenceDiagram`',
    mindmap:   'a `mindmap`',
    timeline:  'a `timeline`',
    decision:  'a decision tree using `flowchart TD` with diamond decision nodes and Yes/No labels'
  })[type] || 'the most appropriate Mermaid diagram';

  return [
    'You are a diagramming assistant for senior care and assisted living teams.',
    "Turn the user's description into a single valid Mermaid.js diagram.",
    `Prefer ${hint}.`,
    'Rules:',
    '- Output ONLY the Mermaid code. No explanation, no markdown fences, no backticks.',
    '- Keep node labels short and clear; wrap long text in double quotes.',
    '- Use simple, ASCII-safe characters in IDs; put readable text in the labels.',
    '- Avoid parentheses, semicolons, and special characters inside labels that break Mermaid.',
    '- Keep it readable: aim for 6-20 nodes unless more are clearly needed.',
    '- It must parse on the first try.'
  ].join('\n');
}

/* ---- strip code fences / stray backticks the model might add ---- */
function cleanMermaid(raw) {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/^`+|`+$/g, '').trim();
}

/* ============================================================================
   HTTP handler  (entry point name = "diagram", referenced in deploy.sh)
   ============================================================================ */
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

  // validate input
  const prompt = (req.body && req.body.prompt ? String(req.body.prompt) : '').trim();
  const type   = (req.body && req.body.type ? String(req.body.type) : 'flowchart');
  if (!prompt) return res.status(400).json({ error: 'Empty prompt' });
  if (prompt.length > LIMITS.MAX_PROMPT_CHARS) return res.status(413).json({ error: 'Prompt too long' });

  // cost guards
  if (Math.random() < 0.05) sweep(); // occasional cleanup
  const ip  = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  if (!allow(`g:${day}`, LIMITS.GLOBAL_PER_DAY, 86400000))   return res.status(503).json({ error: 'Daily limit reached' });
  if (!allow(`m:${ip}`, LIMITS.PER_IP_PER_MIN, 60000))       return res.status(429).json({ error: 'Rate limited' });
  if (!allow(`d:${ip}:${day}`, LIMITS.PER_IP_PER_DAY, 86400000)) return res.status(429).json({ error: 'Rate limited' });

  // call Anthropic
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server not configured' });

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
        system: systemPrompt(type),
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream unreachable' });
  }

  if (!aiRes.ok) {
    const detail = await aiRes.text().catch(() => '');
    return res.status(502).json({ error: 'Upstream error', status: aiRes.status, detail: detail.slice(0, 300) });
  }

  const data = await aiRes.json();
  const mermaid = cleanMermaid(data && data.content && data.content[0] ? data.content[0].text : '');
  if (!mermaid) return res.status(502).json({ error: 'Empty result' });

  return res.status(200).json({ mermaid });
});

// exported for local unit tests
module.exports = { systemPrompt, cleanMermaid, allow, _hits: hits };
