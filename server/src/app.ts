import express, { Express, Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import { LIMITS, EMAIL_RE } from './config';
import { RateLimiter, cleanMermaid, hashIp, clientIp } from './util';
import { systemPrompt } from './prompts';
import { ModelClient, UpstreamError } from './modelClient';
import { LogStore, LeadStore } from './stores/types';
import { MemoryLogStore, MemoryLeadStore } from './stores/memoryStore';
import { RecordedResponseClient } from './recordedClient';

/**
 * Dependency injection for the express app. Defaults give you the fully
 * fake-wired local stack (memory stores + recorded model client) so tests and
 * CI run with no Anthropic key and no database anywhere.
 */
export interface AppDeps {
  logStore: LogStore;
  leadStore: LeadStore;
  modelClient: ModelClient;
  /** DIAG-ADR-001 kill switch — production default is OFF. */
  leadCaptureEnabled: boolean;
  /** Team sign-in password; empty disables sign-in ({authed:false}). */
  authPassword: string;
  /** CORS origin — production MUST be https://thelemurcodes.github.io, never '*'. */
  allowedOrigin: string;
  resendApiKey: string;
  /** Public base URL of this backend, used to build opt-in confirmation links. */
  functionUrl: string;
  /** Shared secret for the usage_intel endpoint. */
  insightsPassword: string;
  /** False when no Anthropic key is configured — mirrors the old 500 path. */
  apiKeyConfigured: boolean;
}

export function defaultDeps(): AppDeps {
  return {
    logStore: new MemoryLogStore(),
    leadStore: new MemoryLeadStore(),
    modelClient: new RecordedResponseClient(path.join(__dirname, '..', 'fixtures')),
    leadCaptureEnabled: false,
    authPassword: '',
    allowedOrigin: '*',
    resendApiKey: '',
    functionUrl: '',
    insightsPassword: '',
    apiKeyConfigured: true,
  };
}

export function createApp(deps: Partial<AppDeps> = {}, limiter = new RateLimiter()): Express {
  const d: AppDeps = { ...defaultDeps(), ...deps };
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.set('deps', d);
  app.set('rateLimiter', limiter);

  app.get('/healthz', (_req, res) => {
    // Railway healthcheck path. Never rate-limited, never logged.
    res.status(200).json({ ok: true });
  });

  app.all('/', (req, res) => {
    handle(req, res, d, limiter).catch((e) => {
      console.error('Unhandled request error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });

  return app;
}

async function handle(req: Request, res: Response, d: AppDeps, limiter: RateLimiter): Promise<void> {
  const origin = d.allowedOrigin;
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    res.status(204).send('');
    return;
  }

  // Lead confirm GET path — gated by LEAD_CAPTURE_ENABLED
  if (
    req.method === 'GET' &&
    d.leadCaptureEnabled &&
    req.query &&
    req.query.action === 'lead_confirm' &&
    req.query.token
  ) {
    const rawIp = clientIp(req.headers as Record<string, unknown>);
    const ipHash = hashIp(rawIp);
    const day = new Date().toISOString().slice(0, 10);

    if (!limiter.allow(`lgc:${day}`, LIMITS.LEAD_CONFIRM_GLOBAL_PER_DAY, 86400000)) {
      res.status(503).send('Service temporarily unavailable. Please try again later.');
      return;
    }
    if (!limiter.allow(`confirm:${ipHash}`, LIMITS.LEAD_CONFIRM_PER_IP_PER_DAY, 86400000)) {
      res.status(429).send('Too many confirmation attempts. Please try again later.');
      return;
    }

    const token = String(req.query.token);
    let lead;
    try {
      lead = await d.leadStore.findByConfirmToken(token);
    } catch (e) {
      console.warn('Lead confirm lookup failed:', (e as Error).message);
      res.status(502).send('Could not look up confirmation token');
      return;
    }
    if (!lead) {
      res.status(400).send('This confirmation link is invalid or has already been used.');
      return;
    }
    if (lead.status === 'confirmed') {
      res.status(200).send('You are already confirmed. No further action needed.');
      return;
    }
    try {
      await d.leadStore.confirmLead(lead.id);
    } catch (e) {
      console.warn('Lead confirm update failed:', (e as Error).message);
      res.status(502).send('Could not confirm your email. Please try again.');
      return;
    }
    res.status(200).send('Your email is confirmed. Thank you!');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Team sign-in — the frontend posts {auth_check: true, auth: pw} and expects
  // {authed: true|false}. The committed Cloud Function never implemented this;
  // the port makes the frontend's promise true.
  if (req.body && req.body.auth_check) {
    const rawIp = clientIp(req.headers as Record<string, unknown>);
    const ipHash = hashIp(rawIp);
    if (!limiter.allow(`auth:${ipHash}`, LIMITS.AUTH_PER_IP_PER_MIN, 60000)) {
      res.status(429).json({ error: 'Rate limited' });
      return;
    }
    const provided = req.body.auth ? String(req.body.auth) : '';
    const authed = Boolean(d.authPassword) && provided === d.authPassword;
    res.status(200).json({ authed });
    return;
  }

  // Usage intel action — authenticated internal endpoint, not rate-limited
  if (req.body && req.body.action === 'usage_intel') {
    await handleUsageIntel(req, res, d);
    return;
  }

  // Lead capture action — only active when kill switch is on.
  // When LEAD_CAPTURE_ENABLED is not 'true', this branch is skipped entirely
  // and the request falls through to the diagram handler, which returns the
  // same 400 "Empty prompt" any other unrecognized action gets.
  if (d.leadCaptureEnabled && req.body && req.body.action === 'lead_capture') {
    const rawIp = clientIp(req.headers as Record<string, unknown>);
    const ipHash = hashIp(rawIp);
    const day = new Date().toISOString().slice(0, 10);

    if (Math.random() < 0.05) limiter.sweep();

    if (!limiter.allow(`lg:${day}`, LIMITS.LEAD_GLOBAL_PER_DAY, 86400000)) {
      res.status(503).json({ error: 'Daily limit reached' });
      return;
    }
    if (!limiter.allow(`lead:${ipHash}`, LIMITS.LEAD_PER_IP_PER_DAY, 86400000)) {
      res.status(429).json({ error: 'Rate limited' });
      return;
    }

    const { email, consent, termsVersion, interestedWorkflow, sourcePage } = req.body;

    if (!email || !EMAIL_RE.test(String(email))) {
      res.status(400).json({ error: 'Valid email required' });
      return;
    }
    if (consent !== true) {
      res.status(400).json({ error: 'Consent required' });
      return;
    }
    if (!termsVersion || !String(termsVersion).trim()) {
      res.status(400).json({ error: 'termsVersion required' });
      return;
    }

    const confirmToken = crypto.randomBytes(24).toString('hex');

    try {
      await d.leadStore.createLead({
        email: String(email),
        interestedWorkflow: interestedWorkflow ? String(interestedWorkflow) : null,
        sourcePage: sourcePage ? String(sourcePage) : null,
        consentTermsVersion: String(termsVersion),
        ipHash,
        confirmToken,
      });
    } catch (e) {
      console.warn('Lead write failed:', (e as Error).message);
      res.status(502).json({ error: 'Could not save lead' });
      return;
    }

    await sendConfirmEmail(String(email), confirmToken, d);

    res.status(200).json({ received: true });
    return;
  }

  // Parse + validate input
  const prompt = (req.body && req.body.prompt ? String(req.body.prompt) : '').trim();
  const type = req.body && req.body.type ? String(req.body.type) : 'flowchart';
  let mode = req.body && req.body.mode ? String(req.body.mode) : 'describe';
  if (mode !== 'policy' && mode !== 'describe') mode = 'describe';

  const templateId = req.body && req.body.templateId != null ? String(req.body.templateId) : null;

  if (!prompt) {
    res.status(400).json({ error: 'Empty prompt' });
    return;
  }

  // Team sign-in raises the cap: an authenticated request gets the 50,000-char
  // cap the frontend has always promised, enforced server-side here.
  const authed = Boolean(d.authPassword) && req.body && req.body.auth === d.authPassword;

  // The absolute 400 ceiling must exceed the per-mode 413 caps or it is
  // unreachable; for authed requests the ceiling is the authed cap itself.
  const absoluteCeiling = authed ? LIMITS.AUTHED_MAX_CHARS : LIMITS.MAX_PROMPT_LENGTH;
  if (prompt.length > absoluteCeiling) {
    res.status(400).json({ error: 'Prompt too long', max: absoluteCeiling });
    return;
  }

  const cap = authed ? LIMITS.AUTHED_MAX_CHARS : mode === 'policy' ? LIMITS.MAX_POLICY_CHARS : LIMITS.MAX_DESCRIBE_CHARS;
  if (prompt.length > cap) {
    res.status(413).json({ error: 'Prompt too long', cap });
    return;
  }

  // Cost guards
  if (Math.random() < 0.05) limiter.sweep();
  const rawIp = clientIp(req.headers as Record<string, unknown>);
  const ipHash = hashIp(rawIp);
  const day = new Date().toISOString().slice(0, 10);

  if (!limiter.allow(`g:${day}`, LIMITS.GLOBAL_PER_DAY, 86400000)) {
    res.status(503).json({ error: 'Daily limit reached' });
    return;
  }
  if (!limiter.allow(`m:${ipHash}`, LIMITS.PER_IP_PER_MIN, 60000)) {
    res.status(429).json({ error: 'Rate limited' });
    return;
  }
  if (!limiter.allow(`d:${ipHash}:${day}`, LIMITS.PER_IP_PER_DAY, 86400000)) {
    res.status(429).json({ error: 'Rate limited' });
    return;
  }

  // Call the model — a missing API key is a server configuration error (500),
  // exactly as the old handler returned before attempting the upstream call.
  if (!d.apiKeyConfigured) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  const referer = String(req.headers['referer'] || req.headers['referrer'] || '').slice(0, 300);
  const logBase = {
    ts: new Date(),
    mode,
    type,
    prompt,
    prompt_chars: prompt.length,
    ip_hash: ipHash,
    referer,
    template_id: templateId,
  };

  let aiRes;
  try {
    aiRes = await d.modelClient.generate({
      system: systemPrompt(type, mode),
      prompt,
      maxTokens: LIMITS.MAX_TOKENS,
      mode,
      type,
    });
  } catch (e) {
    if (e instanceof UpstreamError && e.kind === 'http') {
      await safeLog(d.logStore, { ...logBase, success: false, error: 'upstream_' + e.status });
      res.status(502).json({ error: 'Upstream error', status: e.status, detail: (e.detail || '').slice(0, 300) });
      return;
    }
    await safeLog(d.logStore, { ...logBase, success: false, error: 'upstream_unreachable' });
    res.status(502).json({ error: 'Upstream unreachable' });
    return;
  }

  const mermaid = cleanMermaid(aiRes.text);
  if (!mermaid) {
    await safeLog(d.logStore, { ...logBase, success: false, error: 'empty_result' });
    res.status(502).json({ error: 'Empty result' });
    return;
  }

  // success path
  await safeLog(d.logStore, {
    ...logBase,
    success: true,
    mermaid_chars: mermaid.length,
    usage_in: aiRes.usageIn || null,
    usage_out: aiRes.usageOut || null,
  });

  res.status(200).json({ mermaid });
}

/** Logging must never break the user request (ported rule). */
async function safeLog(store: LogStore, event: Parameters<LogStore['log']>[0]): Promise<void> {
  try {
    await store.log(event);
  } catch (e) {
    console.warn('Log write failed:', (e as Error).message);
  }
}

async function handleUsageIntel(req: Request, res: Response, d: AppDeps): Promise<void> {
  const providedKey = req.body && req.body.insightsKey ? String(req.body.insightsKey) : '';
  const expectedKey = d.insightsPassword;

  if (!expectedKey || providedKey !== expectedKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const intel = await d.logStore.usageIntel();
    res.status(200).json(intel);
  } catch (e) {
    console.warn('usage_intel query failed:', (e as Error).message);
    res.status(502).json({ error: 'Could not retrieve usage data' });
  }
}

/** Send double opt-in confirmation email via Resend. Ported verbatim. */
async function sendConfirmEmail(email: string, token: string, d: AppDeps): Promise<void> {
  if (!d.resendApiKey) {
    console.warn('RESEND_API_KEY not set — confirmation email not sent');
    return;
  }
  const confirmLink = `${d.functionUrl}?action=lead_confirm&token=${token}`;
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d.resendApiKey}`,
      },
      body: JSON.stringify({
        from: 'Senior Care Diagram Maker <noreply@mail.seniorcarediagram.com>',
        to: email,
        subject: 'Please confirm your email',
        html: `<p>Thanks for signing up! Please confirm your email address:</p><p><a href="${confirmLink}">Confirm my email</a></p>`,
      }),
    });
    if (!emailRes.ok) {
      const detail = await emailRes.text().catch(() => '');
      console.warn('Resend API error:', emailRes.status, detail.slice(0, 200));
    }
  } catch (e) {
    console.warn('Confirmation email send failed:', (e as Error).message);
  }
}
