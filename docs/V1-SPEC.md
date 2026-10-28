# Basic EPUB Reader — V1 Spec

Written 2026-10-28 from Joshua's direction. His words govern; this document
records them so the build can be checked against them.

## What Joshua asked for

- Why this app exists, in Joshua's words: due to ads and the lack of
  finding a proper EPUB reader, he decided to create his own using the
  support of Meta's Muse AI system.
- An app like Moon+ Reader is **not** needed for Moon+'s sake — what he valued
  is (a) the way Moon+ puts books on the screen **in the library**, which we
  mimic, and (b) some of its features, which we implement selectively.
- The app lives in its own GitHub home (this repo — decided over reusing a
  folder in the game repo; see the repo decision note in the README history
  and Joshua's message of 2026-10-28 08:44).

## V1 — in scope

### Bookshelf (the library screen — the Moon+ piece, Joshua's description 2026-10-28)

- It looks like **a real bookshelf**: front-facing books lined up on a
  **wood-grain shelf**.
- The **rows scroll** (up and down through the library).
- **Rows adjust to the screen**: room for four or five books per row on a
  wide screen, two or three on a smaller one — counted from the screen,
  never fixed.
- Covers are modest in size but always identifiable, two ways: the
  book's **own cover** from inside the EPUB, or a cover the reader
  **changes within the app**.
- Mock: `mockups/shelf-v1.html` (+ rendered PNG) shows the first-open
  screen — Joshua's real EPUBs on the shelf, 3 per row (his phone's
  size), the third row cut off at the bottom edge because it scrolls.
- Import: pick EPUB files from the phone's local storage or from Google
  Drive (see "Files" below).
- Tap a cover → the book opens where you left off.
- Long-press a cover → book details / change cover / remove from shelf
  (the file itself is never deleted).

### Reading screen
- Page turning by tap zones (right/left edges) and swipe.
- **No footer** (removed 2026-10-28 — see "Reading gestures" below).
  A slim progress indicator — bar plus percentage — is all that
  remains of the old bars, and it lives at the top, where the other
  chrome was.
- Font size by **pinch** (the A−/A+ buttons are gone — see gestures).
- Day / night / sepia themes, brightness by edge drag
  (Moon+ gestures Joshua already knows).
- Table of contents drawer; in-book search; bookmarks.
- Remembers the reading place per book, on the device, with no account.

### Reading gestures (Joshua, 2026-10-28 11:51 — implemented v0.1.1)

Joshua's words, organized. The reading screen runs on gestures now;
chrome exists only where no gesture can replace it.

- **Single tap on the page → full screen.** The app takes over the
  entire phone screen: the page is everything — no header, no
  footer, no progress bar, no system bars. **Tap again → back** to
  the normal view.
- **Tap-and-hold → read aloud from where you are.** The hold opens
  the text-to-speech engine and reading begins at the current
  reading position. A second hold (or the Stop chip that appears in
  the normal view while speaking) stops it.
- **Pinch → text size.** Pinch out makes the text bigger, pinch in
  makes it smaller. This is why the font-size buttons at the top are
  gone: "the buttons at the top are no longer necessary since we're
  using the pinch in and the pinch out."
- **Header/title:** the title header is **not needed**; what stays
  is the progression — how far you have gotten in the book. Joshua's
  alternative, if the title is kept at all: shrink it so it sits
  **above the progression bar** — progression bar and header
  together in one slim strip. **His tap on this choice was still
  pending when v0.1.1 was built**, so v0.1.1 defaults to *no title,
  progress only*, with the title-above-progress variant built in
  behind one stored preference (`ber-title` = `on`) so his ruling
  flips it without a rebuild of the layout.
- **Footer:** none. There is no footer in any view.
- What still has a button, because no gesture replaces it: **Back
  to the shelf** (and the Android Back key, which leaves full
  screen first, then closes the book to the shelf).

Implementation notes (v0.1.1, for the record):

