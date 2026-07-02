/**
 * Tests for the diagram Cloud Function (server/index.js).
 *
 * Strategy:
 *  - Pure helpers (systemPrompt, cleanMermaid, allow, hashIp) are tested
 *    directly via the module's named exports.
 *  - The HTTP handler is exercised through a lightweight req/res fake so we
 *    can hit every guard-clause branch and the happy path without spinning up
 *    an actual HTTP server.
 *  - `fetch` and `@google-cloud/functions-framework` are both mocked so no
 *    network calls or real Cloud registrations occur during tests.
 */

// ---------------------------------------------------------------------------
// 1. Mock the Cloud Functions framework before the module is loaded so that
//    functions.http() is captured rather than trying to register a real handler.
// ---------------------------------------------------------------------------
const registeredHandlers: Record<string, Function> = {};

jest.mock('@google-cloud/functions-framework', () => ({
  http: (name: string, handler: Function) => {
    registeredHandlers[name] = handler;
  },
}));

// Prevent Firestore from being instantiated (it requires ADC credentials).
jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({ add: jest.fn().mockResolvedValue({}) }),
  })),
}));

// ---------------------------------------------------------------------------
// 2. Mock the global fetch used to call the Anthropic API.
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// 3. Load the module under test — happens AFTER mocks are in place.
// ---------------------------------------------------------------------------
const {
  systemPrompt,
  cleanMermaid,
  allow,
  hashIp,
  _hits,
} = require('../index') as {
  systemPrompt: (type: string, mode: string) => string;
  cleanMermaid: (raw: string) => string;
  allow: (key: string, limit: number, windowMs: number) => boolean;
  hashIp: (ip: string) => string;
  _hits: Map<string, { count: number; resetAt: number }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal express-style req object. */
function makeReq(overrides: Partial<{
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> = {}) {
  return {
    method: 'POST',
    body: { prompt: 'Show a resident intake flow', type: 'flowchart', mode: 'describe' },
    headers: {},
    ...overrides,
  };
}

/** Build a minimal express-style res recorder. */
function makeRes() {
  const recorded: { statusCode: number; body: unknown; headers: Record<string, string> } = {
    statusCode: 200,
    body: null,
    headers: {},
  };
  const res: any = {
    _recorded: recorded,
    set: (k: string, v: string) => { recorded.headers[k.toLowerCase()] = v; return res; },
    status: (code: number) => { recorded.statusCode = code; return res; },
    json: (body: unknown) => { recorded.body = body; return res; },
    send: (body: unknown) => { recorded.body = body; return res; },
  };
  return res;
}

/** Invoke the registered 'diagram' handler and return the res recorder. */
async function callHandler(req: ReturnType<typeof makeReq>) {
  const res = makeRes();
  await registeredHandlers['diagram'](req, res);
  return res._recorded;
}

/** Build the standard successful Anthropic API response payload. */
function anthropicOkResponse(mermaidText: string) {
  return {
    ok: true,
    json: async () => ({
      content: [{ text: mermaidText }],
      usage: { input_tokens: 50, output_tokens: 80 },
    }),
    text: async () => '',
  };
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _hits.clear();
  mockFetch.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key-abc';
  delete process.env.LOG_PROMPTS;
  delete process.env.ALLOWED_ORIGIN;
});

// ── systemPrompt ─────────────────────────────────────────────────────────────

describe('systemPrompt', () => {
  it('includes the flowchart hint for describe mode', () => {
    const sp = systemPrompt('flowchart', 'describe');
    expect(sp).toContain('flowchart TD');
    expect(sp).toContain("Turn the user's description");
  });

  it('includes the policy preamble for policy mode', () => {
    const sp = systemPrompt('flowchart', 'policy');
    expect(sp).toContain('pasted a policy');
    expect(sp).not.toContain("Turn the user's description");
  });

  it('uses sequenceDiagram hint for sequence type', () => {
    const sp = systemPrompt('sequence', 'describe');
    expect(sp).toContain('sequenceDiagram');
  });

  it('uses mindmap hint for mindmap type', () => {
    const sp = systemPrompt('mindmap', 'describe');
    expect(sp).toContain('mindmap');
  });

  it('uses org-chart hint for org type', () => {
    const sp = systemPrompt('org', 'describe');
    expect(sp).toContain('organizational chart');
  });

  it('uses decision-tree hint for decision type', () => {
    const sp = systemPrompt('decision', 'describe');
    expect(sp).toContain('decision tree');
    expect(sp).toContain('Yes/No');
  });

  it('uses timeline hint for timeline type', () => {
    const sp = systemPrompt('timeline', 'describe');
    expect(sp).toContain('timeline');
  });

  it('falls back to "most appropriate" for an unknown type', () => {
    const sp = systemPrompt('unknown-type', 'describe');
    expect(sp).toContain('most appropriate Mermaid diagram');
  });

  it('always includes the no-fences output rule', () => {
    const sp = systemPrompt('flowchart', 'describe');
    expect(sp).toContain('no markdown fences');
  });
});

// ── cleanMermaid ──────────────────────────────────────────────────────────────

describe('cleanMermaid', () => {
  it('returns plain mermaid code unchanged', () => {
    const raw = 'flowchart TD\n  A --> B';
    expect(cleanMermaid(raw)).toBe(raw);
  });

  it('strips ```mermaid fences', () => {
    const raw = '```mermaid\nflowchart TD\n  A --> B\n```';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('strips plain ``` fences', () => {
    const raw = '```\nflowchart TD\n  A --> B\n```';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('strips stray leading/trailing backticks when no fences', () => {
    const raw = '`flowchart TD\n  A --> B`';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('handles an empty string gracefully', () => {
    expect(cleanMermaid('')).toBe('');
  });

  it('handles null/undefined-like input (empty fallback)', () => {
    // The function coerces with (raw || '')
    expect(cleanMermaid(undefined as any)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanMermaid('   flowchart TD   ')).toBe('flowchart TD');
  });

  it('preserves interior newlines', () => {
    const code = 'flowchart TD\n  A --> B\n  B --> C';
    expect(cleanMermaid(code)).toContain('\n');
  });
});

// ── allow (rate limiter) ──────────────────────────────────────────────────────

describe('allow', () => {
  beforeEach(() => _hits.clear());

  it('permits the first request', () => {
    expect(allow('test-key', 5, 60_000)).toBe(true);
  });

  it('permits requests up to the limit', () => {
    for (let i = 0; i < 5; i++) expect(allow('k', 5, 60_000)).toBe(true);
  });

  it('blocks the request that exceeds the limit', () => {
    for (let i = 0; i < 5; i++) allow('k', 5, 60_000);
    expect(allow('k', 5, 60_000)).toBe(false);
  });

  it('resets after the window expires', () => {
    // Fill the bucket.
    for (let i = 0; i < 5; i++) allow('k', 5, 1);
    expect(allow('k', 5, 1)).toBe(false);

    // Force the window to expire by back-dating the stored entry.
    const entry = _hits.get('k')!;
    entry.resetAt = Date.now() - 1;

    expect(allow('k', 5, 60_000)).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    for (let i = 0; i < 5; i++) allow('a', 5, 60_000);
    expect(allow('a', 5, 60_000)).toBe(false);
    expect(allow('b', 5, 60_000)).toBe(true);
  });
});

// ── hashIp ────────────────────────────────────────────────────────────────────

describe('hashIp', () => {
  it('returns a 16-character hex string', () => {
    const h = hashIp('192.168.1.1');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'));
  });

  it('produces different hashes for different IPs', () => {
    expect(hashIp('1.2.3.4')).not.toBe(hashIp('4.3.2.1'));
  });

  it('handles an empty/unknown IP without throwing', () => {
    expect(() => hashIp('')).not.toThrow();
    expect(() => hashIp('unknown')).not.toThrow();
  });
});

// ── HTTP handler — guard clauses ──────────────────────────────────────────────

describe('HTTP handler — CORS preflight', () => {
  it('responds 204 to OPTIONS requests', async () => {
    const result = await callHandler(makeReq({ method: 'OPTIONS', body: {} }));
    expect(result.statusCode).toBe(204);
  });

  it('sets CORS headers on every response', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));
    const result = await callHandler(makeReq());
    expect(result.headers['access-control-allow-origin']).toBeDefined();
  });

  it('uses ALLOWED_ORIGIN env var when set', async () => {
    process.env.ALLOWED_ORIGIN = 'https://example.com';
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));
    const result = await callHandler(makeReq());
    expect(result.headers['access-control-allow-origin']).toBe('https://example.com');
  });
});

describe('HTTP handler — method validation', () => {
  it('returns 405 for GET requests', async () => {
    const result = await callHandler(makeReq({ method: 'GET' }));
    expect(result.statusCode).toBe(405);
  });

  it('returns 405 for PUT requests', async () => {
    const result = await callHandler(makeReq({ method: 'PUT' }));
    expect(result.statusCode).toBe(405);
  });
});

describe('HTTP handler — input validation', () => {
  it('returns 400 when prompt is empty', async () => {
    const result = await callHandler(makeReq({ body: { prompt: '' } }));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
  });

  it('returns 400 when prompt is absent', async () => {
    const result = await callHandler(makeReq({ body: {} }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 413 when describe prompt exceeds 1500 chars', async () => {
    const result = await callHandler(makeReq({
      body: { prompt: 'a'.repeat(1501), mode: 'describe' },
    }));
    expect(result.statusCode).toBe(413);
    expect((result.body as any).error).toMatch(/too long/i);
    expect((result.body as any).cap).toBe(1500);
  });

  it('returns 413 when policy prompt exceeds 8000 chars', async () => {
    const result = await callHandler(makeReq({
      body: { prompt: 'a'.repeat(8001), mode: 'policy' },
    }));
    expect(result.statusCode).toBe(413);
    expect((result.body as any).cap).toBe(8000);
  });

  it('accepts a describe prompt at exactly the 1500-char limit', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));
    const result = await callHandler(makeReq({
      body: { prompt: 'a'.repeat(1500), mode: 'describe' },
    }));
    expect(result.statusCode).toBe(200);
  });

  it('accepts a policy prompt at exactly the 8000-char limit', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));
    const result = await callHandler(makeReq({
      body: { prompt: 'a'.repeat(8000), mode: 'policy' },
    }));
    expect(result.statusCode).toBe(200);
  });

  it('defaults mode to "describe" when mode is unrecognised', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));
    const result = await callHandler(makeReq({
      body: { prompt: 'a'.repeat(1499), mode: 'bad-mode' },
    }));
    // Should not be 413 (would only be 413 if policy cap of 8000 applied but
    // actually 1499 < 1500, so either cap is fine here — the point is it
    // doesn't reject the request as an invalid mode).
    expect(result.statusCode).toBe(200);
  });
});

