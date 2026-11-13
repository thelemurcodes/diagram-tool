/**
 * Production entrypoint: wires env vars into createApp and listens.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY      — Anthropic key (Railway env var, owner-set; never
 *                            in the repo, CI, logs, or the browser)
 *   DATABASE_URL           — Postgres connection string (Neon)
 *   AUTH_PASSWORD          — Team sign-in password (auth_check)
 *   INSIGHTS_PASSWORD      — usage_intel shared secret
 *   ALLOWED_ORIGIN         — CORS origin; production MUST be
 *                            https://thelemurcodes.github.io (never '*')
 *   LEAD_CAPTURE_ENABLED   — DIAG-ADR-001 kill switch ('true' enables; default off)
 *   RESEND_API_KEY         — Resend key for double opt-in emails
 *   FUNCTION_URL           — public base URL of this backend (confirmation links)
 *   LOG_PROMPTS            — 'true' writes diagram_logs; off = logging disabled
 *   PORT                   — listen port (Railway provides it; default 8080)
 */
import { createApp } from './app';
import { AnthropicClient } from './modelClient';
import { LogStore, UsageIntel } from './stores/types';
import { MemoryLeadStore, MemoryLogStore } from './stores/memoryStore';
import { PostgresLogStore, PostgresLeadStore } from './stores/postgresStore';

/** LogStore that discards writes (LOG_PROMPTS off — ported gating behavior). */
class NoopLogStore implements LogStore {
  async log(): Promise<void> {
    /* discarded */
  }
  async usageIntel(): Promise<UsageIntel> {
    // Logging is off: the intel view reads nothing and returns zeroed aggregates.
    return {
      totalFetched: 0,
      successRate: 0,
      byType: {},
      byMode: {},
      byTemplateId: {},
      byReferrer: {},
      dailyVolume: {},
    };
  }
}

async function main(): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  const databaseUrl = process.env.DATABASE_URL || '';

  // Postgres (Neon) when DATABASE_URL exists; in-memory otherwise (local dev only).
  const leadStore = databaseUrl
    ? await PostgresLeadStore.connect(databaseUrl)
    : new MemoryLeadStore();
  const logStore: LogStore =
    process.env.LOG_PROMPTS === 'true'
      ? databaseUrl
        ? await PostgresLogStore.connect(databaseUrl)
        : new MemoryLogStore()
      : new NoopLogStore();

  const app = createApp({
    logStore,
    leadStore,
    modelClient: new AnthropicClient(anthropicKey),
    apiKeyConfigured: Boolean(anthropicKey),
    leadCaptureEnabled: process.env.LEAD_CAPTURE_ENABLED === 'true',
    authPassword: process.env.AUTH_PASSWORD || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
    resendApiKey: process.env.RESEND_API_KEY || '',
    functionUrl: process.env.FUNCTION_URL || '',
    insightsPassword: process.env.INSIGHTS_PASSWORD || '',
  });

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.log(`Senior Care Diagram Maker backend listening on :${port}`);
  });
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
