export {}; // isolate this file's top-level scope — sibling test files also declare
           // registeredHandlers/mockFetch/_hits/LIMITS at top level with no module marker

const registeredHandlers: Record<string, Function> = {};

jest.mock('@google-cloud/functions-framework', () => ({
  http: (name: string, handler: Function) => {
    registeredHandlers[name] = handler;
  },
}));

let mockAdd: jest.Mock;
let mockGet: jest.Mock;
let mockUpdate: jest.Mock;

jest.mock('@google-cloud/firestore', () => {
  mockAdd    = jest.fn().mockResolvedValue({});
  mockGet    = jest.fn().mockResolvedValue({ empty: true, docs: [] });
  mockUpdate = jest.fn().mockResolvedValue({});

  const mockDoc = jest.fn().mockReturnValue({ update: mockUpdate });

  const mockWhere = jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnValue({ get: mockGet }),
  });

  const mockCollection = jest.fn().mockReturnValue({
    add: mockAdd,
    where: mockWhere,
    doc: mockDoc,
  });

  return {
    Firestore: jest.fn().mockImplementation(() => ({
      collection: mockCollection,
    })),
  };
});

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const { _hits, LIMITS } = require('../index') as {
  _hits: Map<string, { count: number; resetAt: number }>;
  LIMITS: Record<string, number>;
};

function makeReq(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  method = 'POST',
  query: Record<string, string> = {}
) {
  return { method, body, headers, query };
}

function makeGetReq(query: Record<string, string> = {}) {
  return { method: 'GET', body: {}, headers: {}, query };
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

function validLeadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'lead_capture',
    email: 'test@example.com',
    consent: true,
    termsVersion: 'v1.0',
    sourcePage: '/templates/med-pass',
    ...overrides,
  };
}

beforeEach(() => {
  _hits.clear();
  mockFetch.mockReset();
  mockAdd.mockReset();
  mockAdd.mockResolvedValue({});
  mockGet.mockReset();
  mockGet.mockResolvedValue({ empty: true, docs: [] });
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({});
  process.env.LEAD_CAPTURE_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.FUNCTION_URL = 'https://example.run.app/diagram';
  delete process.env.LOG_PROMPTS;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  delete process.env.LEAD_CAPTURE_ENABLED;
  delete process.env.FUNCTION_URL;
});

