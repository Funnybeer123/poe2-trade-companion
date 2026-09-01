# HANDOFF — Sort/stash pipeline performance overhaul

**Mission**: make the whole sort/stash/item-moving pipeline ULTRA FAST while
staying 100% reliable. Remove redundant steps. The user's words: "I want to
get it ultra fast, but still one hundred percent reliable." Reliability wins
every tie — a rerun is cheap, a misfiled item is not.

**State**: the sorter WORKS and is verified end to end (2026-08-30): all 20
Gear-folder tabs sweep clean by Ctrl+C ground truth, foreigners file to their
true tabs, weapon classes split into per-class standard tabs, T-tab scope
pending re-run. What remains is speed.

## Implementation status (2026-08-30, this session — NEEDS LIVE VALIDATION)

All seven redundancy items below are implemented; tsc + eslint + vitest are
green (the 13 failing tests are the pre-existing better-sqlite3
NODE_MODULE_VERSION mismatch, unrelated). NOT yet run against the game —
kill any running sorter/host first (invariant: the process never sees
edits), then dry-run, then live with bench comparison.

1. DONE — legacy search/highlight machinery deleted outright (GEAR_ROUTES,
   partitionBySearchDim, dimFractionFromScores, decideSearchOutcome,
   decideOccupancySanity, filterByClusterSize, withdrawBudget, ownQueryFor,
   foreignCells, cellCertainlyEmpty, verifiedWithdraw, route(), purgeForeign,
   depositCascade, deposit(), triageBag/depositTriaged, --max-trips) plus
   their tests. setSearch shrank to clearSearch (click+ctrlA+backspace);
   the Highlight box is cleared ONCE per session (searchCleared flag).
   captureFrame split: captureRaw (pixels only) feeds every hot path; bag
   occupancy comes from the calibrated bagGrid via scoreGridCellsRgb; full
   perceiveUi runs only in recovery/uncalibrated fallbacks. The calibration
   profile is loaded once (was: one disk read per frame).
2. DONE — verified sprite-continuation skip in identifyCells:
   cellEdgeContinuity (itemSprites.ts) proposes skipping a cell that
   continues its left neighbour's sprite; claimNeedsReverify (gearSort.ts)
   re-hovers every claimed cell whose item's bounding box is not EXACTLY the
   class's minimum footprint. Pixels propose, the Ctrl+C re-read disposes.
3. DONE — offset probes: ONE informed probe at the brightest 9x9 block in
   the cell (brightestCellPoint) replaces the four blind hovers; the blind
   pattern remains only where no pixel data exists.
4. DONE — incremental re-sweeps in cleanTab: a per-visit read model
   (tabReads) means each round sweeps only unknown cells (withdrawn cells
   are forgotten, deposits appear as new occupancy). A clean verdict built
   on trusted reads triggers ONE belt-and-braces full re-sweep
   (incremental-clean-verify guard) before it counts.
5. DONE — goto: new `pixwait` host op (pixel change-then-stable detection on
   a 60px grid strip) replaces the fixed 1000ms sleeps; folder-list rows are
   cached for the session (folderRowsCache, gated by folderListOpen — the
   top-list flows CLOSE the folder list, one physical dropdown!); an
   already-active tab exits after one cheap grid proof (stashGridVisible =
   hasRegularCellGrid over calibrated bounds, no OCR). The cached-row fast
   path accepts only POSITIVE proof (grid repainted AND still a grid);
   anything less falls back to the slow OCR-verified path. Junk deposits
   remember the last accepting T tab (lastJunkTab) and reuse it without
   re-enumerating the top list.
6. DONE — distributeBag keeps a bag-load read model (bagReads): the bag is
   identified once per load, deposited cells drop out of the model, and the
   post-deposit occupancy capture reconciles it (ground truth).
7. DONE — turbo copysweep hover 120ms → 100ms (identifyCells hoverMs). The
   90ms/22-unread failure predates grid calibration; watch "read N/M cells"
   live and revert to 120 if the read-rate drops.

Watch these NEW guards in bench.jsonl: goto-fast-path-miss,
tab-switch-not-observed, top-list-close-unverified, claim-reverify,
incremental-clean-verify. High fire-rates mean a fast path is misjudging
and its threshold needs tuning (each has a slow-path fallback, so
correctness holds either way — it just gets slow again).

## Live findings (2026-08-30 evening, user's new tab layout)

The user reworked their tabs: top level = Dump (silver, quad), Gear
(folder), AFFINITIES, Extra. NO T tabs, NO Weapons quad; 18 per-class tabs
inside Gear. Adaptations, all verified live:

