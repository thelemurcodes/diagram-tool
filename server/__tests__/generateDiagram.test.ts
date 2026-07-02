/**
 * Unit tests for server/index.js — the Cloud Function that calls Anthropic
 * and returns a Mermaid diagram.
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies needed.
 *
 * Run:  node --test server/__tests__/generateDiagram.test.ts
 *       (Node ≥ 20 supports TypeScript-style .ts files via --experimental-strip-types,
 *        or transpile first; the types here are annotation-only so stripping is safe.)
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Module-level mocks
// We must set up require-level mocks BEFORE loading index.js.  Node's built-in
// module cache lets us inject fakes by populating require.cache entries.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

// The handler function captured by the mock functions-framework.
let capturedHandler: (req: any, res: any) => Promise<void>;

// Mock: @google-cloud/functions-framework
// Captures the handler registered via functions.http() so we can call it directly.
const fakeFramework = {
  http(_name: string, fn: (req: any, res: any) => Promise<void>) {
    capturedHandler = fn;
  },
};

// Mock: @google-cloud/firestore — Firestore is optional; we just need it not to throw.
const fakeFirestore = {
  Firestore: class {
    collection() {
      return { add: async () => {} };
    }
  },
};

// Inject mocks into require cache before index.js is required.
const _require = createRequire(import.meta.url);

function injectMock(id: string, exports: unknown) {
  const resolved = _require.resolve(id, { paths: [serverDir] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
    // Node internals — cast to any so TS doesn't complain about missing fields.
  } as any;
}

injectMock('@google-cloud/functions-framework', fakeFramework);
injectMock('@google-cloud/firestore', fakeFirestore);

// Load the module under test.  We use createRequire so we can clear the cache
// between suites if needed; for now a single load is fine.
const indexPath = path.join(serverDir, 'index.js');
const mod = _require(indexPath) as {
  systemPrompt: (type: string, mode: string) => string;
  cleanMermaid: (raw: string) => string;
  allow: (key: string, limit: number, windowMs: number) => boolean;
  hashIp: (ip: string) => string;
  _hits: Map<string, { count: number; resetAt: number }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock request object. */
function makeReq(overrides: Record<string, any> = {}) {
  return {
    method: 'POST',
    headers: {},
    body: {
      prompt: 'Show admission workflow',
      type: 'flowchart',
      mode: 'describe',
    },
    ...overrides,
  };
}

/** Build a minimal mock response object that records what was sent. */
function makeRes() {
  const r = {
    statusCode: 0,
    body: null as any,
    headers: {} as Record<string, string>,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any)      { r.body = body; return r; },
    send(body: any)      { r.body = body; return r; },
    set(k: string, v: string) { r.headers[k] = v; return r; },
  };
  return r;
}

/** A valid Anthropic API response body for a given mermaid snippet. */
function anthropicOk(mermaid: string) {
  return {
    content: [{ text: mermaid }],
    usage: { input_tokens: 50, output_tokens: 80 },
  };
}

/** Replace the global fetch with a controlled stub. Returns a restore function. */
function stubFetch(impl: (...args: any[]) => Promise<any>) {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = impl;
  return () => { (globalThis as any).fetch = original; };
}

// ---------------------------------------------------------------------------
// cleanMermaid
// ---------------------------------------------------------------------------

describe('cleanMermaid', () => {
  it('returns raw code when there are no fences', () => {
    const raw = 'flowchart TD\n  A --> B';
    assert.equal(mod.cleanMermaid(raw), raw);
  });

  it('strips triple-backtick mermaid fences', () => {
    const raw = '```mermaid\nflowchart TD\n  A --> B\n```';
    assert.equal(mod.cleanMermaid(raw), 'flowchart TD\n  A --> B');
  });

  it('strips generic triple-backtick fences', () => {
    const raw = '```\nflowchart TD\n  A --> B\n```';
    assert.equal(mod.cleanMermaid(raw), 'flowchart TD\n  A --> B');
  });

  it('strips stray leading/trailing backticks', () => {
    const raw = '`flowchart TD`';
    assert.equal(mod.cleanMermaid(raw), 'flowchart TD');
  });

  it('returns empty string for null / undefined input', () => {
    assert.equal(mod.cleanMermaid(null as any), '');
    assert.equal(mod.cleanMermaid(undefined as any), '');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(mod.cleanMermaid('  flowchart TD  '), 'flowchart TD');
  });
});

// ---------------------------------------------------------------------------
// systemPrompt
// ---------------------------------------------------------------------------