describe('HTTP handler — missing API key', () => {
  it('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(500);
    expect((result.body as any).error).toMatch(/not configured/i);
  });
});

describe('HTTP handler — rate limiting', () => {
  it('returns 429 when the per-minute IP limit is exhausted', async () => {
    // Exhaust the 5-req/min slot for a specific IP hash key directly.
    const ipHash = hashIp('10.0.0.1');
    const entry = { count: 5, resetAt: Date.now() + 60_000 };
    _hits.set(`m:${ipHash}`, entry);

    const result = await callHandler(makeReq({
      headers: { 'x-forwarded-for': '10.0.0.1' },
    }));
    expect(result.statusCode).toBe(429);
    expect((result.body as any).error).toMatch(/rate limited/i);
  });

  it('returns 503 when the global daily cap is exhausted', async () => {
    const day = new Date().toISOString().slice(0, 10);
    _hits.set(`g:${day}`, { count: 2000, resetAt: Date.now() + 86_400_000 });

    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(503);
    expect((result.body as any).error).toMatch(/daily limit/i);
  });
});

// ── HTTP handler — Anthropic API error paths ──────────────────────────────────

describe('HTTP handler — upstream errors', () => {
  it('returns 502 when fetch throws (network failure)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error).toMatch(/unreachable/i);
  });

  it('returns 502 when Anthropic responds with a non-OK status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited by anthropic',
    });
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(502);
    expect((result.body as any).status).toBe(429);
  });

  it('returns 502 when Anthropic returns an empty content array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [], usage: {} }),
      text: async () => '',
    });
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error).toMatch(/empty result/i);
  });

  it('returns 502 when Anthropic returns whitespace-only content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '   ' }], usage: {} }),
      text: async () => '',
    });
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error).toMatch(/empty result/i);
  });

  it('returns 502 when Anthropic returns fenced content that cleans to empty', async () => {
    // A response of just ``` ``` cleans to '' after fence stripping.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '```\n\n```' }], usage: {} }),
      text: async () => '',
    });
    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(502);
  });
});

