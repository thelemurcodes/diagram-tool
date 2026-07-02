/**
 * Unit tests for server/index.js — the Cloud Function that talks to the AI
 * and generates Mermaid diagrams.
 *
 * Run with:  node --experimental-vm-modules --test  (Node ≥ 20, no extra deps)
 * Or simply: node --test server/__tests__/generateDiagram.test.ts
 *
 * Because the source is CommonJS we use Node's built-in `node:test` runner
 * and `node:assert`, which are available in Node ≥ 18 (the engines field
 * already requires ≥ 20).
 */

import test, { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { register } from 'node:module';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal Express-style mock request. */
function makeReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    method: 'POST',
    headers: {},
    body: { prompt: 'Show a morning-rounds workflow', type: 'flowchart', mode: 'describe' },
    ...overrides,
  };
}

/** Minimal Express-style mock response that records what the handler sends. */
function makeRes(): MockRes {
  const res: MockRes = {
    _status: 0,
    _body: undefined,
    _headers: {} as Record<string, string>,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
    send(body: unknown) { res._body = body; return res; },
    set(key: string, value: string) { res._headers[key] = value; return res; },
  };
  return res;
}

interface MockReq {
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface MockRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  send(body: unknown): MockRes;
  set(key: string, value: string): MockRes;
}

/** Minimal Anthropic success response envelope. */
function anthropicOk(text: string) {
  return {
    ok: true,
    json: async () => ({
      content: [{ text }],
      usage: { input_tokens: 50, output_tokens: 20 },
    }),
    text: async () => '',
  };
}

/** Minimal Anthropic error response envelope. */
function anthropicErr(status: number, body = 'upstream error') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

// ─── Module loading with mocked dependencies ──────────────────────────────────
//
// We need to require server/index.js in a way that:
//  1. Replaces `@google-cloud/functions-framework` so we can capture the handler.
//  2. Replaces `@google-cloud/firestore` to avoid real network calls.
//  3. Lets us swap the global `fetch` per-test for AI call stubs.
//
// Node's require cache is the simplest seam here: we inject fakes before the
// first require, then reload for tests that need a fresh rate-limit state.

// Capture the handler that functions.http() registers.
let capturedHandler: ((req: MockReq, res: MockRes) => Promise<void>) | null = null;

// We use a Module mock approach compatible with CommonJS + node:test.
// Patch Module._resolveFilename to intercept the two Google deps.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as typeof import('node:module') & {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
  _cache: Record<string, unknown>;
};

// ─── Pure-function exports ─────────────────────────────────────────────────────
// These are exported directly and do not require handler setup.

describe('cleanMermaid', () => {
  // Require only the pure exports — the module registers a handler as a side
  // effect but we just ignore it for these tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cleanMermaid } = require('../index.js') as {
    cleanMermaid: (raw: string) => string;
  };

  it('returns the diagram unchanged when there are no fences', () => {
    const input = 'flowchart TD\n  A --> B';
    assert.equal(cleanMermaid(input), input);
  });

  it('strips triple-backtick mermaid fences', () => {
    const input = '```mermaid\nflowchart TD\n  A --> B\n```';
    assert.equal(cleanMermaid(input), 'flowchart TD\n  A --> B');
  });

  it('strips generic triple-backtick fences', () => {
    const input = '```\nflowchart TD\n  A --> B\n```';
    assert.equal(cleanMermaid(input), 'flowchart TD\n  A --> B');
  });

  it('strips leading and trailing lone backticks', () => {
    const input = '`flowchart TD`';
    assert.equal(cleanMermaid(input), 'flowchart TD');
  });

  it('handles empty string', () => {
    assert.equal(cleanMermaid(''), '');
  });

  it('handles null/undefined gracefully (called with no arg)', () => {
    // @ts-expect-error — testing JS runtime defensive path
    assert.equal(cleanMermaid(undefined), '');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(cleanMermaid('  flowchart TD  '), 'flowchart TD');
  });
});

