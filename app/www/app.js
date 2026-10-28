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

async function importBook(arrayBuffer, quiet){
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
    title: title, creator: creator, cover: cover,
    palette: paletteFor(title),
    data: arrayBuffer, addedAt: Date.now(), lastRead: 0
  };
  await idbPut(rec);
  library.push(rec);
  if (!quiet) toast('Added: ' + title);
  return rec;
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
  $('locLabel').textContent = 'Opening…';
  setReaderOpen(true);

  var book = ePub(rec.data.slice(0));
  cur.book = book;
  await book.ready;
  var rendition = book.renderTo('viewer', {
    width: '100%', height: '100%', flow: 'paginated', spread: 'none'
  });
  cur.rendition = rendition;
  rendition.themes.default({
    'body': { 'font-family': 'Georgia, serif', 'line-height': '1.55',
              'color': '#26221c', 'background': '#f7f1e3' },
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
    $('locLabel').textContent =
      (chapter ? chapter + ' · ' : '') +
      (pct != null ? Math.round(pct * 100) + '%' : '…');
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

/* reader controls */
$('backBtn').addEventListener('click', function(){ closeBook(false); });
$('prevBtn').addEventListener('click', function(){ if (cur.rendition) cur.rendition.prev(); });
$('nextBtn').addEventListener('click', function(){ if (cur.rendition) cur.rendition.next(); });
$('tapLeft').addEventListener('click', function(){ if (cur.rendition) cur.rendition.prev(); });
$('tapRight').addEventListener('click', function(){ if (cur.rendition) cur.rendition.next(); });
$('fontUp').addEventListener('click', function(){
  cur.fontPct = Math.min(160, cur.fontPct + 10);
  if (cur.rendition) cur.rendition.themes.fontSize(cur.fontPct + '%');
});
$('fontDown').addEventListener('click', function(){
  cur.fontPct = Math.max(80, cur.fontPct - 10);
  if (cur.rendition) cur.rendition.themes.fontSize(cur.fontPct + '%');
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
})();
