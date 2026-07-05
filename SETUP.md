# Senior Care Diagram Maker — Setup, Cost & Growth Guide (Google Cloud + GitHub Pages)

A free, no-login tool that turns a plain-English description **or a pasted policy**
into an editable Mermaid flowchart. Built to pull backlinks, rank for long-tail
searches, and surface what facilities are actually mapping (so consultants can
walk into conversations already half-prepared).

## What's in this folder

| Path | What it is |
|------|------------|
| `docs/index.html` | The whole front-end — mode toggle, templates, rendering, export. **GitHub Pages serves this.** |
| `docs/terms.html` | Terms of Use page (**draft — needs legal review before launch**). |
| `server/index.js` | The Google Cloud Function — holds your key, runs cost guards, logs submissions to Firestore. |
| `server/package.json` | Dependencies (functions-framework + firestore). |
| `deploy.sh` | One-shot deploy script (gcloud). **Git-ignored** because you put your key in it. |
| `SETUP.md` | This guide. |
| `.gitignore` | Keeps `deploy.sh`, `node_modules`, etc. out of your public repo. |

## How it fits together

```
Visitor's browser  ──►  docs/index.html on GitHub Pages
        │  POST { prompt, type, mode }            (mode = "describe" or "policy")
        ▼
Google Cloud Function (server/index.js)  ──►  Anthropic Claude Haiku
   • holds your API key (never exposed)               │
   • CORS-locked to your GitHub Pages origin          ▼
   • rate-limits + token caps                  returns Mermaid code
        │
        ├──►  Firestore  (diagram_logs collection)   ← analyse usage patterns
        ▼
Browser renders the diagram with Mermaid (free, client-side)
```

The only thing that ever costs money is the Haiku call. Rendering is free in the
browser, and Pages + the function + Firestore all sit comfortably in free tiers
at prototype scale.

---

## Part 1 — Deploy the backend to Google Cloud (~15 min, one time)

