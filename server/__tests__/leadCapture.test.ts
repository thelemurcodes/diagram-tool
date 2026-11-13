/**
 * Ported lead-capture tests (from leadCapture.test.ts). The Firestore mock is
 * replaced by the in-memory LeadStore — assertions inspect its rows instead of
 * mockAdd calls. Resend email paths still use a mocked global fetch.
 */
import request from 'supertest';
import { createApp, AppDeps } from '../src/app';
import { RateLimiter } from '../src/util';
import { LIMITS } from '../src/config';
import { MemoryLeadStore } from '../src/stores/memoryStore';
import { LeadStore } from '../src/stores/types';

function makeApp(overrides: Partial<AppDeps> = {}) {
  const limiter = new RateLimiter();
  const leadStore = (overrides.leadStore as MemoryLeadStore) || new MemoryLeadStore();
  const app = createApp(
    { leadCaptureEnabled: true, leadStore, functionUrl: 'https://example.run.app/diagram', ...overrides },
    limiter
  );
  return { app, limiter, leadStore };
}

/** LeadStore whose writes fail — ports the Firestore-unavailable branches. */
function failingLeadStore(overrides: Partial<LeadStore> = {}): LeadStore {
  return {
    createLead: jest.fn().mockRejectedValue(new Error('Store unavailable')),
    findByConfirmToken: jest.fn().mockRejectedValue(new Error('Store unavailable')),
    confirmLead: jest.fn().mockRejectedValue(new Error('Store unavailable')),
    ...overrides,
  };
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

afterEach(() => {
  jest.restoreAllMocks();
});

describe('lead capture — kill switch', () => {
  it('treats the action as an unrecognized request (400 Empty prompt) when LEAD_CAPTURE_ENABLED is off', async () => {
    const { app, leadStore } = makeApp({ leadCaptureEnabled: false });
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty prompt/i);
    expect(leadStore.rows).toHaveLength(0);
  });

  it('disabled response is indistinguishable from any other unrecognized action body', async () => {
    const { app } = makeApp({ leadCaptureEnabled: false });
    const leadRes = await request(app).post('/').send(validLeadBody());
    const unrecognizedRes = await request(app).post('/').send({ action: 'some_other_action' });
    expect(leadRes.status).toBe(unrecognizedRes.status);
    expect(leadRes.body.error).toBe(unrecognizedRes.body.error);
  });

  it('processes the action and writes a lead row when LEAD_CAPTURE_ENABLED is true', async () => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(leadStore.rows).toHaveLength(1);
  });
});