- epub.js renders each page in an iframe whose touches never reach
  the outer page, so the gesture handlers are attached inside every
  page as it renders, and to the page-turn tap zones. A tap on a
  footnote/link anchor is never a full-screen toggle — anchors keep
  their own behaviour — and a first tap while a definition pop-up
  is open only dismisses the pop-up.
- **Full-screen toggle, hardened (web bundle 2):** v0.1.2's tap
  entered full screen, but tapping never left it — Joshua escaped
  with the Android edge-swipe Back gesture. The toggle lived only
  on epub.js's per-section page documents, and nothing re-checked
  it after the full-screen transition resized the viewer and
  epub.js re-paginated: the live document could be one carrying no
  handlers. Bundle 2 makes the attachment idempotent and re-asserts
  it on the live document at every lifecycle point (contents hook,
  relocation, render, resize settle, full-screen settle), adds a
  click fallback for taps whose touch sequence is interrupted
  mid-flight, and locks the toggle so one tap toggles exactly once
  however many paths saw it. The state machine now cycles
  normal → full → normal → full by tap alone.
- Read-aloud speaks from the top of the current page (resolved from
  the reading position's CFI; if that ever fails, from the current
  chapter's start), then continues section by section to the end of
  the book. The shell speaks through Android's TextToSpeech, i.e.
  the phone's default engine — SherpaTTS/Piper if that is what is
  installed and set as default. Where no shell bridge exists (the
  web build on a desktop), Web Speech stands in; where neither
  exists, the reader says so instead of failing silently.
- Pinch range is 60%–240%, applied live and persisted as a
  preference, like the reading place.
- The displayed page does **not** chase the voice in v0.1.1: the
  voice reads on from where you started it, wherever you look.
- A long-press on the page suppresses text selection and the
  system long-press menu — the hold means read-aloud, always.
  Consequence: the "Dictionary doorway" below (long-press a word)
  is **superseded on the reading page** and needs a different
  trigger before it can ship; it is an open question for Joshua,
  not silently dropped.

### Files — local and Google Drive (Joshua's decision, 2026-10-28)

The reader works with **local files and Google Drive**, and Joshua has
approved building a sign-in section if that is what it takes. Two depths:

- **Phase 1 (v1) — no sign-in in our app.** Local files open through
  Android's system file picker, which needs no all-files permission.
  The same picker already lists Google Drive as a place (Drive is
  installed on Joshua's phones), so Drive books open the same way.
  The shelf remembers where each book came from.
- **Phase 2 — the sign-in section.** A real in-app Drive connection:
  sign in with Google inside the reader, browse a Drive folder as part
  of the shelf, and keep reading place in Drive so both phones agree.
  This needs Google's sign-in machinery (OAuth, Drive permission for
  the app's own files) — approved by Joshua 2026-10-28; scheduled
  after the reading basics work.

### Folder import (Joshua, 2026-10-28 12:00 — implemented v0.1.2)

Joshua's words, organized: when he taps Add and chooses Google Drive
(or local storage), he should be able to **select a folder** and have
the reader **find every EPUB inside it** — instead of going through
a list picking the books one by one.

- An **Add folder** button sits on the shelf next to the + (which
  still adds individual files). One pick of one folder brings in
  **every EPUB in it, subfolders included**.
- The pick goes through the **system picker**, so it covers local
  storage and Google Drive exactly like the single-file pick —
  Phase 1 rules: no sign-in inside the app.
- While it works, the shelf shows progress ("Adding 3 of 12…");
  at the end, a plain summary: how many were added, how many were
  already on the shelf, how many couldn't be read as books (those
  are skipped, never a hard failure).
- Books are recognised by their **content**, not their names: every
  import path dedupes by the SHA-256 of the book's bytes, so adding
  the same folder twice adds nothing twice.
- Picked folders are **remembered** (the system grants a lasting
  read permission), and **Refresh folders** on the shelf re-scans
  them all for books that arrived since — again adding only what's
  new. A folder whose permission is gone is reported in the summary,
  not silently ignored.
- **Automatic check on open (Joshua, 2026-10-28 12:31 — web
  bundle 2):** reopening the reader re-scans the remembered
  folder(s) BY ITSELF — no Refresh tap. The check runs once per
  cold start, after the shelf has painted (it never blocks the
  shelf from appearing), and it is **quiet**: no progress overlay,
  no summary dialog; unreadable files and unreachable folders pass
  silently (a manual Refresh still reports all of them in full).
  When new books did arrive, one gentle toast says so — "3 new
  books added from your folder" — and dismisses itself. His setup
  behind it: the Drive folder named **"Epub"** is where his books
  live (the Drive root cannot be granted as a folder — a Drive
  provider behaviour — so he created the subfolder and stocked it
  by hand once). From then on, putting a new EPUB in that folder
  is all he should ever have to do.
- Shell note: the folder walk is a generic picker primitive in the
  shell (pick a tree → its files' bytes arrive one at a time), so a
  future import (a folder of dictionaries, say) reuses the same pipe.

### The stable base + web update channel (v0.1.2)

Joshua's framing: **v0.1.2 is the stable base** — the install he
should not have to keep redoing. From here, fixes and features that
live in the web layer (the shelf, the reader page, its scripts and
styles) ship as **patches over the air**, the same manifest pattern
the game ecosystem uses:

- The repo carries the channel: `update/channel.json` names the
  current **web bundle version**, the minimum shell version it
  needs, and the **sha256 of every file** in the bundle; the files
  themselves sit under `update/files/`. Bundle 1 — the web layer
  inside the v0.1.2 APK — is published alongside the build.
- The shell checks the channel **on launch**, and on demand from the
  shelf's **Check for updates** button. A newer bundle downloads in
  the background; **every file's sha256 is verified** against the
  manifest before the bundle is allowed anywhere near the reader.
- A verified bundle waits and **applies at the next cold start** —
  never mid-session, so a book never changes under its reader.
  Whatever goes wrong (no signal, a bad file, a mismatched hash),
  the **last-good bundle keeps serving**; the APK's own bundled web
  layer is the permanent fallback, so an update can never strand
  him on a broken reader.
- The shelf's footer line always says what is running — app version
  and **web bundle number** — so he can report it ("web bundle 3")
  and Mollie knows exactly which code he is looking at.
- **The honest Android limit:** this channel patches the *web
  layer* only. A change to the native shell itself (a new bridge
  power, a new permission) still means a new APK and a one-tap
  install confirm from Joshua — Android gives sideloaded apps no
  fully silent way to replace their own APK, and this reader does
  not pretend otherwise. That is why v0.1.2's shell was built broad
  on purpose: file pick, folder tree, read-aloud, full screen, and
  the update machinery are all already in the base.

### Read-aloud that turns its own pages (Joshua, 2026-10-28 12:33 — spec for web bundle 3, STAGED, not yet built)

Joshua's words, organized: read-aloud must **turn the page itself** —
when the voice finishes a page, the reader moves to the next page
and keeps reading — and the **text being read is highlighted** as it
reads. This supersedes the v0.1.1 note under "Reading gestures"
("the displayed page does not chase the voice"): now the page DOES
follow the voice, and the saved reading place follows it too —
stopping leaves him where the voice stopped.

- Speech is driven in **sentence-sized utterances** from the web
  layer, each mapped to a known CFI range on the current page; when
  a sentence starts, its range is **highlighted** (epub.js
  annotations, a colour that stays readable in day, night, and
  sepia).
- On page exhaustion the reader turns (`rendition.next()`) and
  continues with the next page's sentences, to the end of the book.
- Stopping — a second long-press, the Stop chip, or leaving the
  book — clears the highlight and halts speech and page-turning
  together.
- **Granularity, honestly:** sentence-level highlighting is the
  floor the current shell guarantees — it already forwards
  utterance done/error to the web layer per utterance
  (`__ttsOnDone` / `__ttsOnError`), so one utterance per sentence
  gives the web layer every boundary it needs. **Word-level**
  highlighting needs the engine's character-range callbacks
  (`UtteranceProgressListener.onRangeStart`), which the v0.1.2
  shell does **not** forward — its listener implements onStart,
  onDone, and onError only (MainActivity.java). Word-level
  therefore waits for a small shell increment (reader v0.1.3);
  bundle 3 ships sentence-level and never promises word-level the
  engine cannot supply.

### Definition pop-ups
- Books produced by Mollie carry EPUB 3 footnote definitions
  (`epub:type="noteref"` → footnote asides). Tapping a defined term floats
  the definition over the page; tap anywhere else to dismiss. No page jump.
- **No page jump, enforced (web bundle 2):** v0.1.2 showed the
  pop-up AND still navigated to the definitions — Joshua: "the
  pop-up is still working fine ... but it's definitely still going
  to the definitions page." Root cause: epub.js navigates in-book
  links through an `onclick` **property** it assigns to every
  anchor, and the old pop-up handler's `stopPropagation` cannot
  stop a handler on the same element, so the navigation fired
  right behind the pop-up. The bundle-2 interception sits in a
  **capture-phase listener on the page document**: a definition
  note's click is stopped on its way down, before the anchor is
  ever reached. Ordinary in-book links (chapter cross-references
  that are not definition notes) are untouched and navigate
  exactly as before, and a tap that dismisses an open pop-up
  never opens the note it happens to land on.

### Dictionary doorway (ordinary words)
- Long-press any word → the shell hands it to the installed dictionary app
  (GoldenDict / ColorDict), which floats the meaning; closing it returns to
  the exact reading spot.
- **Superseded in part (2026-10-28):** Joshua's gesture spec gives the
  reading-page long-press to read-aloud. The doorway needs a new
  trigger (double-tap a word is the obvious candidate) — open
  question, awaiting his word. See "Reading gestures".
- Our authored terms live in dictionary files generated from one master
  list (`docs/DICTIONARY.md`), so Joshua's definitions work in every book.

### Read-aloud (text-to-speech)

- V1 includes a **basic read-aloud**: it speaks the book through the
  **phone's own text-to-speech engine**. No voice is built into the
  app — the engine, and therefore the voice, is the phone's choice.
  Started and stopped by **tap-and-hold** on the page since v0.1.1
  (Joshua's gesture spec — there is no read-aloud button).
- Natural voices (finding, 2026-10-28): the truly natural-sounding
  voices are **cloud voices** — they live on a server, not in a phone.
  The practical route to a near-natural voice **offline** on Joshua's
  TCL is a system TTS engine app that this reader (and every other app)
  can then speak through: **SherpaTTS** (F-Droid, GPL) running **Piper**
  voices via sherpa-onnx. A voice is downloaded **once** — about 63 MB
  for a medium voice — and then works entirely offline.
- Why Piper and not the higher-quality Kokoro voices: measured on
  budget phone chips, Kokoro runs **slower than real time** — the phone
  cannot keep up with its own speech — while Piper runs **far faster
  than real time**. On Joshua's hardware, Piper is the voice that works.
- So Joshua can judge the voice himself, Mollie rendered a Piper sample
  (voice: en_US-lessac-medium) reading the sample book's first chapter.

## V1 — out of scope (deliberately)

- PDF (a separate beast; Moon+'s PDF depth is not a v1 goal).
- OPDS / online catalogues, Dropbox sync. (Google Drive is in scope —
  see Files above; the Phase 2 sign-in is the only account.)
- Text-to-speech beyond the basic read-aloud above — no built-in or
  cloud voices in v1; the natural voice comes from the phone's engine
  choice (see "Read-aloud").
- Any store release. Distribution is a sideloaded APK, like the Suite.
