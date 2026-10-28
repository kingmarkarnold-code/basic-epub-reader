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
async function importBook(arrayBuffer, quiet){
  var key = await contentKey(arrayBuffer);
  var dupe = await findByKey(key);
  if (dupe) {
    if (!quiet) toast('Already on your shelf: ' + dupe.title);
    return { status: 'dupe', rec: dupe };
  }
  var book = ePub(arrayBuffer);
  await book.ready;
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

  var book = ePub(rec.data.slice(0));
  cur.book = book;
  await book.ready;
  var rendition = book.renderTo('viewer', {
    width: '100%', height: '100%', flow: 'paginated', spread: 'none'
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
     over the page instead of jumping to the end of the chapter. */
  rendition.hooks.content.register(function(contents){
    var doc = contents.document;
    if (!doc) return;
    var links = doc.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      (function(a){
        var type = a.getAttribute('epub:type') || a.getAttribute('role') || '';
        var href = a.getAttribute('href') || '';
        if (type.indexOf('noteref') < 0 && href.indexOf('#') < 0) return;
        a.addEventListener('click', function(ev){
          var frag = href.split('#')[1];
          var target = frag && doc.getElementById(frag);
          if (!target) return;
          var tt = target.getAttribute('epub:type') || target.getAttribute('role') || '';
          var isNote = tt.indexOf('footnote') >= 0 || tt.indexOf('note') >= 0 ||
                       target.tagName === 'ASIDE';
          if (!isNote) return;   // ordinary link: let the book navigate
          ev.preventDefault(); ev.stopPropagation();
          var text = (target.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) showFootnote(text);
        });
      })(links[i]);
    }
    /* Reading gestures live INSIDE the page: epub.js renders each
       page in an iframe whose touches never reach the outer page,
       so every section document gets its own gesture handlers.
       No long-press menu, ever — a hold means read-aloud. */
    doc.addEventListener('contextmenu', function(ev){ ev.preventDefault(); });
    attachGestures(doc, {
      onTap: function(el){
        if (!$('footnoteCard').classList.contains('hidden')) {
          $('footnoteCard').classList.add('hidden');   // first tap just dismisses
          return;
        }
        var a = null;
        try { a = el && el.closest ? el.closest('a') : null; } catch (e) {}
        if (a) return;   // links/footnotes keep their own behaviour
        setFullscreen(!isFullscreen);
      },
      onLongPress: function(){ toggleTTS(); }
    });
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
  });

  var saved = progressOf(rec);
  await rendition.display(saved.cfi || undefined);
  book.locations.generate(1024).catch(function(){});
}
function closeBook(silent){
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
window.__closeReader = function(){ closeBook(false); };

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

function attachGestures(target, handlers){
  var press = null, pinch = null;
  function armLong(st){
    st.longTimer = setTimeout(function(){
      st.longFired = true;
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
      if (ev.touches.length < 2) { if (pinch.applied) saveFontPct(); pinch = null; }
      if (press) { press.cancelled = true; disarm(press); press = null; }
      return;
    }
    if (!press) return;
    var st = press; press = null; disarm(st);
    if (st.longFired) { if (ev.cancelable) ev.preventDefault(); return; }
    if (st.cancelled || Date.now() - st.t0 > TAP_MAX_MS) return;
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
    if (handlers.onTap) handlers.onTap(st.targetEl);
  });
}

/* ================= full screen ===================================
   Tap toggles it. In full screen the phone gives the page EVERYTHING:
   no chrome here (CSS hides the strip) and no system bars (the shell
   goes immersive via ReaderBridge). Without the shell (desktop), the
   browser's own fullscreen stands in. */
var isFullscreen = false;
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
}
window.__exitFullscreen = function(){ if (isFullscreen) setFullscreen(false); };

/* ================= read-aloud (text-to-speech) ===================
   Long-press starts reading FROM THE CURRENT PAGE, through the
   book to its end (section by section). The voice is the phone's
   own TTS engine — the shell bridge speaks through Android
   TextToSpeech, so whichever engine Joshua installed (SherpaTTS /
   Piper) does the reading. Web Speech is the fallback where no
   bridge exists. A second long-press, the Stop chip, or closing
   the book stops it. The page display does not chase the voice in
   v0.1.1; the voice reads from where you are, wherever you look. */
var speech = { on: false, chunks: [], i: 0, uid: 0,
               currentId: '', nextSections: [], useNative: false };
function cleanText(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function chunkText(text){
  var out = [], rest = cleanText(text);
  while (rest.length > 850) {
    var probe = rest.slice(0, 850);
    var cut = Math.max(probe.lastIndexOf('. '), probe.lastIndexOf('! '),
                       probe.lastIndexOf('? '), probe.lastIndexOf('; '));
    if (cut < 250) cut = probe.lastIndexOf(' ');
    if (cut < 250) cut = 850;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(function(c){ return c.length > 0; });
}
function currentSectionIndex(){
  try {
    var loc = cur.rendition.currentLocation();
    if (loc && loc.start) {
      if (typeof loc.start.index === 'number') return loc.start.index;
      if (loc.start.href) {
        var item = cur.book.spine.get(loc.start.href);
        if (item && typeof item.index === 'number') return item.index;
      }
    }
  } catch (e) {}
  return 0;
}
function sectionText(idx){
  return new Promise(function(resolve){
    var item = null;
    try { item = cur.book.spine.items[idx]; } catch (e) {}
    if (!item) { resolve(''); return; }
    item.load(cur.book.load.bind(cur.book)).then(function(doc){
      var t = '';
      try {
        var html = new XMLSerializer().serializeToString(doc.body || doc);
        t = cleanText(html.replace(/<[^>]+>/g, ' '));
      } catch (e) {}
      try { item.unload(); } catch (e) {}
      resolve(t);
    }).catch(function(){ resolve(''); });
  });
}
function textFromCurrentPage(){
  return new Promise(function(resolve){
    try {
      var loc = cur.rendition.currentLocation();
      var list = cur.rendition.getContents();
      if (loc && loc.start && list && list.length) {
        var contents = list[0], doc = contents.document;
        var range = contents.range(loc.start.cfi);
        if (range && doc && doc.body) {
          var tail = doc.createRange();
          tail.setStart(range.startContainer, range.startOffset);
          tail.setEnd(doc.body, doc.body.childNodes.length);
          var t = cleanText(tail.toString());
          if (t) { resolve(t); return; }
        }
      }
    } catch (e) {}
    /* Fallback: read the current section from its start. */
    sectionText(currentSectionIndex()).then(resolve);
  });
}
function speakNext(){
  if (!speech.on) return;
  if (speech.i >= speech.chunks.length) {
    if (speech.nextSections.length) {
      var idx = speech.nextSections.shift();
      sectionText(idx).then(function(t){
        if (!speech.on) return;
        speech.chunks = chunkText(t);
        speech.i = 0;
        speakNext();
      });
      return;
    }
    stopTTS();
    toast('Finished reading');
    return;
  }
  var id = 'ber' + (++speech.uid);
  speech.currentId = id;
  var text = speech.chunks[speech.i];
  if (speech.useNative) {
    try { ReaderBridge.speak(id, text); }
    catch (e) { speech.useNative = false; speakNext(); }
  } else if (window.speechSynthesis) {
    var u = new SpeechSynthesisUtterance(text);
    var advance = function(){
      if (speech.on && speech.currentId === id) { speech.i++; speakNext(); }
    };
    u.onend = advance; u.onerror = advance;
    try { window.speechSynthesis.speak(u); }
    catch (e) { stopTTS(); toast('Read-aloud is not available on this phone.', 4000); }
  } else {
    stopTTS();
    toast('Read-aloud is not available on this phone.', 4000);
  }
}
window.__ttsOnDone = function(id){
  if (!speech.on || id !== speech.currentId) return;
  speech.i++;
  speakNext();
};
window.__ttsOnError = window.__ttsOnDone;
window.__ttsUnavailable = function(){
  if (!speech.on) return;
  if (speech.useNative && window.speechSynthesis) {
    speech.useNative = false;    // engine refused: try Web Speech once
    speakNext();
  } else {
    stopTTS();
    toast('Read-aloud is not available on this phone.', 4000);
  }
};
function startTTS(){
  if (!cur.rendition || !cur.book) return;
  speech.useNative = !!(window.ReaderBridge && ReaderBridge.speak);
  speech.on = true;
  speech.i = 0; speech.chunks = [];
  speech.nextSections = [];
  var items = [];
  try { items = cur.book.spine.items || []; } catch (e) {}
  for (var k = currentSectionIndex() + 1; k < items.length; k++)
    speech.nextSections.push(k);
  $('ttsStopBtn').classList.remove('hidden');
  toast('Reading aloud — long-press again to stop');
  textFromCurrentPage().then(function(t){
    if (!speech.on) return;
    speech.chunks = chunkText(t);
    speech.i = 0;
    speakNext();
  });
}
function stopTTS(){
  speech.on = false;
  speech.chunks = []; speech.nextSections = [];
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
      toast('Could not open: ' + (files[i].name || 'that file'));
    }
  }
  renderShelf();
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
function folderReset(kind, total){
  fimp = { kind: kind, total: total || 0, received: 0, processed: 0,
           added: 0, dupe: 0, bad: 0, ended: false, inaccessible: 0,
           chain: Promise.resolve(), finished: false };
}
function folderProgress(){
  if (!fimp) return;
  var verb = fimp.kind === 'rescan' ? 'Checking folders' : 'Adding books';
  $('importTitle').textContent = verb + '…';
  $('importText').textContent = 'Adding ' + fimp.processed + ' of ' + fimp.total + '…';
  $('importFill').style.width =
    (fimp.total > 0 ? Math.round(fimp.processed * 100 / fimp.total) : 0) + '%';
  $('importOk').classList.add('hidden');
  $('importOverlay').classList.remove('hidden');
}
function folderMaybeFinish(){
  if (!fimp || fimp.finished) return;
  if (!fimp.ended || fimp.processed < fimp.received) return;
  fimp.finished = true;
  /* Failed = files the shell found but that never became books:
     ones it could not read, plus ones that arrived unparseable. */
  var failed = fimp.total - fimp.added - fimp.dupe;
  var lines = [];
  lines.push('Added ' + fimp.added + ' new book' + (fimp.added === 1 ? '' : 's') + '.');
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
  folderReset(kind, total);
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
      if (r.status === 'added') fimp.added++; else fimp.dupe++;
    } catch (e) {
      fimp.bad++;
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
  toast('A folder is already being added — one at a time.');
};
window.__folderPickFailed = function(){
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
  var shell = '0.1.2', bundle = null;
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

/* ---------------- boot ---------------- */
(async function boot(){
  try {
    await openDB();
    library = await idbAll();
  } catch (e) {
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
})();
