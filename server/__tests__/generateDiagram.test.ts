/**
 * Tests for the diagram Cloud Function (server/index.js).
 *
 * Run with:
 *   node --experimental-strip-types --test server/__tests__/generateDiagram.test.ts
 *
 * Node >=20 ships node:test and node:assert — no extra deps required.
 *
 * Strategy
 * --------
 * 1. Pure helper exports (systemPrompt, cleanMermaid, allow, hashIp) are
 *    tested directly — no HTTP surface needed.
 * 2. The HTTP handler is tested by capturing the function registered via
 *    functions.http(), then calling it with lightweight req/res stubs.
 *    We swap globalThis.fetch before each handler test and restore it after.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Bootstrap: intercept functions-framework BEFORE requiring index.js so we
// can capture the registered handler without a real Cloud runtime.
// ---------------------------------------------------------------------------

type Handler = (req: any, res: any) => Promise<void>;

let registeredHandler: Handler | null = null;

// Stub @google-cloud/functions-framework
const ffStub = {
  http(_name: string, fn: Handler) {
    registeredHandler = fn;
  },
};

// Stub @google-cloud/firestore (Firestore) so the lazy-init in index.js
// does not throw and db stays null (LOG_PROMPTS is not set in tests).
const firestoreStub = {
  Firestore: class {
    collection() {
      return { add: async () => {} };
    }
  },
};

// Node's require cache lets us inject stubs before the real module loads.
// We reach into Module._resolveFilename to wire up our fakes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Patch the module registry before index.js is first required.
const Module = require('module') as any;
const origLoad = Module._load.bind(Module);
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === '@google-cloud/functions-framework') return ffStub;
  if (request === '@google-cloud/firestore') return firestoreStub;
  return origLoad(request, ...rest);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, '..', 'index.js');
const mod = require(indexPath) as {
  systemPrompt: (type: string, mode: string) => string;
  cleanMermaid: (raw: string) => string;
  allow: (key: string, limit: number, windowMs: number) => boolean;
  hashIp: (ip: string) => string;
  _hits: Map<string, { count: number; resetAt: number }>;
};

const { systemPrompt, cleanMermaid, allow, hashIp, _hits } = mod;

// ---------------------------------------------------------------------------
// Helpers for HTTP handler tests
// ---------------------------------------------------------------------------

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: headers,
    set(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
    send(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function makeReq(overrides: Partial<{
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> = {}) {
  return {
    method: 'POST',
    body: { prompt: 'Show a medication round', type: 'flowchart', mode: 'describe' },
    headers: { 'x-forwarded-for': '1.2.3.4' },
    ...overrides,
  };
}

/** Build a minimal fetch-compatible success response for Anthropic. */
function mockAnthropicSuccess(mermaidText: string) {
  return async (_url: string, _opts: unknown) =>
    ({
      ok: true,
      json: async () => ({
        content: [{ text: mermaidText }],
        usage: { input_tokens: 50, output_tokens: 80 },
      }),
      text: async () => '',
    } as any);
}

function mockAnthropicHttpError(status: number, body = 'bad request') {
  return async (_url: string, _opts: unknown) =>
    ({
      ok: false,
      status,
      text: async () => body,
      json: async () => ({}),
    } as any);
}

function mockAnthropicNetworkError() {
  return async (_url: string, _opts: unknown): Promise<never> => {
    throw new Error('Network failure');
  };
}

// ---------------------------------------------------------------------------
// Reset rate-limit state between tests so tests don't bleed into each other.
// ---------------------------------------------------------------------------
beforeEach(() => {
  _hits.clear();
  process.env.ANTHROPIC_API_KEY = 'test-key-abc';
  delete process.env.LOG_PROMPTS;
});

afterEach(() => {
  // Restore fetch if any test replaced it.
  delete (globalThis as any).fetch;
  delete process.env.ANTHROPIC_API_KEY;
});

// ===========================================================================
// systemPrompt
// ===========================================================================

