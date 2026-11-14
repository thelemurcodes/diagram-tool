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
  '.mjs': 'text/javascript',
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

  // Policy completeness review: the frontend re-sends the policy + diagram to
  // the SAME endpoint as a second model call. Intercept those requests (they
  // carry the "completeness review" instruction) and answer with a canned JSON
  // review so the checklist flow runs end to end, deterministically and
  // keyless. The recorded-response backend can't produce JSON reviews (its
  // fixtures are mermaid), and server/ is out of bounds for this branch.
  const REVIEW_JSON = JSON.stringify({
    normal_path: [
      'Verify the five rights before administration',
      'Document on the MAR immediately after administration',
    ],
    errors: ['Medication error is reported to the charge nurse immediately'],
    refusals: ['A refused dose is reported to the charge nurse'],
    exceptions: [
      { title: 'Missed dose', detail: 'A missed dose is reported to the charge nurse within 15 minutes and documented.' },
    ],
    missing: ['Allergy and interaction check is shown on the diagram'],
  });
  let reviewRequests = 0;
  await page.route((url) => url.toString().startsWith(`${BACKEND}/`), async (route) => {
    const req = route.request();
    const body = req.postData() || '';
    if (req.method() === 'POST' && body.includes('completeness review')) {
      reviewRequests++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
        body: JSON.stringify({ mermaid: REVIEW_JSON }),
      });
      return;
    }
    await route.continue();
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

  // Regression guard: describe mode must be unchanged — no completeness review
  // call, and the checklist never appears.
  const checklistHiddenAfterDescribe = await page.evaluate(
    () => document.querySelector('#checklist').classList.contains('hidden')
  );
  if (!checklistHiddenAfterDescribe) failures.push('checklist shown after describe generation');
  if (reviewRequests !== 0) failures.push(`completeness review fired in describe mode (${reviewRequests} calls)`);

  // Regression guard: the lead-capture prompt must never auto-open after a
  // generation completes. It opens only from an explicit click on #lead-open.
  async function expectLeadPromptClosed(stageLabel) {
    const state = await page.evaluate(() => ({
      promptHidden: document.querySelector('#lead-prompt').classList.contains('hidden'),
      entryVisible: !document.querySelector('#lead-entry').classList.contains('hidden'),
    }));
    if (!state.promptHidden) failures.push(`lead prompt auto-opened (${stageLabel})`);
    if (!state.entryVisible) failures.push(`lead entry point not visible (${stageLabel})`);
  }
  await expectLeadPromptClosed('after describe generation');

  // Explicit click opens the prompt; dismiss restores the entry point.
  await page.click('#lead-open');
  await page.waitForFunction(() => !document.querySelector('#lead-prompt').classList.contains('hidden'));
  console.log('[e2e] lead prompt opened from explicit click');
  await page.click('#lead-prompt-dismiss');
  await page.waitForFunction(() => document.querySelector('#lead-prompt').classList.contains('hidden'));
  await expectLeadPromptClosed('after dismissing lead prompt');

  await page.click('button.mode[data-mode="policy"]');
  await page.waitForTimeout(300);
  await generate('policy', POLICY_TEXT);
  await expectLeadPromptClosed('after policy generation');

  // Policy mode: the generation is followed by a completeness review call and
  // the checklist renders under the result.
  await page.waitForFunction(() => !document.querySelector('#checklist').classList.contains('hidden'), null, { timeout: 30000 });
  if (reviewRequests !== 1) failures.push(`expected exactly 1 completeness review call, got ${reviewRequests}`);
  const checklistState = await page.evaluate(() => ({
    heading: document.querySelector('#checklist h3')?.textContent || '',
    missingItems: Array.from(document.querySelectorAll('#checklist .cl-missing li')).map((li) => li.textContent),
    exceptionButtons: document.querySelectorAll('#checklist .cl-diag').length,
  }));
  if (!checklistState.heading.includes('Policy completeness review')) failures.push(`checklist heading wrong: ${checklistState.heading}`);
  if (checklistState.missingItems.length !== 1 || !checklistState.missingItems[0].includes('Allergy')) {
    failures.push(`missing-items section wrong: ${JSON.stringify(checklistState.missingItems)}`);
  }
  if (checklistState.exceptionButtons !== 1) failures.push(`expected 1 per-exception button, got ${checklistState.exceptionButtons}`);
  await page.locator('#checklist').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'local-policy-checklist-1280.png') });
  console.log('[e2e] policy checklist rendered with missing-item + exception row');

  // Per-exception "Diagram this": re-issues generation for that exception only,
  // with no second completeness review. The user's policy stays in the textarea.
  await page.click('#checklist .cl-diag');
  await page.waitForFunction(
    () => {
      const svgs = document.querySelectorAll('#diagram svg');
      return svgs.length > 0;
    },
    null,
    { timeout: 60000 }
  );
  await page.waitForFunction(() => document.querySelector('#checklist').classList.contains('hidden'), null, { timeout: 10000 });
  if (reviewRequests !== 1) failures.push(`per-exception generation must not trigger a review (got ${reviewRequests} total)`);
  const promptAfter = await page.inputValue('#prompt');
  if (!promptAfter.includes('Medication Administration Policy')) failures.push('per-exception generation clobbered the pasted policy');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'local-policy-exception-diagram-1280.png') });
  console.log('[e2e] per-exception diagram generated; policy preserved; review suppressed');

  // Print preview: opens from the toolbar, tiles per paper/orientation, and the
  // print stylesheet isolates #print-root from all app chrome.
  const PAPER_PX = { letter: [816, 1056], a4: [794, 1123] }; // must match index.html
  function expectedPrintLayout(vbW, vbH, paper, orient) {
    const [pw0, ph0] = PAPER_PX[paper];
    const [pw, ph] = orient === 'landscape' ? [ph0, pw0] : [pw0, ph0];
    const margin = 38;
    const scale = Math.min((pw - margin * 2) / vbW, 1);
    return { rows: Math.max(1, Math.ceil((vbH * scale) / (ph - margin * 2))), pw, ph };
  }

  await page.click('#t-print');
  await page.waitForFunction(() => !document.querySelector('#print-modal').classList.contains('hidden'));
  for (const paper of ['letter', 'a4']) {
    for (const orient of ['portrait', 'landscape']) {
      await page.selectOption('#print-paper', paper);
      await page.selectOption('#print-orient', orient);
      const m = await page.evaluate(() => {
        const svg = document.querySelector('#diagram svg');
        const vb = svg.viewBox.baseVal;
        const previewPages = document.querySelectorAll('#print-preview-pages .pp-page');
        const rootPages = document.querySelectorAll('#print-root .pp-page');
        return {
          vbW: vb.width, vbH: vb.height,
          preview: previewPages.length,
          root: rootPages.length,
          rootPageSize: rootPages[0] ? rootPages[0].style.width + ' x ' + rootPages[0].style.height : '',
          summary: document.querySelector('#print-summary').textContent,
        };
      });
      const exp = expectedPrintLayout(m.vbW, m.vbH, paper, orient);
      if (m.preview !== exp.rows) failures.push(`print preview ${paper}/${orient}: ${m.preview} pages, expected ${exp.rows}`);
      if (m.root !== exp.rows) failures.push(`print sheet ${paper}/${orient}: ${m.root} pages, expected ${exp.rows}`);
      if (m.rootPageSize !== `${exp.pw}px x ${exp.ph}px`) failures.push(`print page size ${paper}/${orient}: "${m.rootPageSize}", expected "${exp.pw}px x ${exp.ph}px"`);
      console.log(`[e2e] print preview ${paper}/${orient}: ${m.preview} page(s) ("${m.summary}"), sheet page ${m.rootPageSize}`);
    }
  }

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'local-print-preview-1280.png') });
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  const printState = await page.evaluate(() => ({
    root: getComputedStyle(document.querySelector('#print-root')).display,
    chrome: getComputedStyle(document.querySelector('.wrap')).display,
    modal: getComputedStyle(document.querySelector('#print-modal')).display,
    svgPresent: !!document.querySelector('#print-root svg'),
  }));
  if (printState.root !== 'block') failures.push(`print stylesheet: #print-root display ${printState.root}, expected block`);
  if (printState.chrome !== 'none') failures.push('print stylesheet: app chrome (.wrap) is not hidden');
  if (printState.modal !== 'none') failures.push('print stylesheet: preview dialog is not hidden');
  if (!printState.svgPresent) failures.push('print sheet has no diagram');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'local-print-stylesheet-1280.png') });
  await page.emulateMedia({ media: 'screen' });
  console.log('[e2e] print stylesheet isolates the page sheet from app chrome');

  await page.click('#print-cancel');
  await page.waitForFunction(() => document.querySelector('#print-modal').classList.contains('hidden'));
  if (!(await page.evaluate(() => !!document.querySelector('#diagram svg')))) failures.push('diagram missing after closing print preview');
  if ((await page.evaluate(() => document.querySelector('#print-root').children.length)) !== 0) failures.push('print sheet not cleared after closing preview');
  console.log('[e2e] print preview closed; screen rendering unchanged');

  await browser.close();
  docsServer.close();
  backend.kill();

  if (failures.length) throw new Error(`E2E FAILED: ${failures.join(' | ')}`);
  console.log('[e2e] PASS: describe + policy generated against the local fake backend');
})().catch((e) => {
  console.error('[e2e] FAILED:', e.message);
  process.exit(1);
});
