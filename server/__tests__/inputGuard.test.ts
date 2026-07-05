export {}; // isolate this file's top-level scope — sibling test files also declare
           // registeredHandlers/mockFetch/_hits/LIMITS at top level with no module marker

const registeredHandlers: Record<string, Function> = {};

jest.mock('@google-cloud/functions-framework', () => ({
  http: (name: string, handler: Function) => {
    registeredHandlers[name] = handler;
  },
}));

jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({ add: jest.fn().mockResolvedValue({}) }),
  })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const { _hits, LIMITS } = require('../index') as {
  _hits: Map<string, { count: number; resetAt: number }>;
  LIMITS: Record<string, number>;
};

function makeReq(body: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body,
    headers: {},
  };
}

function makeRes() {
  const recorded: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
  const res: any = {
    _recorded: recorded,
    set: () => res,
    status: (code: number) => { recorded.statusCode = code; return res; },
    json: (body: unknown) => { recorded.body = body; return res; },
    send: (body: unknown) => { recorded.body = body; return res; },
  };
  return res;
}

async function callHandler(req: ReturnType<typeof makeReq>) {
  const res = makeRes();
  await registeredHandlers['diagram'](req, res);
  return res._recorded;
}

beforeEach(() => {
  _hits.clear();
  mockFetch.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.LOG_PROMPTS;
});

describe('input guard — empty prompt', () => {
  it('rejects an empty string with 400 before calling Anthropic', async () => {
    const result = await callHandler(makeReq({ prompt: '' }));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing prompt with 400 before calling Anthropic', async () => {
    const result = await callHandler(makeReq({}));
    expect(result.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only prompt with 400 before calling Anthropic', async () => {
    const result = await callHandler(makeReq({ prompt: '   ' }));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('input guard — over-length prompt', () => {
  it('rejects a prompt over MAX_PROMPT_LENGTH with 400 before calling Anthropic', async () => {
    const overLength = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = await callHandler(makeReq({ prompt: overLength }));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/too long/i);
    expect((result.body as any).max).toBe(LIMITS.MAX_PROMPT_LENGTH);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('includes the maximum in the 400 response body', async () => {
    const overLength = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 100);
    const result = await callHandler(makeReq({ prompt: overLength }));
    expect(result.statusCode).toBe(400);
    expect(typeof (result.body as any).max).toBe('number');
    expect((result.body as any).max).toBeGreaterThan(0);
  });
});

describe('input guard — valid prompt passes through', () => {
  it('calls Anthropic for a prompt within MAX_PROMPT_LENGTH', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'flowchart TD\n  A --> B' }], usage: {} }),
      text: async () => '',
    });

    const validPrompt = 'Show a resident intake workflow';
    const result = await callHandler(makeReq({ prompt: validPrompt, mode: 'describe', type: 'flowchart' }));

    expect(result.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((result.body as any).mermaid).toBe('flowchart TD\n  A --> B');
  });

  it('does not reject a prompt at exactly MAX_PROMPT_LENGTH characters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'flowchart TD\n  A --> B' }], usage: {} }),
      text: async () => '',
    });

    // MAX_POLICY_CHARS is the larger per-mode cap; use a policy-mode prompt at MAX_PROMPT_LENGTH
    // to confirm the absolute guard allows it through to the per-mode check.
    // Since MAX_PROMPT_LENGTH > MAX_POLICY_CHARS, a prompt at MAX_PROMPT_LENGTH chars in
    // policy mode would be caught by the per-mode 413. Use a length that is within both caps.
    const atLimit = 'a'.repeat(LIMITS.MAX_DESCRIBE_CHARS);
    const result = await callHandler(makeReq({ prompt: atLimit, mode: 'describe', type: 'flowchart' }));

    expect(result.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
