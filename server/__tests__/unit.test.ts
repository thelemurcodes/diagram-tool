/**
 * Ports of the pure-helper tests from the old suite (systemPrompt,
 * cleanMermaid, allow, hashIp) — same assertions, new module layout.
 */
import { systemPrompt } from '../src/prompts';
import { cleanMermaid, RateLimiter, hashIp } from '../src/util';

describe('systemPrompt', () => {
  it('includes the flowchart hint for describe mode', () => {
    const sp = systemPrompt('flowchart', 'describe');
    expect(sp).toContain('flowchart TD');
    expect(sp).toContain("Turn the user's description");
  });

  it('includes the policy preamble for policy mode', () => {
    const sp = systemPrompt('flowchart', 'policy');
    expect(sp).toContain('pasted a policy');
    expect(sp).not.toContain("Turn the user's description");
  });

  it('uses sequenceDiagram hint for sequence type', () => {
    const sp = systemPrompt('sequence', 'describe');
    expect(sp).toContain('sequenceDiagram');
  });

  it('uses mindmap hint for mindmap type', () => {
    const sp = systemPrompt('mindmap', 'describe');
    expect(sp).toContain('mindmap');
  });

  it('uses org-chart hint for org type', () => {
    const sp = systemPrompt('org', 'describe');
    expect(sp).toContain('organizational chart');
  });

  it('uses decision-tree hint for decision type', () => {
    const sp = systemPrompt('decision', 'describe');
    expect(sp).toContain('decision tree');
    expect(sp).toContain('Yes/No');
  });

  it('uses timeline hint for timeline type', () => {
    const sp = systemPrompt('timeline', 'describe');
    expect(sp).toContain('timeline');
  });

  it('falls back to "most appropriate" for an unknown type', () => {
    const sp = systemPrompt('unknown-type', 'describe');
    expect(sp).toContain('most appropriate Mermaid diagram');
  });

  it('always includes the no-fences output rule', () => {
    const sp = systemPrompt('flowchart', 'describe');
    expect(sp).toContain('no markdown fences');
  });
});

describe('cleanMermaid', () => {
  it('returns plain mermaid code unchanged', () => {
    const raw = 'flowchart TD\n  A --> B';
    expect(cleanMermaid(raw)).toBe(raw);
  });

  it('strips ```mermaid fences', () => {
    const raw = '```mermaid\nflowchart TD\n  A --> B\n```';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('strips plain ``` fences', () => {
    const raw = '```\nflowchart TD\n  A --> B\n```';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('strips stray leading/trailing backticks when no fences', () => {
    const raw = '`flowchart TD\n  A --> B`';
    expect(cleanMermaid(raw)).toBe('flowchart TD\n  A --> B');
  });

  it('handles an empty string gracefully', () => {
    expect(cleanMermaid('')).toBe('');
  });

  it('handles null/undefined-like input (empty fallback)', () => {
    expect(cleanMermaid(undefined as any)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanMermaid('   flowchart TD   ')).toBe('flowchart TD');
  });

  it('preserves interior newlines', () => {
    const code = 'flowchart TD\n  A --> B\n  B --> C';
    expect(cleanMermaid(code)).toContain('\n');
  });
});

describe('RateLimiter.allow', () => {
  let limiter: RateLimiter;
  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('permits the first request', () => {
    expect(limiter.allow('test-key', 5, 60_000)).toBe(true);
  });

  it('permits requests up to the limit', () => {
    for (let i = 0; i < 5; i++) expect(limiter.allow('k', 5, 60_000)).toBe(true);
  });

  it('blocks the request that exceeds the limit', () => {
    for (let i = 0; i < 5; i++) limiter.allow('k', 5, 60_000);
    expect(limiter.allow('k', 5, 60_000)).toBe(false);
  });

  it('resets after the window expires', () => {
    for (let i = 0; i < 5; i++) limiter.allow('k', 5, 1);
    expect(limiter.allow('k', 5, 1)).toBe(false);
    const entry = limiter.hits.get('k')!;
    entry.resetAt = Date.now() - 1;
    expect(limiter.allow('k', 5, 60_000)).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    for (let i = 0; i < 5; i++) limiter.allow('a', 5, 60_000);
    expect(limiter.allow('a', 5, 60_000)).toBe(false);
    expect(limiter.allow('b', 5, 60_000)).toBe(true);
  });

  it('sweep() drops expired windows', () => {
    for (let i = 0; i < 5; i++) limiter.allow('k', 5, 1);
    const entry = limiter.hits.get('k')!;
    entry.resetAt = Date.now() - 1;
    limiter.sweep();
    expect(limiter.hits.has('k')).toBe(false);
  });
});

describe('hashIp', () => {
  it('returns a 16-character hex string', () => {
    const h = hashIp('192.168.1.1');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'));
  });

  it('produces different hashes for different IPs', () => {
    expect(hashIp('1.2.3.4')).not.toBe(hashIp('4.3.2.1'));
  });

  it('handles an empty/unknown IP without throwing', () => {
    expect(() => hashIp('')).not.toThrow();
    expect(() => hashIp('unknown')).not.toThrow();
  });
});
