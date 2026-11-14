/**
 * Ported input-guard tests: guards must fire BEFORE any model call.
 * Uses a spy ModelClient so "the model was never called" is a real assertion.
 */
import request from 'supertest';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/util';
import { LIMITS } from '../src/config';
import { ModelClient } from '../src/modelClient';

function spyClient() {
  const calls: Array<{ system: string; prompt: string }> = [];
  const client: ModelClient = {
    async generate(req) {
      calls.push({ system: req.system, prompt: req.prompt });
      return { text: 'flowchart TD\n  A --> B', usageIn: 1, usageOut: 1 };
    },
  };
  return { client, calls };
}

async function makeApp(modelClient?: ModelClient) {
  const limiter = new RateLimiter();
  const app = createApp(modelClient ? { modelClient } : {}, limiter);
  return app;
}

describe('input guard — empty prompt', () => {
  it('rejects an empty string with 400 before calling the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty prompt/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing prompt with 400 before calling the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a whitespace-only prompt with 400 before calling the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty prompt/i);
    expect(calls).toHaveLength(0);
  });
});

describe('input guard — over-length prompt', () => {
  it('rejects a prompt over MAX_PROMPT_LENGTH with 400 before calling the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const overLength = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 1);
    const res = await request(app).post('/').send({ prompt: overLength });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
    expect(res.body.max).toBe(LIMITS.MAX_PROMPT_LENGTH);
    expect(calls).toHaveLength(0);
  });

  it('includes the maximum in the 400 response body', async () => {
    const app = await makeApp();
    const overLength = 'x'.repeat(LIMITS.MAX_PROMPT_LENGTH + 100);
    const res = await request(app).post('/').send({ prompt: overLength });
    expect(res.status).toBe(400);
    expect(typeof res.body.max).toBe('number');
    expect(res.body.max).toBeGreaterThan(0);
  });
});

describe('input guard — valid prompt passes through', () => {
  it('calls the model for a prompt within MAX_PROMPT_LENGTH', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app)
      .post('/')
      .send({ prompt: 'Show a resident intake workflow', mode: 'describe', type: 'flowchart' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.body.mermaid).toBe('flowchart TD\n  A --> B');
  });

  it('does not reject a prompt at exactly MAX_DESCRIBE_CHARS characters', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    // Multi-word fill: single-word fills trip the underspecified guard.
    const atLimit = 'policy step '.repeat(Math.ceil(LIMITS.MAX_DESCRIBE_CHARS / 12)).slice(0, LIMITS.MAX_DESCRIBE_CHARS - 1) + 'x';
    const res = await request(app)
      .post('/')
      .send({ prompt: atLimit, mode: 'describe', type: 'flowchart' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('does not reject a prompt at exactly MAX_POLICY_CHARS characters in policy mode', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const atLimit = 'policy step '.repeat(Math.ceil(LIMITS.MAX_POLICY_CHARS / 12)).slice(0, LIMITS.MAX_POLICY_CHARS - 1) + 'x';
    const res = await request(app)
      .post('/')
      .send({ prompt: atLimit, mode: 'policy', type: 'flowchart' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe('input guard — underspecified prompt', () => {
  it('rejects a one-character prompt with 400 before calling the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: 'x', mode: 'describe', type: 'flowchart' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('underspecified');
    expect(res.body.error).toMatch(/more detail/i);
    expect(calls).toHaveLength(0);
  });

  it('rejects a single-word prompt in policy mode too', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: 'audit', mode: 'policy', type: 'flowchart' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('underspecified');
    expect(calls).toHaveLength(0);
  });

  it('rejects two words with too few substantive characters', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: 'a b c d', mode: 'describe' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('underspecified');
    expect(calls).toHaveLength(0);
  });

  it('passes a short-but-meaningful prompt through to the model', async () => {
    const { client, calls } = spyClient();
    const app = await makeApp(client);
    const res = await request(app).post('/').send({ prompt: 'intake flow', type: 'flowchart', mode: 'describe' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
