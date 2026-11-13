# Infrastructure

Deployed resources for the diagram-tool backend. This file records resource
names and identifiers only — never secrets, keys, or connection strings.

## Backend hosting — Railway

| What | Value |
| --- | --- |
| Project | `diagram-tool` (ID `f44303db-7c3b-4b31-940f-7632d170c20c`) |
| Service | `backend` (ID `5e6550ba-fc7f-4fb6-85db-dd5648ac27e0`), connected to `thelemurcodes/diagram-tool` on `main` |
| Environment | `production` (ID `cfe27108-c743-4a79-b80e-ed0a5c2d24f1`) |
| Public domain | `https://backend-production-01bfe80e.up.railway.app` (domain ID `759d1a96-0c5c-41d2-9b29-29db0cc20dcb`) |
| Healthcheck path | `/healthz` |
| Builder | NIXPACKS |
| Deploy mechanism | Railway GitHub App, from `main` (no deploy scripts, no stored keys) |

Environment variables (values set in the Railway dashboard, owner-managed):

- `ALLOWED_ORIGIN=https://thelemurcodes.github.io` — CORS locked to the Pages origin, never `*`
- `ANTHROPIC_API_KEY` — owner-set on the Railway service; never in the repo, CI, logs, or the browser
- `DATABASE_URL` — Neon `app` database, pooled endpoint (see below)
- `LOG_PROMPTS=true` — logging on; writes derived usage fields only to the Neon `diagram_logs` table, never prompt text (DIAG-ADR-002)
- `LEAD_CAPTURE_ENABLED` — unset (default off, per DIAG-ADR-001)

## Data — Neon Postgres

| What | Value |
| --- | --- |
| Project | `diagram-tool` (ID `autumn-rice-49221385`) |
| Region | `aws-us-east-2` (proxy host `c-8.us-east-2.aws.neon.tech`) |
| Branch | `main` (ID `br-restless-moon-bdjfgjr8`) |
| Database | `app` (ID `544740`), owner role `neondb_owner` |
| Connection | pooled endpoint `ep-sparkling-resonance-bdd32tel-pooler.c-8.us-east-2.aws.neon.tech`; connection string lives only in the Railway `DATABASE_URL` variable |

Schema is created on connect by `server/src/stores/postgresStore.ts`
(`SCHEMA_SQL`): `diagram_logs` and `leads`. Only `status = 'confirmed'` leads
are ever contactable or exportable (DIAG-ADR-001).

## CI — GitHub Actions

- `ci.yml` — every PR and `main`: install, `tsc --noEmit`, jest (incl. embedded-Postgres store contracts), build, Playwright e2e of `docs/` against the local recorded-fake backend. Green with no Anthropic key anywhere; screenshots upload as the `e2e-screenshots` artifact.
- `docs-endpoint-check.yml` — fails any `docs/*.html` change (and nightly check) that references a legacy `run.app` or non-production endpoint.

## Frontend — GitHub Pages

Served from `docs/` on `main` at `https://thelemurcodes.github.io/diagram-tool/`.
Buildless single HTML file; `CONFIG.API_ENDPOINT` points at the Railway backend
and is guarded by the docs-endpoint-check workflow.

## Legacy GCP (untouched, owner binding condition)

The existing GCP project, the retired Cloud Function
(`diagram-proxy-hwanyl6rbq-uc.a.run.app`), and all Firestore data remain exactly
as they are — nothing is deleted, migrated, or modified. New writes go to
Postgres (Neon) only.
