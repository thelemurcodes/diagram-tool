/**
 * CI / local-dev entrypoint: same wiring as index.ts but the model client is
 * always the RecordedResponseClient — deterministic, no Anthropic key, no
 * network. This is the backend that CI's Playwright run talks to.
 *
 * Env vars:
 *   ALLOWED_ORIGIN         — CORS origin; set to the local frontend's origin
 *   LEAD_CAPTURE_ENABLED   — DIAG-ADR-001 kill switch ('true' enables; default off)
 *   AUTH_PASSWORD          — Team sign-in password (auth_check); optional
 *   INSIGHTS_PASSWORD      — usage_intel shared secret; optional
 *   PORT                   — listen port (default 8080)
 *
 * The RecordedResponseClient serves committed fixtures from server/fixtures/;
 * it never calls Anthropic and never needs a key.
 */
import path from 'path';
import { createApp } from './app';
import { RecordedResponseClient } from './recordedClient';
import { MemoryLeadStore, MemoryLogStore } from './stores/memoryStore';

async function main(): Promise<void> {
  const app = createApp({
    logStore: new MemoryLogStore(),
    leadStore: new MemoryLeadStore(),
    modelClient: new RecordedResponseClient(path.join(__dirname, '..', 'fixtures')),
    // The fake is always usable — this flag only reports "the server can
    // generate" to clients; set true so the local/CI backend serves generates.
    apiKeyConfigured: true,
    leadCaptureEnabled: process.env.LEAD_CAPTURE_ENABLED === 'true',
    authPassword: process.env.AUTH_PASSWORD || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
    resendApiKey: process.env.RESEND_API_KEY || '',
    functionUrl: process.env.FUNCTION_URL || '',
    insightsPassword: process.env.INSIGHTS_PASSWORD || '',
  });

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.log(`Senior Care Diagram Maker backend (recorded fake) listening on :${port}`);
  });
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
