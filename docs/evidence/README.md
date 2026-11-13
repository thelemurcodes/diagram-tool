# Production evidence

Playwright run against **production** on 2026-11-13 (UTC), un-intercepted: the
browser loaded https://thelemurcodes.github.io/diagram-tool/ and every request
went wherever the published page points. Each mode generated a diagram from the
live backend (https://backend-production-01bfe80e.up.railway.app) and rendered
client-side with Mermaid.

| Screenshot | What it shows |
| --- | --- |
| `tc-1-describe-1280.png` / `tc-1-describe-390.png` | Describe mode (resident-admission process), desktop + mobile |
| `tc-2-policy-1280.png` / `tc-2-policy-390.png` | Policy mode (medication administration policy), desktop + mobile |

Assertions recorded by the run:

- served `CONFIG.API_ENDPOINT` = the Railway backend (no legacy `run.app`)
- 0 requests to `api.anthropic.com` — the key never reaches the browser
- both modes rendered an SVG diagram; screenshots captured at 1280×900 and 390×844

The run script itself is not committed (it lives in the repo's `e2e/`
tooling history); CI re-proves the same frontend/backend contract keylessly on
every push against the recorded-response fake.
