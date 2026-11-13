/**
 * Ported usage-intel tests (from usageIntel.test.ts). The handler is now a
 * single aggregation behind LogStore.usageIntel; the in-memory store
 * implements the same newest-500 aggregation, and assertions inspect its rows.
 * Auth uses the body key `insightsKey` against the `insightsPassword` dep.
 */
import request from 'supertest';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/util';
import { MemoryLogStore } from '../src/stores/memoryStore';
import { LogEvent } from '../src/stores/types';

const KEY = 'super-secret-insights';

function makeApp() {
  const limiter = new RateLimiter();
  const logStore = new MemoryLogStore();
  const app = createApp({ logStore, insightsPassword: KEY }, limiter);
  return { app, logStore };
}

function evt(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: new Date(),
    mode: 'describe',
    type: 'flowchart',
    prompt: 'p',
    prompt_chars: 1,
    ip_hash: 'aaa',
    referer: '',
    template_id: null,
    success: true,
    ...overrides,
  };
}

async function intel(app: ReturnType<typeof createApp>) {
  return request(app).post('/').send({ action: 'usage_intel', insightsKey: KEY });
}

describe('usage intel — auth rejection', () => {
  it('returns 401 when insightsKey is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ action: 'usage_intel' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 when insightsKey is wrong', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ action: 'usage_intel', insightsKey: 'wrong-key' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 with the same generic message for a missing vs wrong key', async () => {
    const { app } = makeApp();
    const missing = await request(app).post('/').send({ action: 'usage_intel' });
    const wrong = await request(app)
      .post('/')
      .send({ action: 'usage_intel', insightsKey: 'bad' });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body.error).toBe(wrong.body.error);
  });

  it('returns 401 when no insights password is configured (no default backdoor)', async () => {
    const limiter = new RateLimiter();
    const app = createApp({ insightsPassword: '' }, limiter);
    const res = await request(app)
      .post('/')
      .send({ action: 'usage_intel', insightsKey: KEY });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });
});

describe('usage intel — bounded aggregation', () => {
  it('returns 200 with the aggregate shape for an authorized request', async () => {
    const { app, logStore } = makeApp();
    await logStore.log(evt({ type: 'flowchart', mode: 'describe' }));
    await logStore.log(
      evt({ type: 'sequence', mode: 'policy', success: false, error: 'upstream_500' })
    );

    const res = await intel(app);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalFetched');
    expect(res.body).toHaveProperty('successRate');
    expect(res.body).toHaveProperty('byType');
    expect(res.body).toHaveProperty('byMode');
    expect(res.body).toHaveProperty('byTemplateId');
    expect(res.body).toHaveProperty('byReferrer');
    expect(res.body).toHaveProperty('dailyVolume');
  });

  it('totalFetched equals the number of log rows', async () => {
    const { app, logStore } = makeApp();
    for (let i = 0; i < 5; i++) {
      await logStore.log(evt({ prompt: `p${i}` }));
    }
    const res = await intel(app);
    expect(res.status).toBe(200);
    expect(res.body.totalFetched).toBe(5);
  });

  it('aggregates over only the newest 500 records', async () => {
    const { app, logStore } = makeApp();
    // 505 rows, each ~1 minute apart going back in time.
    const now = Date.now();
    for (let i = 0; i < 505; i++) {
      await logStore.log(evt({ ts: new Date(now - i * 60_000), prompt: `p${i}` }));
    }
    const res = await intel(app);
    expect(res.status).toBe(200);
    expect(res.body.totalFetched).toBe(500);
  });

  it('successRate is computed correctly (3 of 4 succeeded)', async () => {
    const { app, logStore } = makeApp();
    for (let i = 0; i < 3; i++) await logStore.log(evt({ success: true }));
    await logStore.log(evt({ success: false, error: 'timeout' }));
    const res = await intel(app);
    expect(res.status).toBe(200);
    expect(res.body.successRate).toBeCloseTo(3 / 4);
  });

  it('successRate is 0 (not NaN) when there are no rows', async () => {
    const { app } = makeApp();
    const res = await intel(app);
    expect(res.status).toBe(200);
    expect(res.body.totalFetched).toBe(0);
    expect(res.body.successRate).toBe(0);
  });
});

