# Infrastructure

Deployed resources for the diagram-tool backend. This file records resource
names and identifiers only — never secrets, keys, or connection strings.

## Backend hosting — Railway

| What | Value |
| --- | --- |
| Project | _recorded after deploy_ |
| Service | _recorded after deploy_ |
| Environment | _recorded after deploy_ |
| Public domain | _recorded after deploy_ |
| Healthcheck path | `/healthz` |
| Deploy mechanism | Railway GitHub App, from `main` (no deploy scripts, no stored keys) |

Environment variables (values set in the Railway dashboard, owner-managed):

- `ALLOWED_ORIGIN=https://thelemurcodes.github.io` — CORS locked to the Pages origin, never `*`
- `LOG_PROMPTS` — unset/off (prompt logging disabled)
- `DATABASE_URL` — unset in the skeleton deploy (in-memory stores); set when Neon is attached (PR 3)
- `ANTHROPIC_API_KEY` — owner-set on the Railway service when provided; never in the repo, CI, logs, or the browser
- `LEAD_CAPTURE_ENABLED` — unset (default off, per DIAG-ADR-001)

## Data — Neon Postgres

To be provisioned in PR 3 (deploy + cutover). Schema lives in
`server/src/stores/postgresStore.ts` (`SCHEMA_SQL`): `diagram_logs` and `leads`.

## Legacy GCP (untouched, owner binding condition)

The existing GCP project, the retired Cloud Function
(`diagram-proxy-hwanyl6rbq-uc.a.run.app`), and all Firestore data remain exactly
as they are — nothing is deleted, migrated, or modified. New writes go to
Postgres (Neon) only.
