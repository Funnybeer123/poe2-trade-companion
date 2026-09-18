# Identify & drop: the fast one-action workflow

Written 2026-09-17. Applies to **Num6**, **Tools → Bag triage → Identify & drop**
and `npm run map:triage:run`; all three run `--stage=workflow --run`.

**Status: built and offline-verified. Not yet run against the live game.** Nothing in
this document is a live result unless it says "measured live". The September 14
capture is the only live bag evidence; every replay below uses those saved frames.

## Why the previous path was slow

Measured from the September 14 input trace (`input-trace.jsonl`):

| Cost | Measured |
| --- | --- |
| One clipboard read | ~440 ms (250 ms fixed hover, sentinel write, three native round trips) |
| Initial scan | 120 reads (every one of 60 cells, twice) = 53 of the 56 s |
| One observation | two 4K BMP frames (33 MB each: save, hash twice, per-pixel decode) plus a whole-frame OCR of ~0.8–1.3 s |
| One identification | ~6 frame pairs, ~5 whole-frame OCRs, and a double read of every cell of the target |
| Journal | the whole session (600 KB and growing) re-serialized, validated and flushed on every save |

No threshold change fixes that; the work itself had to go.

## What the workflow does now

1. **Safety** – one half-scale whole-frame OCR (modal, death and panel words; Life) and
   the client log's map instance. Offline on a saved 4K frame: 236 ms + 89 ms resize,
   versus 777 ms at full scale, with `Life` and `INVENTORY` still read.
2. **Empty cursor** – the pointer visits both calibrated probes. A software payload follows
   the pointer, so both probe regions must be identical across the two views, the native
   cursor must be a known empty arrow, and the inventory title patch must match. The
   second view becomes the run's pixel baseline.
3. **Scan** – one read per **physical item**. Cells are visited row-major; an uncovered
   occupied cell is therefore always an item's top-left cell, and the item-size catalogue
   gives the footprint, which must lie on occupied, uncovered cells. Empty cells need
   positive full-resolution pixel evidence and cost no read. An unknown size (relics)
   falls back to per-cell reads and stays uncertain in the shared ledger, which blocks
   every mutation exactly as before. The saved 30-item bag needs 30 reads, not 120.
4. **Assess** – the unchanged shared assessment (`captureBagObservations`, `bagDecision`).
   45 ms for the saved bag.
5. **Identify** – the verified Wisdom stack at (0,0) is armed once, then one natively
   Shift-held click chain covers every eligible unidentified item. Afterwards each target
   and the stack are re-read: every target must keep its class, base, rarity and level;
   the scroll count must drop by exactly the number of items that read identified. A
   mismatch stops the run before any drop. An item the chain skipped simply stays.
6. **Drop** – serial. For each positive Low-priority item: re-read the exact ledger text at
   the click position, pick up, carry to the ground point, confirm that *only* that
   footprint emptied, click, park at the probe, and require a positively clean cursor with
   every other footprint unchanged and no new object.
7. **Finish** – the standard hash-chained journal receives two entries: the original
   capture and the final session with per-action receipts. Timing goes to
   `<journal>.timing.json`.

Durable intent is written to `<journal>.actions.log` (hash-chained, flushed, a few hundred
bytes) **before** every mutating input; a failed write means no input. Verified progress is
saved even when the run stops.

## Pixel evidence (measured live, 2026-09-14 frames)

- Both probe regions were **byte-identical** across ten frames spanning 3.5 minutes with an
  empty cursor. Armed Wisdom appears as a compact ~48×48 change (1,028 / 965 pixels) under
  the pointer only. "Probe equals this run's baseline" is therefore positive empty-cursor
  evidence, and no sprite template is needed.
- While Wisdom is armed the used stack turns olive and 32–35 of 60 cells change tint. The
  bright edge pixels of item art do not: all 30 captured items stayed within 1 RGB.
  Footprints are compared on that art (`bagArtMask`), with the stack-count corner judged
  separately (and skipped for the Wisdom stack, whose count is proven by text).
- Empty cells are neutral (median 5,5,5; ≤2% tinted). Every occupied cell is ≥41% tinted
  (identified navy, unidentified red, armed olive). `emptyBagCell` uses ≤6% / ≤4%.
- A dark object without enough bright edges yields a *weak* mask: it can prove the
  footprint is still occupied, never that it is the same item.