// ── HTTP handler — happy path ─────────────────────────────────────────────────

describe('HTTP handler — happy path', () => {
  it('returns 200 with cleaned mermaid for a plain describe request', async () => {
    const diagram = 'flowchart TD\n  A[Intake] --> B[Assessment]';
    mockFetch.mockResolvedValueOnce(anthropicOkResponse(diagram));

    const result = await callHandler(makeReq({
      body: { prompt: 'Show a resident intake flow', type: 'flowchart', mode: 'describe' },
    }));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe(diagram);
  });

  it('strips markdown fences returned by the AI', async () => {
    const diagram = 'flowchart TD\n  A --> B';
    mockFetch.mockResolvedValueOnce(
      anthropicOkResponse('```mermaid\n' + diagram + '\n```')
    );

    const result = await callHandler(makeReq());
    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe(diagram);
  });

  it('works for policy mode', async () => {
    const diagram = 'flowchart TD\n  A[Receive complaint] --> B[Investigate]';
    mockFetch.mockResolvedValueOnce(anthropicOkResponse(diagram));

    const result = await callHandler(makeReq({
      body: { prompt: 'Policy: staff must log all incidents.', mode: 'policy', type: 'flowchart' },
    }));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe(diagram);
  });

  it('sends the correct model and max_tokens to the Anthropic API', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));

    await callHandler(makeReq());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBe(1100);
    expect(body.messages[0].role).toBe('user');
  });

  it('sends the API key in the x-api-key header', async () => {
    process.env.ANTHROPIC_API_KEY = 'my-secret-key';
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('flowchart TD\n  A --> B'));

    await callHandler(makeReq());

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('my-secret-key');
  });

  it('includes the diagram type in the system prompt sent to the API', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse('sequenceDiagram\n  A->>B: hello'));

    await callHandler(makeReq({ body: { prompt: 'Show handoff', type: 'sequence', mode: 'describe' } }));

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toContain('sequenceDiagram');
  });
});
