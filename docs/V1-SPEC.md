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
- Page turning by tap zones (right/left edges) and swipe; a progress bar and
  chapter name at the bottom.
- Font size control, day / night / sepia themes, brightness by edge drag
  (Moon+ gestures Joshua already knows).
- Table of contents drawer; in-book search; bookmarks.
- Remembers the reading place per book, on the device, with no account.

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
- Our authored terms live in dictionary files generated from one master
  list (`docs/DICTIONARY.md`), so Joshua's definitions work in every book.

### Read-aloud (text-to-speech)

- V1 includes a **basic read-aloud**: a button on the reading screen that
  speaks the book through the **phone's own text-to-speech engine**. No
  voice is built into the app — the engine, and therefore the voice, is
  the phone's choice.
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
