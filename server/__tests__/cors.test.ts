/**
 * New: CORS tests. PROJECT.md constraint — the origin is locked to the Pages
 * site, never * in production, and preflight must succeed for the allowed
 * origin while other origins are refused.
 */
import request from 'supertest';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/util';

const PAGES_ORIGIN = 'https://thelemurcodes.github.io';

function makeApp(allowedOrigin: string = PAGES_ORIGIN) {
  const limiter = new RateLimiter();
  const app = createApp({ allowedOrigin }, limiter);
  return app;
}

describe('CORS — allowed origin', () => {
  it('echoes the Pages origin on a plain POST', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
  });

  it('preflight (OPTIONS) succeeds with 204 for the Pages origin', async () => {
    const app = makeApp();
    const res = await request(app).options('/').send();
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
  });

  it('preflight advertises POST and Content-Type', async () => {
    const app = makeApp();
    const res = await request(app).options('/').send();
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('works for auth_check requests too', async () => {
    const app = makeApp();
    const res = await request(app).post('/').send({ auth_check: true, auth: 'x' });
    expect(res.headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
  });
});

describe('CORS — disallowed origins', () => {
  it.each([
    { label: 'an arbitrary site', origin: 'https://evil.example.com' },
    { label: 'a lookalike subdomain', origin: 'https://thelemurcodes.github.io.evil.com' },
    { label: 'a sibling github pages site', origin: 'https://otheruser.github.io' },
  ])('does not set Access-Control-Allow-Origin for $label', async ({ origin }) => {
    const app = makeApp();
    const res = await request(app)
      .post('/')
      .set('Origin', origin)
      .send({ prompt: 'resident intake flow' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).not.toBe(origin);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('never falls back to * when no Origin header is sent', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('CORS — wildcard hardening', () => {
  it('a response never carries Access-Control-Allow-Origin: * under any tested configuration', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/')
      .send({ prompt: 'resident intake flow' });
    expect(res.headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
