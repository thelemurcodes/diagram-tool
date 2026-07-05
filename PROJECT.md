# PROJECT — Senior-Care Diagram Maker (diagram-tool)

> The durable charter for this project. The factory reads this on every build to scope work against
> the project's actual goals — not one-off task sentences. Human-owned; edit freely.

## What this is (product identity)
A free, no-login web tool that turns a plain-English description **or a pasted policy** into an
editable Mermaid flowchart, aimed at the **senior-care** vertical.

**But the diagram-making is not the product — the funnel is.** The tool is a lead-gen / SEO engine
for a senior-care consultant: rank for long-tail searches, pull backlinks, and surface *what
facilities are actually mapping* so the consultant walks into conversations already half-prepared.
Diagram rendering is commodity (Mermaid, client-side, free); the moat is the funnel.

## Goal / product shape
Grow the funnel's three functions, in priority order:
1. **SEO surface depth (highest leverage).** It is one page today. Senior-care has specific,
   high-intent long-tail searches — med-pass, fall/incident response, admission/discharge, survey/
   audit prep, staffing ratios. Each should become its own template + indexable landing page: more
   ranking surface AND richer "what are they mapping" intel.
2. **Optional lead capture.** No-login is right for adoption, but it captures no identifiable leads
   (only aggregate logs). Add a frictionless, optional "email me the PDF / notify me of new
   templates" that converts anonymous SEO traffic into a lead list — without killing the free-and-
   fast value.
3. **Usage-intel view.** Turn the Firestore logs (what workflows are hot, what policy gaps recur)
   into the consultant's actual sales prep.

## Stack (so the factory builds compatibly)
- **Language/test:** TypeScript, **jest** (`jest --runInBand`), ts-jest. Tests in `server/__tests__`.
- **Package manager:** npm (no lockfile committed today).
- **Frontend:** a single `docs/index.html` served by **GitHub Pages** (client-side Mermaid; zero build).
- **Backend:** `server/index.js` — a **Google Cloud Function** (`@google-cloud/functions-framework`),
  holds the Anthropic key, CORS-locked to the Pages origin, rate-limits + token caps, logs to
  **Firestore** (`diagram_logs`). Model: **Claude Haiku**.
- **Deploy:** `deploy.sh` (gcloud) — git-ignored (holds the key).

## Constraints / MUST-NOT-break
- **Free-tier economics.** The ONLY paid path is the Haiku call. Pages + the function + Firestore sit
  in free tiers at prototype scale — keep it that way; any change must preserve the cost guards
  (rate limits, token caps) and not introduce a paid dependency without an explicit decision.
- **The API key is never exposed** to the browser. CORS stays locked to the Pages origin.
- **No-login / no-friction for the core use** — capture is always optional and post-value, never a gate.
- **Frontend stays buildless** (single HTML on Pages) unless a deliberate decision changes that.

## Governance / data
Senior-care-adjacent. Today only aggregate/anonymous usage is logged (`diagram_logs`) — no PII. If
lead capture is added, treat captured identity as sensitive: minimal collection, clear terms
(`docs/terms.html` needs legal review before launch), no selling/sharing. Do not log or store pasted
policy content beyond what the intel view genuinely needs.

## Definition of done (for a work item)
- Preserves the constraints above (free-tier, key-safety, no-friction).
- Ships with a real test (jest) that would fail if the behavior broke — not a smoke test.
- For an SEO/landing-page item: the page is independently indexable (own URL/title/meta), not just a
  toggle on the single page. It also MUST have:
  - A `<link rel="canonical" href="...">` in `<head>` pointing to the page's own absolute URL on the
    live site (`https://thelemurcodes.github.io/diagram-tool/<path>` — there is no custom domain/CNAME
    today; update this base if that changes).
  - Exactly ONE `<h1>` on the page: the page's own content heading (e.g. `<h1 class="page-title">`).
    The site brand/logo in the header (`Senior Care Diagram Maker`) is navigation chrome, not a
    heading — it must use a non-heading element (e.g. `<p class="site-name">` or `<span>`), never
    `<h1>`, so it doesn't compete with the page's real heading in the SEO outline.
- Doesn't regress the existing describe/policy flows.
