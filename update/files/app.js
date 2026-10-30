/* Basic EPUB Reader — app logic (v0.1 sample build).
   Shelf + reading + footnote pop-ups, per Joshua's spec in
   docs/V1-SPEC.md. Books live in IndexedDB (the shelf copy);
   the original file on the phone / in Drive is never touched. */
'use strict';

/* ---------------- helpers ---------------- */
function $(id){ return document.getElementById(id); }
var toastTimer = null;
function toast(msg, ms){
  var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.add('hidden'); }, ms || 2600);
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function b64ToArrayBuffer(b64){
  var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function blobToDataUrl(blob){
  return new Promise(function(res, rej){
    var r = new FileReader();
    r.onload = function(){ res(r.result); };
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/* ---------------- IndexedDB ---------------- */
var DB = null;
function openDB(){
  return new Promise(function(res, rej){
    var rq = indexedDB.open('basic-epub-reader', 1);
    rq.onupgradeneeded = function(){
      rq.result.createObjectStore('books', { keyPath: 'id' });
    };
    rq.onsuccess = function(){ DB = rq.result; res(); };
    rq.onerror = function(){ rej(rq.error); };
  });
}
function idbAll(){
  return new Promise(function(res, rej){
    var rq = DB.transaction('books', 'readonly').objectStore('books').getAll();
    rq.onsuccess = function(){ res(rq.result || []); };
    rq.onerror = function(){ rej(rq.error); };
  });
}
function idbPut(rec){
  return new Promise(function(res, rej){
    var rq = DB.transaction('books', 'readwrite').objectStore('books').put(rec);
    rq.onsuccess = res; rq.onerror = function(){ rej(rq.error); };
  });
}
function idbDel(id){
  return new Promise(function(res, rej){
    var rq = DB.transaction('books', 'readwrite').objectStore('books').delete(id);
    rq.onsuccess = res; rq.onerror = function(){ rej(rq.error); };
  });
}

/* ---------------- library ---------------- */
var library = [];           // records: {id,title,creator,cover,palette,data,addedAt,lastRead}
var PALETTES = [
  ['#2e7d4f','#1e5631'], ['#2f6fb3','#1d4e89'], ['#c97b2d','#a34d12'],
  ['#b34a33','#8e2f23'], ['#6d439e','#43245f'], ['#476b8a','#2c4358'],
  ['#7d2436','#571826'], ['#7a7d2e','#565a1e'], ['#206a6e','#14464a'],
  ['#93529e','#653a6e']
];
function paletteFor(title){
  var h = 0; for (var i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}
function progressOf(rec){
  try {
    var p = JSON.parse(localStorage.getItem('ber-progress-' + rec.id) || 'null');
    if (p && typeof p.pct === 'number') return p;
  } catch (e) {}
  return { cfi: null, pct: 0 };
}

/* Every import path (single file, sample book, folder import)
   dedupes by ONE content key: the SHA-256 of the book's bytes.
   Same bytes = same book, however many times and however they
   arrive — re-adding a folder can never duplicate the shelf.
   Records carry the key; shelves from before v0.1.2 get theirs
   computed (and stored) the first time a check needs it. */
async function contentKey(arrayBuffer){
  try {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      var digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
      var u8 = new Uint8Array(digest), hex = '';
      for (var i = 0; i < u8.length; i++)
        hex += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
      return 'sha256:' + hex;
    }
  } catch (e) { /* fall through to the hash below */ }
  /* Deterministic fallback (no WebCrypto): two FNV-1a passes over
     the bytes, seeded differently, plus the length. */
  var bytes = new Uint8Array(arrayBuffer);
  function fnv(seed){
    var h = seed >>> 0;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  return 'fnv:' + bytes.length + ':' + fnv(0x811c9dc5) + fnv(0x01000193);
}
async function findByKey(key){
  for (var i = 0; i < library.length; i++) {
    var rec = library[i];
    if (!rec.key) {
      try {
        rec.key = await contentKey(rec.data);
        idbPut(rec);
      } catch (e) { continue; }
    }
    if (rec.key === key) return rec;
  }
  return null;
}

/* Returns { status: 'added' | 'dupe', rec } — throws when the file
   cannot be parsed as a book at all. */
/* epub.js's ready promise can hang FOREVER on a damaged file
   (proven in the bundle-8 harness: a few garbage bytes never
   settle it). An unguarded await would wedge a whole folder
   scan on one corrupt book — no finish, no notice, no report:
   exactly the silent failure bundle 8 exists to eliminate. A
   real book parses in a second or two even on the TCL, so 30 s
   is a generous ceiling, not a target. */
function readyWithTimeout(book){
  return Promise.race([book.ready, new Promise(function(_, reject){
    setTimeout(function(){
      reject(new Error('Book could not be read (parse timed out)'));
    }, 30000);
  })]);
}
async function importBook(arrayBuffer, quiet){
  var key = await contentKey(arrayBuffer);
  var dupe = await findByKey(key);
  if (dupe) {
    if (!quiet) toast('Already on your shelf: ' + dupe.title);
    return { status: 'dupe', rec: dupe };
  }
  var book = ePub(arrayBuffer);
  await readyWithTimeout(book);
  var meta = {};
  try { meta = await book.loaded.metadata; } catch (e) {}
  var title = (meta && meta.title) || 'Untitled book';
  var creator = (meta && meta.creator) || '';
  var cover = null;
  try {
    var url = await book.coverUrl();
    if (url) {
      var blob = await (await fetch(url)).blob();
      cover = await blobToDataUrl(blob);
    }
  } catch (e) { /* a book without a cover gets a painted one */ }
  try { book.destroy(); } catch (e) {}
  var rec = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    key: key,
    title: title, creator: creator, cover: cover,
    palette: paletteFor(title),
    data: arrayBuffer, addedAt: Date.now(), lastRead: 0
  };
  await idbPut(rec);
  library.push(rec);
  if (!quiet) toast('Added: ' + title);
  return { status: 'added', rec: rec };
}

/* ---------------- shelf ---------------- */
function perRow(){
  var w = $('shelfScroll').clientWidth || window.innerWidth;
  return Math.max(2, Math.min(5, Math.floor((w - 8) / 118)));
}
function renderShelf(){
  var shelf = $('shelf');
  shelf.innerHTML = '';
  var books = library.slice().sort(function(a, b){
    return (b.lastRead - a.lastRead) || (b.addedAt - a.addedAt);
  });
  $('shelfEmpty').classList.toggle('hidden', books.length > 0);
  var n = perRow();
  for (var i = 0; i < books.length; i += n) {
    var row = document.createElement('div'); row.className = 'shelf-row';
    books.slice(i, i + n).forEach(function(rec){ row.appendChild(bookCard(rec)); });
    shelf.appendChild(row);
    var plank = document.createElement('div'); plank.className = 'shelf-plank';
    shelf.appendChild(plank);
  }
}
function bookCard(rec){
  var p = progressOf(rec);
  var pct = Math.round((p.pct || 0) * 100);
  var el = document.createElement('div'); el.className = 'book';
  var coverHtml;
  if (rec.cover) {
    coverHtml = '<img class="coverimg" src="' + rec.cover + '" alt="">';
  } else {
    var pal = rec.palette || paletteFor(rec.title);
    coverHtml = '<div class="fakecover" style="background:linear-gradient(160deg,' +
      pal[0] + ',' + pal[1] + ')"><div class="ft">' + esc(rec.title.toUpperCase()) +
      '</div><div class="fr"></div><div class="fs">' + esc(rec.creator || 'EPUB') +
      '</div></div>';
  }
  el.innerHTML = coverHtml +
    '<div class="prog"><i style="width:' + pct + '%"></i></div>' +
    '<div class="pct">' + (pct >= 100 ? 'Finished' : pct > 0 ? pct + '% read' : 'Not started') + '</div>' +
    '<div class="caption">' + esc(rec.title) + '</div>';
  el.addEventListener('click', function(){ openBook(rec.id); });
  var pressT = null;
  el.addEventListener('pointerdown', function(){
    pressT = setTimeout(function(){
      if (confirm('Remove "' + rec.title + '" from the shelf?\n\nOnly the shelf copy is removed — the file itself stays where it is.')) {
        idbDel(rec.id).then(function(){
          library = library.filter(function(b){ return b.id !== rec.id; });
          localStorage.removeItem('ber-progress-' + rec.id);
          renderShelf(); toast('Removed from shelf');
        });
      }
    }, 650);
  });
  ['pointerup','pointerleave','pointermove'].forEach(function(ev){
    el.addEventListener(ev, function(){ clearTimeout(pressT); });
  });
  return el;
}
var resizeT = null;
window.addEventListener('resize', function(){
  clearTimeout(resizeT); resizeT = setTimeout(renderShelf, 200);
});
/* A resize — above all the full-screen transition — makes epub.js
   re-paginate, which can put a fresh document under the reader's
   finger. Once it settles, be sure that document has the page
   gestures (attachToLiveContents is idempotent). */
var fsResizeT = null;
window.addEventListener('resize', function(){
  clearTimeout(fsResizeT);
  fsResizeT = setTimeout(attachToLiveContents, 450);
});

/* ---------------- reader ---------------- */
var cur = { id: null, book: null, rendition: null, fontPct: 110, saveT: null };

/* Font size is a persisted preference now (v0.1.1): pinch sets it,
   the A−/A+ buttons are gone. Range matches the old buttons' spirit
   but wider, because a pinch can ask for more than a button could. */
var FONT_MIN = 60, FONT_MAX = 240;
function loadFontPct(){
  var v = NaN;
  try { v = parseInt(localStorage.getItem('ber-font-pct') || '', 10); } catch (e) {}
  return isFinite(v) ? Math.max(FONT_MIN, Math.min(FONT_MAX, v)) : 110;
}
function saveFontPct(){
  try { localStorage.setItem('ber-font-pct', String(cur.fontPct)); } catch (e) {}
}

/* Header variant (Joshua's ruling pending — see docs/V1-SPEC.md):
   default 'off' = no title header, only the slim progress strip.
   'on' = slim title above the progress bar. One stored preference
   flips it; nothing else in the layout changes. */
var TITLE_ON = false;
try { TITLE_ON = localStorage.getItem('ber-title') === 'on'; } catch (e) {}
document.body.classList.toggle('title-on', TITLE_ON);

function setReaderOpen(open){
  document.body.classList.toggle('reading', open);
  if (window.ReaderBridge && ReaderBridge.setReaderOpen) {
    try { ReaderBridge.setReaderOpen(!!open); } catch (e) {}
  }
}
async function openBook(id){
  var rec = library.find(function(b){ return b.id === id; });
  if (!rec) return;
  closeBook(true);
  cur.id = id;
  rec.lastRead = Date.now();
  idbPut(rec);
  $('shelfView').classList.add('hidden');
  $('readerView').classList.remove('hidden');
  $('readerTitle').textContent = rec.title;
  $('chapterLabel').textContent = '';
  var startPct = Math.round((progressOf(rec).pct || 0) * 100);
  $('progressFill').style.width = startPct + '%';
  $('progressPct').textContent = startPct > 0 ? startPct + '%' : '…';
  cur.fontPct = loadFontPct();
  setReaderOpen(true);

  try {
    var book = ePub(rec.data.slice(0));
    cur.book = book;
    await readyWithTimeout(book);
  /* Reading flow (bundle 7 — Joshua's hands-on report, 2026-10-30):
     the book SCROLLS. Under flow 'paginated' epub.js clips every
     page to exactly the screen and lays the text out in columns
     with overflow hidden — a page holding more than a screenful
     had no way to be read past the fold: he rotated the TCL
     mid-page, the words reflowed to the new layout perfectly, and
     then found a drag did nothing at all, because in paginated
     mode nothing on the page is a scrollable surface. Scrolled
     flow + the continuous manager lays the sections out in one
     tall, vertically scrolling view: a drag scrolls the text,
     next()/prev() (edge tap zones, the read-aloud page chase)
     step one screenful at a time, and rotation simply reflows
     the same scrolling view. */
  var rendition = book.renderTo('viewer', {
    width: '100%', height: '100%', flow: 'scrolled',
    manager: 'continuous', spread: 'none'
  });
  cur.rendition = rendition;
  rendition.themes.default({
    /* user-select off: a long-press on the page means "read aloud"
       (Joshua's gesture), never text selection. */
    'body': { 'font-family': 'Georgia, serif', 'line-height': '1.55',
              'color': '#26221c', 'background': '#f7f1e3',
              '-webkit-user-select': 'none', 'user-select': 'none',
              '-webkit-touch-callout': 'none' },
    'p': { 'margin': '0 0 0.9em 0' }
  });
  rendition.themes.fontSize(cur.fontPct + '%');

  /* Footnote pop-ups: a tapped definition link floats its note
     over the page instead of jumping to the definitions. The
     interception lives in attachFootnotePopups (below). */
  rendition.hooks.content.register(function(contents){
    var doc = contents.document;
    if (!doc) return;
    attachFootnotePopups(doc);
    attachPictureTaps(doc);
    /* Reading gestures live INSIDE the page: epub.js renders each
       page in an iframe whose touches never reach the outer page,
       so every section document gets its own gesture handlers.
       No long-press menu, ever — a hold means read-aloud. */
    doc.addEventListener('contextmenu', function(ev){ ev.preventDefault(); });
    attachGestures(doc, pageGestureHandlers());
  });

  rendition.on('relocated', function(loc){
    if (!loc || !loc.start) return;
    var pct = null;
    try {
      if (book.locations && book.locations.length)
        pct = book.locations.percentageFromCfi(loc.start.cfi);
    } catch (e) {}
    var chapter = '';
    try {
      var nav = book.navigation && book.navigation.get(loc.start.href);
      if (nav && nav.label) chapter = nav.label.trim();
    } catch (e) {}
    /* Slim progress strip: bar + percentage. Chapter shows only in
       the title-on header variant. */
    if (pct != null) {
      $('progressFill').style.width = Math.round(pct * 100) + '%';
      $('progressPct').textContent = Math.round(pct * 100) + '%';
    }
    $('chapterLabel').textContent = chapter;
    clearTimeout(cur.saveT);
    cur.saveT = setTimeout(function(){
      localStorage.setItem('ber-progress-' + cur.id,
        JSON.stringify({ cfi: loc.start.cfi, pct: pct || 0, ts: Date.now() }));
    }, 350);
    attachToLiveContents();
  });

  var saved = progressOf(rec);
  await rendition.display(saved.cfi || undefined);
  attachToLiveContents();
  try { rendition.on('rendered', function(){ attachToLiveContents(); }); } catch (e) {}
    book.locations.generate(1024).catch(function(){});
  } catch (err) {
    /* A book that will not open reports home (bundle 8) and the
       reader falls back to the shelf instead of a blank page. */
    reportError('Opening a book', '"' + (rec.title || 'A book') + '" would not open: ' +
      (err && err.message ? err.message : String(err)));
    toast('Could not open that book.');
    closeBook(false);
    return;
  }
}
function closeBook(silent){
  if (picture.open) { picture.open = false; $('pictureView').classList.add('hidden'); }
  stopTTS();
  if (isFullscreen) setFullscreen(false);
  if (cur.rendition) { try { cur.rendition.destroy(); } catch (e) {} cur.rendition = null; }
  if (cur.book) { try { cur.book.destroy(); } catch (e) {} cur.book = null; }
  cur.id = null;
  $('viewer').innerHTML = '';
  if (!silent) {
    $('readerView').classList.add('hidden');
    $('shelfView').classList.remove('hidden');
    setReaderOpen(false);
    renderShelf();
  }
}
window.__closeReader = function(){
  if (picture.open) { closePicture(); return; }   /* Back closes an open picture first */
  closeBook(false);
};

/* footnote card */
function showFootnote(text){
  $('footnoteText').textContent = text;
  $('footnoteCard').classList.remove('hidden');
}
$('footnoteCard').addEventListener('click', function(){
  $('footnoteCard').classList.add('hidden');
});

/* ================= reading gestures (Joshua, 2026-10-28) ==========
   Single tap on the page ....... toggle full screen
   Tap-and-hold ................. read aloud from here / stop
   Pinch out / pinch in ......... bigger / smaller text (persisted)
   Tap the left/right edges ..... previous / next page (unchanged)
   The handlers attach to each book page's own document (see the
   content hook in openBook) and to the two tap zones, because the
   pages live in an epub.js iframe whose touches stay inside it. */
var LONG_PRESS_MS = 600, TAP_MAX_MS = 400, MOVE_MAX_PX = 14;
var gestureTurnAt = 0;   // lets the plain click fallback stay a fallback
var lastTapHandledAt = 0;   // stamped whenever a tap/hold/pinch completes,
                            // so the click fallback below can tell a tap
                            // it already served from one it never saw

function attachGestures(target, handlers){
  /* Idempotent: epub.js page documents are recycled as the book
     re-paginates, and attachToLiveContents() re-asserts these
     handlers on whichever document is live — never twice on the
     same one. */
  if (!target || target.__berGestures) return;
  target.__berGestures = true;
  var press = null, pinch = null;
  function armLong(st){
    st.longTimer = setTimeout(function(){
      st.longFired = true;
      lastTapHandledAt = Date.now();
      if (handlers.onLongPress) handlers.onLongPress();
    }, LONG_PRESS_MS);
  }
  function disarm(st){ if (st && st.longTimer) { clearTimeout(st.longTimer); st.longTimer = null; } }
  function movedAway(st, x, y){
    return Math.abs(x - st.x) > MOVE_MAX_PX || Math.abs(y - st.y) > MOVE_MAX_PX;
  }
  function tdist(a, b){
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  target.addEventListener('touchstart', function(ev){
    if (ev.touches.length === 2) {
      if (press) { press.cancelled = true; disarm(press); }
      pinch = { d0: tdist(ev.touches[0], ev.touches[1]) || 1,
                pct0: cur.fontPct, applied: false };
    } else if (ev.touches.length === 1 && !pinch) {
      var t = ev.touches[0];
      press = { x: t.clientX, y: t.clientY, t0: Date.now(), targetEl: ev.target,
                longFired: false, cancelled: false, longTimer: null };
      armLong(press);
    }
  }, { passive: true });
  target.addEventListener('touchmove', function(ev){
    if (pinch && ev.touches.length === 2) {
      if (ev.cancelable) ev.preventDefault();
      var pct = Math.round(Math.max(FONT_MIN, Math.min(FONT_MAX,
        pinch.pct0 * (tdist(ev.touches[0], ev.touches[1]) / pinch.d0))));
      if (pct !== cur.fontPct) {
        cur.fontPct = pct;
        if (cur.rendition) cur.rendition.themes.fontSize(pct + '%');
        pinch.applied = true;
      }
    } else if (press && ev.touches.length === 1 &&
               movedAway(press, ev.touches[0].clientX, ev.touches[0].clientY)) {
      press.cancelled = true; disarm(press);   // a drag is a swipe, not a tap/hold
    }
  }, { passive: false });
  target.addEventListener('touchend', function(ev){
    if (pinch) {
      if (ev.touches.length < 2) {
        if (pinch.applied) saveFontPct();
        pinch = null;
        lastTapHandledAt = Date.now();
      }
      if (press) { press.cancelled = true; disarm(press); press = null; }
      return;
    }
    if (!press) return;
    var st = press; press = null; disarm(st);
    if (st.longFired) { if (ev.cancelable) ev.preventDefault(); return; }
    if (st.cancelled || Date.now() - st.t0 > TAP_MAX_MS) return;
    lastTapHandledAt = Date.now();
    if (handlers.onTap) handlers.onTap(st.targetEl);
  });
  target.addEventListener('touchcancel', function(){
    disarm(press); press = null; pinch = null;
  });
  /* Mouse equivalents, so the gestures can be exercised on a desktop. */
  target.addEventListener('mousedown', function(ev){
    if (ev.button !== 0) return;
    press = { x: ev.clientX, y: ev.clientY, t0: Date.now(), targetEl: ev.target,
              longFired: false, cancelled: false, longTimer: null };
    armLong(press);
  });
  target.addEventListener('mousemove', function(ev){
    if (press && movedAway(press, ev.clientX, ev.clientY)) {
      press.cancelled = true; disarm(press);
    }
  });
  target.addEventListener('mouseup', function(){
    if (!press) return;
    var st = press; press = null; disarm(st);
    if (st.longFired || st.cancelled || Date.now() - st.t0 > TAP_MAX_MS) return;
    lastTapHandledAt = Date.now();
    if (handlers.onTap) handlers.onTap(st.targetEl);
  });
  /* Click fallback: a tap whose touch sequence was interrupted
     mid-flight — the system reclaims touches when the bars show or
     hide — can still land as a click. If the paths above already
     served this tap they stamped lastTapHandledAt, and this stays
     out of the way; if they never saw it, this is the tap. */
  target.addEventListener('click', function(ev){
    if (Date.now() - lastTapHandledAt < 700) return;
    if (handlers.onTap) handlers.onTap(ev.target);
  });
}

/* ================= full screen ===================================
   Tap toggles it. In full screen the phone gives the page EVERYTHING:
   no chrome here (CSS hides the strip) and no system bars (the shell
   goes immersive via ReaderBridge). Without the shell (desktop), the
   browser's own fullscreen stands in. */
/* Footnote pop-up interception for one page document.
   epub.js navigates in-book links through an onclick PROPERTY it
   assigns to every anchor in the page (the link rewriter in
   lib/epub.min.js: t.onclick = function(){ ... display(path +
   hash) }). v0.1.2 hung its pop-up handler on the anchor itself
   with addEventListener and called stopPropagation — which can
   never stop another handler on the SAME element — so epub.js's
   onclick fired right after the pop-up showed and the reader
   still jumped to the definitions (Joshua's hands-on report,
   2026-10-28: "the pop-up is still working fine ... but it's
   definitely still going to the definitions page").
   The fix intercepts in the CAPTURE phase on the document: the
   click is stopped on its way down, before the anchor — and its
   onclick — is ever reached, whatever order anything registered
   in. Only definition notes are intercepted; an ordinary in-book
   link is left completely alone and navigates exactly as before.
   And a tap that just dismissed an open pop-up (the gesture layer
   stamps lastFootnoteDismissAt) is swallowed as well: it only
   dismisses — it does not open the note it happened to land on. */
var lastFootnoteDismissAt = 0;
function attachFootnotePopups(doc){
  doc.addEventListener('click', function(ev){
    var a = null;
    try { a = ev.target && ev.target.closest ? ev.target.closest('a') : null; } catch (e) {}
    if (!a) return;
    var type = a.getAttribute('epub:type') || a.getAttribute('role') || '';
    var href = a.getAttribute('href') || '';
    if (type.indexOf('noteref') < 0 && href.indexOf('#') < 0) return;
    var frag = href.split('#')[1];
    var target = frag && doc.getElementById(frag);
    if (!target) return;
    var tt = target.getAttribute('epub:type') || target.getAttribute('role') || '';
    var isNote = tt.indexOf('footnote') >= 0 || tt.indexOf('note') >= 0 ||
                 target.tagName === 'ASIDE';
    if (!isNote) return;   // ordinary link: let the book navigate
    ev.preventDefault();
    ev.stopPropagation();
    if (Date.now() - lastFootnoteDismissAt < 800) return;
    var text = (target.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) showFootnote(text);
  }, true);
}

var isFullscreen = false;
var lastFsToggleAt = 0;
/* The gesture handlers for a book page, shared by every page
   document (the content hook attaches them as pages render;
   attachToLiveContents re-asserts them on the live document after
   re-pagination). The toggle carries its own lock: one physical
   tap may be seen by more than one trigger path (touchend, the
   click fallback, a re-attached document) — it still toggles
   exactly once. */
function pageGestureHandlers(){
  return {
    onTap: function(el){
      if (!$('footnoteCard').classList.contains('hidden')) {
        $('footnoteCard').classList.add('hidden');   // first tap just dismisses
        lastFootnoteDismissAt = Date.now();   // the click trailing this tap must not open a note either
        return;
      }
      var pic = pictureTargetOf(el);
      if (pic) { openPicture(pic); return; }   // a picture tap opens the picture — outranks any link wrapped around it
      var a = null;
      try { a = el && el.closest ? el.closest('a') : null; } catch (e) {}
      if (a) return;   // links/footnotes keep their own behaviour
      var now = Date.now();
      if (now - lastFsToggleAt < 700) return;
      lastFsToggleAt = now;
      setFullscreen(!isFullscreen);
    },
    onLongPress: function(){ toggleTTS(); }
  };
}
/* Make sure the CURRENT page document carries the gesture
   handlers. epub.js creates and recycles the iframe documents the
   pages live in (every section change, every re-pagination), and
   entering/leaving full screen resizes the viewer and forces a
   re-pagination — v0.1.2's tap-in-full-screen failure lived here:
   nothing ever re-checked that the live document still had its
   handlers after the transition. attachGestures is idempotent,
   so calling this often is cheap insurance. */
function attachToLiveContents(){
  if (!cur.rendition || !cur.rendition.getContents) return;
  try {
    var list = cur.rendition.getContents() || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].document)
        attachGestures(list[i].document, pageGestureHandlers());
    }
  } catch (e) {}
}
var fsSettleT = null;
function setFullscreen(on){
  isFullscreen = !!on;
  document.body.classList.toggle('fullscreen', isFullscreen);
  if (window.ReaderBridge && ReaderBridge.setFullscreen) {
    try { ReaderBridge.setFullscreen(isFullscreen); } catch (e) {}
  } else {
    try {
      if (isFullscreen && document.documentElement.requestFullscreen &&
          !document.fullscreenElement) document.documentElement.requestFullscreen();
      if (!isFullscreen && document.exitFullscreen && document.fullscreenElement)
        document.exitFullscreen();
    } catch (e) {}
  }
  /* The transition itself resizes the WebView (bars + inset
     padding) and epub.js re-paginates. When the dust settles,
     re-assert the shell's state (a bars/insets race cannot be
     allowed to undo the toggle) and re-assert the handlers on
     whichever page document is live now — the NEXT tap must
     toggle back just as reliably as this one did. */
  clearTimeout(fsSettleT);
  fsSettleT = setTimeout(function(){
    if (window.ReaderBridge && ReaderBridge.setFullscreen) {
      try { ReaderBridge.setFullscreen(isFullscreen); } catch (e) {}
    }
    attachToLiveContents();
  }, 650);
}
window.__exitFullscreen = function(){
  if (picture.open) { closePicture(); return; }   /* Back closes an open picture first */
  if (isFullscreen) setFullscreen(false);
};

/* ================= fullscreen picture (bundle 8) =================
   Tapping a picture in the book opens it on its own screen: fitted
   so the whole picture is visible, scrollable/pannable so every
   part is reachable on the small screen, one tap zooms it to
   natural size (tap again zooms back out), and it closes via the
   X in the top-right corner, a plain tap on the fitted picture,
   or Android Back. The rendition underneath is never touched, so
   closing returns to the exact reading position. Opening enters
   fullscreen when not already there, which is also what routes
   Android Back to closePicture (via __exitFullscreen above). */
var picture = { open: false, fsBefore: false, url: null, tapTimer: null, lastTouchEndAt: 0 };
function pictureTargetOf(el){
  var node = el;
  for (var depth = 0; node && depth < 5; depth++) {
    var tag = (node.tagName || '').toLowerCase();
    if (tag === 'img') {
      var src = node.currentSrc || node.getAttribute('src');
      if (!src) return null;
      if (!/^(blob:|data:|https?:)/.test(src) && node.ownerDocument) {
        try { src = new URL(src, node.ownerDocument.baseURI).href; } catch (e) { /* keep raw */ }
      }
      return src;
    }
    if (tag === 'image') {
      var href = node.getAttribute('href') ||
        (node.getAttributeNS && node.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
      if (href) return href;
    }
    if (tag === 'svg') {
      var inner = node.querySelector && node.querySelector('image');
      if (inner) {
        var ih = inner.getAttribute('href') ||
          (inner.getAttributeNS && inner.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
        if (ih) return ih;
      }
      try {
        return URL.createObjectURL(new Blob(
          [new XMLSerializer().serializeToString(node)], { type: 'image/svg+xml' }));
      } catch (e) { return null; }
    }
    node = node.parentElement || node.parentNode;
  }
  return null;
}
function openPicture(src){
  if (!src || picture.open) return;
  if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) { showPicture(src); return; }
  fetch(src).then(function(r){ return r.blob(); }).then(function(b){
    showPicture(URL.createObjectURL(b));
  }).catch(function(){ showPicture(src); });
}
function showPicture(url){
  if (picture.url && picture.url !== url && picture.url.indexOf('blob:') === 0)
    URL.revokeObjectURL(picture.url);
  picture.url = url;
  picture.fsBefore = isFullscreen;
  picture.open = true;
  var view = $('pictureView'), sc = $('pictureScroll');
  view.classList.remove('zoomed');
  $('pictureImg').src = url;
  sc.scrollLeft = 0; sc.scrollTop = 0;
  view.classList.remove('hidden');   /* .hidden is display:none !important — the class is the switch, as everywhere else in this app */
  if (!isFullscreen) setFullscreen(true);
}
function closePicture(){
  if (!picture.open) return;
  picture.open = false;
  if (picture.tapTimer) { clearTimeout(picture.tapTimer); picture.tapTimer = null; }
  $('pictureView').classList.add('hidden');
  if (picture.url && picture.url.indexOf('blob:') === 0) {
    URL.revokeObjectURL(picture.url);
    picture.url = null;
  }
  if (isFullscreen !== picture.fsBefore) setFullscreen(picture.fsBefore);
}
function togglePictureZoom(){
  $('pictureView').classList.toggle('zoomed');
  var sc = $('pictureScroll');
  sc.scrollLeft = 0; sc.scrollTop = 0;
}
function pictureTap(){
  if (picture.tapTimer) {   /* second tap right behind the first: zoom, don't close */
    clearTimeout(picture.tapTimer);
    picture.tapTimer = null;
    togglePictureZoom();
    return;
  }
  picture.tapTimer = setTimeout(function(){
    picture.tapTimer = null;
    closePicture();
  }, 360);
}
(function(){
  var sc = $('pictureScroll');
  var downX = 0, downY = 0, moved = false;
  sc.addEventListener('touchstart', function(e){
    var t = e.touches[0];
    downX = t.clientX; downY = t.clientY; moved = false;
  }, { passive: true });
  sc.addEventListener('touchmove', function(e){
    var t = e.touches[0];
    if (Math.abs(t.clientX - downX) > 14 || Math.abs(t.clientY - downY) > 14) moved = true;
  }, { passive: true });
  sc.addEventListener('touchend', function(){
    picture.lastTouchEndAt = Date.now();
    if (!moved) pictureTap();   /* drags pan natively and never close */
  });
  sc.addEventListener('click', function(){
    if (Date.now() - picture.lastTouchEndAt < 700) return;  /* compatibility click after a touch */
    pictureTap();
  });
})();
$('pictureClose').addEventListener('click', function(e){
  e.stopPropagation();
  closePicture();
});
/* Capture-phase click backstop inside each page document: a tap
   on a picture whose touch path was interrupted still opens the
   picture here, and a picture wrapped in a link opens the picture
   instead of navigating the book out from under the reader. */
function attachPictureTaps(doc){
  if (doc.__berPictureTaps) return;
  doc.__berPictureTaps = true;
  doc.addEventListener('click', function(ev){
    var pic = ev.target ? pictureTargetOf(ev.target) : null;
    if (!pic) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (picture.open) return;
    if (Date.now() - lastFootnoteDismissAt < 800) return;  /* that tap only dismissed a note */
    openPicture(pic);
  }, true);
}

/* ================= read-aloud (text-to-speech) ===================
   Long-press starts reading FROM THE TOP OF THE CURRENT PAGE,
   and the reading runs to the end of the book. The voice is the
   phone's own TTS engine — the shell bridge speaks through
   Android TextToSpeech, so whichever engine Joshua installed
   (SherpaTTS / Piper) does the reading. Web Speech is the
   fallback where no bridge exists. A second long-press, the Stop
   chip, or closing the book stops it.

   Bundle 3 (Joshua, 2026-10-28 12:33, confirmed 12:40): the page
   CHASES the voice, and the sentence being read is HIGHLIGHTED.
   Speech is fed one sentence at a time; every sentence is mapped
   to a CFI range on the page in view, its range lights up when
   its utterance starts (an epub.js annotation), and when a
   page's sentences run out the reader turns the page itself and
   reads on. The grain is sentences because the shell forwards
   exactly one boundary event per utterance (__ttsOnDone /
   __ttsOnError): one utterance, one boundary, one highlight step.
   Word-level highlighting would need the engine's
   character-range callbacks (onRangeStart), which the v0.1.2
   shell never forwards — that waits for shell v0.1.3, and this
   bundle does not promise it.
   The saved reading place follows the voice for free: the page
   turns fire the rendition's relocated event, and the handler in
   openBook already persists the place — stopping leaves him
   standing on the page the voice reached. */
var speech = { on: false, uid: 0, currentId: '', useNative: false,
               sentences: [], si: 0, hlCfi: null, runId: 0,
               turning: false, emptyTurns: 0, u: null };
function cleanText(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/* ---- the page in view, as sentences with CFI ranges ---------- */
var TTS_BLOCK_TAGS = { P:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, LI:1,
  BLOCKQUOTE:1, TD:1, TH:1, DIV:1, SECTION:1, ARTICLE:1, DT:1, DD:1,
  FIGCAPTION:1, CAPTION:1, PRE:1, ADDRESS:1 };
function ttsSkippedEl(el){
  /* Never read aloud: scripts/styles, footnote asides (the
     sample book's definitions live in asides — they are pop-up
     material, not story text), anything the book itself hides —
     a hidden attribute or aria-hidden="true" (an EPUB nav
     page-list hides exactly this way, and its raw link labels
     are not story text) — and footnote blocks by class, for
     books whose definitions live in classed divs rather than
     asides. Defence in depth: any one of these marks is enough. */
  var tag = el.tagName || '';
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'ASIDE')
    return true;
  try {
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    var ah = el.getAttribute ? el.getAttribute('aria-hidden') : null;
    if (ah !== null && ah !== 'false') return true;
    if (el.classList && el.classList.contains &&
        (el.classList.contains('footnotes') || el.classList.contains('footnote')))
      return true;
  } catch (e) {}
  var type = '';
  try {
    type = (el.getAttribute && (el.getAttribute('epub:type') || el.getAttribute('role'))) || '';
  } catch (e) {}
  /* A noteref ANCHOR is not the note it points at: its text is a
     defined term sitting inside its sentence ("Words marked in
     blue, like Footnote pop-up, carry their meaning…" / "The USGS
     publishes a number…"), so it is spoken as ordinary story
     text. The note it targets — the footnote aside — stays
     skipped: the ASIDE tag, footnote classes and aria-hidden
     checks above all fire first, and the text walk keeps a whole
     subtree skipped when any ancestor is skipped. */
  if (tag === 'A' && type.indexOf('noteref') >= 0) return false;
  return type.indexOf('footnote') >= 0 || type.indexOf('note') >= 0;
}
function ttsBlockOf(node){
  var n = node.parentNode;
  while (n && n.nodeType === 1) {
    if (TTS_BLOCK_TAGS[n.tagName]) return n;
    n = n.parentNode;
  }
  return null;
}
/* Collect the visible page's text as a stream of node slices:
   every text node inside the page range, clipped at the range's
   ends, in reading order — plus the char positions where the
   block element changes (a paragraph break ends a sentence even
   without terminal punctuation: headings, list items). */
function pageTextStream(contents, startR, endR){
  var doc = contents.document;
  if (!doc || !doc.body) return null;
  var nodes = [];
  (function rec(n, skipped){
    if (n.nodeType === 3) { if (!skipped) nodes.push(n); return; }
    if (n.nodeType !== 1) return;
    var sk = skipped || ttsSkippedEl(n);
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) rec(kids[i], sk);
  })(doc.body, false);
  var si = nodes.indexOf(startR.startContainer);
  var ei = nodes.indexOf(endR.endContainer);
  var siExact = si >= 0, eiExact = ei >= 0;
  if (!siExact || !eiExact) {
    /* A range boundary can sit inside a subtree the walk skips —
       a chapter's last page typically ENDS inside its footnote
       asides. The boundary node is then missing from the list,
       and giving up here (null) made the voice skip the whole
       page, story text and all. Fall back to the nearest listed
       nodes in document order. A boundary from a DIFFERENT
       document means the contents still lag the location —
       keep returning null so the caller retries that instead. */
    if (!startR.startContainer || !endR.endContainer ||
        startR.startContainer.ownerDocument !== doc ||
        endR.endContainer.ownerDocument !== doc)
      return null;
    if (!siExact) {
      for (var a = 0; a < nodes.length; a++) {
        if (startR.startContainer.compareDocumentPosition(nodes[a]) & 4) { si = a; break; }
      }
    }
    if (!eiExact) {
      for (var b = nodes.length - 1; b >= 0; b--) {
        if (endR.endContainer.compareDocumentPosition(nodes[b]) & 2) { ei = b; break; }
      }
    }
    /* Nothing readable lies inside the range (a page showing
       only the footnote block): an empty stream, [] downstream —
       "genuinely nothing to say", not "cannot reach it". */
    if (si < 0 || ei < 0 || ei < si)
      return { segs: [], full: '', breaks: [], doc: doc };
  }
  if (ei < si) return null;
  var segs = [], full = '', breaks = [], prevBlock;
  for (var i = si; i <= ei; i++) {
    var node = nodes[i];
    var data = node.data != null ? String(node.data) : String(node.textContent || '');
    var from = (i === si && siExact) ? startR.startOffset : 0;
    var to = (i === ei && eiExact) ? endR.endOffset : data.length;
    if (to <= from) continue;
    var block = ttsBlockOf(node);
    if (prevBlock !== undefined && block !== prevBlock && full.length > 0)
      breaks.push(full.length);
    prevBlock = block;
    segs.push({ node: node, off: from, text: data.slice(from, to), g: full.length });
    full += data.slice(from, to);
  }
  return { segs: segs, full: full, breaks: breaks, doc: doc };
}
var TTS_ABBREV = { mr:1, mrs:1, ms:1, dr:1, st:1, jr:1, sr:1, prof:1,
                   vs:1, etc:1, fig:1, vol:1 };
/* Sentence spans [s, e) over the page's text stream. A sentence
   ends after . ! ? … (plus any closing quotes/brackets) when what
   follows — past the whitespace — looks like a new sentence (a
   capital, a digit, an opening quote) or is the stream's end;
   a dot closing a known abbreviation or a single initial does
   not end one, and a dot with no space after it (3.5, e.g.'s
   inner dot) never does. Block changes force a cut. Spans are
   trimmed and must contain a letter or a digit to be spoken. */
function ttsSentenceSpans(full, breaks){
  var cuts = {}, i;
  cuts[0] = 1; cuts[full.length] = 1;
  (breaks || []).forEach(function(b){ if (b > 0 && b < full.length) cuts[b] = 1; });
  for (i = 0; i < full.length; i++) {
    var ch = full[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    var j = i + 1;
    while (j < full.length && '.!?…'.indexOf(full[j]) >= 0) j++;
    while (j < full.length && '"\'”’)]'.indexOf(full[j]) >= 0) j++;
    if (j < full.length && !/\s/.test(full[j])) continue;
    if (ch === '.') {
      var w = i;
      while (w > 0 && /[A-Za-z.]/.test(full[w - 1])) w--;
      /* The token the dot closes is the last dot-separated piece
         of the run before it — in "four.Dr." the run is "four.Dr"
         (the previous sentence's dot is part of the run), and the
         token is "Dr". In "U.S.A." it is "A": a single initial. */
      var word = full.slice(w, i).split('.').pop().toLowerCase();
      if (TTS_ABBREV[word] || word.length <= 1) continue;
    }
    var k = j;
    while (k < full.length && /\s/.test(full[k])) k++;
    if (k < full.length && !/[A-Z0-9"“'‘(]/.test(full[k])) continue;
    cuts[j] = 1;
  }
  var pts = Object.keys(cuts).map(Number).sort(function(a, b){ return a - b; });
  var spans = [];
  for (i = 0; i + 1 < pts.length; i++) {
    var s = pts[i], e = pts[i + 1];
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    if (e > s && /[A-Za-z0-9]/.test(full.slice(s, e))) spans.push({ s: s, e: e });
  }
  return spans;
}
function ttsStreamPoint(segs, pos, isEnd){
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (pos < sg.g || pos > sg.g + sg.text.length) continue;
    if (pos === sg.g + sg.text.length && !isEnd && i + 1 < segs.length) continue;
    return { node: sg.node, off: sg.off + (pos - sg.g) };
  }
  var last = segs[segs.length - 1];
  return { node: last.node, off: last.off + last.text.length };
}
/* The sentences of the page currently in view, top to bottom,
   each with its CFI range for the highlight. null = the page's
   innards cannot be reached yet (the caller retries); [] = the
   page genuinely has nothing to say (a picture page, a blank). */
function buildPageSentences(){
  if (!cur.rendition || !cur.rendition.getContents) return null;
  var loc = null, list = null;
  try { loc = cur.rendition.currentLocation(); list = cur.rendition.getContents(); } catch (e) {}
  if (!loc || !loc.start || !loc.end || !list || !list.length) return null;
  /* Scrolled flow keeps several sections loaded at once (bundle
     7), so "the page in view" is no longer simply the first
     contents in the list: pick the one the location is standing
     in. The location's CFI arrives wrapped ("epubcfi(/6/6!/…)"),
     so unwrap it and match the section's cfiBase ("/6/6") at a
     step boundary — a bare prefix test would also let section 3
     claim section 30's CFIs. The section index is the backup
     test. Falling back to the first contents is the old
     behaviour, kept only for a shape this reader never makes. */
  var contents = list[0];
  var locCfi = String(loc.start.cfi || '');
  if (locCfi.indexOf('epubcfi(') === 0)
    locCfi = locCfi.slice('epubcfi('.length, -1);
  for (var ci = 0; ci < list.length; ci++) {
    var cand = list[ci];
    if (!cand) continue;
    if (cand.cfiBase && (locCfi === cand.cfiBase ||
        locCfi.indexOf(cand.cfiBase + '!') === 0 ||
        locCfi.indexOf(cand.cfiBase + '/') === 0)) { contents = cand; break; }
    if (typeof cand.sectionIndex === 'number' &&
        typeof loc.start.index === 'number' &&
        cand.sectionIndex === loc.start.index) contents = cand;
  }
  if (!contents || !contents.document || !contents.range) return null;
  var startR = null, endR = null;
  try {
    startR = contents.range(loc.start.cfi);
    endR = contents.range(loc.end.cfi);
  } catch (e) {}
  if (!startR || !endR) return null;
  var stream = pageTextStream(contents, startR, endR);
  if (!stream) return null;
  var spans = ttsSentenceSpans(stream.full, stream.breaks);
  var out = [];
  for (var i = 0; i < spans.length; i++) {
    var text = cleanText(stream.full.slice(spans[i].s, spans[i].e));
    if (!text) continue;
    var cfi = null;
    try {
      if (typeof contents.cfiFromRange === 'function') {
        var a = ttsStreamPoint(stream.segs, spans[i].s, false);
        var b = ttsStreamPoint(stream.segs, spans[i].e, true);
        var range = stream.doc.createRange();
        range.setStart(a.node, a.off);
        range.setEnd(b.node, b.off);
        cfi = contents.cfiFromRange(range);
      }
    } catch (e) { cfi = null; }
    out.push({ text: text, cfi: cfi });
  }
  return out;
}

/* ---- the highlight ---------------------------------------------
   One annotation, moved sentence by sentence. Warm amber at
   partial opacity reads on the cream page the reader ships with
   and stays visible on a sepia or a dark page alike; blend mode
   normal, so on dark pages it lays colour ON instead of
   multiplying the page darker (the engine's default). */
var TTS_HL_CLASS = 'ber-tts-hl';
var TTS_HL_STYLES = { fill: '#ffa726', 'fill-opacity': '0.45', 'mix-blend-mode': 'normal' };
function clearHighlight(){
  if (speech.hlCfi && cur.rendition && cur.rendition.annotations) {
    try { cur.rendition.annotations.remove(speech.hlCfi, 'highlight'); } catch (e) {}
  }
  speech.hlCfi = null;
}
function setHighlight(cfi){
  clearHighlight();
  if (!cfi || !cur.rendition || !cur.rendition.annotations) return;
  try {
    cur.rendition.annotations.highlight(cfi, {}, null, TTS_HL_CLASS, TTS_HL_STYLES);
    speech.hlCfi = cfi;
  } catch (e) {}
}

/* ---- the speech driver ----------------------------------------- */
function speakCurrent(){
  if (!speech.on) return;
  var s = speech.sentences[speech.si];
  if (!s) { advancePageOrFinish(); return; }
  setHighlight(s.cfi);
  var id = 'ber' + (++speech.uid);
  speech.currentId = id;
  if (speech.useNative) {
    try { ReaderBridge.speak(id, s.text); }
    catch (e) { speech.useNative = false; speakCurrent(); }
  } else if (window.speechSynthesis) {
    var u = new SpeechSynthesisUtterance(s.text);
    speech.u = u;   // held: a garbage-collected utterance can lose its onend
    var advance = function(){
      if (speech.on && speech.currentId === id) { speech.si++; speakCurrent(); }
    };
    u.onend = advance; u.onerror = advance;
    try { window.speechSynthesis.speak(u); }
    catch (e) { stopTTS(); toast('Read-aloud is not available on this phone.', 4000); }
  } else {
    stopTTS();
    toast('Read-aloud is not available on this phone.', 4000);
  }
}
/* The page in view is read out: turn it and read on. The turn
   that goes nowhere — the location stays exactly where it was,
   with epub.js reporting the end of the book — is the finish. */
function advancePageOrFinish(){
  if (!speech.on || !cur.rendition || speech.turning) return;
  speech.turning = true;
  clearHighlight();
  var run = speech.runId;
  var before = null;
  try {
    var l0 = cur.rendition.currentLocation();
    before = l0 && l0.start && l0.start.cfi;
  } catch (e) {}
  var settled = false;
  function verdict(loc){
    if (!loc || !loc.start) return 0;
    if (before && loc.start.cfi && loc.start.cfi !== before) return 1;  // turned
    if (loc.atEnd) return 2;                                            // end of book
    return 0;
  }
  function settle(how){
    if (settled) return;
    settled = true;
    speech.turning = false;
    try { cur.rendition.off('relocated', onReloc); } catch (e) {}
    if (!speech.on || run !== speech.runId) return;
    if (how === 1) afterTurn(0);
    else finishReading();
  }
  function checkNow(){
    if (settled || !speech.on || run !== speech.runId) return;
    var loc = null;
    try { loc = cur.rendition.currentLocation(); } catch (e) {}
    var v = verdict(loc);
    if (v) settle(v);
  }
  function onReloc(loc){ var v = verdict(loc); if (v) settle(v); }
  try { cur.rendition.on('relocated', onReloc); } catch (e) {}
  var p = null;
  try { p = cur.rendition.next(); } catch (e) {}
  if (p && typeof p.then === 'function')
    p.then(function(){ setTimeout(checkNow, 60); }, function(){ setTimeout(checkNow, 60); });
  setTimeout(checkNow, 900);
  /* Backstop: relocation is reliable in practice, but a turn
     must never leave the voice waiting forever — after a long
     silence, judge by the location itself. */
  setTimeout(function(){
    if (settled || !speech.on || run !== speech.runId) return;
    var loc = null;
    try { loc = cur.rendition.currentLocation(); } catch (e) {}
    settle(verdict(loc) || 2);
  }, 4000);
}
/* A page has just turned under the voice (or reading has just
   started on this one): map its sentences and read on. A page
   with nothing to say (a picture, a blank) is turned past; a
   page whose innards lag behind the turn is retried briefly
   before being counted as one. */
function afterTurn(retries){
  if (!speech.on) return;
  var run = speech.runId;
  var sents = buildPageSentences();
  if (sents === null) {
    if (retries < 10) {
      setTimeout(function(){
        if (speech.on && run === speech.runId) afterTurn(retries + 1);
      }, 150);
      return;
    }
    sents = [];
  }
  speech.sentences = sents;
  speech.si = 0;
  if (!sents.length) {
    if (++speech.emptyTurns > 100) { finishReading(); return; }
    advancePageOrFinish();
    return;
  }
  speech.emptyTurns = 0;
  speakCurrent();
}
function finishReading(){
  stopTTS();
  toast('Finished reading');
}
window.__ttsOnDone = function(id){
  if (!speech.on || id !== speech.currentId) return;
  speech.si++;
  speakCurrent();
};
window.__ttsOnError = window.__ttsOnDone;
window.__ttsUnavailable = function(){
  if (!speech.on) return;
  if (speech.useNative && window.speechSynthesis) {
    speech.useNative = false;    // engine refused: try Web Speech once
    speakCurrent();
  } else {
    stopTTS();
    toast('Read-aloud is not available on this phone.', 4000);
  }
};
function startTTS(){
  if (!cur.rendition || !cur.book) return;
  speech.useNative = !!(window.ReaderBridge && ReaderBridge.speak);
  speech.on = true;
  speech.runId++;
  speech.sentences = []; speech.si = 0; speech.hlCfi = null;
  speech.turning = false; speech.emptyTurns = 0;
  $('ttsStopBtn').classList.remove('hidden');
  toast('Reading aloud — long-press again to stop');
  /* From the TOP of the current page — the current location's
     start is the page's first word — as it has been since v0.1.1.
     afterTurn does the rest: map this page, speak it, turn, read on. */
  afterTurn(0);
}
function stopTTS(){
  speech.on = false;
  speech.runId++;
  speech.turning = false;
  clearHighlight();
  speech.sentences = []; speech.si = 0;
  speech.u = null;
  try { if (window.ReaderBridge && ReaderBridge.stopSpeaking) ReaderBridge.stopSpeaking(); } catch (e) {}
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  $('ttsStopBtn').classList.add('hidden');
}
function toggleTTS(){ if (speech.on) { stopTTS(); toast('Reading stopped'); } else startTTS(); }
$('ttsStopBtn').addEventListener('click', function(){ toggleTTS(); });

/* reader controls */
$('backBtn').addEventListener('click', function(){ closeBook(false); });
function turnPage(dir){
  if (!cur.rendition) return;
  gestureTurnAt = Date.now();
  if (dir < 0) cur.rendition.prev(); else cur.rendition.next();
}
attachGestures($('tapLeft'), {
  onTap: function(){ turnPage(-1); },
  onLongPress: function(){ toggleTTS(); }
});
attachGestures($('tapRight'), {
  onTap: function(){ turnPage(1); },
  onLongPress: function(){ toggleTTS(); }
});
/* Click fallback for the tap zones (exotic input only): a real
   gesture turn stamps gestureTurnAt, so the click that trails it
   never turns the page twice. */
$('tapLeft').addEventListener('click', function(){
  if (Date.now() - gestureTurnAt < 600) return;
  if (cur.rendition) cur.rendition.prev();
});
$('tapRight').addEventListener('click', function(){
  if (Date.now() - gestureTurnAt < 600) return;
  if (cur.rendition) cur.rendition.next();
});
/* Drag-scrolling from the tap zones (bundle 7): the zones are
   plain overlay strips, so a vertical drag that STARTS on one
   lands on the strip, not on the book's scrolling view beneath
   it — without help, the outer 22% on each side would be dead
   ground for scrolling. While one finger drags on a zone, walk
   the book's scroll container by the same delta, so a scroll
   drag works from anywhere on the screen, edges included. Taps
   are untouched: under the gesture layer's own movement
   threshold nothing here fires, and a drag that did scroll
   stamps gestureTurnAt so the click fallback trailing it can
   never also turn the page. */
function attachZoneDragScroll(el){
  var drag = null;
  el.addEventListener('touchstart', function(ev){
    drag = (ev.touches.length === 1)
      ? { y: ev.touches[0].clientY, moved: false } : null;
  }, { passive: true });
  el.addEventListener('touchmove', function(ev){
    if (!drag || ev.touches.length !== 1) return;
    var y = ev.touches[0].clientY;
    var dy = drag.y - y;
    drag.y = y;
    if (dy === 0) return;
    drag.moved = true;
    if (ev.cancelable) ev.preventDefault();
    var c = cur.rendition && cur.rendition.manager &&
            cur.rendition.manager.container;
    if (c) c.scrollTop += dy;
  }, { passive: false });
  function endDrag(){
    if (drag && drag.moved) gestureTurnAt = Date.now();
    drag = null;
  }
  el.addEventListener('touchend', endDrag);
  el.addEventListener('touchcancel', endDrag);
}
attachZoneDragScroll($('tapLeft'));
attachZoneDragScroll($('tapRight'));

/* add books */
$('addBtn').addEventListener('click', function(){ $('fileInput').click(); });
$('fileInput').addEventListener('change', async function(ev){
  var files = Array.prototype.slice.call(ev.target.files || []);
  ev.target.value = '';
  for (var i = 0; i < files.length; i++) {
    try {
      var ab = await files[i].arrayBuffer();
      await importBook(ab);
    } catch (e) {
      reportError('Adding a book', '"' + (files[i].name || 'that file') +
        '" could not be added from the file picker: ' +
        (e && e.message ? e.message : String(e)));
      toast('Could not open: ' + (files[i].name || 'that file'));
    }
  }
  renderShelf();
});

/* ================= error reporting (bundle 8) =================
   Silent, automatic error reports to the SAME Player Reports
   inbox the game and the suite editors use (Joshua, 2026-10-30 —
   his editor reporting rule, extended to the reader). A failure
   that is silent to him is never silent to Mollie: a folder scan
   that cannot reach a folder, files that arrive unreadable, a
   book that will not open, session errors — each becomes one
   "Reader Report" response in that form, sent as an ordinary
   form POST (the field codes are the form's own, shared with
   the game's config). Discipline, matching the editors: a
   distinct failure reports ONCE (a signature set remembers what
   has gone; it re-arms when the shell or bundle version
   changes); reports queue on the phone while offline and drain
   on a later launch; the reporter failing is never itself
   reported, and nothing here ever pops anything up at him. */
var REPORT_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeLwZKjsqKoCRVIuedhSD5NXJFO_WkwJtG7ExjXjCV6seakMg/formResponse';
var REPORT_ENTRIES = {
  type: 'entry.245308779', message: 'entry.722588258',
  version: 'entry.1808724204', where: 'entry.613460102',
  device: 'entry.1017388942'
};
function readerVersionTag(){
  var shell = '0.1.3', bundle = null;
  try {
    if (window.ReaderBridge) {
      if (ReaderBridge.shellVersionName) shell = ReaderBridge.shellVersionName();
      if (ReaderBridge.webBundleVersion) bundle = ReaderBridge.webBundleVersion();
    }
  } catch (e) {}
  return 'Reader shell ' + shell + ' · web bundle ' + (bundle || '?');
}
function reportStore(key, fallback){
  try {
    var v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function reportSave(key, val){
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
var reportSending = false;
function flushReports(){
  if (reportSending) return;
  var queue = reportStore('ber-report-queue', []);
  if (!queue.length) return;
  var item = queue[0];
  reportSending = true;
  var body = new URLSearchParams();
  body.set(REPORT_ENTRIES.type, 'Reader Report');
  body.set(REPORT_ENTRIES.message, item.message);
  body.set(REPORT_ENTRIES.version, item.version);
  body.set(REPORT_ENTRIES.where, item.where);
  body.set(REPORT_ENTRIES.device, item.device);
  fetch(REPORT_FORM_URL, { method: 'POST', mode: 'no-cors',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }).then(function(){
    /* The form answers opaquely (no-cors): a resolved fetch is
       "sent". Record the signature, drop the item, send the next. */
    var sent = reportStore('ber-report-sent', {});
    sent[item.sig] = Date.now();
    reportSave('ber-report-sent', sent);
    var q = reportStore('ber-report-queue', []);
    q = q.filter(function(x){ return x.sig !== item.sig; });
    reportSave('ber-report-queue', q);
    reportSending = false;
    flushReports();
  }).catch(function(){
    /* Offline or unreachable: the queue keeps the report for a
       later launch. Never itself worth a report. */
    reportSending = false;
  });
}
function reportError(where, message){
  try {
    var tag = readerVersionTag();
    var marker = reportStore('ber-report-armed', '');
    var sent = reportStore('ber-report-sent', {});
    if (marker !== tag) {
      sent = {};
      reportSave('ber-report-armed', tag);
      reportSave('ber-report-sent', sent);
    }
    var sig = (where + '|' + String(message).split('\n')[0]).slice(0, 180);
    if (sent[sig]) return;
    var queue = reportStore('ber-report-queue', []);
    for (var i = 0; i < queue.length; i++) if (queue[i].sig === sig) return;
    queue.push({ sig: sig, where: where,
      message: String(message).slice(0, 1500), version: tag,
      device: String(navigator.userAgent || '').slice(0, 300),
      ts: Date.now() });
    while (queue.length > 20) queue.shift();
    reportSave('ber-report-queue', queue);
    flushReports();
  } catch (e) { /* reporting must never break the reader */ }
}
/* Session errors ride the same pipe, capped so a looping fault
   can never flood the inbox. */
var sessionReports = 0;
window.addEventListener('error', function(ev){
  if (sessionReports >= 5) return;
  sessionReports++;
  reportError('Session', 'Page error: ' +
    (ev && ev.message ? ev.message : 'unknown'));
});
window.addEventListener('unhandledrejection', function(ev){
  if (sessionReports >= 5) return;
  sessionReports++;
  var r = ev && ev.reason;
  reportError('Session', 'Unhandled rejection: ' +
    String(r && r.message ? r.message : r).slice(0, 300));
});

/* ================= folder import (Joshua, 2026-10-28) ==========
   "Add folder": pick ONE folder — this phone or Google Drive,
   through the system picker — and every EPUB inside it, subfolders
   included, is added. No picking books one by one. The shell walks
   the folder and hands over one book at a time; this side acks each
   receipt, dedupes by content key, and keeps the counts for the
   plain summary at the end. Picked folders are remembered by the
   shell, so "Refresh folders" can re-scan them for new books. */
var fimp = null;
/* Set for exactly one scan: the automatic folder check that runs
   when the app opens (bundle 2 — Joshua, 2026-10-28: "every time I
   reopen the reader it will automatically check that folder for
   new files"). __folderScanStart consumes it; __folderBusy clears
   it if the shell turns the start away. An auto scan is QUIET: no
   progress overlay, no summary dialog. Bundle 8 (Joshua,
   2026-10-30) overrides bundle 2's "silence is the success
   state": when an auto scan adds books, the shelf shows the
   added-books notice naming them (see showAddedNotice); when it
   FAILS — a folder it cannot reach, files it cannot read — the
   failure reports home instead of vanishing (see the reporting
   section). The manual Refresh keeps the full progress +
   summary behaviour, and its summary names the added books too. */
var pendingScanQuiet = false;
/* Set alongside pendingScanQuiet for exactly the automatic
   check's own start attempts (bundle 8), so __folderScanStart
   can tell the retry loop "a scan truly started" and
   __folderBusy can tell "the refused start was the auto one". */
var pendingAutoCheck = false;
function folderReset(kind, total, quiet){
  fimp = { kind: kind, total: total || 0, received: 0, processed: 0,
           added: 0, dupe: 0, bad: 0, ended: false, inaccessible: 0,
           addedTitles: [], badNames: [],
           chain: Promise.resolve(), finished: false, quiet: !!quiet };
}
function folderProgress(){
  if (!fimp || fimp.quiet) return;
  var verb = fimp.kind === 'rescan' ? 'Checking folders' : 'Adding books';
  $('importTitle').textContent = verb + '…';
  $('importText').textContent = 'Adding ' + fimp.processed + ' of ' + fimp.total + '…';
  $('importFill').style.width =
    (fimp.total > 0 ? Math.round(fimp.processed * 100 / fimp.total) : 0) + '%';
  $('importOk').classList.add('hidden');
  $('importOverlay').classList.remove('hidden');
}
/* The added-books notice (bundle 8 — Joshua, 2026-10-30):
   "so many books have been added — [title] is now part of your
   library." In-flow at the top of the shelf, naming every added
   title; OK dismisses it; it never blocks the shelf and it is
   never shown when nothing was added. */
var noticeTitles = [];
function showAddedNotice(titles){
  if (!titles || !titles.length) return;
  for (var i = 0; i < titles.length; i++)
    if (noticeTitles.indexOf(titles[i]) < 0) noticeTitles.push(titles[i]);
  var lines = [];
  if (noticeTitles.length === 1) {
    lines.push('A new book has been added — “' + noticeTitles[0] +
               '” is now part of your library.');
  } else {
    lines.push(noticeTitles.length + ' new books have been added to your library:');
    for (var j = 0; j < noticeTitles.length; j++)
      lines.push('“' + noticeTitles[j] + '”');
  }
  $('addedNoticeText').textContent = lines.join('\n');
  $('addedNotice').classList.remove('hidden');
}
$('addedNoticeOk').addEventListener('click', function(){
  $('addedNotice').classList.add('hidden');
  noticeTitles = [];
});
function folderMaybeFinish(){
  if (!fimp || fimp.finished) return;
  if (!fimp.ended || fimp.processed < fimp.received) return;
  fimp.finished = true;
  /* Failed = files the shell found but that never became books:
     ones it could not read, plus ones that arrived unparseable. */
  var failed = fimp.total - fimp.added - fimp.dupe;
  /* Bundle 8: scan failures report home from BOTH paths. A scan
     that could not reach a folder, or files that arrived
     unreadable, is precisely the "the reader silently did
     nothing" Joshua reported — under the reporting rule it is
     never silent to Mollie, even when it stays quiet to him. */
  var scanKind = 'Folder scan (' + (fimp.quiet ? 'automatic' : 'manual') + ')';
  if (fimp.inaccessible > 0)
    reportError(scanKind,
      fimp.inaccessible + ' remembered folder(s) could not be reached — ' +
      'the folder permission may be gone. The scan found ' + fimp.total +
      ' file(s) and added ' + fimp.added + '.');
  if (failed > 0)
    reportError(scanKind,
      failed + ' file(s) could not be read as books' +
      (fimp.badNames.length ? ': ' + fimp.badNames.join(', ') : '') +
      '. The scan added ' + fimp.added + ' of ' + fimp.total + '.');
  if (fimp.quiet) {
    /* Auto-check: the added-books notice is the announcement
       (bundle 8 ruling above); nothing added = stay quiet. */
    if (fimp.added > 0) {
      renderShelf();
      showAddedNotice(fimp.addedTitles);
    }
    return;
  }
  var lines = [];
  lines.push('Added ' + fimp.added + ' new book' + (fimp.added === 1 ? '' : 's') + '.');
  if (fimp.addedTitles.length)
    lines.push(fimp.addedTitles.map(function(t){ return '“' + t + '”'; }).join(', ') +
               (fimp.addedTitles.length === 1 ? ' is' : ' are') +
               ' now part of your library.');
  if (fimp.dupe > 0)
    lines.push(fimp.dupe + (fimp.dupe === 1 ? ' was' : ' were') + ' already on your shelf.');
  if (failed > 0)
    lines.push(failed + (failed === 1
      ? " couldn't be read as a book, and was skipped."
      : " couldn't be read as books, and were skipped."));
  if (fimp.inaccessible > 0)
    lines.push(fimp.inaccessible + (fimp.inaccessible === 1 ? ' folder' : ' folders') +
               " couldn't be reached — its permission may be gone.");
  if (fimp.total === 0 && fimp.kind === 'import')
    lines.push('No EPUB books were found in that folder.');
  if (fimp.total === 0 && fimp.kind === 'rescan' && fimp.inaccessible === 0)
    lines.push('No new books in your folders.');
  $('importTitle').textContent = fimp.kind === 'rescan' ? 'Folder check done' : 'Folder added';
  $('importText').textContent = lines.join(' ');
  $('importFill').style.width = '100%';
  $('importOk').classList.remove('hidden');
  renderShelf();
}
window.__folderScanStart = function(kind, total){
  var quiet = (kind === 'rescan' && pendingScanQuiet);
  pendingScanQuiet = false;
  if (pendingAutoCheck) {
    /* A scan truly started: the auto-check's retry loop stands
       down for this launch (bundle 8). */
    pendingAutoCheck = false;
    autoCheck.started = true;
    autoCheck.done = true;
  }
  folderReset(kind, total, quiet);
  folderProgress();
};
window.__folderBook = function(name, b64){
  /* Ack receipt FIRST: the shell keeps only one book in flight,
     and this side then processes its queue in order. */
  try { if (window.ReaderBridge && ReaderBridge.folderBookAck) ReaderBridge.folderBookAck(); } catch (e) {}
  if (!fimp) folderReset('import', 0);
  fimp.received++;
  fimp.chain = fimp.chain.then(async function(){
    try {
      var r = await importBook(b64ToArrayBuffer(b64), true);
      if (r.status === 'added') { fimp.added++; fimp.addedTitles.push(r.rec.title); }
      else fimp.dupe++;
    } catch (e) {
      fimp.bad++;
      fimp.badNames.push(name);
    }
    fimp.processed++;
    if (!fimp.finished) folderProgress();
    folderMaybeFinish();
  });
};
window.__folderScanEnd = function(kind, inaccessible){
  if (!fimp) folderReset(kind, 0);
  fimp.ended = true;
  fimp.inaccessible = inaccessible || 0;
  folderMaybeFinish();
};
window.__folderBusy = function(){
  /* The shell refused to start a scan because one is running.
     Bundle 8: if the refused start was the automatic open-check,
     that refusal used to END the launch's only attempt, silently.
     Now it reports home and the check retries once the running
     scan has had time to finish. A refused quiet start that was
     not the auto-check's just clears the flag as before, so the
     next manual scan is never mistaken for an automatic one. */
  if (pendingAutoCheck) {
    pendingAutoCheck = false;
    pendingScanQuiet = false;
    reportError('Folder check (automatic)',
      'The automatic folder check was turned away: another scan was already running.');
    scheduleAutoRetry();
    return;
  }
  if (pendingScanQuiet) { pendingScanQuiet = false; return; }
  toast('A folder is already being added — one at a time.');
};
window.__folderPickFailed = function(){
  reportError('Folder picker',
    'The system folder picker could not be opened on this phone.');
  toast("Couldn't open the folder picker on this phone.");
};
$('importOk').addEventListener('click', function(){
  $('importOverlay').classList.add('hidden');
});
$('addFolderBtn').addEventListener('click', function(){
  if (window.ReaderBridge && ReaderBridge.pickFolder) {
    try { ReaderBridge.pickFolder(); return; } catch (e) {}
  }
  toast('Adding a whole folder works in the app on your phone.');
});
$('refreshFoldersBtn').addEventListener('click', function(){
  pendingScanQuiet = false;   // a manual refresh is never the quiet auto-check
  if (window.ReaderBridge && ReaderBridge.rescanFolders) {
    var n = 0;
    try { n = ReaderBridge.folderCount ? ReaderBridge.folderCount() : 0; } catch (e) {}
    if (!n) { toast('No folders yet — add one with "Add folder" first.'); return; }
    try { ReaderBridge.rescanFolders(); return; } catch (e) {}
  }
  toast('Refreshing folders works in the app on your phone.');
});

/* ================= update channel (v0.1.2) ======================
   This APK is the stable base; web-layer fixes arrive as numbered
   bundles from the reader's repo. The shell checks on launch (and
   on the shelf's Check-for-updates button), verifies every file's
   sha256, and applies a new bundle at the NEXT cold start — never
   mid-session, never unverified. The version line on the shelf
   says which bundle is running, so it can be reported. */
function updateVerLine(){
  var shell = '0.1.3', bundle = null;
  try {
    if (window.ReaderBridge) {
      if (ReaderBridge.shellVersionName) shell = ReaderBridge.shellVersionName();
      if (ReaderBridge.webBundleVersion) bundle = ReaderBridge.webBundleVersion();
    }
  } catch (e) {}
  $('verLine').textContent = 'Reader ' + shell +
    (bundle ? ' · web bundle ' + bundle : '');
}
window.__updateCheckResult = function(status, version){
  if (status === 'current') {
    toast('Your reader is up to date (web bundle ' + version + ').');
  } else if (status === 'updated') {
    toast('Update downloaded — web bundle ' + version +
          ' will be ready next time you open the reader.', 4200);
  } else if (status === 'needs-apk') {
    toast('The next update needs a new app version — ask Mollie for the new file.', 4200);
  } else {
    toast("Couldn't check for updates — try again later.");
  }
  updateVerLine();
};
$('updateBtn').addEventListener('click', function(){
  if (window.ReaderBridge && ReaderBridge.checkForUpdates) {
    toast('Checking for updates…');
    try { ReaderBridge.checkForUpdates(); return; } catch (e) {}
  }
  toast('Update checks work in the app on your phone.');
});

/* ---------------- automatic folder check on open ----------------
   Joshua (2026-10-28, bundle 2): reopening the reader checks his
   remembered folder(s) for new EPUBs BY ITSELF — the manual
   Refresh stays for asking out loud, but he should never have to.
   Once per cold start, after the shelf has painted (never blocking
   first paint), through the same bridge pipe the Refresh uses;
   the scan runs quiet (see pendingScanQuiet above).

   Bundle 8 (2026-10-30) — why it could silently never happen,
   diagnosed after his report that a new book in the folder did
   not shelve on open: the check was ONE shot, and its run-once
   flag was spent BEFORE anything succeeded, so a turned-away
   start (shell busy), a bridge hiccup, or a throw anywhere in
   the attempt ended the launch's only try — and even when the
   scan ran, its failures (a folder it could not reach, a file
   it could not read) were counted in the quiet finish and
   dropped. The check now RETRIES until a scan actually starts
   (__folderScanStart marks it), a busy refusal retries too, the
   only terminal answer is "no folders remembered", and scan
   failures report home from folderMaybeFinish. */
var autoCheck = { tries: 0, started: false, done: false };
var autoRetryT = null;
function scheduleAutoRetry(){
  if (autoCheck.done || autoCheck.started) return;
  if (autoCheck.tries >= 6) return;
  clearTimeout(autoRetryT);
  autoRetryT = setTimeout(maybeAutoFolderCheck, 2500);
}
function maybeAutoFolderCheck(){
  if (autoCheck.done || autoCheck.started) return;
  autoCheck.tries++;
  if (!(window.ReaderBridge && ReaderBridge.rescanFolders)) {
    scheduleAutoRetry();   // the bridge can lag the page; don't spend the launch on it
    return;
  }
  var n = -1;
  try { n = ReaderBridge.folderCount ? ReaderBridge.folderCount() : -1; } catch (e) {}
  if (n < 0) { scheduleAutoRetry(); return; }
  if (n === 0) { autoCheck.done = true; return; }   // genuinely nothing remembered
  if (fimp && !fimp.finished) { scheduleAutoRetry(); return; }
  pendingScanQuiet = true;
  pendingAutoCheck = true;
  try { ReaderBridge.rescanFolders(); }
  catch (e) {
    pendingScanQuiet = false;
    pendingAutoCheck = false;
    scheduleAutoRetry();
  }
}

/* ---------------- boot ---------------- */
(async function boot(){
  try {
    await openDB();
    library = await idbAll();
  } catch (e) {
    reportError('Storage', 'The library database would not open: ' +
      (e && e.message ? e.message : String(e)));
    toast('Storage is unavailable on this phone — books will not persist.', 5000);
    library = [];
  }
  if (library.length === 0 && window.SAMPLE_BOOK_B64) {
    try {
      await importBook(b64ToArrayBuffer(window.SAMPLE_BOOK_B64), true);
      toast('Your sample book is on the shelf');
    } catch (e) { /* starter book failed; the shelf simply starts empty */ }
  }
  renderShelf();
  updateVerLine();
  setTimeout(maybeAutoFolderCheck, 900);
  setTimeout(flushReports, 1600);   /* drain any reports queued offline */
})();