describe('usage intel — breakdowns from logged rows', () => {
  it('byType counts each diagram type', async () => {
    const { app, logStore } = makeApp();
    for (let i = 0; i < 3; i++) await logStore.log(evt({ type: 'flowchart' }));
    for (let i = 0; i < 2; i++) await logStore.log(evt({ type: 'sequence' }));
    const res = await intel(app);
    expect(res.body.byType).toEqual({ flowchart: 3, sequence: 2 });
  });

  it('byMode counts each mode', async () => {
    const { app, logStore } = makeApp();
    for (let i = 0; i < 3; i++) await logStore.log(evt({ mode: 'describe' }));
    for (let i = 0; i < 2; i++) await logStore.log(evt({ mode: 'policy' }));
    const res = await intel(app);
    expect(res.body.byMode).toEqual({ describe: 3, policy: 2 });
  });

  it('byTemplateId includes only non-null template_id values with correct counts', async () => {
    const { app, logStore } = makeApp();
    await logStore.log(evt({ template_id: 'med-pass' }));
    await logStore.log(evt({ template_id: 'med-pass' }));
    await logStore.log(evt({ template_id: 'fall-response' }));
    await logStore.log(evt({ template_id: null }));
    const res = await intel(app);
    expect(res.body.byTemplateId).toEqual({ 'med-pass': 2, 'fall-response': 1 });
  });

  it('byReferrer counts distinct referers and caps at 10 entries', async () => {
    const { app, logStore } = makeApp();
    await logStore.log(evt({ referer: 'https://snf.org' }));
    await logStore.log(evt({ referer: 'https://snf.org' }));
    await logStore.log(evt({ referer: 'https://other.com' }));
    for (let i = 0; i < 12; i++) {
      await logStore.log(evt({ referer: `https://site${i}.com` }));
    }
    const res = await intel(app);
    expect(Object.keys(res.body.byReferrer).length).toBeLessThanOrEqual(10);
    expect(res.body.byReferrer['https://snf.org']).toBe(2);
  });

  it('dailyVolume maps YYYY-MM-DD dates to correct counts across days', async () => {
    const { app, logStore } = makeApp();
    await logStore.log(evt({ ts: new Date('2024-03-15T10:00:00Z') }));
    await logStore.log(evt({ ts: new Date('2024-03-15T11:00:00Z') }));
    await logStore.log(evt({ ts: new Date('2024-03-16T09:00:00Z') }));
    const res = await intel(app);
    expect(res.body.dailyVolume['2024-03-15']).toBe(2);
    expect(res.body.dailyVolume['2024-03-16']).toBe(1);
    expect(Object.keys(res.body.dailyVolume)).toHaveLength(2);
  });
});

describe('usage intel — store failures', () => {
  it('returns 502 and does not crash when the aggregation throws', async () => {
    const limiter = new RateLimiter();
    const failingStore = {
      log: async () => {},
      usageIntel: jest.fn().mockRejectedValue(new Error('DB unavailable')),
    };
    const app = createApp({ logStore: failingStore as any, insightsPassword: KEY }, limiter);
    const res = await request(app)
      .post('/')
      .send({ action: 'usage_intel', insightsKey: KEY });
    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });
});

describe('usage intel — diagram generation logging', () => {
  it('logs template_id from the request when provided', async () => {
    const { app, logStore } = makeApp();
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
  });

  it('logs template_id: null when templateId is absent, with usage counts', async () => {
    const { app, logStore } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show an admission workflow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(logStore.rows[0].template_id).toBeNull();
    expect(logStore.rows[0].usage_in).toBeGreaterThan(0);
    expect(logStore.rows[0].usage_out).toBeGreaterThan(0);
    // Success rows carry no error (the field may be omitted entirely).
    expect(logStore.rows[0].error ?? null).toBeNull();
  });

  it('never stores the raw IP (ip_hash only, 16 hex chars)', async () => {
    const { app, logStore } = makeApp();
    await request(app)
      .post('/')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ prompt: 'intake workflow' });
    const row = logStore.rows[0];
    expect(row.ip_hash).toHaveLength(16);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
  });
});
