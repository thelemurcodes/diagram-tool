/**
 * Local/CI end-to-end run: serves docs/ statically, starts the backend with
 * the recorded-response fake (no Anthropic key, no network), and drives a real
 * browser through a generate in BOTH modes. The page's CONFIG.API_ENDPOINT
 * points at production, so every API request is rewritten to the local
 * backend — proving the frontend/backend contract end to end, deterministically.
 *
 * Env:
 *   BACKEND_PORT   — local backend port (default 8080)
 *   FRONTEND_PORT  — local static docs/ port (default 3000)
 *   ALLOWED_ORIGIN — CORS origin for the local backend (default http://localhost:3000)
 *   EVIDENCE_DIR   — where screenshots go (default e2e-artifacts)
 *
 * Exits non-zero if either mode fails to render.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const BACKEND_PORT = process.env.BACKEND_PORT || '8080';
const FRONTEND_PORT = process.env.FRONTEND_PORT || '3000';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${FRONTEND_PORT}`;
const EVIDENCE_DIR = path.resolve(ROOT, process.env.EVIDENCE_DIR || 'e2e-artifacts');

const DESCRIBE_PROMPT = 'New resident admission: family inquiry, guided tour, care assessment, paperwork, room assignment, welcome orientation.';
const POLICY_TEXT = `Medication Administration Policy (excerpt). 1. Staff administering medication must verify the resident's identity, the medication, the dose, the route, and the time before administration (the "five rights"). 2. The MAR must be checked for allergies and potential interactions before any dose is given. 3. Medications are administered only by licensed staff; unlicensed staff may remind but not administer. 4. After administration, the MAR must be documented immediately. 5. A missed dose is reported to the charge nurse within 15 minutes and documented. 6. A medication error or refusal is reported to the charge nurse immediately.`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const BACKEND = `http://localhost:${BACKEND_PORT}`;

function serveDocs(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.normalize(path.join(DOCS, urlPath));
      if (!file.startsWith(DOCS)) {
        res.writeHead(403).end();
        return;
      }
      if (urlPath === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DOCS, 'index.html');
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404).end('not found');
          return;
        }
        // The served page targets the production endpoint; swap it for the
        // local fake-backed backend so the run is deterministic and keyless.
        // The backend answers CORS for the local origin (ALLOWED_ORIGIN).
        let body = data;
        if (path.basename(file) === 'index.html') {
          body = Buffer.from(
            data.toString('utf8').replace(/API_ENDPOINT:\s*"https?:\/\/[^"]+"/, `API_ENDPOINT: "${BACKEND}"`)
          );
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

function startBackend() {
  const child = spawn('node', [path.join(ROOT, 'server', 'dist', 'devServer.js')], {
    env: { ...process.env, PORT: BACKEND_PORT, ALLOWED_ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  return child;
}

async function waitFor(url, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} never became ready at ${url}`);
}

let backend; // hoisted so the failure handler below can always kill it

(async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const indexHtml = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const endpointMatch = indexHtml.match(/API_ENDPOINT:\s*"(https?:\/\/[^"]+)"(?!\/)/);
  const endpoint = endpointMatch ? endpointMatch[1] : null;
  if (!endpoint) throw new Error('CONFIG.API_ENDPOINT not found in docs/index.html');
  console.log(`[e2e] page endpoint ${endpoint} -> http://localhost:${BACKEND_PORT}`);

  backend = startBackend();
  await waitFor(`http://localhost:${BACKEND_PORT}/healthz`, 'backend');
  const docsServer = await serveDocs(FRONTEND_PORT);
  await waitFor(`http://localhost:${FRONTEND_PORT}/`, 'docs/');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const failures = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('api.anthropic.com')) failures.push('browser contacted api.anthropic.com');
  });

  await page.goto(`http://localhost:${FRONTEND_PORT}/`, { waitUntil: 'networkidle' });
  console.log('[e2e] docs/index.html loaded');

  async function generate(label, text) {
    await page.fill('#prompt', text);
    await page.click('#gen');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#diagram');
        return el && el.querySelector('svg');
      },
      null,
      { timeout: 60000 }
    );
    await page.waitForTimeout(1200);
    await expectWidthFit(`${label} initial render`);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `local-${label}-1280.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.locator('#diagram').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `local-${label}-390.png`) });
    const chars = (await page.inputValue('#code')).length;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
    await expectWidthFit(`${label} after resize`);
    console.log(`[e2e] ${label}: rendered, mermaid ${chars} chars`);
  }

  // Regression guard: the default fit (initial render and after a viewport
  // resize) must fit the diagram WIDTH (capped at 100%), top-aligned — not
  // shrink the whole diagram to the pane height, which made tall flowcharts
  // unreadably small. The "Fit to view" (⤢) button remains the explicit
  // whole-diagram fit.
  async function expectWidthFit(stageLabel) {
    const m = await page.evaluate(() => {
      const svg = document.querySelector('#diagram svg');
      if (!svg) return null;
      const vb = svg.viewBox.baseVal;
      const t = document.querySelector('#diagram').style.transform;
      const scale = parseFloat(t.match(/scale\(([\d.]+)\)/)[1]);
      const ty = parseFloat(t.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)[2]);
      return { vbW: vb.width, wrapW: document.querySelector('#canvas-wrap').clientWidth, scale, ty };
    });
    if (!m) { failures.push(`no diagram to check (${stageLabel})`); return; }
    const expected = Math.min((m.wrapW - 24) / m.vbW, 1);
    const ok = Math.abs(m.scale - expected) < 0.02 && m.ty > 0 && m.ty < 50;
    if (!ok) {
      failures.push(`default fit is not width-fit (${stageLabel}): scale ${m.scale.toFixed(3)} vs expected ${expected.toFixed(3)}, ty ${m.ty}px`);
    }
    console.log(`[e2e] ${stageLabel}: zoom ${(m.scale * 100).toFixed(0)}% (width-fit expected ${(expected * 100).toFixed(0)}%)`);
  }

  await generate('describe', DESCRIBE_PROMPT);
  await page.click('button.mode[data-mode="policy"]');
  await page.waitForTimeout(300);
  await generate('policy', POLICY_TEXT);

  await browser.close();
  docsServer.close();
  backend.kill();

  if (failures.length) throw new Error(`E2E FAILED: ${failures.join(' | ')}`);
  console.log('[e2e] PASS: describe + policy generated against the local fake backend');
})().catch((e) => {
  console.error('[e2e] FAILED:', e.message);
  process.exit(1);
});
