/* Basic EPUB Reader — sync client + desktop keys + LAN shelf
   helpers (injected at document end by the Linux shell; written
   platform-neutral on purpose: this same file is the web side the
   phone adopts as a channel bundle once the Android shell grows
   ReaderBridge.syncExchange — see SYNC-SPEC.md).

   SYNC CLIENT
   - Snapshot: for every shelf book whose content key is a real
     SHA-256 ('sha256:<hex>'), read its place from the core's own
     store (localStorage 'ber-progress-<id>': {cfi, pct, ts}) and
     its last-opened stamp from the book record.
   - Exchange: once shortly after boot (apply-on-open), again
     whenever the snapshot changes (checked on an interval and
     right after a book closes), via ReaderBridge.syncExchange.
   - Apply: the shell answers with window.__berSyncApply(map).
     Newer positions are written into the core's store immediately;
     a book that is OPEN right now is never yanked mid-read — its
     newer place waits in pendingForOpen and is applied by the
     openBook wrapper just before that book is next opened.

   DESKTOP KEYS (the laptop has no pinch and no tap):
   - Ctrl+mouse-wheel, '+' / '-' : text size, through the core's
     own font preference (cur.fontPct + saveFontPct) — the same
     store the pinch writes on the phone.
   - Right / Left arrows, Space, Page Down / Page Up: page turns.
   - Esc: leave full screen.  F11: toggle full screen.
   - R: read-aloud start/stop (the mouse's long-press). Plus,
     under the desktop shell only (see the 1.2.0 section below):
     a speaker button in the reader chrome, a right-click
     "Read aloud" entry on the page, and double-click for
     full screen. */
