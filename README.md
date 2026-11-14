# Senior Care Diagram Maker

A free, no-login tool that turns a plain-English description **or a pasted
policy** into an editable Mermaid flowchart. Built to pull backlinks, rank for
long-tail senior-care searches, and surface what facilities are actually
mapping. See `PROJECT.md` for the charter.

## Status

**Live.** The product works end to end: the Pages frontend generates diagrams
in both modes (describe and policy) against the Railway backend.

- Frontend: https://thelemurcodes.github.io/diagram-tool/ (GitHub Pages, from `docs/` on `main`)
- Backend: https://backend-production-01bfe80e.up.railway.app (Railway, deployed from `main` via the Railway GitHub App — no deploy scripts, no stored keys)
- CI: GitHub Actions (`ci.yml`) on every PR and `main` — typecheck, jest, Playwright e2e against the local recorded-response fake. **Green with no Anthropic key anywhere.**
- Lead capture: **off** (`LEAD_CAPTURE_ENABLED` unset, per DIAG-ADR-001)
- Prompt logging: **on** (`LOG_PROMPTS=true`) — writes derived usage fields to Postgres
  `diagram_logs` only; prompt text is never stored (DIAG-ADR-002)

**Launch gate (not a build gate):** `docs/terms.html` needs legal review before
lead capture is enabled. Recorded here; building proceeds with capture off.

## How to run locally

```bash
scripts/bootstrap.sh        # npm ci + Playwright Chromium (needs sudo for --with-deps)
npm run build               # tsc -> server/dist
npm run start:fake          # backend on :8080 backed by recorded fixtures (no key, no network)
npm run e2e                 # serves docs/ on :3000 and drives a real browser through both modes
npm test                    # full jest suite (embedded Postgres for the store contracts)
```

Or run the real backend locally (needs `ANTHROPIC_API_KEY` and `DATABASE_URL`):

```bash
ALLOWED_ORIGIN=http://localhost:3000 LOG_PROMPTS=false npm start
```

The e2e run rewrites `CONFIG.API_ENDPOINT` to the local backend in memory only —
nothing under `docs/` changes on disk, and the endpoint guard still protects it.

## Architecture

```
Visitor's browser ──► docs/index.html on GitHub Pages
        │  POST { prompt, type, mode }        (mode = "describe" or "policy")
        ▼
Railway backend (server/src, TypeScript/Express) ──► Anthropic Claude Haiku
   • ModelClient interface: AnthropicClient (real) / RecordedResponseClient (fake)   │
   • CORS locked to https://thelemurcodes.github.io, never *                          ▼
   • rate limits + token caps carried over from the Cloud Function            Mermaid code
   • auth_check: AUTH_PASSWORD; authed prompts get the 50,000-char cap
        │
        ├──► Neon Postgres (diagram_logs, leads)  ← usage intel; leads default OFF
        ▼
Browser renders the diagram with Mermaid (free, client-side)
```

- **Key safety:** the Anthropic key lives only in the Railway process
  (`ANTHROPIC_API_KEY` env). Never in the repo, CI, logs, fixtures, or browser.
- **Cost guards:** per-IP 5/min and 40/day, global 2,000/day, 1,100 output
  tokens, mode caps 1,500 (describe) / 8,000 (policy) chars. The only paid path
  is the Haiku call.
- **Stores:** `LogStore`/`LeadStore` interfaces with in-memory (tests) and
  Postgres/Neon (production) implementations; schema self-applies on connect.
  Only `status='confirmed'` leads are ever contactable.
- **Legacy GCP untouched:** the old Cloud Function and all Firestore data stay
  exactly as they are; new writes go to Postgres only.

## Operations

Resource names, IDs, and environment-variable inventory:
[`docs/infrastructure.md`](docs/infrastructure.md). The old GCP setup guide is
retired — this README is the setup reference.

Production evidence (Playwright screenshots of real generated diagrams from the
live site, both modes) lives in `docs/evidence/`.
