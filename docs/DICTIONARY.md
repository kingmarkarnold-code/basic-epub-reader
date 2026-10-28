# Dictionaries — one master list, every doorway

## The doctrine

Definitions are authored **once**, in a master list (term → definition kept
with the book or report project that introduced the term). Every surface is
generated from that list — never retyped:

1. **Footnote layer inside the EPUB** — EPUB 3 noterefs + footnote asides,
   for the in-book pop-ups (this reader, Moon+, Apple Books).
2. **A glossary chapter** at the back of the same book — the fallback every
   reader can show.
3. **Dictionary files** for the external dictionary apps:
   - `.dsl` (plain text) — GoldenDict's native authoring format.
   - StarDict (`.ifo` / `.idx` / `.dict`) — read by ColorDict and GoldenDict.

Updating a definition = editing the master list and regenerating. The user
side of an update is replacing one small file in the dictionary app's folder.

## Shipped

`dictionaries/` — the 7 terms from the sample book *Adamsville in Miniature*
(Zone, Spawn point, NPC, Waypoint, Draw distance, Terrain, Reflowable text),
as `adamsville-definitions.dsl` and `stardict/adamsville-definitions.*`.
Both verified: the StarDict set parses back word-for-word.

## Why ColorDict is acceptable despite its age (Joshua's question, 2026-10-28)

Its only job is dumb and local: read a dictionary file and float the text.
If it installs and indexes the file on the phone in question, lack of
maintenance is a small risk, not a blocker. The real cautions are practical:
install only from the official Play listing (never a random APK site), and
test on the actual phone — very old apps can refuse to install on the newest
Android versions or fail to see their folder under scoped storage. GoldenDict
is the maintained alternative and reads both formats shipped here.
