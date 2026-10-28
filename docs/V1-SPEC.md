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

### Definition pop-ups
- Books produced by Mollie carry EPUB 3 footnote definitions
  (`epub:type="noteref"` → footnote asides). Tapping a defined term floats
  the definition over the page; tap anywhere else to dismiss. No page jump.

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
