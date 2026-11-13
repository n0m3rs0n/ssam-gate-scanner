// Regression tests for the a685662 "doesn't scan" bug:
// 1) the 3:4 preview must be hidden during review/result so the result card is on screen
// 2) the decode loop must keep scheduling after empty frames
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const deskApi = require(join(root, 'assets/gate-desk.js'));

const src = readFileSync(join(root, 'assets/app.js'), 'utf8');
const start = src.indexOf('function videoIsHidden');
const end = src.indexOf('  var setupEl');
assert.ok(start >= 0 && end > start, 'could not extract camera helpers from app.js');

const module = { exports: {} };
const api = deskApi;
vm.runInNewContext(
  src.slice(start, end) +
    '\nmodule.exports = { createCamera, cameraError, videoIsHidden, scaleFrame };',
  { module, exports: module.exports, api, Date, Promise, console },
  { filename: 'app-camera-extract.js' }
);
const { createCamera, videoIsHidden } = module.exports;

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

await check('videoIsHidden: hide the 3:4 preview on review/result so the card is visible', () => {
  assert.equal(videoIsHidden('scanning', 'scanning'), false);
  assert.equal(videoIsHidden('scanning', 'starting'), false);
  assert.equal(videoIsHidden('scanning', 'holding'), false);
  assert.equal(videoIsHidden('scanning', 'idle'), true);
  assert.equal(videoIsHidden('scanning', 'error'), true);
  // The a685662 regression: preview stayed visible while holding during review,
  // covering Confirm / Already inside on a phone-sized viewport.
  assert.equal(videoIsHidden('review', 'holding'), true);
  assert.equal(videoIsHidden('result', 'holding'), true);
  assert.equal(videoIsHidden('review', 'scanning'), true);
  assert.equal(videoIsHidden('signin', 'idle'), true);
});

function makeCamera(opts) {
  const queued = [];
  const video = { videoWidth: 640, videoHeight: 480, play: function () { return Promise.resolve(); } };
  let frames = opts.frames || [];
  const camera = createCamera({
    secureContext: true,
    getUserMedia: function () { return Promise.resolve({ getTracks: function () { return []; } }); },
    video: video,
    decodeFrame: function () {
      const next = frames.length ? frames.shift() : '';
      return Promise.resolve(next);
    },
    schedule: function (fn) { queued.push(fn); }
  });
  return {
    camera,
    video,
    drain: async function (n) {
      const max = n == null ? 50 : n;
      let steps = 0;
      let idle = 0;
      while (steps < max && idle < 8) {
        if (queued.length) {
          steps += 1;
          idle = 0;
          queued.shift()();
        } else {
          idle += 1;
        }
        await Promise.resolve();
      }
      // Flush the last decodeFrame promise so loop() has a chance to reschedule.
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      return steps;
    },
    pending: function () { return queued.length; },
    setFrames: function (next) { frames = next.slice(); }
  };
}

await check('decode loop keeps scheduling after empty frames, then holds on a QR', async () => {
  const harness = makeCamera({ frames: ['', '', '', 'https://example.com/?t=TokSecretA12345'] });
  const events = [];
  harness.camera.subscribe(function (snap) { events.push(snap.state + ':' + snap.token); });
  await harness.camera.start({ facingMode: 'environment' });
  assert.equal(harness.camera.snapshot().state, 'scanning');
  const steps = await harness.drain(20);
  assert.ok(steps >= 4, 'expected several loop turns, got ' + steps);
  const snap = harness.camera.snapshot();
  assert.equal(snap.state, 'holding');
  assert.equal(snap.token, 'TokSecretA12345');
  const pendingAfterHold = harness.pending();
  await harness.drain(10);
  assert.equal(harness.pending(), pendingAfterHold, 'loop must stop after a hold; missed schedule would also fail a later QR');
  assert.ok(events.includes('holding:TokSecretA12345'));
});

await check('scanAgain resumes the same stream and can accept a different QR', async () => {
  const harness = makeCamera({ frames: ['TokOne'] });
  await harness.camera.start({ facingMode: 'environment' });
  await harness.drain(10);
  assert.equal(harness.camera.snapshot().state, 'holding');
  assert.equal(harness.camera.snapshot().token, 'TokOne');
  harness.setFrames(['', 'TokTwo']);
  await harness.camera.scanAgain();
  await harness.drain(10);
  assert.equal(harness.camera.snapshot().state, 'holding');
  assert.equal(harness.camera.snapshot().token, 'TokTwo');
});

await check('same-code cooldown does not freeze the loop; a later rescan can hold again', async () => {
  const harness = makeCamera({ frames: ['TokSame'] });
  await harness.camera.start({ facingMode: 'environment' });
  await harness.drain(10);
  assert.equal(harness.camera.snapshot().token, 'TokSame');
  harness.setFrames(['TokSame', 'TokSame', 'TokSame']);
  await harness.camera.scanAgain();
  // Immediately after resume, the same token is in the 1.2s cooldown.
  // The loop must keep running (not sit in holding with no new emit).
  await harness.drain(6);
  assert.equal(harness.camera.snapshot().state, 'scanning', 'cooldown must not re-enter holding immediately');
  assert.ok(harness.pending() > 0, 'loop must still be scheduled during cooldown');
  assert.equal(harness.camera.snapshot().token, '');
});

console.log(results.join('\n'));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
