// Playwright harness: real scanner page + in-process V30 GateWeb mock. No deploy, no GitHub push.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('/workspace/ssam-ux-review/node_modules/playwright');
const gateSrc = readFileSync('/workspace/ssam-v30/clipboard-source/GateWeb.txt', 'utf8');

function loadGate() {
  const module = { exports: {} };
  vm.runInNewContext(gateSrc, { module, exports: module.exports }, { filename: 'GateWeb.txt' });
  return module.exports;
}
function sha256Bytes(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return [...crypto.createHash('sha256').update(buf).digest()];
}
function hex(bytes) { return Buffer.from(bytes).toString('hex'); }
function hmac(body, key) { return crypto.createHmac('sha256', String(key)).update(String(body)).digest('base64url'); }
function b64url(text) { return Buffer.from(String(text), 'utf8').toString('base64url'); }
function b64decode(text) { return Buffer.from(String(text), 'base64url').toString('utf8'); }
function randomHex(n) { return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n); }

const T = (id, tok, bk, label, extra) => Object.assign({
  ticketId: id, token: tok, bookingId: bk, personLabel: label,
  checkedInAt: '', checkedOutAt: '', checkedInBy: '', checkedOutBy: '',
  checkInRequestId: '', checkOutRequestId: '', lastCheckIn: '', lastCheckOut: ''
}, extra || {});

function makeService() {
  const gate = loadGate();
  const salt = 'aabbccdd11223344';
  const secret = 'test';
  const hash = gate.hashStaffSecret(secret, salt, sha256Bytes, hex);
  const now = Date.parse('2027-03-13T19:05:00+08:00');
  const db = {
    props: {
      GATE_HMAC_KEY: 'ab'.repeat(32), GATE_EPOCH: '1', GATE_DENY_JSON: '[]', GATE_AUTH_JSON: '',
      STAFF_JSON: JSON.stringify({ users: [{ username: 'gate', role: 'gate', salt, hash }] })
    },
    tickets: [
      T('tix_aaaa1111', 'TokSecretA12345', 'bk_p', 'Dela Cruz, Juana Testa'),
      T('tix_aaaa2222', 'TokSecretB12345', 'bk_p', 'Reyes, Pedro Fake'),
      T('tix_inside99', 'TokSecretI12345', 'bk_i', 'Santos, Already Inside', { checkedInAt: '2027-03-13T11:00:00.000Z' })
    ],
    bookings: [
      { id: 'bk_p', tier: 'early', plan: 'full', headcount: '2', section: 'Hedwig', fullName: 'Dela Cruz, Juana Testa', status: 'paid', balance: '0', email: 'x@yahoo.com', mobile: '09170000001', source: 'uat' },
      { id: 'bk_i', tier: 'early', plan: 'full', headcount: '1', section: 'Anysia', fullName: 'Santos, Already Inside', status: 'paid', balance: '0', source: 'uat' }
    ],
    audit: [],
    attendance: []
  };
  return { service: gate.createGateService({ db, now: () => now, sha256Bytes, hex, hmac, randomHex, b64url, b64decode }), db, secret };
}

const TYPES = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8' };

function startStatic() {
  const server = createServer((req, res) => {
    const path = join(root, decodeURIComponent((req.url || '/').split('?')[0]));
    const safe = path.startsWith(root) ? path : root;
    const file = safe.endsWith('/') || safe === root ? join(root, 'index.html') : safe;
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

const { service, db, secret } = makeService();
const server = await startStatic();
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
  headless: true
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.route(/https:\/\/script\.google\.com\/macros\/s\/.+/, async (route) => {
  let body = {};
  try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { body = {}; }
  const op = body && body.op;
  const result = typeof service[op] === 'function' ? service[op](body) : { ok: false, resultCode: 'rejected', message: 'That request is not available.' };
  await route.fulfill({ status: 200, contentType: 'text/plain;charset=utf-8', body: JSON.stringify(result) });
});
await page.goto('http://127.0.0.1:' + port + '/');
await page.fill('#user', 'gate');
await page.fill('#secret', secret);
await page.click('#signin-btn');
await page.waitForSelector('#desk:not([hidden])');
assert.equal(await page.locator('#count').innerText(), 'Inside now: 1');
assert.equal(await page.locator('#find h2').innerText(), 'Find by name or ticket number');

await page.fill('#query', 'Dela');
await page.click('#search-btn');
await page.waitForFunction(() => document.querySelectorAll('#hits .hit').length === 2);
const first = await page.locator('#hits .hit').nth(0).innerText();
const second = await page.locator('#hits .hit').nth(1).innerText();
assert.match(first, /Dela Cruz, Juana Testa/);
assert.match(first, /tix_aaaa1111/);
assert.match(first, /Not checked in/);
assert.match(second, /guest of Dela Cruz, Juana Testa/);
assert.equal(first.includes('TokSecret') || first.includes('yahoo') || first.includes('0917'), false);
assert.equal(second.includes('TokSecret') || second.includes('yahoo'), false);

const outDir = join(root, 'tests/shots');
mkdirSync(outDir, { recursive: true });
await page.locator('#find').screenshot({ path: join(outDir, 'search-results.png') });

await page.locator('#hits .hit').nth(0).getByRole('button', { name: 'Check in' }).click();
await page.waitForSelector('#find-confirm:not([hidden])');
const prompt = await page.locator('#find-confirm-text').innerText();
assert.match(prompt, /Check in Dela Cruz, Juana Testa/);
assert.match(prompt, /tix_aaaa1111/);
assert.match(prompt, /Nobody is checked in until you confirm/);
await page.locator('#find').screenshot({ path: join(outDir, 'search-confirm.png') });
await page.click('#find-confirm-btn');
await page.waitForFunction(() => document.getElementById('find-status').textContent.includes('Checked in'));
assert.match(await page.locator('#find-status').innerText(), /Checked in/);
assert.equal(await page.locator('#count').innerText(), 'Inside now: 2');
assert.equal(db.attendance.length, 1);
assert.equal(db.attendance[0].method, 'name_search');

await page.locator('#hits .hit').nth(0).getByRole('button', { name: 'Check in' }).click();
await page.click('#find-confirm-btn');
await page.waitForFunction(() => document.getElementById('find-status').textContent.includes('Already inside'));
assert.equal(await page.locator('#find-status').innerText(), 'Already inside. Nothing was changed.');
assert.equal(await page.locator('#find-status').getAttribute('class'), 'already_inside');
await page.locator('#find').screenshot({ path: join(outDir, 'search-already-inside.png') });

await page.fill('#query', 'Santos');
await page.click('#search-btn');
await page.waitForFunction(() => {
  const hits = [...document.querySelectorAll('#hits .hit')];
  return hits.length === 1 && hits[0].innerText.includes('Santos, Already Inside') && hits[0].innerText.includes('Inside');
});
await page.locator('#hits .hit').getByRole('button', { name: 'Check in' }).click();
await page.click('#find-confirm-btn');
await page.waitForFunction(() => document.getElementById('find-status').textContent.includes('Already inside'));
assert.equal(await page.locator('#find-status').innerText(), 'Already inside. Nothing was changed.');

await browser.close();
server.close();
console.log('PASS  playwright harness: search, confirm, already inside');
console.log('shots: ' + outDir);