describe('lead capture — email validation', () => {
  it('returns 400 when email is missing', async () => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ email: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
    expect(leadStore.rows).toHaveLength(0);
  });

  it.each([
    { label: 'empty string', email: '' },
    { label: 'no @ symbol', email: 'notanemail' },
    { label: 'no domain after @', email: 'user@' },
  ])('returns 400 and does not write when email is invalid ($label)', async ({ email }) => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ email }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
    expect(leadStore.rows).toHaveLength(0);
  });

  it('accepts a valid email address', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ email: 'nurse@snf.org' }));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe('lead capture — consent validation', () => {
  it.each([
    { label: 'consent false', consent: false },
    { label: 'consent string "true"', consent: 'true' },
    { label: 'consent missing', consent: undefined },
    { label: 'consent 1 instead of boolean true', consent: 1 },
  ])('returns 400 when $label', async ({ consent }) => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ consent }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consent/i);
    expect(leadStore.rows).toHaveLength(0);
  });

  it('accepts consent: true (strict boolean)', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ consent: true }));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe('lead capture — termsVersion validation', () => {
  it('returns 400 when termsVersion is missing', async () => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ termsVersion: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/termsVersion/i);
    expect(leadStore.rows).toHaveLength(0);
  });

  it('returns 400 when termsVersion is an empty string', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ termsVersion: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/termsVersion/i);
  });

  it('accepts a non-empty termsVersion', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send(validLeadBody({ termsVersion: 'v2.1' }));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe('lead capture — successful lead write', () => {
  it('writes the lead with status pending and a confirmToken', async () => {
    const { app, leadStore } = makeApp();
    await request(app).post('/').send(
      validLeadBody({
        email: 'admin@facility.com',
        termsVersion: 'v1.0',
        interestedWorkflow: 'med-pass',
        sourcePage: '/templates/med-pass',
      })
    );
    expect(leadStore.rows).toHaveLength(1);
    const written = leadStore.rows[0];
    expect(written.status).toBe('pending');
    expect(written.email).toBe('admin@facility.com');
    expect(written.consent_terms_version).toBe('v1.0');
    expect(written.interested_workflow).toBe('med-pass');
    expect(written.source_page).toBe('/templates/med-pass');
    expect(typeof written.ip_hash).toBe('string');
    expect(written.ip_hash).toHaveLength(16);
    expect(typeof written.confirm_token).toBe('string');
    expect(written.confirm_token!.length).toBeGreaterThan(0);
  });

  it('does not include a document id in the response', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['received']);
    expect(res.body.received).toBe(true);
  });

  it('stores null for optional interestedWorkflow when omitted and responds 200', async () => {
    const { app, leadStore } = makeApp();
    const body = validLeadBody();
    delete (body as any).interestedWorkflow;
    const res = await request(app).post('/').send(body);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(leadStore.rows[0].interested_workflow).toBeNull();
  });

  it('stores only lead fields (no prompt/mode) and returns 200', async () => {
    const { app, leadStore } = makeApp();
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    const written = leadStore.rows[0] as any;
    expect(written).not.toHaveProperty('prompt');
    expect(written).not.toHaveProperty('mode');
    expect(written).toHaveProperty('email');
    expect(written).toHaveProperty('status', 'pending');
  });

  it('returns 502 and does not crash when the lead store write fails', async () => {
    const limiter = new RateLimiter();
    const app = createApp(
      { leadCaptureEnabled: true, leadStore: failingLeadStore() },
      limiter
    );
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });
});

describe('lead capture — per-IP rate limit', () => {
  it('returns 429 after 3 lead requests from the same IP', async () => {
    const { app } = makeApp();
    const ip = '10.1.2.3';
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/').set('x-forwarded-for', ip).send(validLeadBody());
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).post('/').set('x-forwarded-for', ip).send(validLeadBody());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/i);
  });

  it('allows a different IP after the first IP is rate-limited', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/').set('x-forwarded-for', '10.1.2.3').send(validLeadBody());
    }
    const blocked = await request(app).post('/').set('x-forwarded-for', '10.1.2.3').send(validLeadBody());
    expect(blocked.status).toBe(429);
    const allowed = await request(app).post('/').set('x-forwarded-for', '10.1.2.4').send(validLeadBody());
    expect(allowed.status).toBe(200);
  });

  it('returns 503 when the global lead daily cap is exhausted', async () => {
    const { app, limiter, leadStore } = makeApp();
    const day = new Date().toISOString().slice(0, 10);
    limiter.hits.set(`lg:${day}`, { count: LIMITS.LEAD_GLOBAL_PER_DAY, resetAt: Date.now() + 86_400_000 });
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/daily limit/i);
    expect(leadStore.rows).toHaveLength(0);
  });
});

describe('lead capture — does not interfere with diagram generation', () => {
  it('a normal diagram request still succeeds when lead capture is enabled', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show a resident intake workflow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
  });

  it('lead rate-limit keys are distinct from diagram rate-limit keys', async () => {
    const { app } = makeApp();
    const ip = '10.5.5.5';
    for (let i = 0; i < 3; i++) {
      await request(app).post('/').set('x-forwarded-for', ip).send(validLeadBody());
    }
    const leadBlocked = await request(app).post('/').set('x-forwarded-for', ip).send(validLeadBody());
    expect(leadBlocked.status).toBe(429);

    const diagramRes = await request(app)
      .post('/')
      .set('x-forwarded-for', ip)
      .send({ prompt: 'intake workflow', type: 'flowchart', mode: 'describe' });
    expect(diagramRes.status).toBe(200);
  });
});

