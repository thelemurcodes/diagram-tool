/**
 * New: model-interface contract tests. The same assertions run against
 * whichever client is configured, so the recorded-response fake cannot drift
 * from the real AnthropicClient contract silently.
 *
 * Real-client contract assertions run only when ANTHROPIC_API_KEY is present
 * (skipped, not failed, in keyless CI — the one documented exception to
 * running contracts against both adapters).
 */
import path from 'path';
import {
  ModelClient,
  AnthropicClient,
  UpstreamError,
} from '../src/modelClient';
import { RecordedResponseClient } from '../src/recordedClient';
import { LIMITS } from '../src/config';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

interface ClientCase {
  name: string;
  make: () => ModelClient;
  /** Recorded client has no mode/type in the prompt; the fake keys on them. */
  request: { system: string; prompt: string; maxTokens: number; mode?: string; type?: string };
  expectedPrefix?: string;
}

const describeFlowchartReq = {
  system: 'You are a diagramming assistant.',
  prompt: 'Show a resident intake flow',
  maxTokens: LIMITS.MAX_TOKENS,
  mode: 'describe',
  type: 'flowchart',
};

const cases: ClientCase[] = [
  {
    name: 'RecordedResponseClient',
    make: () => new RecordedResponseClient(FIXTURES_DIR),
    request: describeFlowchartReq,
    expectedPrefix: 'flowchart',
  },
];

// The real client joins the contract suite only when a key exists.
if (process.env.ANTHROPIC_API_KEY) {
  cases.push({
    name: 'AnthropicClient (live)',
    make: () => new AnthropicClient(process.env.ANTHROPIC_API_KEY!, LIMITS.MODEL),
    request: describeFlowchartReq,
  });
}

describe.each(cases)('ModelClient contract — $name', ({ make, request, expectedPrefix }) => {
  let client: ModelClient;
  beforeEach(() => {
    client = make();
  });

  it('generate() resolves with the {text, usageIn, usageOut} result shape', async () => {
    const res = await client.generate(request);
    expect(typeof res.text).toBe('string');
    expect(typeof res.usageIn).toBe('number');
    expect(typeof res.usageOut).toBe('number');
  });

  it('generate() returns non-empty mermaid text for a real prompt', async () => {
    const res = await client.generate(request);
    expect(res.text.trim().length).toBeGreaterThan(0);
  });

  if (expectedPrefix) {
    it(`generate() text starts with ${expectedPrefix}`, async () => {
      const res = await client.generate(request);
      expect(res.text.trim().startsWith(expectedPrefix)).toBe(true);
    });
  }
});

describe('RecordedResponseClient specifics', () => {
  const client = new RecordedResponseClient(FIXTURES_DIR);

  it('serves type-specific fixtures (decision)', async () => {
    const res = await client.generate({ ...describeFlowchartReq, type: 'decision' });
    expect(res.text).toContain('Resident responsive?');
  });

  it('serves policy-mode fixtures for policy requests', async () => {
    const res = await client.generate({ ...describeFlowchartReq, mode: 'policy' });
    expect(res.text).toContain('incident reported');
  });

  it('falls back to describe-flowchart for a type without a fixture', async () => {
    const res = await client.generate({ ...describeFlowchartReq, type: 'org' });
    expect(res.text.trim().startsWith('flowchart')).toBe(true);
  });

  it('is deterministic — the same request returns the same response', async () => {
    const a = await client.generate(describeFlowchartReq);
    const b = await client.generate(describeFlowchartReq);
    expect(a.text).toBe(b.text);
    expect(a.usageIn).toBe(b.usageIn);
    expect(a.usageOut).toBe(b.usageOut);
  });

  it('throws a clear error when no fixture exists at all', async () => {
    const empty = new RecordedResponseClient(path.join(FIXTURES_DIR, 'does-not-exist'));
    await expect(empty.generate(describeFlowchartReq)).rejects.toThrow(/No recorded fixture/);
  });
});

describe('AnthropicClient upstream error contract (mocked fetch)', () => {
  it('throws UpstreamError(kind=unreachable) when fetch rejects', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new AnthropicClient('test-key', LIMITS.MODEL, failing as any);
    await expect(client.generate(describeFlowchartReq)).rejects.toMatchObject({
      name: 'UpstreamError',
      kind: 'unreachable',
    });
  });

  it('throws UpstreamError(kind=http, status) on a non-OK upstream response', async () => {
    const failing = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'upstream rate limited',
    });
    const client = new AnthropicClient('test-key', LIMITS.MODEL, failing as any);
    const err = await client.generate(describeFlowchartReq).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(429);
    expect(err.detail).toContain('rate limited');
  });

  it('truncates upstream error detail to 300 chars', async () => {
    const failing = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'x'.repeat(1000),
    });
    const client = new AnthropicClient('test-key', LIMITS.MODEL, failing as any);
    const err = await client.generate(describeFlowchartReq).catch((e) => e);
    expect(err.detail.length).toBe(300);
  });

  it('sends model, max_tokens, system prompt, and key header; never logs the key', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'flowchart TD\n  A --> B' }],
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    });
    const client = new AnthropicClient('secret-key', LIMITS.MODEL, spy as any);
    const res = await client.generate({ ...describeFlowchartReq, maxTokens: 1100 });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('secret-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(LIMITS.MODEL);
    expect(body.max_tokens).toBe(1100);
    expect(body.system).toBe(describeFlowchartReq.system);
    expect(body.messages).toEqual([{ role: 'user', content: describeFlowchartReq.prompt }]);

    expect(res).toEqual({ text: 'flowchart TD\n  A --> B', usageIn: 12, usageOut: 34 });
  });

  it('returns empty text (not a throw) when the response carries no content', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [], usage: {} }),
    });
    const client = new AnthropicClient('test-key', LIMITS.MODEL, spy as any);
    const res = await client.generate(describeFlowchartReq);
    expect(res.text).toBe('');
    expect(res.usageIn).toBe(0);
    expect(res.usageOut).toBe(0);
  });
});