- **No strip overflow ⇒ no top-list toggle.** The old (1287,212) toggle
  does not render; openTopList can never succeed. Top-level navigation now
  clicks the tab's own STRIP HEADER (user's chosen design; the dropdown is
  used only for positional T@row sources). listTopSources enumerates the
  strip; the dropdown is consulted only when the strip shows T tabs.
- **A light-coloured tab NEVER OCRs** (silver Dump: dark text on light
  ground, active or not — 98-113 gray vs brown headers ≤78, background
  ~15). brightHeaderRuns (threshold 88) finds it by pixels; when exactly
  one bright unlabeled header exists and nothing readable claims the wanted
  label, it is clicked as that tab (top-tab-by-brightness guard). Unmask
  hop to a gear tab is the last resort.
- **Deposit verification races the bounce animation.** A full tab's items
  read as "landed" if the bag is captured while they fly back (~0.7-1.3s!),
  then reappear — this re-filed the same rings for whole rounds and poisoned
  fullDests/stuck marks. depositCells now waits 700ms unpaced and requires
  TWO reads (650ms apart) to agree a cell emptied (deposit-bounce-detected
  guard fires when the reads disagree).
- **"Not enough space" toasts cover the stash TITLE**, faking panel-closed;
  ensureStash then clicked the world's Stash nameplate visible beside the
  open panel, the walk closed the panel for real, and the run died
  (stash-lost-and-unrecoverable ×2). Destructive recovery clicks are now
  gated on the stash GRID being pixel-absent
  (stash-open-by-grid-despite-title-miss guard), and a failed bail return
  is non-fatal (bail-return-failed).
- **Unreachable/full destinations self-heal**: deadDests per visit, items
  bail junk→source (bag-bailed-to-source), and foreignItemsFor excludes
  them so they stop being withdrawn. With no Weapons quad, axe/sword/claw/
  dagger/flail items stay in Dump by design (destForItemClass still says
  "Weapons") — decide a real home for them with the user.
- The "full tab" verdicts of the mid-evening sessions were mostly RACE
  ARTIFACTS: with the widened double-read (700ms + 650ms) the final run
  filed 52 rings into "full" Rings and finished the whole tab. Trust no
  full-verdict recorded before the wide window existed.
- Turbo 100ms hover read-rate matched 130ms (265/290 both) — keep 100ms.
- Incremental re-sweep verified live: 52/576 cells on revisit vs 290 fresh.

## OUTCOME (2026-08-30 late): Dump tab sorted end-to-end

Final run exited clean: "Dump^: done — ~92 cells moved" that run alone;
across the evening ~150 items filed by Ctrl+C ground truth, final full
sweep verified 1 junk item + row-22 phantom band (red decorative cells,
all blacklisted unclicked) + a handful of never-copyable items reported
for hand-checking. Bag empty.

## NEXT session tuning (bench, final session)

goto n=30 avg 12.2s (baseline 9.9s — REGRESSED for this layout):
- tab-switch-not-observed fired 44× — near-empty dest tabs are pixel-
  identical in the 60px probe strip, so pixwait burns its 1100ms cap plus
  the 500ms penalty on hops that actually succeeded. Treat "unchanged" as
  cheap-success when the destination was already plausible, or probe a
  region that differs across tabs (e.g. include the strip row).
- goto-fast-path-miss fired 18× — hasConsistentCellGrid (strict, needed to
  stop the hideout-floor false positive in ensureStash) false-negatives on
  item-covered tabs and disables the cached-row fast path. Split the
  proofs: strict only for DESTRUCTIVE recovery gates, a cheaper positive
  signal (folderListOpen + repaint) for fast-path entry.
- distribute-bag avg 112s — the wide double-read costs ~1.6s per deposit
  round; consider one read at +1.4s instead of two, and batch consecutive
  groups whose dest repeats.
clean n=1 total 665s for the final mop-up session (multi-trip).

## Measured baseline (artifacts/tab-admin/bench.jsonl, last ~800 phases)

| phase           | n   | total    | avg    |
|-----------------|-----|----------|--------|
| clean (per tab) | 65  | 3396.8s  | 52.3s  |
| goto (per hop)  | 273 | 2708.8s  | 9.9s   |
| distribute-bag  | 34  | 2148.7s  | 63.2s  |
| ensure-session  | 13  | 209.5s   | 16.1s  |

Navigation is ~45 minutes of the session. Re-sweeps and fixed sleeps dominate
the rest. `bench.jsonl` keeps recording — use it to prove every change.

## Known redundancies to attack (concrete, with locations)

