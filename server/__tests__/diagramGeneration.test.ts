/**
 * Tests for the diagram-generation endpoint's input guards (server/index.js).
 *
 * Coverage:
 *  - Empty prompt is rejected with 400 before any Anthropic call.
 *  - Prompt exceeding MAX_PROMPT_LENGTH is rejected with 400 before any Anthropic call.
 *  - A valid in-range prompt passes through to the Anthropic mock without error.
 *
 * The describe/policy mode flows and mode-specific 413 caps tested in
 * generateDiagram.test.ts are not duplicated here — this file focuses solely
 * on the new input guards.
 */

// ---------------------------------------------------------------------------
// Mock the Cloud Functions framework so functions.http() captures the handler
// rather than attempting real Cloud registration.
// ---------------------------------------------------------------------------
const registeredHandlers: Record<string, Function> = {};

jest.mock('@google-cloud/functions-framework', () => ({
  http: (name: string, handler: Function) => {
    registeredHandlers[name] = handler;
  },
}));

// Prevent Firestore from being instantiated (requires ADC credentials).
jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({ add: jest.fn().mockResolvedValue({}) }),
  })),
}));

// ---------------------------------------------------------------------------
// Mock global fetch so no real network calls are made.
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Load the module under test after mocks are in place.
// ---------------------------------------------------------------------------
const { _hits, LIMITS } = require('../index') as {
  _hits: Map<string, { count: number; resetAt: number }>;
  LIMITS: {
    MAX_PROMPT_LENGTH: number;
    MAX_DESCRIBE_CHARS: number;
    MAX_POLICY_CHARS: number;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    set: (_k: string, _v: string) => res,
    status: (code: number) => { recorded.statusCode = code; return res; },
    json: (body: unknown) => { recorded.body = body; return res; },
    send: (body: unknown) => { recorded.body = body; return res; },
  };
  return res;
}

async function callHandler(body: Record<string, unknown>) {
  const res = makeRes();
  await registeredHandlers['diagram'](makeReq(body), res);
  return res._recorded;
}

function anthropicOk(mermaidText: string) {
  return {
    ok: true,
    json: async () => ({ content: [{ text: mermaidText }], usage: { input_tokens: 10, output_tokens: 20 } }),
    text: async () => '',
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _hits.clear();
  mockFetch.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.LOG_PROMPTS;
  delete process.env.ALLOWED_ORIGIN;
});

// ---------------------------------------------------------------------------
// Sanity-check the exported constant so test logic is anchored to code, not
// a hardcoded number. If the constant changes, tests will adapt automatically.
// ---------------------------------------------------------------------------