describe('systemPrompt', () => {
  it('mentions flowchart TD for describe mode with flowchart type', () => {
    const prompt = systemPrompt('flowchart', 'describe');
    assert.ok(prompt.includes('flowchart TD'), 'should reference flowchart TD diagram type');
  });

  it('includes policy-mode language when mode is policy', () => {
    const prompt = systemPrompt('flowchart', 'policy');
    assert.ok(
      prompt.includes('policy') || prompt.includes('procedure'),
      'policy mode prompt should mention policy/procedure'
    );
  });

  it('includes org-chart language for org type', () => {
    const prompt = systemPrompt('org', 'describe');
    assert.ok(
      prompt.includes('organizational chart') || prompt.includes('org'),
      'should mention org chart'
    );
  });

  it('includes sequenceDiagram for sequence type', () => {
    const prompt = systemPrompt('sequence', 'describe');
    assert.ok(prompt.includes('sequenceDiagram'));
  });

  it('falls back gracefully for an unknown type', () => {
    const prompt = systemPrompt('unknown_type_xyz', 'describe');
    assert.ok(
      typeof prompt === 'string' && prompt.length > 0,
      'should return a non-empty string for unknown type'
    );
    assert.ok(
      prompt.includes('most appropriate'),
      'fallback should mention "most appropriate" diagram'
    );
  });

  it('always includes the no-fences output rule', () => {
    for (const type of ['flowchart', 'org', 'sequence', 'mindmap', 'timeline', 'decision']) {
      for (const mode of ['describe', 'policy']) {
        const prompt = systemPrompt(type, mode);
        assert.ok(
          prompt.includes('ONLY the Mermaid code'),
          `${type}/${mode}: should instruct output-only rule`
        );
      }
    }
  });
});

// ===========================================================================
// cleanMermaid
// ===========================================================================

describe('cleanMermaid', () => {
  it('returns plain diagram unchanged', () => {
    const raw = 'flowchart TD\n  A --> B';
    assert.equal(cleanMermaid(raw), raw);
  });

  it('strips triple-backtick mermaid fence', () => {
    const raw = '```mermaid\nflowchart TD\n  A --> B\n```';
    assert.equal(cleanMermaid(raw), 'flowchart TD\n  A --> B');
  });

  it('strips plain triple-backtick fence (no language tag)', () => {
    const raw = '```\nflowchart TD\n  A --> B\n```';
    assert.equal(cleanMermaid(raw), 'flowchart TD\n  A --> B');
  });

  it('strips leading and trailing backtick characters', () => {
    const raw = '`flowchart TD\n  A --> B`';
    assert.equal(cleanMermaid(raw), 'flowchart TD\n  A --> B');
  });

  it('returns empty string for null/undefined input', () => {
    assert.equal(cleanMermaid(null as any), '');
    assert.equal(cleanMermaid(undefined as any), '');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(cleanMermaid('  flowchart TD\n  A --> B  '), 'flowchart TD\n  A --> B');
  });

  it('preserves interior content when fence is used', () => {
    const inner = 'sequenceDiagram\n  A->>B: Hello\n  B-->>A: World';
    const raw = '```mermaid\n' + inner + '\n```';
    assert.equal(cleanMermaid(raw), inner);
  });
});

// ===========================================================================
// allow (rate limiter)
// ===========================================================================