describe('systemPrompt', () => {
  it('includes "flowchart TD" hint for flowchart type', () => {
    const p = mod.systemPrompt('flowchart', 'describe');
    assert.match(p, /flowchart TD/);
  });

  it('includes "sequenceDiagram" hint for sequence type', () => {
    const p = mod.systemPrompt('sequence', 'describe');
    assert.match(p, /sequenceDiagram/);
  });

  it('falls back gracefully for unknown diagram type', () => {
    const p = mod.systemPrompt('unknown_type', 'describe');
    assert.match(p, /most appropriate Mermaid diagram/);
  });

  it('uses policy-mode language when mode=policy', () => {
    const p = mod.systemPrompt('flowchart', 'policy');
    assert.match(p, /policy|procedure|guideline/i);
  });

  it('uses describe-mode language when mode=describe', () => {
    const p = mod.systemPrompt('flowchart', 'describe');
    assert.match(p, /description/i);
  });

  it('always includes the output-only rule', () => {
    const p = mod.systemPrompt('flowchart', 'describe');
    assert.match(p, /Output ONLY the Mermaid code/);
  });

  it('includes rules for all supported diagram types', () => {
    const types = ['flowchart', 'org', 'sequence', 'mindmap', 'timeline', 'decision'];
    for (const t of types) {
      const p = mod.systemPrompt(t, 'describe');
      // Must mention mermaid (case-insensitive) and return a non-empty string.
      assert.ok(p.length > 0, `empty prompt for type=${t}`);
      assert.match(p, /mermaid/i);
    }
  });
});

// ---------------------------------------------------------------------------
// hashIp
// ---------------------------------------------------------------------------

describe('hashIp', () => {
  it('returns a 16-character hex string', () => {
    const h = mod.hashIp('192.168.1.1');
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('is deterministic — same input, same output', () => {
    assert.equal(mod.hashIp('10.0.0.1'), mod.hashIp('10.0.0.1'));
  });

  it('produces different hashes for different IPs', () => {
    assert.notEqual(mod.hashIp('10.0.0.1'), mod.hashIp('10.0.0.2'));
  });

  it('handles empty / falsy input without throwing', () => {
    assert.doesNotThrow(() => mod.hashIp(''));
    assert.doesNotThrow(() => mod.hashIp(null as any));
  });
});

// ---------------------------------------------------------------------------
// allow (rate limiter)
// ---------------------------------------------------------------------------

describe('allow', () => {
  beforeEach(() => {
    // Clear shared in-memory hit map so tests do not bleed into each other.
    mod._hits.clear();
  });

  it('allows the first request', () => {
    assert.equal(mod.allow('test-key', 3, 60_000), true);
  });

  it('counts up to the limit', () => {
    assert.equal(mod.allow('k', 2, 60_000), true);
    assert.equal(mod.allow('k', 2, 60_000), true);
  });

  it('blocks when the limit is reached', () => {
    mod.allow('k', 2, 60_000);
    mod.allow('k', 2, 60_000);
    assert.equal(mod.allow('k', 2, 60_000), false);
  });

  it('resets after the window expires', async () => {
    // Use a 1 ms window so it expires immediately.
    mod.allow('k', 1, 1);
    mod.allow('k', 1, 1); // hits limit

    await new Promise(r => setTimeout(r, 10)); // let window expire

    assert.equal(mod.allow('k', 1, 1), true);
  });

  it('tracks different keys independently', () => {
    mod.allow('a', 1, 60_000);
    mod.allow('a', 1, 60_000); // 'a' is now blocked

    assert.equal(mod.allow('b', 1, 60_000), true); // 'b' unaffected
    assert.equal(mod.allow('a', 1, 60_000), false);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler — happy path
// ---------------------------------------------------------------------------

describe('HTTP handler — happy path', () => {
  const validMermaid = 'flowchart TD\n  A[Admit] --> B[Assess]';

  before(() => {
    mod._hits.clear();
    process.env.ANTHROPIC_API_KEY = 'test-key-abc';
    process.env.LOG_PROMPTS = 'false';
  });

  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns 200 and mermaid diagram for a valid describe request', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk(validMermaid),
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mermaid, validMermaid);
  });

  it('returns 200 for policy mode', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk(validMermaid),
    }));

    const req = makeReq({ body: { prompt: 'Policy: ...'.repeat(50), type: 'flowchart', mode: 'policy' } });
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.mermaid);
  });

  it('strips code fences returned by the AI before responding', async () => {
    const fenced = '```mermaid\n' + validMermaid + '\n```';
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk(fenced),
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.body.mermaid, validMermaid);
  });

  it('sets CORS header on successful response', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk(validMermaid),
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.ok(res.headers['Access-Control-Allow-Origin']);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler — input validation
// ---------------------------------------------------------------------------

describe('HTTP handler — input validation', () => {
  before(() => {
    mod._hits.clear();
    process.env.ANTHROPIC_API_KEY = 'test-key-abc';
  });

  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns 405 for GET requests', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 405);
  });

  it('returns 204 for OPTIONS preflight', async () => {
    const req = makeReq({ method: 'OPTIONS' });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 204);
  });

  it('returns 400 when prompt is empty string', async () => {
    const req = makeReq({ body: { prompt: '', type: 'flowchart', mode: 'describe' } });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /empty prompt/i);
  });

  it('returns 400 when prompt is missing from body', async () => {
    const req = makeReq({ body: { type: 'flowchart', mode: 'describe' } });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it('returns 413 when describe prompt exceeds 1500 chars', async () => {
    const req = makeReq({ body: { prompt: 'x'.repeat(1501), type: 'flowchart', mode: 'describe' } });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 413);
  });

  it('returns 413 when policy prompt exceeds 8000 chars', async () => {
    const req = makeReq({ body: { prompt: 'x'.repeat(8001), type: 'flowchart', mode: 'policy' } });
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 413);
  });

  it('accepts a prompt exactly at the describe limit (1500 chars)', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk('flowchart TD\n  A --> B'),
    }));

    const req = makeReq({ body: { prompt: 'x'.repeat(1500), type: 'flowchart', mode: 'describe' } });
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.notEqual(res.statusCode, 413);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler — missing API key
// ---------------------------------------------------------------------------

