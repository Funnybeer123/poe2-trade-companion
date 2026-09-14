# Saved map and cursor capture search

Searched 2026-09-14 after the user asked to locate existing material. The
implementation checkout is `Documents/Codex/poe2-trade-companion`; the older
`Documents/Cursor Repos/poe2-trade-companion` copy contains substantially more
historical artifacts. It was inspected read-only and was not changed.

## Located material

| Location | What was found and inspected | Use and limitation |
| --- | --- | --- |
| `Documents/My Games/Path of Exile 2/Screenshots` | Eight game screenshots. `screenshot-0005.png`, `0006.png`, `0007.png` are dated September 11 and were inspected at full-frame resolution. They visibly show Map Objectives/Map Content during encounters. Earlier images show town/hideout/dialog contexts. | Useful positive map and negative town/hideout samples. The recent map images have inventory closed; they do not demonstrate Wisdom use or an item-held-to-ground sequence. |
| `Documents/Cursor Repos/poe2-trade-companion/artifacts/map-triage` | August journals, benchmark records and move calibration/history; no saved image files in this folder. | Historical behavior and failure records, not new per-item cursor/ground receipts. The old runner's summary of a drop is not independent proof. |
| `Documents/Cursor Repos/poe2-trade-companion/artifacts/teach` | Five teaching folders, including August 29 and September 2, with frame sequences and input-event JSONL. Timeline samples from each were visually inspected; the final September 2 folder also has narration about merchant pricing. | Useful stash, merchant, pricing-dialog and inventory observations. The inspected samples do not establish a complete Wisdom-use and ground-drop sequence. Further frame-by-frame cursor annotation may be useful. |
| `Documents/Cursor Repos/poe2-trade-companion/fixtures/perception/live` | 1,923 image files, predominantly August 25 cycle/step/open-stash/deposit captures. Filename groups and timestamps were inventoried. | Existing stash/perception regression material; not all 1,923 files were visually reviewed. These predate the August 31 map-triage journal runs. |
| `Documents/Cursor Repos/poe2-trade-companion/artifacts/vendor-cycle` | Failure/probe screenshots, including `probe-now.bmp`, vendor panels and portal/hub errors; these were visually sampled. | Useful map/world and vendor/obstruction cases. No paired Wisdom-use/held-item receipt was established. |
| `%APPDATA%/poe2-trade-companion/assistive-artifacts` | 169 image files; 101 after choosing PNG over duplicate-named BMP. All 101 were reviewed as contact sheets. | The reviewed scenes show stash/inventory transfers and tooltip states. They do not provide the required in-map identification/drop sequence. |
| `Documents/Codex/Poe2StashRegexWeb/tools/ui-stash-scan/Poe2StashScanner/bin/Debug/net8.0-windows/troubleshooting_inventory_pack_2026-06-07_222922_frames` | 180 cropped inventory frames, sampled every ten frames. Sampled frames are 960×478. | Useful physical layout, packing and tooltip cases. Cropped inventory frames cannot establish map context or ground release. |
| `OneDrive/Desktop/poe2-item-intelligence-demo.mp4` | Beginning/middle/end samples inspected. | Companion UI demonstration, not a game identification/drop recording. |

The project copies under `Documents/Codex` and `Documents/ChatGPT`, likely
recording/screenshot folders, other development folders, and matching temporary
capture filenames were also searched. No claim is made that every image on
every drive has been examined.

## Local evidence and next use

Search inventories are ignored files under `artifacts/bag-*-capture-search.txt`.
`artifacts/map-triage/capture-search/index.json` and `legacy-index.json` retain
the exact absolute source paths and sampled image dimensions. Corresponding
`contact-*.jpg` and `legacy-*.jpg` allow quick visual review. Original images,
recordings and journals were not altered, and private imagery/raw inventory
data were not committed or uploaded.

There **are** existing map and inventory captures to reuse. There is **not yet
a verified complete set** for empty cursor → Wisdom-use cursor → identified
item → held intended item → confirmed ground release. Do not relabel the
available images as that evidence. The live adapter, native cancellation and
staged app integration remain unfinished as described in
[BAG_TRIAGE_VALIDATION.md](BAG_TRIAGE_VALIDATION.md).