1. **Legacy search/highlight machinery still runs and is never used.**
   Ground-truth Ctrl+C identification replaced the stash-search flow, but:
   - `cleanTab` still calls `setSearch("")` every round 0
     (src/adapters/gearSorter.ts, "search-clear-failed") — full search-box
     focus proof + typing per tab. Only needed if a stale query could dim
     cells; clear ONCE per session, not per tab.
   - `GEAR_ROUTES`, `partitionBySearchDim`, `dimFractionFromScores`,
     `decideSearchOutcome`, `verifiedWithdraw`, `route()`, `purgeForeign`,
     `depositCascade`, `ownQueryFor`, `filterByClusterSize`,
     `withdrawBudget`-by-route (src/core/gearSort.ts + gearSorter.ts legacy
     methods) are DEAD in the `run()` path but still compiled, tested, and
     mentally maintained. Delete them and their tests, or quarantine into a
     legacy module. `minFootprintForClass` is already unused (import removed).
   - `captureFrame` runs full perception (`perceiveUi`) per round mostly for
     the empty-cell baseline + a geometry fallback that calibration has
     superseded. Strip it to: capture BMP → `scoreGridCells` on the
     calibrated region only. (Keep `stashRegionSane` fallback for the no-
     calibration case.)

2. **Multi-cell items are hovered on every cell** ("clicking on multiple
   spots on one item"). Claiming was removed because top-left-anchored claims
   hid rings beside helmets (user screenshot, 2026-08-30). The RIGHT fix is
   VERIFIED claiming inside `identifyCells` (src/adapters/gearSorter.ts):
   after the batched row sweep, cells whose copy-text EQUALS an adjacent
   already-read cell's text collapse into that item via
   `groupIdentifiedCells` — that part is free. The cost is the hover itself.
   Safe optimization: within a row batch, when cell N returns text T, cell
   N+1 may be SKIPPED only if a cheap per-cell pixel signature says it is a
   continuation of the same sprite (e.g. cross-correlation of the cell edge
   columns), and any skipped cell MUST be re-verified whenever its item's
   grab-cell count disagrees with `minFootprintForClass`. Never skip on
   class-footprint assumptions alone — that is the exact bug that hid rings.

3. **Offset probes are 4 blind extra hovers** per silent cell. Use the cell's
   pixel content to pick ONE probe point (brightest 9x9 block inside the
   cell) instead of the fixed 4-point pattern (`identifyCells` offset loop).

4. **Full-tab re-sweeps every round.** After a withdraw trip, `cleanTab`
   re-identifies the ENTIRE tab. Only these cells can have changed: the
   withdrawn cells, unread cells, and phantom candidates. Re-sweep exactly
   that set; trust prior reads for untouched cells within the same tab visit.
   Verify with one final full sweep only when the incremental pass says
   clean (belt-and-braces, still saves n-1 of n sweeps). Weapons took 4+
   full 576-cell sweeps in one clean.

5. **goto costs 9.9s** because every hop re-OCRs the full screen (often
   multiple times), then sleeps fixed 1000ms + settleGrid. Attack:
   - Cache the folder list rows for the WHOLE tab visit (rows do not move);
     re-read only on a failed click-verification.
   - Replace fixed sleeps with change-detection: capture a 60px strip of the
     grid area and poll every ~80ms until it changes (tab switched), cap at
     the current sleep. Same for `selectTabListRow`'s 1000ms.
   - Deposit trips bounce dest→source→dest; order bag groups so consecutive
     trips share a dest, and consider withdrawing from the source until the
     bag is FULL before the first deposit hop (fewer round trips per tab).
   - `ensureSession`/`listSources` full-screen OCR passes: one per run is
     enough; the requeue path re-lists redundantly.

6. **Bag re-identify between filings** (`identifying N bag cells` repeats
   with shrinking N): after a deposit lands, the remaining bag cells' texts
   are already known — drop only the deposited cells from the model instead
   of re-copysweeping the bag every group. Re-verify the bag ONLY when a
   deposit's click count disagrees with the bag-shrink ground truth.

7. **Fixed pacing**: turbo hover 120ms + clipboard poll (15ms step, 220ms
   cap) in `copysweep` (scripts/win-input-host.ps1). The poll usually
   returns in ~40-60ms; the hover wait is the dominant term. Try 90-100ms
   hover with the offset-probe safety net and measure read-rate (it was
   tried at 90ms once and produced 22/93 unread — but that was BEFORE the
   grid calibration; retest now that hovers land dead-centre).

## Invariants — do NOT regress these (each cost hours to learn)

- **Classification is Ctrl+C item text only.** Pixels may SKIP (empty-cell
  baseline) or PRIORITIZE, never classify.
- **Never click a cell that was not identified this visit.** The old
  phantom-over-tab-header incident (clicked a tab header mid-burst).
- **Row clicks anchor to each label's own OCR position** (`snapRows` per-gap
  slots; clickY = line.y + h/2). `top + slot × pitch` drifted a full row by
  slot 8 and deposited 56 rings into Helmets.