These replays run in `tests/bag-fast-vision.test.ts` and `tests/bag-cursor-vision.test.ts`
whenever the private evidence exists under `%APPDATA%`; they are skipped elsewhere and the
frames are never committed.

## Ground evidence

The staged runner demanded a new matching world label after each drop. A loot filter hides
exactly the items this feature drops, so that receipt cannot pass for them. The fast path
records the release as: the item was the sole source departure after an exact text read,
the cursor is positively clean afterwards, every other tracked footprint is unchanged, no
new object appeared in the bag, and the inventory panel is still open. If the click is
refused the item is still on the cursor, the run stops, and the message says so.

## Interlocks that did not change

Process/window allow-list and pinned window handle, native per-event guard (stop, pause,
focus, user-held modifiers and buttons), Num0 / Insert / Ctrl+Shift+Esc stop, Num5 pause,
parent watchdog and stop file, same-map-instance check from the client log, action traces
through `GameInputController`, clipboard restored only if the user did not change it.
New native operations (`readitem`, `clickchain`, `regions`) run inside the same interlock;
the Shift key and buttons they own are released on every exit path, covered by the host
self-test (`shift-chain-release-and-count`, `read-item-sequence-bound`).

## Timing knobs

Defaults (`DEFAULT_FAST_TUNING` in `src/adapters/liveBagFast.ts`), overridable with an
optional `fastTiming` object in `live-perception.json`; every value is bounded to the
native wait range:

| Key | Default | Meaning |
| --- | --- | --- |
| `scanHoverMs` | 110 | hover before a normal read (the old runner used 100–120 live; 140 was reported to miss early currency reads under the staged adapter, cause never established) |
| `carefulHoverMs` | 250 | automatic retry hover after a silent read |
| `readTimeoutMs` | 160 | wait for the clipboard sequence number to advance |
| `probeSettleMs` / `heldSettleMs` | 120 / 110 | frames for the software cursor to follow the pointer before a capture |
| `armSettleMs` | 180 | after the right-click; with the following look this exceeds the ~300 ms the game needs |
| `chainSettleMs` / `chainGapMs` / `chainAfterMs` | 45 / 70 / 140 | Shift chain pacing |
| `dropGapMs` | 200 | minimum pickup-to-ground gap (35 ms was refused, 200 ms landed, 2026-08-31) |

Projected for the saved bag (30 items, 10 identifications, ~8 drops) at these defaults:
about 16 s end to end, of which ~5 s is hover time. **This is arithmetic, not a
measurement.** Lower `scanHoverMs` only after live runs show zero careful retries.

## Staged diagnostics

`--stage=capture|identify|drop|reconcile` still use the per-action staged adapter. Its
three armed-cursor guards now judge item art per known footprint instead of raw background
pixels, accept a compact colour-consistent software payload that follows both pointer
positions, and write the payload rejection beside the empty-cursor fallback in
`*.cursor-proof.json`. The real September 14 pair now proves `wisdom`; without known
footprints it still fails exactly as it did live.

## Entry points

- `spawn("npx.cmd")` throws `EINVAL` on Node ≥ 20.12 (confirmed on Node 24.16), so the
  daemon's script dispatch could not start any worker from this checkout.
  `src/core/scriptLauncher.ts` now runs the prebuilt `dist-electron/map-triage.cjs` with
  node itself when it is at least as new as its sources (0.08 s to start, versus 1.2 s
  through npx), then a local tsx, then npx through a shell with quoted arguments.
- `npm run map:calibrate` was removed: it passed a legacy flag the strict parser rejects,
  and the old calibration moved real items.
- Compaction is still disabled and is not part of this workflow.

## Live acceptance plan (needs a coordinated window)

1. `--max-identifications=1 --max-drops=0`: one identification, exact decrement, all other
   footprints intact. Inspect `*.look.json` for the armed probe delta.
2. `--max-identifications=59 --max-drops=1`: the full chain, then one genuine Low-priority drop.
3. A full mixed bag, three times. Record `*.timing.json` (startup, safety, baseline, scan,
   identify, drop, median/p95 read and drop latency) and careful-retry counts.
4. A comparable human baseline: same item count, size mix and keep/drop choices.

Until step 4 exists the "faster than a human" claim is unproven. Things most likely to
need a live adjustment: `scanHoverMs`; whether releasing Shift always disarms Wisdom
(the run stops with a clear message if the cursor is still occupied); whether a held item
re-tints other cells enough to disturb a *weak* mask.
