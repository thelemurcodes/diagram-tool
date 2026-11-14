import crypto from 'crypto';
import { LIMITS } from './config';

/** In-memory soft rate limiter (per warm instance). Ported verbatim. */
export class RateLimiter {
  hits = new Map<string, { count: number; resetAt: number }>();

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now > e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  }

  /** Occasionally drop expired windows so the map doesn't grow unbounded. */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (now > v.resetAt) this.hits.delete(k);
  }
}

/** Strip code fences / stray backticks. Ported verbatim. */
export function cleanMermaid(raw: string | null | undefined): string {
  let s = (raw || '').trim();
  const fence = s.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/^`+|`+$/g, '').trim();
}

/** One-way IP hash (so we never store raw IPs). Ported verbatim. */
export function hashIp(ip: string | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(String(ip || 'unknown'))
    .digest('hex')
    .slice(0, 16);
}

/** Extract the client IP the way the Cloud Function did (x-forwarded-for). */
export function clientIp(headers: Record<string, unknown>): string {
  return (
    String((headers as Record<string, string>)['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown'
  );
}

/**
 * True when a prompt is too thin to diagram from: fewer than MIN_PROMPT_WORDS
 * words or fewer than MIN_PROMPT_CHARS alphanumeric characters. Input this
 * underspecified makes the model invent a workflow (eval-harness run 2,
 * finding B) instead of the user getting an ask-for-detail error.
 */
export function isUnderspecified(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length < LIMITS.MIN_PROMPT_WORDS) return true;
  const alnum = prompt.replace(/[^a-zA-Z0-9]/g, '');
  return alnum.length < LIMITS.MIN_PROMPT_CHARS;
}