describe('LIMITS.MAX_PROMPT_LENGTH', () => {
  it('is exported and is a positive integer', () => {
    expect(typeof LIMITS.MAX_PROMPT_LENGTH).toBe('number');
    expect(LIMITS.MAX_PROMPT_LENGTH).toBeGreaterThan(0);
  });

  it('exceeds both mode-specific caps so 413 paths remain reachable', () => {
    expect(LIMITS.MAX_PROMPT_LENGTH).toBeGreaterThan(LIMITS.MAX_DESCRIBE_CHARS);
    expect(LIMITS.MAX_PROMPT_LENGTH).toBeGreaterThan(LIMITS.MAX_POLICY_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Input guard: empty prompt
// ---------------------------------------------------------------------------

describe('input guard — empty prompt', () => {
  it('returns 400 when prompt is an empty string', async () => {
    const result = await callHandler({ prompt: '' });
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
  });

  it('returns 400 when prompt key is absent from body', async () => {
    const result = await callHandler({});
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when prompt is only whitespace (trims to empty)', async () => {
    const result = await callHandler({ prompt: '   ' });
    expect(result.statusCode).toBe(400);
  });

  // Guard must short-circuit before reaching Anthropic: the caller receives a
  // 400 error body, not a mermaid diagram, confirming no upstream call occurred.
  it('returns an error body (not a mermaid diagram) when prompt is empty', async () => {
    const result = await callHandler({ prompt: '' });
    expect(result.statusCode).toBe(400);
    expect((result.body as any).mermaid).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input guard: prompt over MAX_PROMPT_LENGTH
// ---------------------------------------------------------------------------

describe('input guard — prompt over MAX_PROMPT_LENGTH', () => {
  it('returns 400 when prompt length exceeds MAX_PROMPT_LENGTH', async () => {
    const overlong = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = await callHandler({ prompt: overlong });
    expect(result.statusCode).toBe(400);
  });

  it('response body contains an error message and the limit value', async () => {
    const overlong = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = await callHandler({ prompt: overlong });
    expect((result.body as any).error).toMatch(/too long/i);
    expect((result.body as any).maxLength).toBe(LIMITS.MAX_PROMPT_LENGTH);
  });

  // Guard must short-circuit before reaching Anthropic: the caller receives a
  // 400 error body without a mermaid field, confirming no upstream call occurred.
  it('returns an error body (not a mermaid diagram) when prompt exceeds MAX_PROMPT_LENGTH', async () => {
    const overlong = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = await callHandler({ prompt: overlong });
    expect(result.statusCode).toBe(400);
    expect((result.body as any).mermaid).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 at exactly one character over the limit', async () => {
    const atPlusOne = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const result = await callHandler({ prompt: atPlusOne });
    expect(result.statusCode).toBe(400);
  });

  it('does NOT return 400 for a prompt at exactly MAX_PROMPT_LENGTH characters', async () => {
    // A prompt at the boundary is not rejected by the new guard — it may still
    // be rejected by a mode-specific cap, but the status will not be 400 from
    // this guard (it would be 413 from the mode cap).
    const atLimit = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH);
    const result = await callHandler({ prompt: atLimit, mode: 'policy' });
    expect(result.statusCode).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Valid in-range prompt passes through to Anthropic
// ---------------------------------------------------------------------------

describe('valid prompt — passes through to Anthropic', () => {
  it('returns 200 for a short describe-mode prompt', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk('flowchart TD\n  A --> B'));
    const result = await callHandler({ prompt: 'Show a resident intake flow', mode: 'describe' });
    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe('flowchart TD\n  A --> B');
  });

  // A valid prompt must reach Anthropic and return its diagram — confirming the
  // guard did not incorrectly reject a well-formed request.
  it('returns the mermaid diagram from Anthropic for a valid prompt', async () => {
    const diagram = 'flowchart TD\n  A[Admit] --> B[Assess]';
    mockFetch.mockResolvedValueOnce(anthropicOk(diagram));
    const result = await callHandler({ prompt: 'Show a med-pass workflow', mode: 'describe' });
    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe(diagram);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // An empty prompt must never produce a diagram — the guard fires and the
  // response carries an error, not mermaid output.
  it('returns an error body without a mermaid field for an empty prompt', async () => {
    const result = await callHandler({ prompt: '' });
    expect(result.statusCode).toBe(400);
    expect((result.body as any).mermaid).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not reject a valid prompt in policy mode', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk('flowchart TD\n  A --> B'));
    const result = await callHandler({
      prompt: 'Staff must log all incidents within 24 hours.',
      mode: 'policy',
    });
    expect(result.statusCode).toBe(200);
  });

  it('returns 200 for a describe-mode prompt at exactly MAX_DESCRIBE_CHARS', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk('flowchart TD\n  A --> B'));
    const atCap = 'a'.repeat(LIMITS.MAX_DESCRIBE_CHARS);
    const result = await callHandler({ prompt: atCap, mode: 'describe' });
    expect(result.statusCode).toBe(200);
  });

  it('returns 200 for a policy-mode prompt at exactly MAX_POLICY_CHARS', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk('flowchart TD\n  A --> B'));
    const atCap = 'a'.repeat(LIMITS.MAX_POLICY_CHARS);
    const result = await callHandler({ prompt: atCap, mode: 'policy' });
    expect(result.statusCode).toBe(200);
  });
});