describe('allow', () => {
  it('permits the first call within a window', () => {
    assert.equal(allow('test-key-1', 3, 60000), true);
  });

  it('permits calls up to the limit', () => {
    assert.equal(allow('test-key-2', 3, 60000), true);
    assert.equal(allow('test-key-2', 3, 60000), true);
    assert.equal(allow('test-key-2', 3, 60000), true);
  });

  it('blocks once the limit is exceeded', () => {
    allow('test-key-3', 2, 60000);
    allow('test-key-3', 2, 60000);
    assert.equal(allow('test-key-3', 2, 60000), false);
  });

  it('resets after the window expires', async () => {
    // Use a 1 ms window so it expires almost immediately.
    allow('test-key-4', 1, 1);
    allow('test-key-4', 1, 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(allow('test-key-4', 1, 1), true);
  });

  it('tracks different keys independently', () => {
    allow('key-a', 1, 60000);
    assert.equal(allow('key-a', 1, 60000), false);
    assert.equal(allow('key-b', 1, 60000), true);
  });
});

// ===========================================================================
// hashIp
// ===========================================================================

describe('hashIp', () => {
  it('returns a hex string of length 16', () => {
    const h = hashIp('1.2.3.4');
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('is deterministic — same IP always produces the same hash', () => {
    assert.equal(hashIp('10.0.0.1'), hashIp('10.0.0.1'));
  });

  it('produces different hashes for different IPs', () => {
    assert.notEqual(hashIp('1.2.3.4'), hashIp('5.6.7.8'));
  });

  it('handles null/undefined gracefully', () => {
    const h = hashIp(null as any);
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 16);
  });
});

// ===========================================================================
// HTTP handler — requires registeredHandler to have been set by index.js load
// ===========================================================================

describe('HTTP handler', () => {
  before(() => {
    assert.ok(registeredHandler, 'functions.http should have been called during module load');
  });

  // -------------------------------------------------------------------------
  // CORS / method validation
  // -------------------------------------------------------------------------

  it('responds 204 to OPTIONS preflight', async () => {
    const req = makeReq({ method: 'OPTIONS' });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 204);
  });

  it('sets CORS allow-origin header on every response', async () => {
    (globalThis as any).fetch = mockAnthropicSuccess('flowchart TD\n  A --> B');
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.ok(
      res._headers['Access-Control-Allow-Origin'],
      'CORS header should be present'
    );
  });

  it('rejects non-POST methods with 405', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 405);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('returns 400 when prompt is missing', async () => {
    const req = makeReq({ body: { type: 'flowchart' } });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 400);
    assert.equal((res._body as any).error, 'Empty prompt');
  });

  it('returns 400 when prompt is an empty string', async () => {
    const req = makeReq({ body: { prompt: '', type: 'flowchart' } });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 400);
  });

  it('returns 400 when prompt is only whitespace', async () => {
    const req = makeReq({ body: { prompt: '   ', type: 'flowchart' } });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 400);
  });

  it('returns 413 when describe-mode prompt exceeds 1500 chars', async () => {
    const req = makeReq({
      body: { prompt: 'a'.repeat(1501), mode: 'describe', type: 'flowchart' },
    });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 413);
    assert.ok((res._body as any).cap, 'response should include the cap value');
  });

  it('returns 413 when policy-mode prompt exceeds 8000 chars', async () => {
    const req = makeReq({
      body: { prompt: 'x'.repeat(8001), mode: 'policy', type: 'flowchart' },
    });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 413);
  });

  it('accepts a describe-mode prompt exactly at the 1500-char limit', async () => {
    (globalThis as any).fetch = mockAnthropicSuccess('flowchart TD\n  A --> B');
    const req = makeReq({
      body: { prompt: 'a'.repeat(1500), mode: 'describe', type: 'flowchart' },
    });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 200);
  });

  // -------------------------------------------------------------------------
  // Missing API key
  // -------------------------------------------------------------------------

  it('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 500);
    assert.equal((res._body as any).error, 'Server not configured');
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns 200 with mermaid field on a successful AI call', async () => {
    const diagram = 'flowchart TD\n  A[Start] --> B[End]';
    (globalThis as any).fetch = mockAnthropicSuccess(diagram);
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 200);
    assert.equal((res._body as any).mermaid, diagram);
  });

  it('strips markdown fences from the AI response before returning', async () => {
    const inner = 'flowchart TD\n  A --> B';
    (globalThis as any).fetch = mockAnthropicSuccess('```mermaid\n' + inner + '\n```');
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 200);
    assert.equal((res._body as any).mermaid, inner);
  });

  it('passes type and mode through to the AI system prompt (org / policy)', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ text: 'flowchart TD\n  A --> B' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        text: async () => '',
      };
    };
    const req = makeReq({ body: { prompt: 'Describe the org', type: 'org', mode: 'policy' } });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.ok(capturedBody, 'fetch should have been called');
    assert.ok(
      capturedBody.system.includes('policy') || capturedBody.system.includes('procedure'),
      'system prompt should reflect policy mode'
    );
    assert.ok(
      capturedBody.system.includes('organizational chart') || capturedBody.system.includes('org'),
      'system prompt should reflect org type'
    );
  });

  it('sends the correct model and max_tokens to Anthropic', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ text: 'flowchart TD\n  A --> B' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        text: async () => '',
      };
    };
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.ok(capturedBody.model, 'model should be set');
    assert.ok(typeof capturedBody.max_tokens === 'number', 'max_tokens should be a number');
    assert.ok(capturedBody.max_tokens > 0, 'max_tokens should be positive');
  });

  it('sends the x-api-key header to Anthropic', async () => {
    let capturedHeaders: any;
    (globalThis as any).fetch = async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          content: [{ text: 'flowchart TD\n  A --> B' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        text: async () => '',
      };
    };
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(capturedHeaders['x-api-key'], 'test-key-abc');
  });

  // -------------------------------------------------------------------------
  // Upstream errors
  // -------------------------------------------------------------------------

  it('returns 502 when fetch throws (network error)', async () => {
    (globalThis as any).fetch = mockAnthropicNetworkError();
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as any).error, 'Upstream unreachable');
  });

  it('returns 502 when Anthropic responds with a non-2xx status', async () => {
    (globalThis as any).fetch = mockAnthropicHttpError(429, 'quota exceeded');
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as any).status, 429);
  });

  it('returns 502 when the AI response has no content', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ content: [], usage: {} }),
      text: async () => '',
    });
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as any).error, 'Empty result');
  });

  it('returns 502 when the AI returns only whitespace', async () => {
    (globalThis as any).fetch = mockAnthropicSuccess('   ');
    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as any).error, 'Empty result');
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  it('returns 429 after the per-minute per-IP limit is exhausted', async () => {
    (globalThis as any).fetch = mockAnthropicSuccess('flowchart TD\n  A --> B');

    const ip = '9.9.9.9';
    // PER_IP_PER_MIN = 5; burn through all of them.
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await registeredHandler!(makeReq({ headers: { 'x-forwarded-for': ip } }), res);
      // First five should succeed (or hit daily global — depends on earlier tests, but we cleared hits).
      assert.notEqual(res._status, 429, `call ${i + 1} should not be rate-limited yet`);
    }

    const res = makeRes();
    await registeredHandler!(makeReq({ headers: { 'x-forwarded-for': ip } }), res);
    assert.equal(res._status, 429);
  });

  it('returns 503 when the global daily cap is exhausted', async () => {
    // Force the global cap slot to be full by manipulating _hits directly.
    const day = new Date().toISOString().slice(0, 10);
    _hits.set(`g:${day}`, { count: 2000, resetAt: Date.now() + 86400000 });

    const req = makeReq();
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 503);
    assert.equal((res._body as any).error, 'Daily limit reached');
  });

  // -------------------------------------------------------------------------
  // Mode normalisation
  // -------------------------------------------------------------------------

  it('treats an unrecognised mode value as describe mode', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ text: 'flowchart TD\n  A --> B' }],
          usage: {},
        }),
        text: async () => '',
      };
    };
    const req = makeReq({ body: { prompt: 'Test', type: 'flowchart', mode: 'invalid_mode' } });
    const res = makeRes();
    await registeredHandler!(req, res);
    assert.equal(res._status, 200);
    // The system prompt should NOT contain policy language.
    assert.ok(
      !capturedBody.system.includes('pasted a policy'),
      'invalid mode should fall back to describe, not policy'
    );
  });
});
