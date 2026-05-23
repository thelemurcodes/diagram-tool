# Senior Care Diagram Maker — Setup, Cost & Growth Guide (Google Cloud + GitHub Pages)

A free, no-login tool that turns a plain-English description of any senior-care
workflow into an editable Mermaid flowchart. Built to pull backlinks, rank for
long-tail searches, and funnel visitors toward your consultations and SaaS.

## What's in this folder

| Path | What it is |
|------|------------|
| `docs/index.html` | The whole front-end — UI, templates, rendering, export. **GitHub Pages serves this.** |
| `server/index.js` | The Google Cloud Function that holds your Anthropic key and enforces cost guards. |
| `server/package.json` | Dependencies for the function. |
| `deploy.sh` | One-shot deploy script (gcloud). **Git-ignored** because you put your key in it. |
| `SETUP.md` | This guide. |
| `.gitignore` | Keeps `deploy.sh`, `node_modules`, etc. out of your public repo. |

## How it fits together

```
Visitor's browser  ──►  docs/index.html on GitHub Pages (https://USER.github.io/REPO)
        │  POST { prompt, type }
        ▼
Google Cloud Function (server/index.js)  ──►  Anthropic Claude Haiku
   • holds your API key (never exposed)               │
   • CORS-locked to your GitHub Pages origin          ▼
   • rate-limits + token caps                  returns Mermaid code
        │
        ▼
Browser renders the diagram with Mermaid (free, client-side)
```

The only thing that ever costs money is the Haiku call. Rendering, editing, and
exporting all happen for free in the visitor's browser, and the front-end hosting
on GitHub Pages is free.

> **Why two places?** GitHub Pages can only host static files — it can't run
> server code, and your API key can't be in static files. So the front-end goes on
> GitHub Pages and the key-holding proxy runs on Google Cloud. This is the standard
> pattern and both halves sit comfortably in free tiers.

---

## Part 1 — Deploy the backend to Google Cloud (~15 min, one time)

