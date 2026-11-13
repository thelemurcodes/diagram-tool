/**
 * New: auth_check tests. Today's committed backend never implemented the
 * auth_check handler the frontend calls — the port fixes that. These pin the
 * fix: correct password auths, wrong password rejects with {authed:false}, and
 * an authed generate gets the 50,000-char cap while unauthenticated requests
 * get mode caps. Wrong-password responses are 200 {authed:false} — exactly the
 * shape the frontend's sign-in flow already expects.
 */
import request from 'supertest';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/util';
import { LIMITS } from '../src/config';
import { MemoryLogStore } from '../src/stores/memoryStore';

const AUTH_PASSWORD = 'team-pass-2024';

function makeApp() {
  const limiter = new RateLimiter();
  const app = createApp({ authPassword: AUTH_PASSWORD }, limiter);
  return { app, limiter };
}

describe('auth_check', () => {
  it('returns {authed: true} for the correct password', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ auth_check: true, auth: AUTH_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authed: true });
  });

  it('returns {authed: false} for a wrong password', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ auth_check: true, auth: 'not-the-password' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authed: false });
  });

  it('returns {authed: false} when the auth field is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ auth_check: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authed: false });
  });

  it('returns the same {authed: false} body for missing vs wrong password', async () => {
    const { app } = makeApp();
    const missing = await request(app).post('/').send({ auth_check: true });
    const wrong = await request(app).post('/').send({ auth_check: true, auth: 'x' });
    expect(missing.body).toEqual(wrong.body);
  });

  it('never auths when no AUTH_PASSWORD is configured (no default backdoor)', async () => {
    const limiter = new RateLimiter();
    const app = createApp({ authPassword: '' }, limiter);
    const res = await request(app).post('/').send({ auth_check: true, auth: AUTH_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authed: false });
  });

  it('never auths when the auth field is a non-string type', async () => {
    const { app } = makeApp();
    const num = await request(app).post('/').send({ auth_check: true, auth: 12345 });
    const obj = await request(app).post('/').send({ auth_check: true, auth: { pw: AUTH_PASSWORD } });
    expect(num.body).toEqual({ authed: false });
    expect(obj.body).toEqual({ authed: false });
  });

  it('never leaks the configured password in the response', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/').send({ auth_check: true, auth: 'wrong' });
    expect(JSON.stringify(res.body)).not.toContain(AUTH_PASSWORD);
  });

  it('is rate-limited to AUTH_PER_IP_PER_MIN attempts per IP', async () => {
    const { app } = makeApp();
    const ip = '10.7.7.7';
    for (let i = 0; i < LIMITS.AUTH_PER_IP_PER_MIN; i++) {
      const r = await request(app)
        .post('/')
        .set('x-forwarded-for', ip)
        .send({ auth_check: true, auth: 'guess' });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post('/')
      .set('x-forwarded-for', ip)
      .send({ auth_check: true, auth: 'guess' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/i);
  });

  it('auth_check requests do not write diagram_logs rows', async () => {
    const logStore = new MemoryLogStore();
    const limiter = new RateLimiter();
    const app = createApp({ logStore }, limiter);
    await request(app).post('/').send({ auth_check: true, auth: AUTH_PASSWORD });
    expect(logStore.rows).toHaveLength(0);
  });
});

describe('authed generate cap', () => {
  it('accepts an authed prompt over every mode cap but under the 50,000-char authed cap', async () => {
    const { app } = makeApp();
    // A prompt too long for any mode cap would 413 unauthenticated; with a
    // valid auth it must reach the model path and return a diagram.
    const longPrompt = 'a'.repeat(LIMITS.MAX_POLICY_CHARS + 1);
    const res = await request(app)
      .post('/')
      .send({ prompt: longPrompt, mode: 'policy', auth: AUTH_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mermaid).toMatch(/^flowchart TD/);
  });

  it('still returns 400 for an authed prompt over the 50,000-char ceiling', async () => {
    const { app } = makeApp();
    const overAuthed = 'a'.repeat(LIMITS.AUTHED_MAX_CHARS + 1);
    const res = await request(app)
      .post('/')
      .send({ prompt: overAuthed, mode: 'describe', auth: AUTH_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.max).toBe(LIMITS.AUTHED_MAX_CHARS);
  });

  it('rejects an invalid auth on an over-cap prompt with 413 (mode cap applies)', async () => {
    const { app } = makeApp();
    const longPrompt = 'a'.repeat(LIMITS.MAX_POLICY_CHARS + 1);
    const res = await request(app)
      .post('/')
      .send({ prompt: longPrompt, mode: 'policy', auth: 'wrong-password' });
    expect(res.status).toBe(413);
  });

  it('unauthenticated prompts keep the mode caps', async () => {
    const { app } = makeApp();
    const longPrompt = 'a'.repeat(LIMITS.MAX_DESCRIBE_CHARS + 1);
    const res = await request(app)
      .post('/')
      .send({ prompt: longPrompt, mode: 'describe' });
    expect(res.status).toBe(413);
    expect(res.body.cap).toBe(LIMITS.MAX_DESCRIBE_CHARS);
  });

  it('accepts an unauthenticated prompt exactly at the mode cap', async () => {
    const { app } = makeApp();
    const atCap = 'a'.repeat(LIMITS.MAX_DESCRIBE_CHARS);
    const res = await request(app)
      .post('/')
      .send({ prompt: atCap, mode: 'describe' });
    expect(res.status).toBe(200);
  });

  it('auth does not raise the cap when no AUTH_PASSWORD is configured', async () => {
    const limiter = new RateLimiter();
    const app = createApp({ authPassword: '' }, limiter);
    const longPrompt = 'a'.repeat(LIMITS.MAX_POLICY_CHARS + 1);
    const res = await request(app)
      .post('/')
      .send({ prompt: longPrompt, mode: 'policy', auth: AUTH_PASSWORD });
    expect(res.status).toBe(413);
  });
});