describe('HTTP handler — missing API key', () => {
  before(() => {
    mod._hits.clear();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /not configured/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler — upstream / Anthropic errors
// ---------------------------------------------------------------------------

describe('HTTP handler — upstream errors', () => {
  before(() => {
    mod._hits.clear();
    process.env.ANTHROPIC_API_KEY = 'test-key-abc';
    process.env.LOG_PROMPTS = 'false';
  });

  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns 502 when fetch throws (network unreachable)', async () => {
    const restore = stubFetch(async () => { throw new Error('ECONNREFUSED'); });

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /upstream unreachable/i);
  });

  it('returns 502 when Anthropic responds with a non-ok status', async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 529,
      text: async () => 'overloaded',
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /upstream error/i);
    assert.equal(res.body.status, 529);
  });

  it('returns 502 when Anthropic returns an empty content array', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => ({ content: [], usage: {} }),
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /empty result/i);
  });

  it('returns 502 when Anthropic returns whitespace-only text', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '   ' }], usage: {} }),
    }));

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /empty result/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler — rate limiting
// ---------------------------------------------------------------------------

describe('HTTP handler — rate limiting', () => {
  before(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-abc';
    process.env.LOG_PROMPTS = 'false';
  });

  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    mod._hits.clear();
  });

  it('returns 429 when per-IP per-minute limit is exhausted', async () => {
    // Clear hits and then pre-fill the per-minute bucket for a fake IP.
    mod._hits.clear();

    const fakeIp = '203.0.113.99'; // TEST-NET-3, will never clash with real traffic
    const ipHash = mod.hashIp(fakeIp);

    // Exhaust the per-minute bucket (limit = 5).
    const minuteBucketKey = `m:${ipHash}`;
    mod._hits.set(minuteBucketKey, { count: 5, resetAt: Date.now() + 60_000 });

    // Also ensure global and daily buckets are not the bottleneck.
    // (They start empty, so they're fine for 1 hit.)

    const restore = stubFetch(async () => ({
      ok: true,
      json: async () => anthropicOk('flowchart TD\n  A --> B'),
    }));

    const req = makeReq({ headers: { 'x-forwarded-for': fakeIp } });
    const res = makeRes();
    await capturedHandler(req, res);

    restore();

    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /rate limited/i);
  });

  it('returns 503 when the global daily cap is exhausted', async () => {
    mod._hits.clear();

    const day = new Date().toISOString().slice(0, 10);
    mod._hits.set(`g:${day}`, { count: 2000, resetAt: Date.now() + 86_400_000 });

    const req = makeReq();
    const res = makeRes();
    await capturedHandler(req, res);

    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /daily limit/i);
  });
});
