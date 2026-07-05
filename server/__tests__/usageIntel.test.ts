export {};

const registeredHandlers: Record<string, Function> = {};

jest.mock('@google-cloud/functions-framework', () => ({
  http: (name: string, handler: Function) => {
    registeredHandlers[name] = handler;
  },
}));

let mockAdd: jest.Mock;
let mockGet: jest.Mock;
let mockLimit: jest.Mock;
let mockOrderBy: jest.Mock;

jest.mock('@google-cloud/firestore', () => {
  mockAdd     = jest.fn().mockResolvedValue({});
  mockGet     = jest.fn().mockResolvedValue({ docs: [] });
  mockLimit   = jest.fn().mockReturnValue({ get: () => mockGet() });
  mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });

  const mockWhere = jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }),
  });

  const mockUpdate = jest.fn().mockResolvedValue({});
  const mockDoc    = jest.fn().mockReturnValue({ update: mockUpdate });

  const mockCollection = jest.fn().mockReturnValue({
    add:     mockAdd,
    where:   mockWhere,
    doc:     mockDoc,
    orderBy: mockOrderBy,
  });

  return {
    Firestore: jest.fn().mockImplementation(() => ({
      collection: mockCollection,
    })),
  };
});

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const { _hits } = require('../index') as {
  _hits: Map<string, { count: number; resetAt: number }>;
};

function makeReq(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  method = 'POST'
) {
  return { method, body, headers, query: {} };
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

function makeTimestamp(isoDate: string) {
  const d = new Date(isoDate);
  return { toDate: () => d };
}

function makeDiagramDoc(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'describe',
    type: 'flowchart',
    success: true,
    referer: 'https://example.com',
    template_id: null,
    timestamp: makeTimestamp('2024-03-15T10:00:00Z'),
    ...overrides,
  };
}

const FIXTURE_DOCS = [
  makeDiagramDoc({ type: 'flowchart', mode: 'describe', success: true,  template_id: 'med-pass',      referer: 'https://snf.org',   timestamp: makeTimestamp('2024-03-15T10:00:00Z') }),
  makeDiagramDoc({ type: 'flowchart', mode: 'describe', success: true,  template_id: 'med-pass',      referer: 'https://snf.org',   timestamp: makeTimestamp('2024-03-15T11:00:00Z') }),
  makeDiagramDoc({ type: 'sequence',  mode: 'policy',   success: false, template_id: null,            referer: 'https://snf.org',   timestamp: makeTimestamp('2024-03-15T12:00:00Z') }),
  makeDiagramDoc({ type: 'flowchart', mode: 'describe', success: true,  template_id: 'fall-response', referer: 'https://other.com', timestamp: makeTimestamp('2024-03-16T09:00:00Z') }),
  makeDiagramDoc({ type: 'sequence',  mode: 'policy',   success: true,  template_id: null,            referer: 'https://other.com', timestamp: makeTimestamp('2024-03-16T10:00:00Z') }),
];

const VALID_INSIGHTS_KEY = 'super-secret-insights';

beforeEach(() => {
  _hits.clear();
  mockFetch.mockReset();
  mockAdd.mockReset();
  mockAdd.mockResolvedValue({});
  mockGet.mockReset();
  mockGet.mockResolvedValue({ docs: [] });
  mockOrderBy.mockClear();
  mockLimit.mockClear();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.INSIGHTS_PASSWORD = VALID_INSIGHTS_KEY;
  delete process.env.LOG_PROMPTS;
  delete process.env.LEAD_CAPTURE_ENABLED;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  delete process.env.INSIGHTS_PASSWORD;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('usage_intel — auth rejection', () => {
  it('returns 401 and does not query Firestore when insightsKey is missing', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel' }));
    expect(result.statusCode).toBe(401);
    expect(mockOrderBy).not.toHaveBeenCalled();
  });

  it('returns 401 and does not query Firestore when insightsKey is wrong', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: 'wrong-key' }));
    expect(result.statusCode).toBe(401);
    expect(mockOrderBy).not.toHaveBeenCalled();
  });

  it('returns 401 with the same generic message for a missing vs wrong key', async () => {
    const missing = await callHandler(makeReq({ action: 'usage_intel' }));
    const wrong   = await callHandler(makeReq({ action: 'usage_intel', insightsKey: 'bad' }));
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect((missing.body as any).error).toBe((wrong.body as any).error);
  });

  it('returns 401 and does not query Firestore when INSIGHTS_PASSWORD env var is unset', async () => {
    delete process.env.INSIGHTS_PASSWORD;
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    expect(result.statusCode).toBe(401);
    expect((result.body as any).error).toBeDefined();
    expect(mockOrderBy).not.toHaveBeenCalled();
  });

  it('returns the same 401 message whether INSIGHTS_PASSWORD is unset or the key is just wrong', async () => {
    delete process.env.INSIGHTS_PASSWORD;
    const unset = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));

    process.env.INSIGHTS_PASSWORD = VALID_INSIGHTS_KEY;
    const wrong = await callHandler(makeReq({ action: 'usage_intel', insightsKey: 'not-the-right-key' }));

    expect(unset.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect((unset.body as any).error).toBe((wrong.body as any).error);
  });
});