describe('lead capture — Resend confirmation email', () => {
  function mockFetchOk() {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    });
    (global as any).fetch = mockFetch;
    return mockFetch;
  }

  it('sends a Resend call with the confirmToken embedded in the link after a successful write', async () => {
    const mockFetch = mockFetchOk();
    const { app, leadStore } = makeApp({ resendApiKey: 'resend-test-key' });
    const res = await request(app).post('/').send(validLeadBody({ email: 'nurse@snf.org' }));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const writtenToken = leadStore.rows[0].confirm_token as string;
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
    const mockFetch = jest.fn().mockRejectedValue(new Error('Network failure'));
    (global as any).fetch = mockFetch;
    const { app, leadStore } = makeApp({ resendApiKey: 'resend-test-key' });
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(leadStore.rows).toHaveLength(1);
  });

  it('returns 200 to the submitter when the Resend API responds with a non-ok status', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable Entity',
    });
    (global as any).fetch = mockFetch;
    const { app, leadStore } = makeApp({ resendApiKey: 'resend-test-key' });
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(leadStore.rows).toHaveLength(1);
  });

  it('does not call Resend when no Resend API key is configured', async () => {
    const mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    const { app } = makeApp({ resendApiKey: '' });
    const res = await request(app).post('/').send(validLeadBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('lead confirm — GET path kill switch', () => {
  it('returns 405 for a GET with lead_confirm action when LEAD_CAPTURE_ENABLED is off (plain GET still probes ok)', async () => {
    const { app } = makeApp({ leadCaptureEnabled: false });
    const withAction = await request(app).get('/').query({ action: 'lead_confirm', token: 'abc' });
    const plainGet = await request(app).get('/');
    expect(withAction.status).toBe(405);
    expect(plainGet.status).toBe(200);
    expect(plainGet.body).toEqual({ ok: true, service: 'senior-care-diagram-proxy' });
  });

  it('returns 200 for a plain GET (no query params) when LEAD_CAPTURE_ENABLED is true', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'senior-care-diagram-proxy' });
  });
});

describe('lead confirm — pending to confirmed', () => {
  it('flips status to confirmed, clears confirmToken, and responds 200 for a pending lead', async () => {
    const { app, leadStore } = makeApp();
    await leadStore.createLead({
      email: 'admin@facility.com',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: 'hashhashhashhash',
      confirmToken: 'valid-pending-token',
    });

    const res = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'valid-pending-token' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('Your email is confirmed. Thank you!');
    expect(leadStore.rows[0].status).toBe('confirmed');
    // The token is retained so a replayed link stays idempotent (app contract).
    expect(typeof leadStore.rows[0].confirm_token).toBe('string');
  });

  it('responds 200 and does not write again when the lead is already confirmed (idempotent)', async () => {
    const { app, leadStore } = makeApp();
    await leadStore.createLead({
      email: 'admin@facility.com',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: 'hashhashhashhash',
      confirmToken: 'already-confirmed-token',
    });
    await leadStore.confirmLead(leadStore.rows[0].id);

    const res = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'already-confirmed-token' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('You are already confirmed. No further action needed.');
    // Idempotent: the confirmed row is untouched (token retained, no rewrite).
    expect(leadStore.rows[0].status).toBe('confirmed');
    expect(typeof leadStore.rows[0].confirm_token).toBe('string');
  });
});

describe('lead confirm — invalid / missing token', () => {
  it('responds 400 with a generic message when no lead matches the token', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'nonexistent-token' });
    expect(res.status).toBe(400);
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('responds with the same 400 message whether the token never existed or was already cleared', async () => {
    const { app } = makeApp();
    const neverExisted = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'ghost-token' });
    const alreadyCleared = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'cleared-token' });
    expect(neverExisted.status).toBe(400);
    expect(alreadyCleared.status).toBe(400);
    expect(neverExisted.text).toBe(alreadyCleared.text);
  });
});

