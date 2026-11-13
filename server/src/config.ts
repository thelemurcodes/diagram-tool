/**
 * Cost guards and mode caps — carried over unmodified from the Cloud Function
 * (server/index.js LIMITS). Do not change these values without an owner
 * decision: they are the project's free-tier economics (see PROJECT.md).
 */
export const LIMITS = {
  MODEL: 'claude-haiku-4-5-20251001',
  MAX_TOKENS: 1100,

  MAX_PROMPT_LENGTH: 10000, // absolute ceiling for unauthenticated requests; returns 400
  MAX_DESCRIBE_CHARS: 1500, // describe mode
  MAX_POLICY_CHARS: 8000, // policy mode (pasted policy text)

  // Signed-in ("Team sign in") users get the larger cap the frontend already
  // promises (MAX_CHARS.authed). Enforced server-side here for the first time.
  AUTHED_MAX_CHARS: 50000,

  PER_IP_PER_MIN: 5,
  PER_IP_PER_DAY: 40,
  GLOBAL_PER_DAY: 2000, // soft per-instance daily ceiling

  LEAD_PER_IP_PER_DAY: 3,
  LEAD_GLOBAL_PER_DAY: 500,

  LEAD_CONFIRM_PER_IP_PER_DAY: 20,
  LEAD_CONFIRM_GLOBAL_PER_DAY: 1000,

  // Team sign-in attempts (auth_check) — bounded so the password can't be
  // brute-forced at request rate. Frontend surfaces 429 as "Too many attempts."
  AUTH_PER_IP_PER_MIN: 5,
} as const;

/** Basic RFC-5322-ish email regex — rejects obvious non-emails, not exhaustive. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
