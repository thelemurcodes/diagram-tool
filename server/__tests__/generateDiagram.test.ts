/**
 * Ported HTTP handler tests (from generateDiagram.test.ts) — now exercised
 * through supertest against the express app. The default wiring runs the
 * recorded-response fake; upstream error paths use an AnthropicClient driven
 * by a mocked fetch so the same assertions carry over.
 */
import request from 'supertest';
import { createApp, AppDeps } from '../src/app';
import { RateLimiter, hashIp } from '../src/util';
import { LIMITS } from '../src/config';
import { AnthropicClient } from '../src/modelClient';
import { MemoryLogStore } from '../src/stores/memoryStore';

function makeApp(overrides: Partial<AppDeps> = {}) {
  const limiter = new RateLimiter();
  const app = createApp(overrides, limiter);
  return { app, limiter };
}

/** Multi-word fill of exactly n chars (the handler trims, so it must not end
 *  in whitespace, and single-word fills now trip the underspecified guard). */
function fillChars(n: number): string {
  return 'policy step '.repeat(Math.ceil(n / 12)).slice(0, n - 1) + 'x';
}

describe('HTTP handler — CORS preflight', () => {
  it('responds 204 to OPTIONS requests', async () => {
    const { app } = makeApp();
    const res = await request(app).options('/').send();
    expect(res.status).toBe(204);
  });

  it('sets CORS headers on every response', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show a resident intake flow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('uses the allowedOrigin dep when set (production: the Pages origin)', async () => {
    const { app } = makeApp({ allowedOrigin: 'https://thelemurcodes.github.io' });
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show a resident intake flow', type: 'flowchart', mode: 'describe' });
    expect(res.headers['access-control-allow-origin']).toBe('https://thelemurcodes.github.io');
  });

  it('preflight allows POST and Content-Type headers', async () => {
    const { app } = makeApp();
    const res = await request(app).options('/').send();
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });
});

describe('HTTP handler — method validation', () => {
  it('returns 200 ok for a plain GET (root health probe)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'senior-care-diagram-proxy' });
  });

  it('returns 405 for PUT requests', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/').send({});
    expect(res.status).toBe(405);
  });
});

describe('HTTP handler — input validation', () => {
  it('returns 400 when prompt is empty', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ prompt: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty prompt/i);
  });

  it('returns 400 when prompt is absent', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
  });

  it('returns 413 when describe prompt exceeds 1500 chars', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ prompt: 'a'.repeat(1501), mode: 'describe' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too long/i);
    expect(res.body.cap).toBe(1500);
  });

  it('returns 413 when policy prompt exceeds 8000 chars', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ prompt: 'a'.repeat(8001), mode: 'policy' });
    expect(res.status).toBe(413);
    expect(res.body.cap).toBe(8000);
  });

  it('accepts a describe prompt at exactly the 1500-char limit', async () => {
    const { app } = makeApp();
    // Multi-word fill: a single-word or single-character fill is now caught
    // by the underspecified-input guard before it reaches the cap.
    const res = await request(app).post('/').send({ prompt: fillChars(1500), mode: 'describe' });
    expect(res.status).toBe(200);
  });

  it('accepts a policy prompt at exactly the 8000-char limit', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ prompt: fillChars(8000), mode: 'policy' });
    expect(res.status).toBe(200);
  });

  it('defaults mode to "describe" when mode is unrecognised', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ prompt: fillChars(1499), mode: 'bad-mode' });
    expect(res.status).toBe(200);
  });

  it('rejects a prompt over MAX_PROMPT_LENGTH with 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
    expect(res.body.max).toBe(LIMITS.MAX_PROMPT_LENGTH);
  });
});

describe('HTTP handler — missing API key', () => {
  it('returns 500 with Server not configured when no Anthropic key is configured', async () => {
    const { app } = makeApp({ apiKeyConfigured: false });
    const res = await request(app).post('/').send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

describe('HTTP handler — rate limiting', () => {
  it('returns 429 when the per-minute IP limit is exhausted', async () => {
    const { app, limiter } = makeApp();
    limiter.hits.set(`m:${hashIp('10.0.0.1')}`, { count: LIMITS.PER_IP_PER_MIN, resetAt: Date.now() + 60_000 });

    const res = await request(app)
      .post('/')
      .set('x-forwarded-for', '10.0.0.1')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limited/i);
  });

  it('returns 503 when the global daily cap is exhausted', async () => {
    const { app, limiter } = makeApp();
    const day = new Date().toISOString().slice(0, 10);
    limiter.hits.set(`g:${day}`, { count: LIMITS.GLOBAL_PER_DAY, resetAt: Date.now() + 86_400_000 });

    const res = await request(app).post('/').send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/daily limit/i);
  });

  it('returns 429 when the per-day IP limit is exhausted', async () => {
    const { app, limiter } = makeApp();
    const day = new Date().toISOString().slice(0, 10);
    limiter.hits.set(`d:${hashIp('10.0.0.7')}:${day}`, { count: LIMITS.PER_IP_PER_DAY, resetAt: Date.now() + 86_400_000 });

    const res = await request(app)
      .post('/')
      .set('x-forwarded-for', '10.0.0.7')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(429);
  });
});

describe('HTTP handler — upstream errors (AnthropicClient via mocked fetch)', () => {
  function appWithMockedFetch(mockFetch: jest.Mock) {
    const limiter = new RateLimiter();
    const client = new AnthropicClient('test-key', LIMITS.MODEL, mockFetch as any);
    const app = createApp({ modelClient: client }, limiter);
    return app;
  }

  it('returns 502 when fetch throws (network failure)', async () => {
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error('Connection refused'));
    const res = await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('returns 502 when Anthropic responds with a non-OK status', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited by anthropic',
    });
    const res = await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe(429);
  });

  it('returns 502 when Anthropic returns an empty content array', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [], usage: {} }),
      text: async () => '',
    });
    const res = await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/empty result/i);
  });

  it('returns 502 when Anthropic returns whitespace-only content', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '   ' }], usage: {} }),
      text: async () => '',
    });
    const res = await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/empty result/i);
  });

  it('returns 502 when Anthropic returns fenced content that cleans to empty', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: '```\n\n```' }], usage: {} }),
      text: async () => '',
    });
    const res = await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(502);
  });

  it('sends the correct model, max_tokens, key header, and system prompt to the API', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: 'flowchart TD\n  A --> B' }],
        usage: { input_tokens: 50, output_tokens: 80 },
      }),
      text: async () => '',
    });

    await request(appWithMockedFetch(mockFetch))
      .post('/')
      .send({ prompt: 'Show handoff', type: 'sequence', mode: 'describe' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBe(1100);
    expect(body.messages[0].role).toBe('user');
    expect(init.headers['x-api-key']).toBe('test-key');
    expect(body.system).toContain('sequenceDiagram');
  });
});

