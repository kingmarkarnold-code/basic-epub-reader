# Basic EPUB Reader

Joshua's own EPUB reader, started 2026-10-28.

## Why this exists

In Joshua's words: due to ads and the lack of finding a proper EPUB
reader, I decided to create my own using the support of Meta's Muse
AI system.

The free readers are ad-supported, and none of the readers he tried --
Google Play Books, Moon+ Reader, ReadEra -- was the proper fit. So
this reader is being built to his own spec, keeping the features he
actually valued:

1. **A bookshelf like Moon+'s** -- books laid out as covers on a shelf/grid,
   the way Moon+ presents a library. This is the piece Joshua singled out.
2. **Pop-up footnote definitions** -- the EPUBs Mollie produces carry
   their definitions as EPUB 3 footnotes; this reader floats them over the
   page on tap, by design, guaranteed to match the books because both sides
   are ours.
3. **A dictionary doorway for ordinary words** -- like Moon+, the reader owns
   no dictionary. It hands a pressed word to an installed dictionary app
   (GoldenDict or ColorDict) which floats the meaning. Our own terms are
   authored into dictionary files (see `docs/DICTIONARY.md`), so Joshua's
   definitions pop up in any book, not just ours.
4. **No ads, no all-files permission grab, no maze.** Only the settings
   Joshua uses.

## Architecture (decided 2026-10-28)

Same proven pipeline as the Adamsville Suite APK: a web app (HTML/JS) in an
Android shell, built with the toolchain already on Mollie's VM.

- EPUB rendering: **epub.js** (open source) inside the shell — full control
  over the footnote pop-up behaviour, which is the feature this app exists for.
- Dictionary hand-off: a small native bridge in the shell fires the Android
  intent the dictionary apps answer.
- Alternative noted, not chosen: a fully native build on the Readium Kotlin
  toolkit. Revisit only if the web build hits a wall epub.js cannot climb.

## Status

- 2026-10-28: repository created; v1 spec written (`docs/V1-SPEC.md`);
  first dictionary files shipped (7 terms from the sample book
  "Adamsville in Miniature", in `dictionaries/` — DSL for GoldenDict,
  StarDict for ColorDict/GoldenDict).
- Next: bookshelf first build (shelf screen + open a book + reading screen),
  then footnote pop-ups, then the dictionary doorway.

Proof standard (Joshua's rule): nothing counts as working until it works in
his hands on his phone.