- **The dropdown is ONE scrollable combined list** (top rows above folder
  children). Mixed frames are usable after stripping top-level rows
  (`openFolderList`); a stable scrolled state must be RESET by closing the
  list (`closing to reset scroll`), never re-read forever (livelocked once).
- **The strip's second row can belong to the SPECIAL group** (Currency,
  Flask, Maps, Distilled …) — `ensureFolderRowOpen`/`openFolder` must detect
  it and re-select the Gear header (livelocked once; special regex includes
  `dist`).
- **Exact (confusable-folded) label matching for navigation and renames**;
  loose `labelsSimilar` containment sent Staff deposits into QuarterStaff
  and renamed the wrong tab. `labelsEqualFolded` + word-run segment matching
  (`pickExact`, `findLabelSegment`) are the write-path matchers; the settings
  dialog's own Name field is the final gate.
- **Fold OCR confusables** (l/i→1, o→0) before comparing labels ("lh Mace").
- **Elimination matching** (the one unclaimed row must be the missing tab)
  requires a CLEAN children-only frame — mixed frames have many unclaimed
  rows and must refuse.
- **Y-cache for unreadable rows stores absolute clickY, never slot index.**
- **Park the cursor before every list OCR** (tooltips OCR as phantom tab
  rows); chat/AFK lines and single-char debris rows must be filtered
  (`normalizeTabLabel(label).length < 2`, protected-label filters).
- **Grid geometry**: user-calibrated bounds (artifacts/tab-admin/
  grid-calibration.json, `__default_24x24` / `__default_12x12` share the same
  panel rect) + lattice-line size detection (`detectGridDivisions`, ABSOLUTE
  odd/even gap — separator lines are BRIGHTER than interiors). Taught
  per-tab entries outrank detection; detection outranks perception.
- **Never touch**: `(Remove-only)` tabs, `~price` tabs (public listings),
  AFFINITIES; the Gear row is a folder, not a tab. Refusals live at
  enumeration, navigation, and dialog layers — keep all three.
- **Deposits**: plain ctrl-click, then ONE shift+ctrl retry (affinity
  bounce), two-different-tabs undepositable blacklist, home-full → overflow
  to T tabs + `fullDests`. Net-progress accounting uses bag-growth ground
  truth only.
- **Stop/pause**: Numpad 0/5 must land ≤100ms on click paths, between rows
  on sweeps. One overlay at a time; every click shows bullseye+label
  (`SortHarness`), tab-admin clicks show the red marker via
  `StashTabKit.pointer` (POE2_SHOW_CLICKS=0 disables).
- **Stash recovery**: full-screen OCR only (region crops hit the
  Windows.Media.Ocr dead zone); stash plate click excludes Guild stash and
  the minimap label (minimap is walk-toward only); never click blind when
  nothing stash-like is on screen; pause-menu/options detection before any
  corrective clicks; never interact with lock/login screens.
- **The running process never sees code edits** — kill + relaunch (kill node
  PIDs matching sort-gear/tsx AND orphan win-input-host.ps1 processes).

## Validation workflow

1. `npx tsc --noEmit -p tsconfig.node.json` (ignore vendorStaging errors —
   pre-existing, owned by another session) + `npx vitest run` (all suites).
2. `npx tsx scripts/sort-gear.ts --no-triage --dry-run` — full audit, red
   click-plans shown, nothing moves.
3. Live: `npx tsx scripts/sort-gear.ts --no-triage --turbo`; watch
   read-rates ("read N/M cells") and bench phases. `--teach-grid` gates the
   lattice per tab if geometry is ever in doubt.
4. Compare bench.jsonl phase averages before/after EVERY change; a speed win
   that raises unread counts or foreign misses is a loss.

## Current open items (not performance)

- T1-T16 sweep still pending after the last stop (gear scattered there by
  overflow: sceptres in T10/bag, junk routing normal). Weapons and Body
  Armour are no longer full; Sceptres has room again.
- A handful of "never yielded item text" cells may reappear — offset probes
  cover most; watch the logs.
- vendorStaging.ts TS errors are another session's (chip task exists).