describe('systemPrompt', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { systemPrompt } = require('../index.js') as {
    systemPrompt: (type: string, mode: string) => string;
  };

  it('includes the flowchart hint in describe mode', () => {
    const prompt = systemPrompt('flowchart', 'describe');
    assert.match(prompt, /flowchart TD/);
    assert.match(prompt, /description into a single valid Mermaid/);
  });

  it('includes the policy preamble in policy mode', () => {
    const prompt = systemPrompt('flowchart', 'policy');
    assert.match(prompt, /pasted a policy/);
  });

  it('uses sequence diagram hint for sequence type', () => {
    const prompt = systemPrompt('sequence', 'describe');
    assert.match(prompt, /sequenceDiagram/);
  });

  it('uses mindmap hint for mindmap type', () => {
    const prompt = systemPrompt('mindmap', 'describe');
    assert.match(prompt, /mindmap/);
  });

  it('falls back to "most appropriate" hint for unknown types', () => {
    const prompt = systemPrompt('unknown_type', 'describe');
    assert.match(prompt, /most appropriate Mermaid diagram/);
  });

  it('always includes the no-fences output rule', () => {
    const prompt = systemPrompt('flowchart', 'describe');
    assert.match(prompt, /Output ONLY the Mermaid code/);
  });
});

describe('hashIp', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hashIp } = require('../index.js') as { hashIp: (ip: string) => string };

  it('returns a 16-character hex string', () => {
    const h = hashIp('192.168.1.1');
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', () => {
    assert.equal(hashIp('10.0.0.1'), hashIp('10.0.0.1'));
  });

  it('produces different hashes for different IPs', () => {
    assert.notEqual(hashIp('10.0.0.1'), hashIp('10.0.0.2'));
  });

  it('handles unknown/falsy gracefully', () => {
    // @ts-expect-error — testing JS runtime path
    const h = hashIp(null);
    assert.match(h, /^[0-9a-f]{16}$/);
  });
});

describe('allow (rate limiter)', () => {
  // Each describe block gets a fresh module instance so rate state doesn't leak.
  // We delete the cached module before re-requiring.
  let allow: (key: string, limit: number, windowMs: number) => boolean;
  let _hits: Map<string, { count: number; resetAt: number }>;

  before(() => {
    // Clear the cached module so we get a fresh hits Map.
    const resolved = require.resolve('../index.js');
    delete require.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index.js') as {
      allow: (key: string, limit: number, windowMs: number) => boolean;
      _hits: Map<string, { count: number; resetAt: number }>;
    };
    allow = mod.allow;
    _hits = mod._hits;
  });

  beforeEach(() => {
    _hits.clear();
  });

  it('allows the first request', () => {
    assert.equal(allow('test-key', 5, 60_000), true);
  });

  it('allows up to the limit', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(allow('k', 5, 60_000), true, `request ${i + 1} should be allowed`);
    }
  });

  it('blocks the request after the limit is reached', () => {
    for (let i = 0; i < 5; i++) allow('k', 5, 60_000);
    assert.equal(allow('k', 5, 60_000), false);
  });

  it('resets after the window expires', () => {
    // Use a tiny window (already expired by the time we check).
    allow('k', 1, 1); // window = 1 ms
    // Spin until the window expires.
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) { /* busy-wait */ }
    assert.equal(allow('k', 1, 60_000), true);
  });

  it('tracks different keys independently', () => {
    allow('a', 1, 60_000); // exhaust key "a"
    assert.equal(allow('a', 1, 60_000), false);
    assert.equal(allow('b', 1, 60_000), true); // key "b" is unaffected
  });
});

// ─── HTTP handler integration tests ───────────────────────────────────────────
//
// We load index.js in a sandboxed require so that:
//  • functions.http() captures the handler into our variable.
//  • Firestore is stubbed out (no real network).
//  • global fetch is replaced per test.
//
// Because Node's require cache is global we must carefully manage it.