describe('lead capture — kill switch', () => {
  it('treats the action as an unrecognized request (400 Empty prompt) when LEAD_CAPTURE_ENABLED is unset', async () => {
    delete process.env.LEAD_CAPTURE_ENABLED;
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('treats the action as an unrecognized request (400 Empty prompt) when LEAD_CAPTURE_ENABLED is false', async () => {
    process.env.LEAD_CAPTURE_ENABLED = 'false';
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('treats the action as an unrecognized request (400 Empty prompt) when LEAD_CAPTURE_ENABLED is an arbitrary value', async () => {
    process.env.LEAD_CAPTURE_ENABLED = 'yes';
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/empty prompt/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('disabled response is indistinguishable from any other unrecognized action body', async () => {
    delete process.env.LEAD_CAPTURE_ENABLED;
    const leadResult = await callHandler(makeReq(validLeadBody()));
    const unrecognizedResult = await callHandler(makeReq({ action: 'some_other_action' }));
    expect(leadResult.statusCode).toBe(unrecognizedResult.statusCode);
    expect((leadResult.body as any).error).toBe((unrecognizedResult.body as any).error);
  });

  it('processes the action and writes to Firestore when LEAD_CAPTURE_ENABLED is true', async () => {
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

describe('lead capture — email validation', () => {
  it('returns 400 when email is missing', async () => {
    const result = await callHandler(makeReq(validLeadBody({ email: undefined })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/email/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'empty string',      email: '',           expectation: 'rejects before any write' },
    { label: 'no @ symbol',       email: 'notanemail', expectation: 'rejects before any write' },
    { label: 'no domain after @', email: 'user@',      expectation: 'rejects before any write' },
  ])('returns 400 and does not write when email is invalid ($label)', async ({ email }) => {
    const result = await callHandler(makeReq(validLeadBody({ email })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/email/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('accepts a valid email address', async () => {
    const result = await callHandler(makeReq(validLeadBody({ email: 'nurse@snf.org' })));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
  });
});

describe('lead capture — consent validation', () => {
  it('returns 400 when consent is false', async () => {
    const result = await callHandler(makeReq(validLeadBody({ consent: false })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/consent/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns 400 when consent is the string "true" instead of boolean true', async () => {
    const result = await callHandler(makeReq(validLeadBody({ consent: 'true' })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/consent/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns 400 when consent is missing', async () => {
    const result = await callHandler(makeReq(validLeadBody({ consent: undefined })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/consent/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns 400 when consent is 1 instead of boolean true', async () => {
    const result = await callHandler(makeReq(validLeadBody({ consent: 1 })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/consent/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('accepts consent: true (strict boolean)', async () => {
    const result = await callHandler(makeReq(validLeadBody({ consent: true })));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
  });
});

describe('lead capture — termsVersion validation', () => {
  it('returns 400 when termsVersion is missing', async () => {
    const result = await callHandler(makeReq(validLeadBody({ termsVersion: undefined })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/termsVersion/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns 400 when termsVersion is an empty string', async () => {
    const result = await callHandler(makeReq(validLeadBody({ termsVersion: '' })));
    expect(result.statusCode).toBe(400);
    expect((result.body as any).error).toMatch(/termsVersion/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('accepts a non-empty termsVersion', async () => {
    const result = await callHandler(makeReq(validLeadBody({ termsVersion: 'v2.1' })));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
  });
});

describe('lead capture — successful Firestore write', () => {
  it('writes to the leads collection with status pending and a confirmToken', async () => {
    await callHandler(makeReq(validLeadBody({
      email: 'admin@facility.com',
      termsVersion: 'v1.0',
      interestedWorkflow: 'med-pass',
      sourcePage: '/templates/med-pass',
    })));

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const written = mockAdd.mock.calls[0][0];
    expect(written.status).toBe('pending');
    expect(written.email).toBe('admin@facility.com');
    expect(written.consentTermsVersion).toBe('v1.0');
    expect(written.interestedWorkflow).toBe('med-pass');
    expect(written.sourcePage).toBe('/templates/med-pass');
    expect(typeof written.ipHash).toBe('string');
    expect(written.ipHash).toHaveLength(16);
    expect(written.createdAt).toBeInstanceOf(Date);
    expect(typeof written.confirmToken).toBe('string');
    expect(written.confirmToken.length).toBeGreaterThan(0);
  });

  it('does not include a Firestore document id in the response', async () => {
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(200);
    expect(Object.keys(result.body as any)).toEqual(['received']);
    expect((result.body as any).received).toBe(true);
  });

  it('stores null for optional interestedWorkflow when omitted and responds 200', async () => {
    const body = validLeadBody();
    delete body.interestedWorkflow;
    const result = await callHandler(makeReq(body));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    const written = mockAdd.mock.calls[0][0];
    expect(written.interestedWorkflow).toBeNull();
  });

  it('writes only lead fields (no prompt/mode) and returns 200', async () => {
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    const written = mockAdd.mock.calls[0][0];
    expect(written).not.toHaveProperty('prompt');
    expect(written).not.toHaveProperty('mode');
    expect(written).toHaveProperty('email');
    expect(written).toHaveProperty('status', 'pending');
  });

  it('returns 502 and does not crash when Firestore write fails', async () => {
    mockAdd.mockRejectedValueOnce(new Error('Firestore unavailable'));
    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error).toBeDefined();
  });
});

describe('lead capture — per-IP rate limit', () => {
  it('returns 429 after 3 lead requests from the same IP', async () => {
    const ip = '10.1.2.3';
    const headers = { 'x-forwarded-for': ip };

    for (let i = 0; i < 3; i++) {
      const r = await callHandler(makeReq(validLeadBody(), headers));
      expect(r.statusCode).toBe(200);
    }

    const blocked = await callHandler(makeReq(validLeadBody(), headers));
    expect(blocked.statusCode).toBe(429);
    expect((blocked.body as any).error).toMatch(/rate limited/i);
  });

  it('allows a different IP after the first IP is rate-limited', async () => {
    const ip1 = '10.1.2.3';
    const ip2 = '10.1.2.4';

    for (let i = 0; i < 3; i++) {
      await callHandler(makeReq(validLeadBody(), { 'x-forwarded-for': ip1 }));
    }
    const blocked = await callHandler(makeReq(validLeadBody(), { 'x-forwarded-for': ip1 }));
    expect(blocked.statusCode).toBe(429);

    const allowed = await callHandler(makeReq(validLeadBody(), { 'x-forwarded-for': ip2 }));
    expect(allowed.statusCode).toBe(200);
  });

  it('returns 503 when the global lead daily cap is exhausted', async () => {
    const day = new Date().toISOString().slice(0, 10);
    _hits.set(`lg:${day}`, { count: LIMITS.LEAD_GLOBAL_PER_DAY, resetAt: Date.now() + 86_400_000 });

    const result = await callHandler(makeReq(validLeadBody()));
    expect(result.statusCode).toBe(503);
    expect((result.body as any).error).toMatch(/daily limit/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('lead capture — does not interfere with diagram generation', () => {
  it('a normal diagram request still succeeds when lead capture is enabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'flowchart TD\n  A --> B' }], usage: {} }),
      text: async () => '',
    });

    const result = await callHandler(makeReq({
      prompt: 'Show a resident intake workflow',
      type: 'flowchart',
      mode: 'describe',
    }));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).mermaid).toBe('flowchart TD\n  A --> B');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('lead rate-limit keys are distinct from diagram rate-limit keys', async () => {
    const ip = '10.5.5.5';
    const headers = { 'x-forwarded-for': ip };

    for (let i = 0; i < 3; i++) {
      await callHandler(makeReq(validLeadBody(), headers));
    }
    const leadBlocked = await callHandler(makeReq(validLeadBody(), headers));
    expect(leadBlocked.statusCode).toBe(429);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'flowchart TD\n  A --> B' }], usage: {} }),
      text: async () => '',
    });
    const diagramResult = await callHandler(makeReq(
      { prompt: 'intake workflow', type: 'flowchart', mode: 'describe' },
      headers
    ));
    expect(diagramResult.statusCode).toBe(200);
  });
});

describe('lead capture — Resend confirmation email', () => {
  it('sends a Resend call with the confirmToken embedded in the link after a successful write', async () => {
    process.env.RESEND_API_KEY = 'resend-test-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    });

    const result = await callHandler(makeReq(validLeadBody({ email: 'nurse@snf.org' })));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);

    const writtenToken = mockAdd.mock.calls[0][0].confirmToken as string;
    expect(typeof writtenToken).toBe('string');
    expect(writtenToken.length).toBeGreaterThan(0);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, fetchOpts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(fetchOpts.headers['Authorization']).toBe('Bearer resend-test-key');

    const emailBody = JSON.parse(fetchOpts.body);
    expect(emailBody.to).toBe('nurse@snf.org');
    expect(emailBody.html).toContain(`action=lead_confirm&token=${writtenToken}`);
  });

  it('returns 200 to the submitter even when the Resend call throws', async () => {
    process.env.RESEND_API_KEY = 'resend-test-key';
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await callHandler(makeReq(validLeadBody()));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('returns 200 to the submitter when the Resend API responds with a non-ok status', async () => {
    process.env.RESEND_API_KEY = 'resend-test-key';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable Entity',
    });

    const result = await callHandler(makeReq(validLeadBody()));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('does not call Resend when RESEND_API_KEY is absent', async () => {
    delete process.env.RESEND_API_KEY;

    const result = await callHandler(makeReq(validLeadBody()));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).received).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('lead confirm — GET path kill switch', () => {
  it('returns 405 for a GET with lead_confirm action when LEAD_CAPTURE_ENABLED is unset', async () => {
    delete process.env.LEAD_CAPTURE_ENABLED;
    const withFlag = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'abc' }));
    const withoutFlag = await callHandler(makeGetReq());
    expect(withFlag.statusCode).toBe(withoutFlag.statusCode);
    expect(withFlag.body).toEqual(withoutFlag.body);
  });

  it('returns 405 for a GET with lead_confirm action when LEAD_CAPTURE_ENABLED is false', async () => {
    process.env.LEAD_CAPTURE_ENABLED = 'false';
    const withAction = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'abc' }));
    const plainGet = await callHandler(makeGetReq());
    expect(withAction.statusCode).toBe(405);
    expect(withAction.statusCode).toBe(plainGet.statusCode);
  });

  it('returns 405 for a plain GET (no query params) when LEAD_CAPTURE_ENABLED is true', async () => {
    const result = await callHandler(makeGetReq());
    expect(result.statusCode).toBe(405);
  });
});

describe('lead confirm — pending to confirmed', () => {
  it('flips status to confirmed, clears confirmToken, and responds 200 for a pending lead', async () => {
    const token = 'valid-pending-token';
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'lead-doc-1', data: () => ({ status: 'pending', confirmToken: token }) }],
    });

    const result = await callHandler(makeGetReq({ action: 'lead_confirm', token }));

    expect(result.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg.status).toBe('confirmed');
    expect(updateArg.confirmToken).toBeNull();
  });

  it('responds 200 and does not write again when the lead is already confirmed (idempotent)', async () => {
    const token = 'already-confirmed-token';
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'lead-doc-2', data: () => ({ status: 'confirmed', confirmToken: null }) }],
    });

    const result = await callHandler(makeGetReq({ action: 'lead_confirm', token }));

    expect(result.statusCode).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('lead confirm — invalid / missing token', () => {
  it('responds 400 with a generic message when no document matches the token', async () => {
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

    const result = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'nonexistent-token' }));

    expect(result.statusCode).toBe(400);
    expect(typeof result.body).toBe('string');
    expect((result.body as string).length).toBeGreaterThan(0);
  });

  it('responds with the same 400 message whether the token never existed or was already cleared', async () => {
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const neverExisted = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'ghost-token' }));

    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const alreadyCleared = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'cleared-token' }));

    expect(neverExisted.statusCode).toBe(400);
    expect(alreadyCleared.statusCode).toBe(400);
    expect(neverExisted.body).toBe(alreadyCleared.body);
  });
});

describe('lead confirm — Firestore errors', () => {
  it('responds 502 when the Firestore query throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Firestore down'));

    const result = await callHandler(makeGetReq({ action: 'lead_confirm', token: 'some-token' }));

    expect(result.statusCode).toBe(502);
  });

  it('responds 502 when the Firestore update throws', async () => {
    const token = 'update-fail-token';
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'lead-doc-3', data: () => ({ status: 'pending', confirmToken: token }) }],
    });
    mockUpdate.mockRejectedValueOnce(new Error('Update failed'));

    const result = await callHandler(makeGetReq({ action: 'lead_confirm', token }));

    expect(result.statusCode).toBe(502);
  });
});