**Prereqs:** the [gcloud CLI](https://cloud.google.com/sdk/docs/install), a Google
Cloud project with billing enabled (free tier covers this easily), and an
[Anthropic API key](https://console.anthropic.com/).

1. **Sign in:**
   ```bash
   gcloud auth login
   ```

2. **Fill in `deploy.sh`** — open it and set the four values at the top:
   ```bash
   PROJECT_ID="your-gcp-project-id"
   REGION="us-central1"
   GITHUB_USER="your-github-username"   # becomes CORS origin https://USER.github.io
   ANTHROPIC_API_KEY="sk-ant-…"
   ```

3. **Deploy:**
   ```bash
   bash deploy.sh
   ```
   It enables the APIs (incl. Firestore), creates the default Firestore database
   if needed, grants the function's runtime service account access to Firestore,
   then deploys the function with `LOG_PROMPTS=true`. When it finishes it prints
   your **endpoint URL** — something like `https://diagram-proxy-xxx.a.run.app`.

### Lead capture + usage intel env vars (added 2026-07-05, both default OFF)

`deploy.sh` isn't in this repo (git-ignored, holds your keys) — these three
env vars need to be added to it directly since this doc can't reach that file.
Add them alongside `ANTHROPIC_API_KEY` in your `--set-env-vars` (or
`--update-env-vars` on a repeat deploy):

```bash
LEAD_CAPTURE_ENABLED="false"     # "true" to turn on lead capture — see below
RESEND_API_KEY="re_…"            # only needed once LEAD_CAPTURE_ENABLED=true
INSIGHTS_PASSWORD="pick-a-password"   # gates docs/insights.html; safe to set anytime
```

- **`LEAD_CAPTURE_ENABLED`** — the backend half of the lead-capture kill switch
  (the frontend half, `LEAD_CAPTURE_UI_ENABLED` in `docs/index.html`, is already
  flipped on — the "Notify me" prompt is visible, but submissions silently fail
  until this backend flag is also `true`). The terms.html clause covering what's
  collected has been reviewed and approved — flip this to `true` whenever you're
  ready to go live, no further code changes needed.
- **`RESEND_API_KEY`** — only read when `LEAD_CAPTURE_ENABLED=true`; without it,
  leads still get saved but the double-opt-in confirmation email silently isn't
  sent (logged as a warning, never a user-facing error). Get a free-tier key at
  [resend.com](https://resend.com) — 100 emails/day, no card required.
- **`INSIGHTS_PASSWORD`** — gates `docs/insights.html` (the usage-intel dashboard).
  No legal/PII gate on this one; safe to set to anything and share only with
  whoever should see aggregate usage stats. Placeholder values are fine here —
  rotate the same way you'd rotate `AUTH_PASSWORD` (edit `deploy.sh`, rerun it).

   > Re-running `deploy.sh` is safe — the API enable / DB create / IAM grant
   > steps are idempotent.

---

## Part 2 — Point the front-end at your function

Open `docs/index.html` and edit the `CONFIG` block near the bottom (around line 270):

```js
const CONFIG = {
  API_ENDPOINT: "https://diagram-proxy-xxx.a.run.app",  // from step 3
  BRAND_NAME:   "Senior Care Diagram Maker",
  ORG_NAME:     "Your Agency Name",
  LOGO_TEXT:    "YA",
  CONSULT_URL:  "https://www.youragency.com/book-a-consultation",
  SAAS_URL:     "https://www.youragency.com/platform",
  HOME_URL:     "https://www.youragency.com",
  SAAS_NAME:    "CarePlatform",
  EXPORT_WATERMARK: "Made free with Your Agency · youragency.com"
};
```

> **Try it before publishing:** open `docs/index.html` in a browser with
> `API_ENDPOINT` left empty — it switches to "local test mode" so you can paste
> your own key and click around (including testing policy mode). Never publish
> in that mode; production uses the Cloud Function.

---

## Part 3 — Publish to your GitHub site (GitHub Pages)

Standard GitHub Pages flow: push the folder, then **Settings → Pages →
Source: Deploy from a branch → Branch: main, Folder: /docs**. Live at
`https://YOUR_USER.github.io/your-repo/`.

The CORS origin is `https://YOUR_USER.github.io` regardless of repo name — as
long as `GITHUB_USER` in `deploy.sh` matches your username, you're done.

---

## Part 4 — Two input modes, and what they're for

| Mode | When to use it | Char cap | Cost / use* |
|------|---------------|----------|-------------|
| **Describe a process** | Quick descriptions, "map our intake from inquiry to move-in." Also what every template fills in. | 1,500 | ~$0.003 |
| **Paste a policy** | They already wrote it. Paste a med-pass policy, an evacuation procedure, an infection-control SOP — get the diagram. | 8,000 | ~$0.0045 |

*Per-call cost at Haiku pricing (~$1/M input + ~$5/M output). Confirm current
rates at https://claude.com/pricing.*

The mode is sent in the POST body as `mode: "describe"` or `mode: "policy"`. The
Cloud Function picks the matching system prompt and the matching character cap.

---

## Team sign-in for larger input caps

There's a small **Sign in** button in the header. Signing in unlocks a much larger
input cap (50,000 chars in either mode) — enough to paste full procedures and
policies without splitting them up. Anonymous visitors stay capped at 1,500 /
8,000 chars. When an anonymous visitor hits the limit, the error message
surfaces a "Sign in" link inline so your consultants don't have to hunt for it.

**How it works**
- The password is set as the `AUTH_PASSWORD` env var on the Cloud Function
  (`deploy.sh` writes it). The current value is in `deploy.sh` — git-ignored.
- The browser sends the entered password to a small `auth_check` endpoint on
  the same function; the server compares it to the env var and replies
  `{authed: true|false}`. On a match, the front-end stores the password in
  `localStorage` and sends it with every diagram request.
- The server validates the password on every request and only grants the
  larger cap if it matches.

**Sharing the password.** Tell your team in person / Slack / etc. — *not* on a
public page. Avoid putting it in client-side code on any other site.

**Rotating it.** Edit `AUTH_PASSWORD` in `deploy.sh`, rerun `bash deploy.sh`.
Existing browsers with the old token will get re-validated on next page load
and quietly signed out.

> ### ⚠️ Be honest about what this is
>
> This is a **UX gate**, not real authentication. The password travels in
> request bodies over HTTPS and ends up in `localStorage` and in the GCP
> Console (as an env var). Someone reading network traffic or with GCP project
> access can find it. The threat model:
>
> - **What an attacker gains:** a higher input cap (~50k chars). Each call is
>   still bounded by `MAX_TOKENS` and counted against your rate limits and the
>   Anthropic monthly spend cap.
> - **What they don't gain:** any access to logs, your project, or anything
>   sensitive.
>
> So leakage means "extra Anthropic spend, bounded by your cap" — not a
> disaster. If you ever need real auth (per-user accounts, revocable tokens,
> audit trails), that's a product step, not a free-tool tweak.

**Local-test mode** (no `API_ENDPOINT` set) auto-grants the larger cap and hides
the Sign-in button — you're the developer, you already have full access.

---

## Part 5 — Templates (the 10 sharpened set)

The current template library is focused on policy-heavy and emergency-prep
workflows — the two strongest fit-signals from real conversations:

1. Medication administration (MAR)
2. Emergency evacuation plan
3. Fall response & post-fall protocol
4. Incident reporting
5. Infection control / outbreak response
6. Lockdown / active threat
7. Severe weather response
8. Missing resident / elopement
9. Resident admission & intake
10. Shift change & handoff (SBAR)

To add or change them, edit the `TEMPLATES` array near the top of the script
block in `docs/index.html`. Each entry is `{ t, d, type, p }` —
title, short subtitle, default diagram type, prompt text. Every template you add
is a candidate SEO landing page (see growth playbook below).

---

## Part 6 — Data capture & privacy (read this carefully)

When `LOG_PROMPTS=true` (the default after `deploy.sh`), every request writes a
record to Firestore's `diagram_logs` collection:

```js
{
  timestamp:     <server time>,
  mode:          "describe" | "policy",
  type:          "flowchart" | "org" | …,
  prompt:        <the full text the user submitted>,
  prompt_chars:  <length>,
  ip_hash:       <16-char SHA-256 of IP, never the raw IP>,
  referer:       <where the request came from>,
  success:       true | false,
  mermaid_chars: <output length on success>,
  usage_in:      <input tokens>,
  usage_out:     <output tokens>,
  error:         <only on failure>
}
```

**Browse it in the GCP Console** → Firestore → Data → `diagram_logs`.

**Query patterns** (example: most-mapped policy topics this month):
```bash
gcloud firestore export gs://your-bucket/exports   # then load into BigQuery, or:
# In the Firestore console, filter on mode=="policy" and sort by timestamp.
```

> ### ⚠️ Before broadly promoting the tool, do these three things
>
> 1. **Have your legal/compliance team review `docs/terms.html`** and update the
>    bracketed placeholders (`[Your Brand]`, `[contact@youragency.com]`,
>    `[your state / jurisdiction]`). Remove the yellow "Draft" banner at the top
>    of the body once approved.
> 2. **Decide your PHI posture.** The tool tells users not to paste PHI, but some
>    will anyway. Your T&Cs handle the legal side; consider also adding a server-
>    side scrubber (e.g., reject obvious patterns like SSNs, MRNs) if exposure
>    becomes a concern.
> 3. **Set a monthly spend cap on the Anthropic key** in the Anthropic Console.
>    This is your hard $ ceiling — without it, "log full content" + "fully open"
>    has no upper bound.
>
> To temporarily turn off logging without redeploying everything: set
> `LOG_PROMPTS=false` via `gcloud functions deploy diagram-proxy --gen2
> --region=us-central1 --update-env-vars=LOG_PROMPTS=false`.

---

## Part 7 — Cost guards (what protects you from a runaway bill)

| Guard | Where | What it does |
|-------|-------|--------------|
| `MAX_TOKENS` / mode-specific char caps | `server/index.js` `LIMITS` | Caps the size and cost of any single request. |
| Per-IP limits (5/min, 40/day) | `server/index.js` `LIMITS` | Stops one visitor from hammering it. *In-memory soft limits.* |
| `--max-instances=3` | `deploy.sh` | Caps concurrency = caps spend rate. |
| **Anthropic monthly spend limit** | Anthropic Console | **Your hard ceiling.** Set this. |
| GCP **budget alert** | GCP Console → Billing → Budgets | Emails you if cloud costs cross a threshold. |

Policy-mode requests cost a bit more (~$0.0045 vs ~$0.003) because the input is
longer. Even at the global soft cap of 2,000/day all in policy mode, max spend
is around $9/day — still well under any sane Anthropic cap.

---

## Part 8 — Optional hardening

**Move the key into Secret Manager** (so it's not an env var):
```bash
echo -n "sk-ant-…" | gcloud secrets create anthropic-key --data-file=-
# Grant the function SA access, then redeploy with:
#   --set-secrets="ANTHROPIC_API_KEY=anthropic-key:latest"
#   (drop ANTHROPIC_API_KEY from --set-env-vars)
```

**Allow more origins** (e.g., your Squarespace site + GitHub Pages): the
function reads a single `ALLOWED_ORIGIN`. To allow several, change the CORS
block in `server/index.js` to match an allow-list, then redeploy.

**Durable rate limits with Firestore counters:** the limits are in-memory today
(reset on cold start). For exact, cross-instance limits, move the counters into
Firestore using a transaction. Only worth it once traffic is consistently high.

---

## Part 9 — Making it actually drive dollars (the growth playbook)

The tool is the magnet. These turn traffic into backlinks, rankings, and consults:

**1. A landing page per template.** Each of the 10 sharpened templates is
long-tail SEO gold — *"assisted living fall response flowchart template"*,
*"infection control outbreak response diagram"*. Make a page per template with
the embedded tool plus ~300–500 words of useful context.

**2. "Embed this free tool" snippet.** Every senior-care blog or association
that drops it into a post is a backlink — the single biggest backlink driver.

**3. The export watermark is a backlink seed.** Every PNG downloaded carries
your brand + URL.

**4. Outreach where senior-care ops people gather** — LeadingAge, Argentum,
AANAC, McKnight's, state associations, "free tools for [industry]" lists.

**5. Mine the Firestore logs** for what facilities are actually mapping. Common
prompt patterns are exactly the topics you should be publishing about and the
service gaps your consulting team can speak to.

---

*Code is heavily commented — search for the `CONFIG` block in `docs/index.html`
and the `LIMITS` block in `server/index.js`.*