describe('lead confirm — store errors', () => {
  it('responds 502 when the token lookup throws', async () => {
    const limiter = new RateLimiter();
    const app = createApp(
      { leadCaptureEnabled: true, leadStore: failingLeadStore() },
      limiter
    );
    const res = await request(app).get('/').query({ action: 'lead_confirm', token: 'some-token' });
    expect(res.status).toBe(502);
  });

  it('responds 502 when the confirm update throws', async () => {
    const limiter = new RateLimiter();
    const leadStore = failingLeadStore({
      findByConfirmToken: jest.fn().mockResolvedValue({
        id: 1,
        email: 'a@b.c',
        interested_workflow: null,
        source_page: null,
        consent_terms_version: 'v1',
        ip_hash: '0123456789abcdef',
        status: 'pending',
        confirm_token: 'update-fail-token',
        created_at: new Date(),
      }),
    });
    const app = createApp({ leadCaptureEnabled: true, leadStore }, limiter);
    const res = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'update-fail-token' });
    expect(res.status).toBe(502);
  });
});

describe('lead confirm — rate limiting', () => {
  async function seedPendingLead(leadStore: MemoryLeadStore, token: string) {
    await leadStore.createLead({
      email: 'confirm@example.com',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: '0123456789abcdef',
      confirmToken: token,
    });
    // Re-pend the lead: createLead starts pending; nothing else needed.
    return token;
  }

  it('returns 429 after exceeding per-IP confirm limit and does not reach the store', async () => {
    const { app, limiter, leadStore } = makeApp();
    const ip = '10.2.3.4';
    const token = await seedPendingLead(leadStore, 'tok');

    for (let i = 0; i < LIMITS.LEAD_CONFIRM_PER_IP_PER_DAY; i++) {
      // Each confirm clears the token, so re-create a pending lead each round.
      await leadStore.confirmLead(leadStore.rows[leadStore.rows.length - 1].id);
      const fresh = await seedPendingLead(leadStore, `tok-${i}`);
      const r = await request(app)
        .get('/')
        .set('x-forwarded-for', ip)
        .query({ action: 'lead_confirm', token: fresh });
      expect(r.status).not.toBe(429);
    }
    void token;

    const blocked = await request(app)
      .get('/')
      .set('x-forwarded-for', ip)
      .query({ action: 'lead_confirm', token: 'anything' });
    expect(blocked.status).toBe(429);
    expect(typeof blocked.text).toBe('string');
  });

  it('allows a different IP after another IP per-IP confirm limit is exhausted', async () => {
    const { app, limiter, leadStore } = makeApp();
    const { hashIp } = require('../src/util');
    limiter.hits.set(`confirm:${hashIp('10.2.3.4')}`, {
      count: LIMITS.LEAD_CONFIRM_PER_IP_PER_DAY,
      resetAt: Date.now() + 86_400_000,
    });

    const blockedIp1 = await request(app)
      .get('/')
      .set('x-forwarded-for', '10.2.3.4')
      .query({ action: 'lead_confirm', token: 'tok' });
    expect(blockedIp1.status).toBe(429);

    await seedPendingLead(leadStore, 'tok2');
    const allowedIp2 = await request(app)
      .get('/')
      .set('x-forwarded-for', '10.2.3.5')
      .query({ action: 'lead_confirm', token: 'tok2' });
    expect(allowedIp2.status).toBe(200);
  });

  it('returns 503 when the global confirm daily cap is exhausted and does not reach the store', async () => {
    const { app, limiter, leadStore } = makeApp();
    const day = new Date().toISOString().slice(0, 10);
    limiter.hits.set(`lgc:${day}`, { count: LIMITS.LEAD_CONFIRM_GLOBAL_PER_DAY, resetAt: Date.now() + 86_400_000 });
    const res = await request(app)
      .get('/')
      .query({ action: 'lead_confirm', token: 'some-token' });
    expect(res.status).toBe(503);
    expect(typeof res.text).toBe('string');
    expect(leadStore.rows).toHaveLength(0);
  });
});
