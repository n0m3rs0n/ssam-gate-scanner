// Local tests for the scanner name/ticket search desk, including a GateWeb mock.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const deskApi = require(join(root, 'assets/gate-desk.js'));
const gateSrc = readFileSync('/workspace/ssam-v30/clipboard-source/GateWeb.txt', 'utf8');

let failed = 0;
let passed = 0;
const results = [];

function check(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed += 1;
    results.push('PASS  ' + name);
  }).catch(function (err) {
    failed += 1;
    results.push('FAIL  ' + name + '  ' + (err && err.message ? err.message : err));
  });
}

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

function memory() {
  const bag = {};
  return {
    get: function (k) { return bag[k] || ''; },
    set: function (k, v) { bag[k] = String(v); },
    remove: function (k) { delete bag[k]; },
    bag: bag
  };
}

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
      GATE_HMAC_KEY: 'ab'.repeat(32),
      GATE_EPOCH: '1',
      GATE_DENY_JSON: '[]',
      GATE_AUTH_JSON: '',
      STAFF_JSON: JSON.stringify({
        users: [
          { username: 'gate', role: 'gate', salt: salt, hash: hash },
          { username: 'admin', role: 'admin', salt: salt, hash: hash },
          { username: 'treasurer', role: 'treasurer', salt: salt, hash: hash }
        ]
      })
    },
    tickets: [
      T('tix_aaaa1111', 'TokSecretA12345', 'bk_p', 'Dela Cruz, Juana Testa'),
      T('tix_aaaa2222', 'TokSecretB12345', 'bk_p', 'Reyes, Pedro Fake'),
      T('tix_eeee5555', 'TokSecretE12345', 'bk_u', 'Delarosa, Unpaid Person'),
      T('tix_dddd4444', 'TokSecretD12345', 'bk_d', 'Delacroix, Demo Only'),
      T('tix_inside99', 'TokSecretI12345', 'bk_i', 'Santos, Already Inside', { checkedInAt: '2027-03-13T11:00:00.000Z' })
    ],
    bookings: [
      { id: 'bk_p', tier: 'early', plan: 'full', headcount: '2', section: 'Hedwig', fullName: 'Dela Cruz, Juana Testa', status: 'paid', balance: '0', email: 'x@yahoo.com', mobile: '09170000001', source: 'uat' },
      { id: 'bk_u', tier: 'early', plan: 'full', headcount: '1', section: 'Beatriz', fullName: 'Delarosa, Unpaid Person', status: 'partially_paid', balance: '2500', source: 'uat' },
      { id: 'bk_d', tier: 'early', plan: 'full', headcount: '1', section: 'Anysia', fullName: 'Delacroix, Demo Only', status: 'paid', balance: '0', source: 'client_demo' },
      { id: 'bk_i', tier: 'early', plan: 'full', headcount: '1', section: 'Anysia', fullName: 'Santos, Already Inside', status: 'paid', balance: '0', source: 'uat' }
    ],
    audit: [],
    attendance: []
  };
  const service = gate.createGateService({
    db, now: function () { return now; }, sha256Bytes, hex, hmac, randomHex, b64url, b64decode
  });
  return { service, db, secret };
}

function makeDesk(service, posts, extras) {
  const store = memory();
  store.set('ssamGateEndpoint', 'https://script.google.com/macros/s/AKfycbzTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST/exec');
  const scheduled = [];
  const resumes = [];
  const desk = deskApi.createGateDesk(Object.assign({
    endpointOk: deskApi.endpointOk,
    storage: store,
    post: function (body) {
      posts.push(body);
      const op = body && body.op;
      if (typeof service[op] !== 'function') return Promise.resolve({ ok: false, resultCode: 'rejected', message: 'That request is not available.' });
      return Promise.resolve(service[op](body));
    },
    feedback: function () {},
    schedule: function (fn, ms) { scheduled.push({ fn, ms }); },
    resume: function () { resumes.push(Date.now()); }
  }, extras || {}));
  return { desk, store, posts, scheduled, resumes, flush: function () { const list = scheduled.splice(0); list.forEach(function (item) { item.fn(); }); } };
}

await check('queryLongEnough: 3 letters or a ticket number, accents count', () => {
  assert.equal(deskApi.queryLongEnough('de'), false);
  assert.equal(deskApi.queryLongEnough('Dela'), true);
  assert.equal(deskApi.queryLongEnough('tix_aaaa'), true);
  assert.equal(deskApi.queryLongEnough('Niño'), true);
});

await check('publicHit keeps only safe fields', () => {
  const cleaned = deskApi.publicHit({
    ticketId: 'tix_aaaa1111', name: 'Dela Cruz, Juana Testa', student: 'Dela Cruz, Juana Testa', role: 'Student',
    section: 'Hedwig', ticketType: 'Early bird · Couple', status: 'not_arrived',
    token: 'TokSecretA12345', email: 'x@yahoo.com', mobile: '09170000001', bookingId: 'bk_p'
  });
  const text = JSON.stringify(cleaned);
  assert.equal(cleaned.statusLabel, 'Not checked in');
  ['TokSecret', 'yahoo', '0917', 'bk_p', 'token', 'email', 'mobile', 'bookingId'].forEach((x) => {
    assert.equal(text.includes(x), false, x);
  });
});