describe('HTTP handler', () => {
  let handler: (req: MockReq, res: MockRes) => Promise<void>;

  // Stub fetch as a global before loading the module.
  const originalFetch = global.fetch;

  function loadHandler(fetchStub?: typeof global.fetch) {
    // Remove any previously cached version of our module.
    const key = require.resolve('../index.js');
    delete require.cache[key];

    // Stub global.fetch before the module loads (it captures it at call time
    // via the global, so we set it each time we call the handler).
    if (fetchStub) {
      // @ts-expect-error — replacing global fetch with a stub
      global.fetch = fetchStub;
    }

    // Stub out @google-cloud/functions-framework
    const fwKey = require.resolve('@google-cloud/functions-framework');
    const originalFw = require.cache[fwKey];
    require.cache[fwKey] = {
      id: fwKey,
      filename: fwKey,
      loaded: true,
      exports: {
        http: (_name: string, fn: typeof handler) => { handler = fn; },
      },
      // node internals we don't use
      parent: null,
      children: [],
      path: '',
      paths: [],
    } as unknown as NodeJS.Module;

    // Stub out @google-cloud/firestore so Firestore init doesn't throw or connect.
    try {
      const fsKey = require.resolve('@google-cloud/firestore');
      const originalFs = require.cache[fsKey];
      require.cache[fsKey] = {
        id: fsKey,
        filename: fsKey,
        loaded: true,
        exports: {
          Firestore: class {
            collection() {
              return { add: async () => ({}) };
            }
          },
        },
        parent: null,
        children: [],
        path: '',
        paths: [],
      } as unknown as NodeJS.Module;
    } catch {
      // Firestore not installed — the module's try/catch already handles this.
    }

    require('../index.js');

    // Restore functions-framework stub so later requires of other modules aren't
    // affected (though we re-stub each time, this is defensive).
  }

  before(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key-for-unit-tests';
  });

  after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    // @ts-expect-error — restoring
    global.fetch = originalFetch;
  });

  // ── CORS / method guards ────────────────────────────────────────────────────

  it('returns 204 for OPTIONS preflight', async () => {
    loadHandler();
    const req = makeReq({ method: 'OPTIONS' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 204);
  });

  it('returns 405 for GET requests', async () => {
    loadHandler();
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 405);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns 400 when prompt is missing', async () => {
    loadHandler();
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 400);
    assert.equal((res._body as { error: string }).error, 'Empty prompt');
  });

  it('returns 400 when prompt is an empty string', async () => {
    loadHandler();
    const req = makeReq({ body: { prompt: '   ' } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 400);
  });

  it('returns 413 when describe-mode prompt exceeds 1500 chars', async () => {
    loadHandler();
    const req = makeReq({ body: { prompt: 'x'.repeat(1501), mode: 'describe' } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 413);
    assert.equal((res._body as { error: string }).error, 'Prompt too long');
  });

  it('returns 413 when policy-mode prompt exceeds 8000 chars', async () => {
    loadHandler();
    const req = makeReq({ body: { prompt: 'x'.repeat(8001), mode: 'policy' } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 413);
  });

  it('accepts a policy-mode prompt up to 8000 chars', async () => {
    loadHandler(async () => anthropicOk('flowchart TD\n  A --> B'));
    const req = makeReq({ body: { prompt: 'x'.repeat(8000), mode: 'policy' } });
    const res = makeRes();
    await handler(req, res);
    // Should not be rejected by length guard (might fail for other reasons but not 413).
    assert.notEqual(res._status, 413);
  });

  // ── Missing API key ─────────────────────────────────────────────────────────

  it('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    loadHandler();
    delete process.env.ANTHROPIC_API_KEY;
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 500);
    assert.equal((res._body as { error: string }).error, 'Server not configured');
    // Restore for subsequent tests.
    process.env.ANTHROPIC_API_KEY = 'test-key-for-unit-tests';
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with mermaid diagram on success', async () => {
    const diagram = 'flowchart TD\n  A[Start] --> B[End]';
    loadHandler(async () => anthropicOk(diagram));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal((res._body as { mermaid: string }).mermaid, diagram);
  });

  it('strips code fences from the AI response before returning', async () => {
    const diagram = 'flowchart TD\n  A --> B';
    loadHandler(async () => anthropicOk('```mermaid\n' + diagram + '\n```'));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal((res._body as { mermaid: string }).mermaid, diagram);
  });

  it('forwards the correct model and max_tokens to the Anthropic API', async () => {
    let capturedBody: Record<string, unknown> = {};
    loadHandler(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return anthropicOk('flowchart TD\n  A --> B');
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(capturedBody.model, 'claude-haiku-4-5-20251001');
    assert.equal(capturedBody.max_tokens, 1100);
  });

  it('sends the user prompt as the user message', async () => {
    let capturedBody: Record<string, unknown> = {};
    loadHandler(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return anthropicOk('flowchart TD\n  A --> B');
    });
    const req = makeReq({ body: { prompt: 'Medication administration rounds', type: 'flowchart', mode: 'describe' } });
    const res = makeRes();
    await handler(req, res);
    const messages = capturedBody.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Medication administration rounds');
  });

  // ── Upstream error handling ─────────────────────────────────────────────────

  it('returns 502 when Anthropic returns a non-ok status', async () => {
    loadHandler(async () => anthropicErr(500));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as { error: string }).error, 'Upstream error');
    assert.equal((res._body as { status: number }).status, 500);
  });

  it('returns 502 when the fetch call itself throws (network error)', async () => {
    loadHandler(async () => { throw new Error('ECONNREFUSED'); });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as { error: string }).error, 'Upstream unreachable');
  });

  it('returns 502 when the AI response content is empty', async () => {
    loadHandler(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: '' }], usage: {} }),
      text: async () => '',
    }));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as { error: string }).error, 'Empty result');
  });

  it('returns 502 when the AI response has no content array', async () => {
    loadHandler(async () => ({
      ok: true,
      json: async () => ({ usage: {} }),
      text: async () => '',
    }));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 502);
    assert.equal((res._body as { error: string }).error, 'Empty result');
  });

  // ── Mode normalisation ──────────────────────────────────────────────────────

  it('treats an unrecognised mode as "describe"', async () => {
    let capturedBody: Record<string, unknown> = {};
    loadHandler(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return anthropicOk('flowchart TD\n  A --> B');
    });
    const req = makeReq({ body: { prompt: 'Some text', mode: 'INVALID', type: 'flowchart' } });
    const res = makeRes();
    await handler(req, res);
    // The system prompt should be the describe variant (not mention "pasted a policy").
    assert.ok(!(capturedBody.system as string).includes('pasted a policy'));
  });

  // ── CORS headers ────────────────────────────────────────────────────────────

  it('sets Access-Control-Allow-Origin on every response', async () => {
    loadHandler(async () => anthropicOk('flowchart TD\n  A --> B'));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.ok(res._headers['Access-Control-Allow-Origin']);
  });

  // ── Rate limiting (integration smoke-test) ──────────────────────────────────

  it('returns 429 once the per-IP per-minute limit is exceeded', async () => {
    // Load with fresh rate-limit state and a working fetch stub.
    loadHandler(async () => anthropicOk('flowchart TD\n  A --> B'));

    // Also clear the _hits map exported by the freshly loaded module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _hits } = require('../index.js') as {
      _hits: Map<string, unknown>;
    };
    _hits.clear();

    // Exhaust the per-minute limit (PER_IP_PER_MIN = 5) by making 5 requests
    // that each succeed, then verify the 6th is rate-limited.
    // We use a fixed x-forwarded-for so all requests share the same IP bucket.
    const headers = { 'x-forwarded-for': '203.0.113.1' };

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq({ headers }), res);
      // Each of these should succeed (200) because the daily global guard and
      // per-IP daily guard have headroom.  If they don't succeed for some
      // unrelated reason we still continue — we just want to exhaust the bucket.
    }

    const res = makeRes();
    await handler(makeReq({ headers }), res);
    assert.equal(res._status, 429);
    assert.equal((res._body as { error: string }).error, 'Rate limited');
  });
});