describe('HTTP handler — happy path (recorded-response fake)', () => {
  it('returns 200 with cleaned mermaid for a plain describe request', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show a resident intake flow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
  });

  it('strips markdown fences returned by the AI', async () => {
    // Fixture text is unfenced, so this pins cleanMermaid on the handler path
    // via the mocked-fetch client with a fenced response.
    const mockFetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ text: '```mermaid\nflowchart TD\n  A --> B\n```' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    });
    const limiter = new RateLimiter();
    const app = createApp({ modelClient: new AnthropicClient('k', LIMITS.MODEL, mockFetch as any) }, limiter);
    const res = await request(app).post('/').send({ prompt: 'intake flow' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toBe('flowchart TD\n  A --> B');
  });

  it('works for policy mode', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Policy: staff must log all incidents.', mode: 'policy', type: 'flowchart' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
  });

  it('serves type-specific fixtures for decision diagrams', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'What happens after a fall', type: 'decision', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
    expect(res.body.mermaid).toContain('Resident responsive?');
  });

  it('falls back to the describe-flowchart fixture for types without a fixture', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show handoff', type: 'org', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
  });

  it('includes template_id in the diagram_logs write when provided', async () => {
    const logStore = new MemoryLogStore();
    const limiter = new RateLimiter();
    const app = createApp({ logStore }, limiter);
    const res = await request(app)
      .post('/')
      .send({
        prompt: 'Show a med-pass workflow',
        type: 'flowchart',
        mode: 'describe',
        templateId: 'med-pass',
      });
    expect(res.status).toBe(200);
    expect(logStore.rows).toHaveLength(1);
    expect(logStore.rows[0].template_id).toBe('med-pass');
    expect(logStore.rows[0].success).toBe(true);
    expect(logStore.rows[0].ip_hash).toHaveLength(16);
    expect(logStore.rows[0].prompt_chars).toBe('Show a med-pass workflow'.length);
  });

  it('logs template_id: null when templateId is absent', async () => {
    const logStore = new MemoryLogStore();
    const limiter = new RateLimiter();
    const app = createApp({ logStore }, limiter);
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show an admission workflow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(logStore.rows[0].template_id).toBeNull();
    expect(logStore.rows[0].usage_in).toBeGreaterThan(0);
    expect(logStore.rows[0].usage_out).toBeGreaterThan(0);
  });

  it('never stores raw prompt text for a policy-mode request (DIAG-ADR-002)', async () => {
    const marker =
      'Policy-MARKER: Resident Jane Doe (DOB 1931) requires insulin at 11:00 with UTI precautions';
    const logStore = new MemoryLogStore();
    const limiter = new RateLimiter();
    const app = createApp({ logStore }, limiter);
    const res = await request(app)
      .post('/')
      .send({ prompt: marker, type: 'flowchart', mode: 'policy' });
    expect(res.status).toBe(200);
    expect(logStore.rows).toHaveLength(1);

    const row: Record<string, unknown> = logStore.rows[0] as unknown as Record<string, unknown>;
    // Strict: the event carries no `prompt` field at all, and no string value
    // anywhere in the logged row contains any part of the pasted policy.
    expect('prompt' in row).toBe(false);
    for (const value of Object.values(row)) {
      const asText = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      expect(asText).not.toContain(marker);
      expect(asText).not.toContain('Jane Doe');
    }
    expect(row.prompt_chars).toBe(marker.length);
  });

  it('responds 200 even when the log store write fails', async () => {
    const failingLogStore = {
      log: jest.fn().mockRejectedValueOnce(new Error('log down')),
      usageIntel: jest.fn(),
    };
    const limiter = new RateLimiter();
    const app = createApp({ logStore: failingLogStore as any }, limiter);
    const res = await request(app).post('/').send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toBeDefined();
  });
});
