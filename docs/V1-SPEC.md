# Basic EPUB Reader — V1 Spec

Written 2026-10-28 from Joshua's direction. His words govern; this document
records them so the build can be checked against them.

## What Joshua asked for

- An app like Moon+ Reader is **not** needed for Moon+'s sake — what he valued
  is (a) the way Moon+ puts books on the screen **in the library**, which we
  mimic, and (b) some of its features, which we implement selectively.
- The app lives in its own GitHub home (this repo — decided over reusing a
  folder in the game repo; see the repo decision note in the README history
  and Joshua's message of 2026-10-28 08:44).

## V1 — in scope

### Bookshelf (the library screen — the Moon+ piece)
- Books shown as **covers on a shelf-style grid**, title + author under each
  cover, most recently read first.
- Import: pick EPUB files from the phone (Downloads, Drive via the system
  file picker). The book's cover is extracted from the EPUB itself.
- Tap a cover → the book opens where you left off.
- Long-press a cover → book details / remove from shelf (file itself is
  never deleted).

### Reading screen
- Page turning by tap zones (right/left edges) and swipe; a progress bar and
  chapter name at the bottom.
- Font size control, day / night / sepia themes, brightness by edge drag
  (Moon+ gestures Joshua already knows).
- Table of contents drawer; in-book search; bookmarks.
- Remembers the reading place per book, on the device, with no account.

### Definition pop-ups (the reason the app exists)
- Books produced by Mollie carry EPUB 3 footnote definitions
  (`epub:type="noteref"` → footnote asides). Tapping a defined term floats
  the definition over the page; tap anywhere else to dismiss. No page jump.

### Dictionary doorway (ordinary words)
- Long-press any word → the shell hands it to the installed dictionary app
  (GoldenDict / ColorDict), which floats the meaning; closing it returns to
  the exact reading spot.
- Our authored terms live in dictionary files generated from one master
  list (`docs/DICTIONARY.md`), so Joshua's definitions work in every book.

## V1 — out of scope (deliberately)

- PDF (a separate beast; Moon+'s PDF depth is not a v1 goal).
- OPDS / online catalogues, Dropbox or cloud sync, accounts.
- Text-to-speech (the phone's own read-aloud and Play Books cover today).
- Any store release. Distribution is a sideloaded APK, like the Suite.