await check('GateWeb: gate role can search and act_by_ticket; treasurer cannot sign in', async () => {
  const { service, secret } = makeService();
  const treasurer = service.login({ username: 'treasurer', secret });
  assert.equal(treasurer.ok, false);
  const gateLogin = service.login({ username: 'gate', secret });
  assert.equal(gateLogin.ok, true);
  assert.equal(gateLogin.role, 'gate');
  const res = service.search({ session: gateLogin.session, query: 'Dela' });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(res.results.map((r) => r.ticketId).sort()), JSON.stringify(['tix_aaaa1111', 'tix_aaaa2222']));
  const text = JSON.stringify(res);
  ['TokSecret', 'yahoo', '0917'].forEach((x) => assert.equal(text.includes(x), false, x));
});

await check('desk search: signed-out session is refused without leaking tickets', async () => {
  const { service } = makeService();
  const { desk } = makeDesk(service, []);
  desk.setQuery('Dela');
  const snap = await desk.search();
  assert.equal(snap.searchCode, 'signed_out');
  assert.equal(snap.hits.length, 0);
  assert.match(snap.searchMessage, /Sign in is required/);
});

await check('desk search: too short does not call the server', async () => {
  const { service, secret } = makeService();
  const posts = [];
  const { desk } = makeDesk(service, posts);
  await desk.signIn('gate', secret);
  posts.length = 0;
  desk.setQuery('de');
  const snap = await desk.search();
  assert.equal(snap.searchCode, 'too_short');
  assert.equal(posts.length, 0);
});

await check('desk search: paid tickets only, guest label, max 10, no emails or tokens in hits', async () => {
  const { service, secret } = makeService();
  const posts = [];
  const { desk } = makeDesk(service, posts);
  await desk.signIn('gate', secret);
  desk.setQuery('Dela');
  const snap = await desk.search();
  assert.equal(snap.searchCode, 'found');
  assert.equal(snap.hits.length, 2);
  assert.equal(deskApi.hitLabel(snap.hits[0]), 'Dela Cruz, Juana Testa');
  assert.equal(deskApi.hitLabel(snap.hits[1]), 'Reyes, Pedro Fake (guest of Dela Cruz, Juana Testa)');
  assert.equal(snap.hits[0].statusLabel, 'Not checked in');
  const text = JSON.stringify(snap.hits);
  ['TokSecret', 'yahoo', '0917', 'token', 'email', 'mobile'].forEach((x) => assert.equal(text.includes(x), false, x));
  assert.equal(posts.filter((p) => p.op === 'search').length, 1);
  desk.setQuery('zzzzzzz');
  const none = await desk.search();
  assert.equal(none.searchCode, 'none');
  assert.match(none.searchMessage, /No paid ticket/);
});

await check('desk: Check in waits for Confirm; already inside is clear; idempotent requestId', async () => {
  const { service, secret, db } = makeService();
  const posts = [];
  const { desk } = makeDesk(service, posts);
  await desk.signIn('gate', secret);
  desk.setQuery('Santos');
  await desk.search();
  posts.length = 0;
  const asked = desk.askAct('tix_inside99', 'check_in');
  assert.ok(asked.confirmHit);
  assert.equal(asked.confirmHit.mode, 'check_in');
  assert.equal(asked.confirmHit.name, 'Santos, Already Inside');
  assert.equal(posts.length, 0, 'no act until Confirm');
  const done = await desk.confirmAct();
  assert.equal(done.searchCode, 'already_inside');
  assert.equal(done.searchMessage, 'Already inside. Nothing was changed.');
  assert.equal(done.confirmHit, null);
  assert.equal(done.hits[0].status, 'inside');
  assert.equal(done.hits[0].statusLabel, 'Inside');
  assert.equal(db.attendance.length, 0);
  assert.equal(posts[0].op, 'act_by_ticket');
  assert.equal(posts[0].ticketId, 'tix_inside99');
  assert.match(posts[0].requestId, /^n\d+$/);
});

await check('desk: confirm check-in of a paid ticket logs name_search and cancel does nothing', async () => {
  const { service, secret, db } = makeService();
  const { desk } = makeDesk(service, []);
  await desk.signIn('gate', secret);
  desk.setQuery('tix_aaaa1111');
  await desk.search();
  desk.askAct('tix_aaaa1111', 'check_in');
  desk.cancelAct();
  assert.equal(desk.snapshot().confirmHit, null);
  assert.equal(db.attendance.length, 0);
  desk.askAct('tix_aaaa1111', 'check_in');
  const first = await desk.confirmAct();
  assert.equal(first.searchCode, 'checked_in');
  assert.equal(first.searchMessage, 'Checked in.');
  assert.equal(first.hits[0].status, 'inside');
  assert.equal(first.inside, 2, 'sample already-inside ticket plus this one');
  assert.equal(db.attendance.length, 1);
  assert.equal(db.attendance[0].action, 'check_in');
  assert.equal(db.attendance[0].method, 'name_search');
  assert.match(db.audit[0].detail, /via name_search/);
  desk.askAct('tix_aaaa1111', 'check_in');
  const again = await desk.confirmAct();
  assert.equal(again.searchCode, 'already_inside');
  assert.equal(db.attendance.length, 1);
});

