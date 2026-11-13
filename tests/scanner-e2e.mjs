// Real headless-Chromium + fake-camera proof for the v3 scanner fix.
// Does not contact the live gate; lookup is stubbed; act is blocked (no check-in).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/workspace/ssam-ux-review/node_modules/playwright');

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[3] || 'v3';
const y4m = process.env.SSAM_Y4M || '/tmp/ssam-e2e/qr8.y4m';
const outDir = process.env.SSAM_SHOTS || '/tmp/ssam-e2e/shots';
mkdirSync(outDir, { recursive: true });
const FAKE_EXEC = 'https://script.google.com/macros/s/AKfycbzTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST/exec';
const TYPES = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8' };

function startStatic(dir) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = urlPath === '/' ? join(dir, 'index.html') : join(dir, urlPath);
    if (!file.startsWith(dir)) { res.writeHead(403); res.end('no'); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function snap(page) {
  return page.evaluate(() => {
    const v = document.getElementById('view');
    const desk = window.ssamGateApp.desk.snapshot();
    const cam = window.ssamGateApp.camera.snapshot();
    return {
      count: document.getElementById('count').textContent,
      status: document.getElementById('status').textContent,
      who: document.getElementById('who').textContent,
      stateText: document.getElementById('state').textContent,
      reviewHidden: document.getElementById('review').hidden,
      videoHidden: v.hidden,
      videoWidth: v.videoWidth,
      paused: v.paused,
      deskView: desk.view,
      guestMessage: desk.guest && desk.guest.message,
      guestStatus: desk.guest && desk.guest.status,
      camState: cam.state,
      token: cam.token,
      jsQR: typeof window.jsQR,
      onCodeCount: (window.__scanTrace && window.__scanTrace.onCode.length) || 0
    };
  });
}

const posts = [];
const server = await startStatic(root);
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--disable-gesture-requirement-for-media-playback',
    '--autoplay-policy=no-user-gesture-required'
  ]
});
const context = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 390, height: 664 }
});
await context.grantPermissions(['camera'], { origin: `http://127.0.0.1:${port}` });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));

await page.route('https://script.google.com/**', async (route) => {
  let body = {};
  try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
  posts.push(body.op);
  if (body.op === 'login') {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, session: 'sess-test', inside: 1, role: 'gate' }) });
    return;
  }
  if (body.op === 'lookup') {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, resultCode: 'ready', status: 'inside', message: 'Already inside.',
      name: 'Bagnol, Sample', section: 'Anysia', ticketType: 'Early bird', ticketId: 'tix_3fb7e472', inside: 1
    }) });
    return;
  }
  // Never check anyone in or out.
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    ok: false, resultCode: 'already_inside', message: 'Already inside. Nothing was changed.', inside: 1
  }) });
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
if (await page.locator('#setup').isVisible()) {
  await page.fill('#endpoint', FAKE_EXEC);
  await page.click('#save-endpoint');
}
if (await page.locator('#signin').isVisible()) {
  await page.fill('#user', 'gate');
  await page.fill('#secret', 'test');
  await page.click('#signin-btn');
}
await page.waitForSelector('#desk:not([hidden])', { timeout: 8000 });

await page.evaluate(() => {
  window.__scanTrace = { onCode: [] };
  const orig = window.ssamGateApp.desk.onCode.bind(window.ssamGateApp.desk);
  window.ssamGateApp.desk.onCode = function (raw) {
    window.__scanTrace.onCode.push(String(raw || ''));
    return orig(raw);
  };
});

await page.click('#rear');
await page.waitForFunction(() => window.__scanTrace && window.__scanTrace.onCode.length > 0, { timeout: 8000 });
await page.waitForFunction(() => {
  const el = document.getElementById('state');
  return el && el.textContent.includes('Already inside');
}, { timeout: 5000 });

const first = await snap(page);
await page.screenshot({ path: join(outDir, label + '-result.png'), fullPage: true });

// The a685662/5737c6a bug: the card vanished at 1.8s, then a rescan could flash it
// back around 3s. Sample the whole window so a flicker still fails.
const hiddenDuring = await page.evaluate(async () => {
  const seen = [];
  const start = Date.now();
  while (Date.now() - start < 3000) {
    seen.push({
      hidden: document.getElementById('review').hidden,
      view: window.ssamGateApp.desk.snapshot().view,
      at: Date.now() - start
    });
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen;
});
const stayed = await snap(page);
stayed.hiddenDuring = hiddenDuring;
await page.screenshot({ path: join(outDir, label + '-stayed.png'), fullPage: true });

let scanNextOk = null;
let rescan = null;
const hasSkip = await page.locator('#skip').isVisible();
if (hasSkip) {
  await page.click('#skip');
  await page.waitForTimeout(400);
  scanNextOk = await snap(page);
  // After cooldown (1.2s) the same QR still in the fake camera should show the card again.
  await page.waitForFunction(() => {
    const el = document.getElementById('state');
    return el && !document.getElementById('review').hidden && el.textContent.includes('Already inside');
  }, { timeout: 8000 });
  rescan = await snap(page);
  await page.screenshot({ path: join(outDir, label + '-rescan.png'), fullPage: true });
}

await browser.close();
server.close();

const report = { label, root, errors, posts, first, stayed, scanNextOk, rescan, jsQRWasFunction: first.jsQR === 'function' };
writeFileSync(join(outDir, label + '-e2e.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

assert.deepEqual(errors, [], 'no page errors (jsQR must load)');
assert.equal(first.jsQR, 'function', 'jsQR must be a function');
assert.equal(first.reviewHidden, false, 'result card visible after first decode');
assert.match(first.stateText, /Already inside/);
assert.equal(first.who, 'Bagnol, Sample');
assert.equal(first.videoHidden, true, 'preview hides while the result is shown');
assert.equal(first.deskView, 'review');
assert.ok(!posts.includes('act') && !posts.includes('act_by_ticket'), 'must not check anyone in');

assert.equal(stayed.reviewHidden, false, 'result card must still be visible 3s later (no 1.8s auto-dismiss)');
assert.match(stayed.stateText, /Already inside/);
assert.equal(stayed.deskView, 'review');
const flickered = (stayed.hiddenDuring || []).filter((s) => s.hidden || s.view !== 'review');
assert.equal(flickered.length, 0, 'result card must not flicker away during the 3s window: ' + JSON.stringify(flickered.slice(0, 3)));

assert.ok(scanNextOk, 'Scan next should be available');
assert.equal(scanNextOk.deskView, 'scanning', 'Scan next returns to scanning');
assert.equal(scanNextOk.reviewHidden, true);
assert.equal(scanNextOk.videoHidden, false, 'preview returns after Scan next');

assert.ok(rescan, 'rescan should show a result');
assert.equal(rescan.reviewHidden, false);
assert.match(rescan.stateText, /Already inside/);
assert.equal(rescan.videoHidden, true);

console.log('PASS  e2e', label, ': first decode, card stays 3s, Scan next, rescan after cooldown');