(function () {
  'use strict';

  /* ---------------- desktop keys ---------------- */
  function reading() {
    return document.body && document.body.classList.contains('reading');
  }
  function bumpFont(delta) {
    if (!window.cur || !cur.rendition) return;
    var min = window.FONT_MIN || 60, max = window.FONT_MAX || 240;
    var pct = Math.max(min, Math.min(max, (cur.fontPct || 110) + delta));
    if (pct === cur.fontPct) return;
    cur.fontPct = pct;
    try { cur.rendition.themes.fontSize(pct + '%'); } catch (e) {}
    try { saveFontPct(); } catch (e) {}
  }
  document.addEventListener('wheel', function (ev) {
    if (!ev.ctrlKey || !reading()) return;
    ev.preventDefault();
    bumpFont(ev.deltaY < 0 ? 10 : -10);
  }, { passive: false });
  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ev.key === 'Escape') {
      hideBerCtxMenu();
      if (window.__exitFullscreen) window.__exitFullscreen();
      return;
    }
    if (ev.key === 'F11') {
      ev.preventDefault();
      if (typeof setFullscreen === 'function' && typeof isFullscreen !== 'undefined')
        setFullscreen(!isFullscreen);
      return;
    }
    if (!reading()) return;
    if (ev.key === '+' || ev.key === '=') { bumpFont(10); return; }
    if (ev.key === '-' || ev.key === '_') { bumpFont(-10); return; }
    if ((ev.key === 'r' || ev.key === 'R') &&
        !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      /* Read-aloud (desktop 1.2.0): the phone starts it with a
         long-press, which a mouse cannot do — R is the desktop's
         press. It calls the core's own toggle: start reads from
         the top of the current page with sentence highlighting
         and automatic page turns; pressing R again stops. */
      if (typeof toggleTTS === 'function') {
        ev.preventDefault();
        toggleTTS();
      }
      return;
    }
    if (!window.cur || !cur.rendition) return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') {
      ev.preventDefault(); cur.rendition.next();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') {
      ev.preventDefault(); cur.rendition.prev();
    }
  });

  /* ---------------- desktop reader features (1.2.0) -----------
     Live only under the Linux shell: its bridge.js is what
     defines window.__berShellState — the Android shell never
     injects it — so if this file is ever adopted by the phone as
     a channel bundle, everything in this section stays inert.

     The phone starts read-aloud with a long-press; a mouse has
     no long-press. Desktop gets three doors into the core's own
     toggleTTS (same start at the top of the current page, same
     sentence highlighting and automatic page turns, same stop):
     a speaker button in the reader chrome, the R key, and a
     right-click "Read aloud" entry on the page.

     Double-click on the page toggles full screen. Care is needed:
     the core already turns a double-click's two constituent taps
     into exactly ONE toggle (its onTap stamps lastFsToggleAt
     under a 700 ms lock and swallows the second tap), so the
     handler below stands down when the core just toggled — one
     double-click, one toggle — and toggles itself only when the
     taps never landed (e.g. a recycled page document whose
     gesture handlers are gone). */
  var BER_DESKTOP = !!window.__berShellState;

  function ttsToggle() {
    if (typeof toggleTTS === 'function') toggleTTS();
  }
  function speechOn() {
    return !!(window.speech && speech.on);
  }

  /* speaker button in the reader chrome */
  function ensureSpeakBtn() {
    if (!BER_DESKTOP) return;
    var chrome = document.getElementById('readerChrome');
    if (!chrome || document.getElementById('berSpeakBtn')) return;
    var b = document.createElement('button');
    b.id = 'berSpeakBtn';
    b.className = 'barbtn';
    b.type = 'button';
    b.title = 'Read aloud (R)';
    b.textContent = '🔊 Read aloud';
    b.addEventListener('click', function () { ttsToggle(); });
    chrome.insertBefore(b, document.getElementById('ttsStopBtn') || null);
  }
  setInterval(function () {
    var b = document.getElementById('berSpeakBtn');
    if (b) b.textContent = speechOn() ? '🔊 Stop' : '🔊 Read aloud';
  }, 600);

  /* right-click "Read aloud" menu (one entry, core-styled) */
  var berCtxMenu = null;
  function ensureBerCtxMenu() {
    if (berCtxMenu) return berCtxMenu;
    var st = document.createElement('style');
    st.textContent =
      '#berCtxMenu{position:fixed;z-index:200;min-width:170px;' +
      'background:#fffaf0;color:#2a2118;border:2px solid #b98a45;' +
      'border-radius:10px;padding:6px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.65);' +
      'font-family:Georgia,serif;font-size:15px;}' +
      '#berCtxMenu.hidden{display:none;}' +
      '#berCtxMenu .berCtxItem{padding:8px 10px;border-radius:6px;' +
      'cursor:pointer;}' +
      '#berCtxMenu .berCtxItem:hover{background:#f0dfba;}';
    document.head.appendChild(st);
    berCtxMenu = document.createElement('div');
    berCtxMenu.id = 'berCtxMenu';
    berCtxMenu.className = 'hidden';
    var item = document.createElement('div');
    item.className = 'berCtxItem';
    item.setAttribute('data-act', 'tts');
    item.textContent = 'Read aloud';
    item.addEventListener('click', function () {
      hideBerCtxMenu();
      ttsToggle();
    });
    berCtxMenu.appendChild(item);
    document.body.appendChild(berCtxMenu);
    return berCtxMenu;
  }
  function hideBerCtxMenu() {
    if (berCtxMenu) berCtxMenu.classList.add('hidden');
  }
  document.addEventListener('mousedown', function (ev) {
    if (berCtxMenu && !berCtxMenu.classList.contains('hidden') &&
        !berCtxMenu.contains(ev.target)) hideBerCtxMenu();
  }, true);

  function onBerContextMenu(ev) {
    if (!reading()) return;
    ev.preventDefault();
    var menu = ensureBerCtxMenu();
    menu.querySelector('[data-act="tts"]').textContent =
      speechOn() ? 'Stop reading' : 'Read aloud';
    var x = ev.clientX, y = ev.clientY;
    try {
      /* Events from a page document live in the epub.js iframe;
         translate its coordinates into the top frame's. */
      var fr = ev.target && ev.target.ownerDocument &&
        ev.target.ownerDocument.defaultView &&
        ev.target.ownerDocument.defaultView.frameElement;
      if (fr) {
        var r = fr.getBoundingClientRect();
        x += r.left;
        y += r.top;
      }
    } catch (e) {}
    menu.style.left =
      Math.max(4, Math.min(x, window.innerWidth - 190)) + 'px';
    menu.style.top =
      Math.max(4, Math.min(y, window.innerHeight - 64)) + 'px';
    menu.classList.remove('hidden');
  }

  /* double-click full screen (coordination note at section head) */
  function onBerDblClick(ev) {
    if (!reading()) return;
    try {
      if (ev.target && ev.target.closest && ev.target.closest('a')) return;
    } catch (e) {}
    if (typeof window.lastFsToggleAt === 'number' &&
        Date.now() - window.lastFsToggleAt < 900) return;
    if (typeof setFullscreen === 'function' &&
        typeof isFullscreen !== 'undefined')
      setFullscreen(!isFullscreen);
  }

  function attachBerDoc(doc) {
    if (!doc || doc.__berDesktopDoc) return;
    doc.__berDesktopDoc = true;
    doc.addEventListener('dblclick', onBerDblClick);
    doc.addEventListener('contextmenu', onBerContextMenu);
  }
  var berHooked = false;
  function sweepBerDocs() {
    if (!BER_DESKTOP) return;
    ensureSpeakBtn();
    if (!(window.cur && cur.rendition)) return;
    try {
      var list = cur.rendition.getContents() || [];
      for (var i = 0; i < list.length; i++)
        if (list[i] && list[i].document) attachBerDoc(list[i].document);
      /* epub.js recycles page documents as it re-paginates; its
         content hook is how the core keeps its own handlers on
         the live one — ride the same hook. */
      if (!berHooked && cur.rendition.hooks &&
          cur.rendition.hooks.content) {
        berHooked = true;
        cur.rendition.hooks.content.register(function (contents) {
          if (contents && contents.document)
            attachBerDoc(contents.document);
        });
      }
    } catch (e) {}
  }
  if (BER_DESKTOP) {
    var vw = document.getElementById('viewerWrap');
    if (vw) vw.addEventListener('contextmenu', onBerContextMenu);
    /* Test hook for the shell's smoke suite: under WebKitGTK's
       multi-process model, events a script dispatches into an
       iframe document are silently dropped (real input is routed
       to the frame's own process and works), so the smoke drives
       these two handlers directly and separately proves the
       real-input path end to end. */
    window.__berDesktopHandlers = {
      dblclick: onBerDblClick,
      contextmenu: onBerContextMenu
    };
    sweepBerDocs();
  }

  /* ---------------- sync client ---------------- */
  var lastSentJson = null;
  var lastMerged = {};        // hexkey -> merged entry (newest seen)
  var pendingForOpen = {};    // hexkey -> entry for the open book
  var wrapped = false;

  function hexOf(rec) {
    return (rec && typeof rec.key === 'string' && rec.key.indexOf('sha256:') === 0)
      ? rec.key.slice(7) : null;
  }
  function localProgress(rec) {
    try {
      return JSON.parse(localStorage.getItem('ber-progress-' + rec.id) || 'null');
    } catch (e) { return null; }
  }
  async function buildSnapshot() {
    var books = {};
    var lib = window.library || [];
    for (var i = 0; i < lib.length; i++) {
      var rec = lib[i];
      if (!rec.key && typeof contentKey === 'function' && rec.data) {
        try { rec.key = await contentKey(rec.data); } catch (e) {}
      }
      var hex = hexOf(rec);
      if (!hex) continue;   // only real SHA-256 identities sync
      var p = localProgress(rec);
      books[hex] = {
        title: rec.title || '',
        cfi: p ? (p.cfi || null) : null,
        pct: p ? (p.pct || 0) : 0,
        positionUpdatedAt: p ? (p.ts || 0) : 0,
        lastOpenedAt: Math.max(rec.lastRead || 0, p ? (p.ts || 0) : 0),
        present: true
      };
    }
    return { books: books };
  }
  async function exchange() {
    if (!(window.ReaderBridge && ReaderBridge.syncExchange)) return;
    var snap = await buildSnapshot();
    var json = JSON.stringify(snap);
    if (json === lastSentJson) return;
    lastSentJson = json;
    try { ReaderBridge.syncExchange(json); } catch (e) {}
  }
  window.__berSyncNow = function () { lastSentJson = null; exchange(); };

  window.__berSyncApply = function (applyMap) {
    if (!applyMap) return;
    var lib = window.library || [];
    var byHex = {};
    lib.forEach(function (rec) { var h = hexOf(rec); if (h) byHex[h] = rec; });
    Object.keys(applyMap).forEach(function (hex) {
      var entry = applyMap[hex];
      lastMerged[hex] = entry;
      var rec = byHex[hex];
      if (!rec) return;   // a place for a book this device doesn't have: kept in the file, nothing to write
      if (window.cur && cur.id === rec.id) {
        pendingForOpen[hex] = entry;   // never yank an open book
        return;
      }
      writeLocal(rec, entry);
    });
    if (!(window.cur && cur.id) && typeof renderShelf === 'function') {
      try { renderShelf(); } catch (e) {}
    }
  };
  function writeLocal(rec, entry) {
    var p = localProgress(rec);
    if (p && (p.ts || 0) >= (entry.positionUpdatedAt || 0)) return;
    try {
      localStorage.setItem('ber-progress-' + rec.id, JSON.stringify({
        cfi: entry.cfi || null, pct: entry.pct || 0,
        ts: entry.positionUpdatedAt || 0
      }));
    } catch (e) {}
  }

  function wrapCore() {
    if (wrapped) return;
    if (typeof window.openBook !== 'function' ||
        typeof window.closeBook !== 'function') return;
    wrapped = true;
    var origOpen = window.openBook;
    window.openBook = function (id) {
      /* Apply-on-open, guaranteed: if a merged place newer than the
         local one is waiting for this book, land it in the core's
         store before the core reads it. */
      try {
        var lib = window.library || [];
        for (var i = 0; i < lib.length; i++) {
          if (lib[i].id !== id) continue;
          var hex = hexOf(lib[i]);
          var entry = (hex && (pendingForOpen[hex] || lastMerged[hex])) || null;
          if (entry) writeLocal(lib[i], entry);
        }
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    var origClose = window.closeBook;
    window.closeBook = function () {
      var r = origClose.apply(this, arguments);
      /* The core saves the final place ~350 ms after the last page
         turn; give it a beat, then publish. */
      setTimeout(function () { window.__berSyncNow(); }, 700);
      return r;
    };
  }

  /* ---------------- LAN sync shelf access (SYNC-SPEC §6) -------
     The desktop shell's LAN host cannot see IndexedDB; these are
     its hands. Each returns a Promise for a STRING (the shell polls
     a result box — WebKit's run_javascript does not await). */
  function bytesToB64(buf) {
    var bytes = new Uint8Array(buf), out = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(
        null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return btoa(out);
  }
  window.__berLanShelf = async function () {
    var snap = await buildSnapshot();
    var manifest = [];
    var lib = window.library || [];
    for (var i = 0; i < lib.length; i++) {
      var hex = hexOf(lib[i]);
      if (!hex) continue;
      manifest.push({
        key: hex, title: lib[i].title || '',
        size: (lib[i].data && lib[i].data.byteLength) || 0
      });
    }
    return JSON.stringify({ snapshot: snap, manifest: manifest });
  };
  window.__berLanBook = function (hex) {
    var lib = window.library || [];
    for (var i = 0; i < lib.length; i++) {
      if (hexOf(lib[i]) === hex && lib[i].data) {
        try { return Promise.resolve(bytesToB64(lib[i].data)); }
        catch (e) { return Promise.resolve(''); }
      }
    }
    return Promise.resolve('');
  };
  window.__berLanShelve = async function (b64) {
    /* The core's own import path — it dedupes by content key and
       answers 'added' or a dupe status, the same pipe folder
       import uses (minus the folder summary UI). */
    try {
      var r = await importBook(b64ToArrayBuffer(b64), true);
      if (typeof renderShelf === 'function') {
        try { renderShelf(); } catch (e) {}
      }
      window.__berSyncNow && __berSyncNow();
      return (r && r.status) || 'added';
    } catch (e) { return 'bad'; }
  };

  function boot() {
    wrapCore();
    sweepBerDocs();
    exchange();
    setInterval(function () { wrapCore(); sweepBerDocs(); exchange(); }, 4000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) window.__berSyncNow();
    });
  }
  /* The core boots async (IndexedDB); poll briefly for its library,
     then start. Sync must not hold up the shelf's first paint. */
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (Array.isArray(window.library) || tries > 40) {
      clearInterval(iv);
      setTimeout(boot, 400);
    }
  }, 250);
})();