await check('desk: QR check-in path is unchanged and does not use act_by_ticket', async () => {
  const { service, secret } = makeService();
  const posts = [];
  const { desk } = makeDesk(service, posts);
  await desk.signIn('gate', secret);
  posts.length = 0;
  const looked = await desk.onCode('TokSecretA12345');
  assert.equal(looked.view, 'review');
  assert.equal(looked.guest.name, 'Dela Cruz, Juana Testa');
  desk.choose('check_in');
  const done = await desk.confirm();
  assert.equal(done.guest.resultCode, 'checked_in');
  assert.deepEqual(posts.map((p) => p.op), ['lookup', 'act']);
  assert.equal(posts[1].ticket, 'TokSecretA12345');
});

await check('desk: rescan of an already-inside QR shows Already inside and stays until Scan next', async () => {
  const { service, secret } = makeService();
  const posts = [];
  const { desk, scheduled, resumes, flush } = makeDesk(service, posts);
  await desk.signIn('gate', secret);
  posts.length = 0;
  const first = await desk.onCode('TokSecretA12345');
  assert.equal(first.view, 'review');
  assert.equal(first.guest.status, 'not_arrived');
  assert.equal(scheduled.length, 0, 'fresh tickets wait for Confirm; no auto-resume');
  const checked = await desk.confirm();
  assert.equal(checked.guest.resultCode, 'checked_in');
  assert.equal(checked.view, 'result');
  assert.equal(scheduled[0].ms, 900);
  flush();
  assert.equal(desk.snapshot().view, 'scanning');
  assert.equal(desk.snapshot().pending, '');
  assert.equal(resumes.length, 1);

  const again = await desk.onCode('TokSecretA12345');
  assert.equal(again.view, 'review');
  assert.equal(again.guest.status, 'inside');
  assert.equal(again.guest.message, 'Already inside.');
  assert.equal(again.guest.resultCode, 'ready');
  assert.equal(scheduled.length, 0, 'Already inside stays on screen; no 1.8s auto-dismiss');
  assert.equal(posts.filter((p) => p.op === 'lookup').length, 2);
  assert.equal(desk.snapshot().view, 'review');
  desk.dismiss();
  assert.equal(desk.snapshot().view, 'scanning');
  assert.equal(resumes.length, 2);

  const third = await desk.onCode('TokSecretA12345');
  assert.equal(third.guest.message, 'Already inside.');
  assert.equal(third.view, 'review');
});

await check('desk: same-token ignore no longer swallows a rescan once back on scanning', async () => {
  const { service, secret } = makeService();
  const { desk, flush } = makeDesk(service, []);
  await desk.signIn('gate', secret);
  await desk.onCode('TokSecretI12345');
  const snap = desk.snapshot();
  assert.equal(snap.guest.status, 'inside');
  assert.equal(snap.guest.message, 'Already inside.');
  const blocked = await desk.onCode('TokSecretI12345');
  assert.equal(blocked.view, 'review', 'while review is up, a second decode is ignored');
  desk.dismiss();
  const after = await desk.onCode('TokSecretI12345');
  assert.equal(after.view, 'review');
  assert.equal(after.guest.message, 'Already inside.');
});

await check('desk: choosing Check out from an already-inside QR can still confirm it', async () => {
  const { service, secret, db } = makeService();
  const { desk, scheduled, flush } = makeDesk(service, []);
  await desk.signIn('gate', secret);
  const looked = await desk.onCode('TokSecretI12345');
  assert.equal(looked.guest.status, 'inside');
  assert.equal(looked.view, 'review');
  assert.equal(scheduled.length, 0);
  desk.choose('check_out');
  const done = await desk.confirm();
  assert.equal(done.guest.resultCode, 'checked_out');
  assert.equal(db.attendance.length, 1);
  assert.equal(db.attendance[0].action, 'check_out');
  flush();
  assert.equal(desk.snapshot().view, 'scanning');
});

await check('desk: unpaid and demo tickets cannot be acted on by ticket id', async () => {
  const { service, secret } = makeService();
  const { desk } = makeDesk(service, []);
  await desk.signIn('gate', secret);
  desk.setQuery('tix_eeee5555');
  const unpaid = await desk.search();
  assert.equal(unpaid.hits.length, 0);
  // Force an act against an unpaid id (as if the id were typed somehow).
  const denied = service.act_by_ticket({
    session: (await service.login({ username: 'gate', secret })).session,
    ticketId: 'tix_eeee5555',
    mode: 'check_in',
    requestId: 'n9'
  });
  assert.equal(denied.resultCode, 'not_a_ticket');
});

console.log(results.join('\n'));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
