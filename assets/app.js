/* Gate scanner page: camera, QR review, and name/ticket search. */
(function () {
  var api = window.ssamGate;
  var DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzfapi6GC4acvDDgFDoaONEktH771Rl4oVrHcnRjyGIl09mBb-CpUnXIOuif5mkdpS1/exec';

  function scaleFrame(width, height, maxSide) {
    var w = Number(width) || 0, h = Number(height) || 0;
    if (w < 1 || h < 1) return { width: 0, height: 0 };
    var scale = Math.min(1, maxSide / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  function decodeImageData(image, decoder) {
    if (!image || typeof decoder !== 'function') return '';
    var result = decoder(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    return result && result.data ? String(result.data) : '';
  }

  function cameraError(err) {
    var name = err && err.name ? String(err.name) : 'Error';
    var message = 'The camera did not start. Nothing was checked in.';
    if (name === 'NotAllowedError') message = 'The browser refused the camera. Nothing was checked in.';
    else if (name === 'NotFoundError') message = 'No camera was found. Nothing was checked in.';
    else if (name === 'NotReadableError') message = 'The camera is already in use. Nothing was checked in.';
    else if (name === 'OverconstrainedError') message = 'That camera is not available. Try the other one. Nothing was checked in.';
    else if (name === 'SecurityError') message = 'This page cannot use the camera from here. Nothing was checked in.';
    return { errorName: name, error: message };
  }

  function createCamera(opts) {
    var state = 'idle', facing = 'environment', token = '', error = '', errorName = '', stream = null, gen = 0, listeners = [];

    function snapshot() {
      return { state: state, facing: facing, token: token, error: error, errorName: errorName };
    }
    function emit() {
      var current = snapshot();
      listeners.forEach(function (fn) { fn(current); });
    }
    function stopTracks(current) {
      if (!current || typeof current.getTracks !== 'function') return;
      current.getTracks().forEach(function (track) { if (track && track.stop) track.stop(); });
    }
    function clearStream() {
      stopTracks(stream);
      stream = null;
      if (opts.video) opts.video.srcObject = null;
    }
    function loop(id) {
      opts.schedule(function () {
        if (id !== gen || state !== 'scanning') return;
        if (!opts.video || !opts.video.videoWidth) { loop(id); return; }
        Promise.resolve().then(function () { return opts.decodeFrame(opts.video); }).then(function (raw) {
          if (id !== gen || state !== 'scanning') return;
          if (raw) {
            token = api.ticketToken(raw);
            state = 'holding';
            error = '';
            errorName = '';
            gen += 1;
            clearStream();
            emit();
            return;
          }
          loop(id);
        }).catch(function () {
          if (id === gen && state === 'scanning') loop(id);
        });
      });
    }
    function start(options) {
      if (opts.secureContext === false) {
        state = 'error';
        errorName = 'SecurityError';
        error = 'This page is not the top-level secure page, so the camera stays off. Nothing was checked in.';
        emit();
        return Promise.resolve(snapshot());
      }
      if (typeof opts.getUserMedia !== 'function') {
        state = 'error';
        errorName = 'NotSupportedError';
        error = 'This browser has no camera API. Nothing was checked in.';
        emit();
        return Promise.resolve(snapshot());
      }
      gen += 1;
      var id = gen;
      clearStream();
      facing = options && options.facingMode === 'user' ? 'user' : 'environment';
      state = 'starting';
      token = '';
      error = '';
      errorName = '';
      emit();
      return Promise.resolve().then(function () {
        return opts.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
      }).then(function (next) {
        if (id !== gen) { stopTracks(next); return snapshot(); }
        stream = next;
        opts.video.srcObject = next;
        opts.video.muted = true;
        if (opts.video.setAttribute) opts.video.setAttribute('playsinline', '');
        return Promise.resolve(opts.video.play()).then(function () {
          if (id === gen) { state = 'scanning'; emit(); loop(id); }
          return snapshot();
        });
      }).catch(function (err) {
        if (id !== gen) return snapshot();
        clearStream();
        var mapped = cameraError(err);
        state = 'error';
        errorName = mapped.errorName;
        error = mapped.error;
        emit();
        return snapshot();
      });
    }
    function stop() {
      gen += 1;
      clearStream();
      if (state !== 'holding') { state = 'idle'; error = ''; errorName = ''; }
      emit();
      return snapshot();
    }
    return {
      start: start,
      stop: stop,
      switchCamera: function () { return start({ facingMode: facing === 'environment' ? 'user' : 'environment' }); },
      scanAgain: function () { return start({ facingMode: facing }); },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (item) { return item !== fn; }); };
      },
      snapshot: snapshot
    };
  }

  var setupEl = document.getElementById('setup');
  var signinEl = document.getElementById('signin');
  var deskEl = document.getElementById('desk');
  var reviewEl = document.getElementById('review');
  var videoEl = document.getElementById('view');
  var statusEl = document.getElementById('status');
  var findEl = document.getElementById('find');
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  var detector = null;
  var storage = {
    get: function (key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } },
    set: function (key, value) { try { sessionStorage.setItem(key, value); } catch (e) {} },
    remove: function (key) { try { sessionStorage.removeItem(key); } catch (e) {} }
  };

  if (!storage.get('ssamGateEndpoint') && DEFAULT_ENDPOINT) storage.set('ssamGateEndpoint', DEFAULT_ENDPOINT);
  try { if (window.BarcodeDetector) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }

  function decodeFromVideo(video) {
    var size = scaleFrame(video.videoWidth, video.videoHeight, 720);
    if (!size.width) return '';
    canvas.width = size.width;
    canvas.height = size.height;
    ctx.drawImage(video, 0, 0, size.width, size.height);
    return decodeImageData(ctx.getImageData(0, 0, size.width, size.height), window.jsQR);
  }

  function decodeFrame(video) {
    if (detector) {
      return detector.detect(video).then(function (codes) {
        return codes && codes[0] && codes[0].rawValue ? String(codes[0].rawValue) : decodeFromVideo(video);
      }).catch(function () { return decodeFromVideo(video); });
    }
    return Promise.resolve(decodeFromVideo(video));
  }

  function beep(ok) {
    try {
      var audio = new AudioContext();
      var osc = audio.createOscillator();
      var gain = audio.createGain();
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.12);
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(ok ? 40 : [30, 40, 30]); } catch (e2) {}
  }

  var camera = createCamera({
    secureContext: window.isSecureContext,
    getUserMedia: navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? function (constraints) {
      return navigator.mediaDevices.getUserMedia(constraints);
    } : null,
    video: videoEl,
    decodeFrame: decodeFrame,
    schedule: function (fn) { requestAnimationFrame(fn); }
  });

  var desk = api.createGateDesk({
    endpointOk: api.endpointOk,
    storage: storage,
    post: function (body) { return api.postToGate(storage.get('ssamGateEndpoint'), body); },
    feedback: function (code) { beep(code === 'checked_in' || code === 'checked_out'); },
    schedule: function (fn, ms) { setTimeout(fn, ms); },
    resume: function () { camera.scanAgain(); }
  });

  function confirmText(pending) {
    if (!pending) return '';
    var verb = pending.mode === 'check_out' ? 'Check out' : 'Check in';
    var detail = [pending.section, pending.ticketId].filter(Boolean).join(', ');
    return verb + ' ' + pending.name + (detail ? ' (' + detail + ')' : '') + '? Nobody is checked in until you confirm.';
  }

  function paintHits(state) {
    var box = document.getElementById('hits');
    box.textContent = '';
    (state.hits || []).forEach(function (hit) {
      var row = document.createElement('article');
      row.className = 'hit';
      row.setAttribute('data-ticket', hit.ticketId);
      var name = document.createElement('p');
      name.className = 'hit-name';
      name.textContent = api.hitLabel(hit);
      var meta = document.createElement('p');
      meta.className = 'hit-meta';
      meta.textContent = [hit.role, hit.section, hit.ticketId].filter(Boolean).join(' · ');
      var st = document.createElement('p');
      st.className = 'hit-state ' + (hit.status || '');
      st.textContent = hit.statusLabel || hit.status || '';
      var actions = document.createElement('div');
      actions.className = 'actions';
      var inn = document.createElement('button');
      inn.type = 'button';
      inn.className = 'primary';
      inn.textContent = 'Check in';
      inn.addEventListener('click', function () { desk.askAct(hit.ticketId, 'check_in'); });
      var out = document.createElement('button');
      out.type = 'button';
      out.textContent = 'Check out';
      out.addEventListener('click', function () { desk.askAct(hit.ticketId, 'check_out'); });
      actions.appendChild(inn);
      actions.appendChild(out);
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(st);
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  function showView(view) {
    setupEl.hidden = view !== 'setup';
    signinEl.hidden = view !== 'signin';
    deskEl.hidden = view !== 'scanning' && view !== 'review' && view !== 'result';
    reviewEl.hidden = view !== 'review' && view !== 'result';
    if (findEl) findEl.hidden = view !== 'scanning';
  }

  function paint(state) {
    showView(state.view);
    var count = document.getElementById('count');
    if (count) count.textContent = 'Inside now: ' + (state.inside || 0);
    var guest = state.guest;
    document.getElementById('who').textContent = guest && guest.name ? guest.name : (guest && guest.message ? guest.message : '');
    document.getElementById('meta').textContent = guest && guest.name ? [guest.ticketType, guest.section].filter(Boolean).join(' · ') : '';
    var stateEl = document.getElementById('state');
    stateEl.textContent = guest && guest.message ? guest.message : (guest && guest.status === 'inside' ? 'Already inside.' : '');
    stateEl.className = 'state ' + (guest && guest.resultCode ? guest.resultCode : (guest && guest.status ? guest.status : ''));
    document.getElementById('in').setAttribute('aria-pressed', state.mode === 'check_in' ? 'true' : 'false');
    document.getElementById('out').setAttribute('aria-pressed', state.mode === 'check_out' ? 'true' : 'false');
    var canConfirm = state.view === 'review' && guest && guest.ok !== false && guest.resultCode !== 'not_a_ticket';
    document.getElementById('confirm').hidden = !canConfirm;
    if (state.view === 'scanning') {
      statusEl.textContent = camera.snapshot().error || (camera.snapshot().state === 'scanning' ? 'Rear camera is on. Hold the QR in the frame.' : 'The camera is off.');
    }
    videoEl.hidden = state.view !== 'scanning' || camera.snapshot().state === 'idle';

    var queryEl = document.getElementById('query');
    if (queryEl && queryEl.value !== state.query && document.activeElement !== queryEl) queryEl.value = state.query || '';
    var findStatus = document.getElementById('find-status');
    findStatus.textContent = state.searchMessage || '';
    findStatus.className = state.searchCode || '';
    document.getElementById('find-more').hidden = !state.more;
    paintHits(state);
    var confirmBox = document.getElementById('find-confirm');
    confirmBox.hidden = !state.confirmHit;
    document.getElementById('find-confirm-text').textContent = confirmText(state.confirmHit);
    document.getElementById('search-btn').disabled = !!state.busy;
    document.getElementById('find-confirm-btn').disabled = !!state.busy;
  }

  desk.subscribe(paint);
  camera.subscribe(function () { paint(desk.snapshot()); });
  camera.subscribe(function (cam) {
    if (cam.state === 'holding' && cam.token) desk.onCode(cam.token);
  });
  paint(desk.snapshot());

  document.getElementById('save-endpoint').addEventListener('click', function () {
    var result = desk.setEndpoint(document.getElementById('endpoint').value);
    document.getElementById('setup-status').textContent = result.ok ? '' : result.message;
  });
  document.getElementById('signin-btn').addEventListener('click', function () {
    var secret = document.getElementById('secret');
    desk.signIn(document.getElementById('user').value, secret.value).then(function (res) {
      secret.value = '';
      document.getElementById('signin-status').textContent = res.ok ? '' : res.message;
    });
  });
  document.getElementById('rear').addEventListener('click', function () { camera.start({ facingMode: 'environment' }); });
  document.getElementById('front').addEventListener('click', function () { camera.start({ facingMode: 'user' }); });
  document.getElementById('stop').addEventListener('click', function () { camera.stop(); });
  document.getElementById('in').addEventListener('click', function () { desk.choose('check_in'); });
  document.getElementById('out').addEventListener('click', function () { desk.choose('check_out'); });
  document.getElementById('confirm').addEventListener('click', function () { desk.confirm(); });
  document.getElementById('skip').addEventListener('click', function () { desk.dismiss(); });
  document.getElementById('signout').addEventListener('click', function () { camera.stop(); desk.signOut(); });
  document.getElementById('search-btn').addEventListener('click', function () {
    desk.setQuery(document.getElementById('query').value);
    desk.search();
  });
  document.getElementById('query').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      desk.setQuery(document.getElementById('query').value);
      desk.search();
    }
  });
  document.getElementById('find-confirm-btn').addEventListener('click', function () { desk.confirmAct(); });
  document.getElementById('find-cancel').addEventListener('click', function () { desk.cancelAct(); });

  window.ssamGateApp = { desk: desk, camera: camera, confirmText: confirmText, paintHits: paintHits };
})();