/* ==================================================================
   PHONE SYNC SCREEN (v0.1.3 — the Android half of SYNC-SPEC §5+§6).

   Everything above this line is the platform-neutral sync client,
   byte-identical to the file the Linux shell injects (its
   desktop-only sections key off window.__berShellState, which the
   Android shell never defines, so they stay inert here).

   Below is the phone's Sync screen: the shelf-level "Sync" entry
   the desktop's sync window tells Joshua to choose. It drives the
   shell's LAN bridge (ReaderBridge.lan*): find the laptop (NSD)
   or type its address, enter the 6-digit code its window shows
   (pair once), then one tap syncs — places through the desktop's
   /sync (the same ber_sync merge the folder file uses, so the two
   transports can never disagree) and whole books by SHA-256,
   hash-verified before anything is shelved. Status text is
   honest: it says what happened, including failures.
   ================================================================== */
(function () {
  'use strict';
  if (window.__berShellState) return;          // desktop has its own UI
  var B = window.ReaderBridge;
  if (!B || !B.lanSyncNow) return;             // needs the 0.1.3 shell

  var paired = null;         // {deviceId, name, platform, addresses[]}
  var found = [];            // NSD results: {name, deviceId, addresses[]}
  var chosenAddr = '';       // address the Pair button will use
  var busy = false;

  function el(id) { return document.getElementById(id); }

  function inject() {
    if ($('syncBtn')) return;
    var tools = document.querySelector('.shelf-tools');
    if (!tools) return;
    var btn = document.createElement('button');
    btn.id = 'syncBtn';
    btn.className = 'toolbtn sync-btn';
    btn.type = 'button';
    btn.textContent = 'Sync';
    btn.addEventListener('click', openPanel);
    tools.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'syncPanel';
    panel.className = 'hidden';
    panel.innerHTML =
      '<div class="sync-card">' +
      '  <div class="sync-head">' +
      '    <div class="sync-title">Sync with your laptop</div>' +
      '    <button id="syncClose" class="barbtn" type="button">Close</button>' +
      '  </div>' +
      '  <div id="syncStatus" class="sync-status">Reading places also ' +
      'travel by themselves through your Epub folder.</div>' +
      '  <div id="syncPairView">' +
      '    <p class="sync-note">On the laptop, open Basic EPUB Reader, ' +
      'tap the menu (☰) in the top right, and choose ' +
      '<b>Sync with phone…</b> It shows a 6-digit code. Then:</p>' +
      '    <button id="syncFindBtn" class="toolbtn" type="button">' +
      'Find my laptop</button>' +
      '    <div id="syncFound"></div>' +
      '    <label class="sync-label">Laptop address ' +
      '(from its sync window)</label>' +
      '    <input id="syncAddr" class="sync-input" type="text" ' +
      'placeholder="e.g. 192.168.1.20" autocomplete="off">' +
      '    <label class="sync-label">Pairing code</label>' +
      '    <input id="syncCode" class="sync-input" type="tel" ' +
      'inputmode="numeric" maxlength="6" placeholder="6 digits" ' +
      'autocomplete="off">' +
      '    <button id="syncPairBtn" class="toolbtn" type="button">' +
      'Pair</button>' +
      '  </div>' +
      '  <div id="syncNowView" class="hidden">' +
      '    <p class="sync-note" id="syncPeerLine"></p>' +
      '    <button id="syncNowBtn" class="toolbtn" type="button">' +
      'Sync now</button>' +
      '    <button id="syncForgetBtn" class="toolbtn" type="button">' +
      'Forget this laptop</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(panel);

    el('syncClose').addEventListener('click', closePanel);
    el('syncFindBtn').addEventListener('click', function () {
      setStatus('Looking for your laptop on this network…');
      found = [];
      renderFound();
      try { B.lanDiscover(); } catch (e) {
        setStatus('Finding the laptop is not available on this phone — ' +
                  'type its address instead.');
      }
    });
    el('syncAddr').addEventListener('input', function () {
      chosenAddr = el('syncAddr').value.trim();
    });
    el('syncPairBtn').addEventListener('click', function () {
      var addr = (el('syncAddr').value || '').trim() || chosenAddr;
      var code = (el('syncCode').value || '').trim();
      if (!addr) {
        setStatus('Find your laptop or type its address first.');
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        setStatus('The pairing code is the 6 digits on the laptop’s ' +
                  'sync window.');
        return;
      }
      setBusy(true);
      setStatus('Pairing…');
      try { B.lanPair(addr, code); } catch (e) {
        setBusy(false);
        setStatus('Pairing could not start on this phone.');
      }
    });
    el('syncNowBtn').addEventListener('click', function () {
      setBusy(true);
      setStatus('Syncing…');
      try { B.lanSyncNow(); } catch (e) {
        setBusy(false);
        setStatus('Sync could not start on this phone.');
      }
    });
    el('syncForgetBtn').addEventListener('click', function () {
      try { B.lanForget(); } catch (e) {}
      paired = null;
      showPairView();
      setStatus('Pairing forgotten. Pair again whenever you like.');
    });
  }

  function setBusy(on) {
    busy = on;
    ['syncPairBtn', 'syncNowBtn', 'syncFindBtn'].forEach(function (id) {
      var b = el(id);
      if (b) b.disabled = on;
    });
  }
  function setStatus(msg) {
    var s = el('syncStatus');
    if (s) s.textContent = msg;
  }
  function showPairView() {
    el('syncPairView').classList.remove('hidden');
    el('syncNowView').classList.add('hidden');
  }
  function showNowView() {
    el('syncPairView').classList.add('hidden');
    el('syncNowView').classList.remove('hidden');
    el('syncPeerLine').textContent = paired
      ? 'Paired with ' + (paired.name || 'your laptop') +
        '. One tap exchanges reading places and any books either ' +
        'side is missing.'
      : '';
  }
  function refreshPaired() {
    paired = null;
    try {
      var raw = B.lanPairedInfo ? B.lanPairedInfo() : null;
      if (raw) paired = JSON.parse(raw);
    } catch (e) { paired = null; }
    if (paired && paired.name) showNowView(); else showPairView();
  }
  function openPanel() {
    inject();
    el('syncPanel').classList.remove('hidden');
    refreshPaired();
    if (paired) {
      setStatus('Ready when the laptop’s sync window is open. Away ' +
                'from home, its window must be left listening and ' +
                'Tailscale must be on.');
    } else {
      setStatus('Reading places also travel by themselves through ' +
                'your Epub folder.');
    }
  }
  function closePanel() {
    var p = el('syncPanel');
    if (p) p.classList.add('hidden');
    try { B.lanStopDiscover && B.lanStopDiscover(); } catch (e) {}
  }
  function renderFound() {
    var box = el('syncFound');
    if (!box) return;
    if (!found.length) { box.innerHTML = ''; return; }
    box.innerHTML = '';
    found.forEach(function (svc) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toolbtn sync-found-item';
      b.textContent = svc.name || 'Laptop';
      b.addEventListener('click', function () {
        chosenAddr = (svc.addresses || [])[0] || '';
        el('syncAddr').value = chosenAddr;
        setStatus('Laptop chosen: ' + (svc.name || chosenAddr) +
                  '. Now type its 6-digit code and tap Pair.');
      });
      box.appendChild(b);
    });
  }

  /* ---- shell callbacks ---- */
  window.__berLanFound = function (list) {
    found = Array.isArray(list) ? list : [];
    if (!el('syncPanel') || el('syncPanel').classList.contains('hidden')) {
      return;
    }
    if (found.length) {
      setStatus('Found ' + found.length +
                (found.length === 1 ? ' laptop' : ' laptops') +
                ' — tap yours, then enter its code.');
      renderFound();
    } else {
      setStatus('No laptop found on this network. Check its sync ' +
                'window is open — or type its address below.');
    }
  };
  window.__berLanStatus = function (st) {
    if (!st) return;
    if (st.message) setStatus(st.message);
    if (st.phase === 'paired') {
      setBusy(false);
      refreshPaired();
    } else if (st.phase === 'done' || st.phase === 'error') {
      setBusy(false);
      if (st.phase === 'done') {
        /* Places learned over LAN are already in the store via
           __berSyncApply; refresh the shelf's place badges. */
        if (typeof renderShelf === 'function') {
          try { renderShelf(); } catch (e) {}
        }
      }
    }
  };
  window.__berSyncFailed = function () {
    /* The folder-file exchange failed (folder gone, Drive
       unreachable). The client retries on its next change; the
       shelf simply keeps the local places. Nothing to nag about. */
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