**Prereqs:** the [gcloud CLI](https://cloud.google.com/sdk/docs/install), a Google
Cloud project with billing enabled (free tier covers this), and an
[Anthropic API key](https://console.anthropic.com/).

1. **Sign in:**
   ```bash
   gcloud auth login
   ```

2. **Fill in `deploy.sh`** — open it and set the four values at the top:
   ```bash
   PROJECT_ID="your-gcp-project-id"
   REGION="us-central1"
   GITHUB_USER="your-github-username"        # becomes CORS origin https://USER.github.io
   ANTHROPIC_API_KEY="sk-ant-…"
   ```

3. **Deploy:**
   ```bash
   bash deploy.sh
   ```
   It enables the needed APIs and deploys the function. When it finishes it prints
   your **endpoint URL**, something like
   `https://diagram-proxy-abc123-uc.a.run.app`. Copy it.

---

## Part 2 — Point the front-end at your function

Open `docs/index.html` and edit the `CONFIG` block near the bottom:

```js
const CONFIG = {
  API_ENDPOINT: "https://diagram-proxy-abc123-uc.a.run.app", // from step 3
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

`CONSULT_URL` and `SAAS_URL` are your money paths — point them at your real
booking and product pages.

> **Try it before publishing:** open `docs/index.html` in a browser with
> `API_ENDPOINT` left empty — it switches to "local test mode" so you can paste
> your own key and click around. Never publish in that mode; production uses the
> Cloud Function.

---

## Part 3 — Publish to your GitHub site (GitHub Pages)

1. **Create a repo** on GitHub (e.g. `diagram-tool`) and push this folder:
   ```bash
   cd "Free Tool - Diagramming"
   git init
   git add .
   git commit -m "Senior care diagram maker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/diagram-tool.git
   git push -u origin main
   ```
   (`deploy.sh` is git-ignored, so your key won't be pushed.)

2. **Turn on Pages:** in the repo, go to **Settings → Pages → Build and deployment**.
   Set **Source = Deploy from a branch**, **Branch = `main`**, **Folder = `/docs`**,
   then **Save**.

3. After a minute your tool is live at:
   ```
   https://YOUR_USER.github.io/diagram-tool/
   ```

That origin (`https://YOUR_USER.github.io`) is exactly what the function's CORS is
locked to — as long as `GITHUB_USER` in `deploy.sh` matched your username, you're
done. (If it didn't, fix it and re-run `bash deploy.sh`.)

> Embedding in Squarespace later? Drop this in a Code block:
> ```html
> <iframe src="https://YOUR_USER.github.io/diagram-tool/"
>         style="width:100%;min-height:880px;border:0;" loading="lazy"
>         title="Free Senior Care Diagram Maker"></iframe>
> ```
> Then add that Squarespace page's origin to CORS (see "Allow more origins" below).

---

## Part 4 — Keeping it cheap (the cost guards)

Each diagram is ~450 input + ~500 output tokens. At Claude Haiku's pricing
(**confirm current rates at https://claude.com/pricing** — on the order of ~$1 per
million input / ~$5 per million output) that's about:

```
≈ $0.003 per diagram  →  roughly 300 diagrams per $1
```

Your protection is layered:

| Guard | Where | What it does |
|-------|-------|--------------|
| `MAX_TOKENS` / `MAX_PROMPT_CHARS` | `server/index.js` `LIMITS` | Caps the size (and cost) of any single request. |
| Per-IP limits (5/min, 40/day) | `server/index.js` `LIMITS` | Stops one visitor from hammering it. *In-memory — soft (see note).* |
| `--max-instances=3` | `deploy.sh` | Caps how many copies run at once = caps throughput = caps spend rate. |
| **Anthropic monthly spend limit** | Anthropic Console | **Your hard ceiling.** Set this — the tool can never cost more than you allow. |
| GCP **budget alert** | GCP Console → Billing → Budgets | Emails you if cloud costs cross a threshold. |

**Do set the Anthropic spend cap** — it's the one guarantee that doesn't depend on
any code. With it in place, "fully open" can never become an expensive surprise.

When a limit is hit, the tool shows a friendly message that nudges the visitor to
**book a consultation** instead of just erroring — the limit becomes a conversion
moment.

> **Note on the per-IP limits:** they live in the function's memory, so they reset
> on a cold start and aren't shared across instances. With `--max-instances=3`
> that's plenty for a prototype. If you later want exact, durable limits, see the
> Firestore upgrade below.

---

## Part 5 — Optional hardening & upgrades

**Move the key into Secret Manager** (so it's not in an env var):
```bash
echo -n "sk-ant-…" | gcloud secrets create anthropic-key --data-file=-
# grant the function's runtime service account access, then redeploy with:
#   --set-secrets="ANTHROPIC_API_KEY=anthropic-key:latest"   (instead of --set-env-vars for the key)
```

**Allow more origins** (e.g. your Squarespace domain + GitHub Pages): the function
reads a single `ALLOWED_ORIGIN`. To allow several, change the CORS block in
`server/index.js` to check the incoming `Origin` header against a small allow-list,
then redeploy.

**Durable, exact rate limits with Firestore:** add `@google-cloud/firestore`, store
the counters in a `counters` collection with transactions, and grant the function
`roles/datastore.user`. Only worth it once traffic is high enough that the soft
in-memory limits matter.

---

## Part 6 — Making it actually drive dollars (the growth playbook)

The tool is the magnet. These turn traffic into backlinks, rankings, and consults:

**1. A landing page per template.** The 10 built-in templates (med administration,
evacuation, intake, onboarding…) are long-tail SEO gold. Make a page per template
with the embedded tool plus ~300–500 words of useful context. They rank for
searches competitors ignore, like *"assisted living medication pass flowchart
template."*

**2. Let other sites embed it.** Add an "Embed this free tool" snippet (the iframe
above). Every senior-care blog or association that embeds it is a backlink — the
single biggest backlink driver.

**3. The export watermark is a backlink seed.** Every PNG a visitor downloads and
shares carries your brand + URL. Keep `EXPORT_WATERMARK` pointed at your domain.

**4. Outreach where senior-care ops people gather** — LeadingAge, Argentum, AANAC,
McKnight's, state assisted-living associations, "free tools for [industry]" lists.
Pitch it as free and genuinely useful (it is), not as a sales page.

**5. Add Open Graph tags** to `docs/index.html`'s `<head>` so shared links show a
nice preview — more clicks per share.

**6. Cheapest quality-preserving cost cuts** (when you're ready): pre-bake the 10
template diagrams so they render with zero API calls, and cache custom results by
prompt hash. Both cut spend without touching output quality.

---

*The two code files are heavily commented — search for the `CONFIG` block in
`docs/index.html` and the `LIMITS` block in `server/index.js`.*
