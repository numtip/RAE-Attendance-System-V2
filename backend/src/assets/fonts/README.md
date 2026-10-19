# Bundled fonts (Thai) — provenance and licence

Report exports (R-03) embed a Thai font. A PDF cannot render Thai without one, and a browser or OS font
cannot be used from a server process, so the font ships with the backend.

| File | Size | SHA-256 |
|---|---|---|
| `Sarabun-Regular.ttf` | 90,220 B | `226D4F368FBC0457990DDEF2692679BADFD2C1A4E89E5AC4D43C10BA7743B2F1` |
| `Sarabun-Bold.ttf` | 89,804 B | `D38308CA27D067B9A1B79006337C1F9A66C29AA016D96A9D88D3801DA7FA83B9` |
| `OFL.txt` | 4,387 B | the licence text, copied verbatim |

* **Family:** Sarabun (the standard Thai government typeface), by The Sarabun Project Authors.
* **Source:** <https://github.com/google/fonts/tree/main/ofl/sarabun> (fetched 2026-10-16).
* **Licence:** SIL Open Font License, Version 1.1 — see `OFL.txt` in this folder. Redistribution and
  embedding in documents are permitted; the font must not be sold on its own and must not be renamed. The
  family name is unchanged here, and the licence text travels with the files as the OFL requires.
* **Verified:** both files are TrueType (`00 01 00 00` magic), load in fontkit/pdfkit, and shape Thai
  correctly — including the reordering case, where pdfkit applies GSUB so that `้` followed by `ำ` becomes a
  single glyph that its ToUnicode CMap maps back to `U+0E49 U+0E33`.

## Why these files are in `src/`

`deploy/docker/backend/Dockerfile` copies `backend/src` into the image, so anything under `src/assets/`
ships with no Dockerfile change. Keep them here.

## Updating

Replace the files, re-run the export tests and the document-level tests, and update the hashes above. A
different family is a deliberate decision, not a swap: the PDF tests assert the registered font, and the
resolved absolute path is derived from `path.join(__dirname, ...)` so a missing file must fail loudly rather
than silently falling back to a font that renders Thai as empty boxes.

## Known limitation (recorded, not hidden)

Extracting Thai text from a generated PDF is not always byte-exact: words containing `ำ` (U+0E33) can come
back decomposed (for example `ทำงาน` extracts as `ทำางาน`). The **visual** output is correct and the numbers
and dates extract exactly, which is what a report is read for. This is a pdfkit/fontkit shaping behaviour,
not a defect in the export code; it is recorded in the slice document as a known limitation.
