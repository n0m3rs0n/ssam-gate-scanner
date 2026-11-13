/* Gate desk controller: sign-in, QR lookup/act, and name/ticket search.
   No tickets or passwords are stored. The session token lives only in sessionStorage. */
(function (root) {
  var STATUS_WORDS = {
    not_arrived: 'Not checked in',
    inside: 'Inside',
    left: 'Left (no re-entry)'
  };

  function ticketToken(raw) {
    var match = /[?&]t=([A-Za-z0-9]+)/.exec(String(raw || ''));
    return match ? match[1] : String(raw || '');
  }

  function endpointOk(url) {
    try {
      var parsed = new URL(String(url || '').trim());
      return parsed.protocol === 'https:' &&
        parsed.hostname === 'script.google.com' &&
        /\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(parsed.pathname) &&
        !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
    } catch (err) {
      return false;
    }
  }

  function foldQuery(text) {
    var t = String(text || '').replace(/[\u00d1\u00f1]/g, 'n');
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function queryLongEnough(raw) {
    return foldQuery(raw).replace(/\s+/g, '').length >= 3;
  }

  function hitLabel(hit) {
    if (!hit || !hit.name) return '';
    if (hit.role === 'Guest' && hit.student) return hit.name + ' (guest of ' + hit.student + ')';
    return hit.name;
  }

  function publicHit(hit) {
    if (!hit || typeof hit !== 'object') return null;
    return {
      ticketId: String(hit.ticketId || ''),
      name: String(hit.name || ''),
      student: String(hit.student || ''),
      role: String(hit.role || ''),
      section: String(hit.section || ''),
      ticketType: String(hit.ticketType || ''),
      status: String(hit.status || ''),
      statusLabel: STATUS_WORDS[hit.status] || String(hit.status || '')
    };
  }

  function createGateDesk(opts) {
    var view = 'setup';
    var mode = 'check_in';
    var guest = null;
    var pendingToken = '';
    var requestSeq = 0;
    var busy = false;
    var listeners = [];
    var query = '';
    var hits = [];
    var more = false;
    var searchMessage = '';
    var searchCode = '';
    var confirmHit = null;
    var confirmRequestId = '';
    var resumeGen = 0;

    function snapshot() {
      return {
        view: view,
        mode: mode,
        guest: guest,
        pending: pendingToken ? 'held' : '',
        busy: busy,
        inside: guest && guest.inside != null ? guest.inside : (opts.inside || 0),
        query: query,
        hits: hits.slice(),
        more: more,
        searchMessage: searchMessage,
        searchCode: searchCode,
        confirmHit: confirmHit
      };
    }

    function emit() {
      var state = snapshot();
      listeners.forEach(function (fn) { fn(state); });
    }

    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (item) { return item !== fn; });
      };
    }

    function clearSearchConfirm() {
      confirmHit = null;
      confirmRequestId = '';
    }

    function cancelAutoResume() {
      resumeGen += 1;
    }

    function backToScan() {
      cancelAutoResume();
      pendingToken = '';
      guest = null;
      mode = 'check_in';
      view = 'scanning';
      emit();
      if (opts.resume) opts.resume();
      return snapshot();
    }

    function armAutoResume(ms) {
      resumeGen += 1;
      var id = resumeGen;
      opts.schedule(function () {
        if (id !== resumeGen) return;
        backToScan();
      }, ms || 1800);
    }

    function setEndpoint(url) {
      if (!opts.endpointOk(url)) {
        return { ok: false, message: 'Paste the gate web app address ending in /exec.' };
      }
      opts.storage.set('ssamGateEndpoint', String(url).trim());
      view = 'signin';
      emit();
      return { ok: true };
    }

    function signIn(username, secret) {
      if (busy) return Promise.resolve(snapshot());
      busy = true;
      emit();
      return opts.post({ op: 'login', username: username, secret: secret }).then(function (res) {
        busy = false;
        if (!res || !res.ok || !res.session) {
          emit();
          return { ok: false, message: res && res.message ? res.message : 'Those sign-in details were not accepted.' };
        }
        opts.storage.set('ssamGateSession', res.session);
        opts.inside = res.inside || 0;
        view = 'scanning';
        query = '';
        hits = [];
        more = false;
        searchMessage = '';
        searchCode = '';
        clearSearchConfirm();
        emit();
        return { ok: true };
      }).catch(function () {
        busy = false;
        emit();
        return { ok: false, message: 'The gate did not answer. Nothing was checked in.' };
      });
    }

    function onCode(raw) {
      if (view === 'review' || view === 'result' || busy || confirmHit) return Promise.resolve(snapshot());
      var token = ticketToken(raw);
      if (!token) return Promise.resolve(snapshot());
      pendingToken = token;
      view = 'review';
      mode = 'check_in';
      busy = true;
      emit();
      return opts.post({
        op: 'lookup',
        session: opts.storage.get('ssamGateSession'),
        ticket: token
      }).then(function (res) {
        busy = false;
        guest = res || { ok: false, resultCode: 'not_a_ticket', message: 'The gate did not answer.' };
        opts.inside = guest.inside || opts.inside || 0;
        if (guest.resultCode === 'not_a_ticket' || guest.status === 'inside' || guest.status === 'left') {
          opts.feedback(guest.resultCode === 'not_a_ticket' ? 'not_a_ticket' : guest.status);
          armAutoResume(1800);
        }
        emit();
        return snapshot();
      }).catch(function () {
        busy = false;
        guest = { ok: false, resultCode: 'rejected', message: 'The gate did not answer. Nothing was checked in.' };
        armAutoResume(1800);
        emit();
        return snapshot();
      });
    }

    function choose(nextMode) {
      if (nextMode === 'check_in' || nextMode === 'check_out') {
        cancelAutoResume();
        mode = nextMode;
        emit();
      }
      return snapshot();
    }

    function confirm() {
      if (busy || view !== 'review' || !guest || guest.ok === false) return Promise.resolve(snapshot());
      cancelAutoResume();
      busy = true;
      requestSeq += 1;
      var requestId = 'g' + requestSeq;
      emit();
      return opts.post({
        op: 'act',
        session: opts.storage.get('ssamGateSession'),
        ticket: pendingToken,
        mode: mode,
        requestId: requestId
      }).then(function (res) {
        busy = false;
        guest = res || guest;
        opts.inside = guest.inside || 0;
        view = 'result';
        opts.feedback(guest.resultCode || 'rejected');
        emit();
        opts.schedule(function () {
          backToScan();
        }, 900);
        return snapshot();
      }).catch(function () {
        busy = false;
        guest = { ok: false, resultCode: 'rejected', message: 'The gate did not answer. Nothing was checked in.' };
        view = 'result';
        emit();
        armAutoResume(1800);
        return snapshot();
      });
    }

    function dismiss() {
      return backToScan();
    }

    function setQuery(value) {
      query = String(value || '');
      return snapshot();
    }

    function search() {
      if (busy) return Promise.resolve(snapshot());
      if (!queryLongEnough(query)) {
        hits = [];
        more = false;
        searchCode = 'too_short';
        searchMessage = 'Type at least 3 letters of the surname, or the ticket number.';
        clearSearchConfirm();
        emit();
        return Promise.resolve(snapshot());
      }
      busy = true;
      searchMessage = 'Searching paid tickets, please wait…';
      searchCode = '';
      clearSearchConfirm();
      emit();
      return opts.post({
        op: 'search',
        session: opts.storage.get('ssamGateSession'),
        query: query
      }).then(function (res) {
        busy = false;
        if (res && res.inside != null) opts.inside = res.inside;
        if (!res || res.ok === false) {
          hits = [];
          more = false;
          searchCode = res && res.resultCode ? res.resultCode : 'rejected';
          searchMessage = res && res.message ? res.message : 'The gate did not answer. Nothing was checked in.';
          emit();
          return snapshot();
        }
        hits = (res.results || []).map(publicHit).filter(Boolean).slice(0, 10);
        more = !!res.more;
        searchCode = res.resultCode || (hits.length ? 'found' : 'none');
        searchMessage = hits.length ? '' : (res.message || 'No paid ticket matches that. Check the spelling or try the ticket number.');
        emit();
        return snapshot();
      }).catch(function () {
        busy = false;
        hits = [];
        more = false;
        searchCode = 'rejected';
        searchMessage = 'The gate did not answer. Nothing was checked in.';
        emit();
        return snapshot();
      });
    }

    function askAct(ticketId, actMode) {
      if (busy) return snapshot();
      if (actMode !== 'check_in' && actMode !== 'check_out') return snapshot();
      var hit = null;
      hits.forEach(function (row) { if (row.ticketId === ticketId) hit = row; });
      if (!hit) return snapshot();
      requestSeq += 1;
      confirmRequestId = 'n' + requestSeq;
      confirmHit = { ticketId: hit.ticketId, name: hit.name, section: hit.section, mode: actMode };
      searchMessage = '';
      searchCode = '';
      emit();
      return snapshot();
    }

    function cancelAct() {
      clearSearchConfirm();
      emit();
      return snapshot();
    }

    function confirmAct() {
      if (busy || !confirmHit) return Promise.resolve(snapshot());
      var pending = confirmHit;
      var requestId = confirmRequestId;
      busy = true;
      emit();
      return opts.post({
        op: 'act_by_ticket',
        session: opts.storage.get('ssamGateSession'),
        ticketId: pending.ticketId,
        mode: pending.mode,
        requestId: requestId
      }).then(function (res) {
        busy = false;
        var result = res || { ok: false, resultCode: 'rejected', message: 'The gate did not answer. Nothing was checked in.' };
        if (result.inside != null) opts.inside = result.inside;
        hits = hits.map(function (row) {
          if (row.ticketId !== pending.ticketId) return row;
          var next = publicHit(row);
          if (result.status) {
            next.status = String(result.status);
            next.statusLabel = STATUS_WORDS[next.status] || next.status;
          }
          return next;
        });
        searchCode = result.resultCode || 'rejected';
        searchMessage = result.message || (result.name ? result.name + ': ' + searchCode : searchCode);
        if (result.resultCode === 'checked_in' || result.resultCode === 'checked_out') {
          opts.feedback(result.resultCode);
        }
        clearSearchConfirm();
        emit();
        return snapshot();
      }).catch(function () {
        busy = false;
        searchCode = 'rejected';
        searchMessage = 'The gate did not answer. Nothing was checked in.';
        emit();
        return snapshot();
      });
    }

    function signOut() {
      cancelAutoResume();
      var session = opts.storage.get('ssamGateSession');
      opts.storage.remove('ssamGateSession');
      pendingToken = '';
      guest = null;
      query = '';
      hits = [];
      more = false;
      searchMessage = '';
      searchCode = '';
      clearSearchConfirm();
      view = 'signin';
      emit();
      if (session) opts.post({ op: 'logout', session: session }).catch(function () {});
      return snapshot();
    }

    if (opts.storage.get('ssamGateSession') && opts.endpointOk(opts.storage.get('ssamGateEndpoint'))) view = 'scanning';
    else if (opts.endpointOk(opts.storage.get('ssamGateEndpoint'))) view = 'signin';

    return {
      subscribe: subscribe,
      snapshot: snapshot,
      setEndpoint: setEndpoint,
      signIn: signIn,
      onCode: onCode,
      choose: choose,
      confirm: confirm,
      dismiss: dismiss,
      signOut: signOut,
      setQuery: setQuery,
      search: search,
      askAct: askAct,
      cancelAct: cancelAct,
      confirmAct: confirmAct
    };
  }

  async function postToGate(url, body) {
    if (!endpointOk(url)) throw new Error('The gate address is not an Apps Script web app.');
    var response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body || {})
    });
    var text = await response.text();
    try { return JSON.parse(text); }
    catch (err) { throw new Error('The gate did not answer.'); }
  }

  var api = {
    createGateDesk: createGateDesk,
    ticketToken: ticketToken,
    endpointOk: endpointOk,
    foldQuery: foldQuery,
    queryLongEnough: queryLongEnough,
    hitLabel: hitLabel,
    publicHit: publicHit,
    postToGate: postToGate,
    STATUS_WORDS: STATUS_WORDS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ssamGate = api;
})(typeof window !== 'undefined' ? window : globalThis);