describe('usage_intel — bounded query chain', () => {
  it('reads only the most recent 500 docs and reflects that count in totalFetched', async () => {
    const fiveDocs = Array.from({ length: 5 }, (_, i) =>
      ({ data: () => makeDiagramDoc({ timestamp: makeTimestamp(`2024-03-${String(i + 1).padStart(2, '0')}T10:00:00Z`) }) })
    );
    mockGet.mockResolvedValueOnce({ docs: fiveDocs });

    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));

    expect(result.statusCode).toBe(200);
    expect((result.body as any).totalFetched).toBe(5);
    expect(mockOrderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(500);
  });
});

describe('usage_intel — correct aggregation from fixture docs', () => {
  beforeEach(() => {
    mockGet.mockResolvedValueOnce({
      docs: FIXTURE_DOCS.map(d => ({ data: () => d })),
    });
  });

  it('returns 200 with the aggregate shape', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    expect(result.statusCode).toBe(200);
    const body = result.body as any;
    expect(body).toHaveProperty('totalFetched');
    expect(body).toHaveProperty('successRate');
    expect(body).toHaveProperty('byType');
    expect(body).toHaveProperty('byMode');
    expect(body).toHaveProperty('byTemplateId');
    expect(body).toHaveProperty('byReferrer');
    expect(body).toHaveProperty('dailyVolume');
  });

  it('totalFetched equals the number of fixture docs', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    expect((result.body as any).totalFetched).toBe(5);
  });

  it('successRate is computed correctly (4 of 5 docs succeeded)', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    expect((result.body as any).successRate).toBeCloseTo(4 / 5);
  });

  it('byType counts each type value correctly', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const byType = (result.body as any).byType;
    expect(byType.flowchart).toBe(3);
    expect(byType.sequence).toBe(2);
  });

  it('byMode counts each mode value correctly', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const byMode = (result.body as any).byMode;
    expect(byMode.describe).toBe(3);
    expect(byMode.policy).toBe(2);
  });

  it('byTemplateId includes only non-null template_id values with correct counts', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const byTemplateId = (result.body as any).byTemplateId;
    expect(byTemplateId['med-pass']).toBe(2);
    expect(byTemplateId['fall-response']).toBe(1);
    expect(Object.keys(byTemplateId)).not.toContain('null');
    expect(Object.keys(byTemplateId)).toHaveLength(2);
  });

  it('byReferrer counts distinct referer values', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const byReferrer = (result.body as any).byReferrer;
    expect(byReferrer['https://snf.org']).toBe(3);
    expect(byReferrer['https://other.com']).toBe(2);
  });

  it('dailyVolume maps YYYY-MM-DD dates to correct counts across two different days', async () => {
    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const dailyVolume = (result.body as any).dailyVolume;
    expect(dailyVolume['2024-03-15']).toBe(3);
    expect(dailyVolume['2024-03-16']).toBe(2);
    expect(Object.keys(dailyVolume)).toHaveLength(2);
  });
});

describe('usage_intel — byReferrer cap at top 10', () => {
  it('caps byReferrer to at most 10 entries when there are more than 10 distinct referrers', async () => {
    const manyRefererDocs = Array.from({ length: 15 }, (_, i) =>
      ({ data: () => makeDiagramDoc({ referer: `https://site${i}.com`, timestamp: makeTimestamp('2024-03-15T10:00:00Z') }) })
    );
    mockGet.mockResolvedValueOnce({ docs: manyRefererDocs });

    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    const byReferrer = (result.body as any).byReferrer;
    expect(Object.keys(byReferrer).length).toBeLessThanOrEqual(10);
  });
});

describe('usage_intel — Firestore query failure', () => {
  it('returns 502 and does not crash when the Firestore query throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const result = await callHandler(makeReq({ action: 'usage_intel', insightsKey: VALID_INSIGHTS_KEY }));
    expect(result.statusCode).toBe(502);
    expect((result.body as any).error).toBeDefined();
  });
});

describe('diagram generation — templateId logging', () => {
  function anthropicOk(text = 'flowchart TD\n  A --> B') {
    return {
      ok: true,
      json: async () => ({ content: [{ text }], usage: { input_tokens: 10, output_tokens: 20 } }),
      text: async () => '',
    };
  }

  it('includes template_id in the diagram_logs write when templateId is provided in the request', async () => {
    process.env.LOG_PROMPTS = 'true';
    mockFetch.mockResolvedValueOnce(anthropicOk());

    const result = await callHandler(makeReq({
      prompt: 'Show a med-pass workflow',
      type: 'flowchart',
      mode: 'describe',
      templateId: 'med-pass',
    }));

    expect(result.statusCode).toBe(200);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const logged = mockAdd.mock.calls[0][0];
    expect(logged.template_id).toBe('med-pass');
  });

  it('logs template_id: null when templateId is absent from the request', async () => {
    process.env.LOG_PROMPTS = 'true';
    mockFetch.mockResolvedValueOnce(anthropicOk());

    const result = await callHandler(makeReq({
      prompt: 'Show an admission workflow',
      type: 'flowchart',
      mode: 'describe',
    }));

    expect(result.statusCode).toBe(200);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const logged = mockAdd.mock.calls[0][0];
    expect(logged.template_id).toBeNull();
  });
});
