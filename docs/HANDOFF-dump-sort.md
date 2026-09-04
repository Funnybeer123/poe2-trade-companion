# HANDOFF — Dump→Gear sort as THE default, split navigation, empty-bag guarantee

## STATUS (2026-09-01): implemented and live-validated; run stopped by user mid-sort

All six items below are built; tsc + eslint green, vitest green except the 13
pre-existing better-sqlite3 NODE_MODULE_VERSION failures. Live validation:
dry-run clean (480/481 cells, 194-item plan), then a live run that filed ~30
items into 10 class tabs before the user pressed Numpad 0 (stop landed
instantly, mid-sweep). ~165 items remain in Dump — rerun
`npx tsx scripts/sort-gear.ts --no-triage --turbo` to continue; the
dirty-bag phase files any bag leftovers first.

Key learnings this session (bench-verified):
- **pixwait's change baseline races the click**: it is grabbed AFTER the
  click, so a fast tab switch completes first and reads as "no change" —
  this is what the perf handoff's 44 tab-switch-not-observed fires on
  SUCCEEDED hops were. Fixed race-free: a frame captured BEFORE the click is
  compared against one captured after (`regionChangedFraction`,
  `observeTabSwitch`, guard `tab-switch-caught-by-baseline` — caught the
  race live on the first Shields hop). Never trust a post-click baseline.
- The switch probe now covers the STRIP rows + grid top (highlight always
  moves on a real switch, even between pixel-identical near-empty grids).
- Goto times after the fix: 3.5-3.8s cached-row hops, 8.8s first hop
  (baseline was 12.2s avg with the old probe).
- Rings accepted deposits — the "Rings full" verdicts of 2026-08-31 were
  race artifacts of the pre-wide-window double-read, as suspected.
- An already-active tab is the one legitimate "unchanged" click: strip and
  folder paths blind-accept ONCE (guarded) when the active tab is unknown;
  demanding a change called an already-active Dump "unreachable" for 35s.

Still open: the homeless weapon classes (axe/sword/claw/dagger/flail →
dest "Weapons", which no longer exists) had NO live instances in Dump this
run — the user still needs to name a home before any appear.

## Round 3 (2026-09-01, live testing + watcher-bot speed analysis)

**The Dump tab is SORTED** (run 4 exited "0 leaving", verified-empty bag;
only junk + a few Ctrl+C-silent cells remain in Dump by design). Bugs found
by watching runs 3-4 live and fixed:
- **Placement, not cell count**: 57 free cells fit only twelve 2x2 helmets
  in a 12x5 bag — the game refused the rest. `packTripByDest` now simulates
  the game's first-fit fill (emptyBagMask/findPlacement) over the bag's
  real occupancy; after an overflow a new destination joins only if its
  WHOLE group places.
- **Tooltip poisoned the shortfall check**: the burst leaves the cursor on
  the last cell and its item tooltip covered the grid — 10 of 15 items
  "restored" when only 3 stayed. Now: park + pre/post-burst frame diff per
  item bounding box.
- **Withdraw-commit race**: a paced 400ms expired mid-burst-processing and
  the bag undercounted (false restores EVERY trip). Now an unpaced poll
  until two consecutive bag reads agree, plus an implausibility re-check.
- **Switch observation is baseline-FIRST**: pixwait's post-click baseline
  missed 20/20 real switches (guaranteed 1.6s burn per hop). The pre-click
  frame comparison (strip + full grid, 0.2% threshold; live: no-op 0.00%,
  real switch 11-27%) is now the primary observation; pixwait only holds
  for repaint stability. tab-switch-not-observed is now a REAL signal.
- **Proof freshness**: any observed panel repaint counts as a positive
  stash proof for 20s (reset on recovery/unobserved clicks) — the per-hop
  title-OCR rounds are gone.
- **Cached top-header points** (`topHeaderPoints`): Dump returns click the
  remembered strip point (baseline-verified) instead of re-running
  settledOcr — 11.5s → ~4s per return.
- **Pixel-verified dropdown toggles**: chevron clicks wait on a list-region
  diff against the pre-click frame instead of a blind sleep, so the next
  OCR read never races the animation (killed the per-trip toggle churn).
- **Deposit verify = ONE read at +1450ms** (equal detection to the old
  700+650 pair — the union rule made the early read powerless, watcher #9).
- **Nav-fail ≠ dead**: a known gear tab whose goto fails gets one retry on
  a later trip before deadDests (a flaky goto once stranded 7 helmets).
- Capture BMP scratch moved out of the OneDrive-synced repo (os.tmpdir()).
- Turbo hover stays 100ms. A 90ms retest was INCONCLUSIVE: the 23
  unread cells it hit are silent at 100ms too — a persistent unreadable
  cluster in Dump (glare/decorative cells scoring occupied), not a speed
  effect. Retest 90ms only against a FULL tab. Those 23 cells re-report
  every clean-tab run (~30s cost) — worth a hand check / calibration look.

Watcher-bot backlog (not yet shipped): bag re-identification could be
replaced by placement-simulation inference with an exact-occupancy-mask
gate (~90s/run; verify the game's fill rule matches findPlacement first);
clicking the strip's SECOND ROW headers directly for folder tabs would drop
the dropdown from the hot path entirely (~100-150s/run) but changes the
handoff's dropdown-for-folder-tabs design — ask the user.

## Round 5 (2026-09-01 night) — THE ROOT CAUSE, user-diagnosed

**TOP-LEVEL tabs render the stash grid ONE STRIP ROW HIGHER than folder
tabs** (~67px: no second tab row when a top-level tab is active). The user
spotted it from the perception overlay (scripts/diag-overlay-items.ts);
lattice-measured: top-level grid y 253..1518, folder grid y 320..1583. One
calibration was serving both states, so on Dump every read AND click was
exactly one row low — they agreed with each other, which is why sorting
"worked" while: the true top row was invisible (the missed jewels/trinkets),
the taught bottom row hovered the panel FOOTER (the entire "phantom band" /
"silent cells" grind was footer decoration), and the "ungrabbable belt" was
a real belt one row above where we clicked. Nearly every mystery of rounds
1-4 was this one offset.

Fix: per-tab-kind geometry — `__default_24x24_toplevel` in
grid-calibration.json (fallback: TOP_LEVEL_GRID_DY = -67 applied to the
folder bounds), `STASH_AREA_TOP_LEVEL` click floor (minY 272), and the
overlay/diag tools use the top-level bounds for Dump. The stale phantom
store was purged (its entries were footer cells recorded under the wrong
geometry; the footer is now outside the region by construction). Run 12
verification: overlay approved by the user first try (11 cells, 0 phantoms,
0 dim-rescues needed), then 8/8 items filed in one trip, ~90s, clean exit.

The dim-cell rescue (Round 4) and phantom store remain as safety nets but
should now rarely fire. The interactive overlay tool is the debugging
front-door for any future "it missed items" report: it draws exactly what
perception concludes and lets the user teach corrections with pixel data.

## Round 4 (2026-09-01 evening, phantom band + reopen)

Run 9 (fresh loot): 39 items in 3 trips, 4m40s total, zero unread, zero
anomalies, jewels found and filed. Changes:
- **Persistent phantom cells** (artifacts/tab-admin/phantom-cells.json):
  cells that survive the full probe battery are stored WITH their pixel
  signature (phantomSignatureMatches) and skipped while unchanged — a real
  item landing there breaks the signature and re-probes. Recording is
  incremental (onSilent) so a Numpad 0 mid-sweep keeps the learning.
  The Dump quad's bottom decorative band (rows 22-23, 36 cells — the
  "clicking around on the bottom row" complaint) was seeded from ONE
  screenshot via scripts/seed-phantom-cells.ts, no probing.
- Probe battery: informed probe at 140ms hover (the 35ms inventory default
  was why jewels stayed silent) + blind-cross fallback; the separate retry
  pass is gone.
- OPEN: the first folder hop of each trip still runs the 36-38s slow path —
  the chevron's first click after a Dump return reads as swallowed
  (list-toggle-unverified 1x/trip; cause unknown). reopenFolderListFast now
  logs its ref-match fraction and falls back to ONE OCR read (accepting a
  changed-looking open list and refreshing the reference) — next loot run's
  log lines "fast reopen: ..." will say whether the click opens a
  different-looking list or truly does nothing.

## Round 2 (2026-09-01, user feedback after watching the live run)

1. **Single-index visits**: the user guarantees nothing touches the stash
   while a sort runs, so cleanTab now indexes the tab ONCE (phase 1: one
   occupancy scan + one Ctrl+C sweep + one unread-retry pass) and runs every
   withdraw trip off that model (phase 2). The per-trip re-scans, the
   incremental-clean-verify sweep, and the unread retry ROUNDS are gone with
   the assumption that required them. A shortfall withdraw burst triggers
   one cheap pixel read of just the batch cells (withdraw-partial-restored)
   — never a re-sweep. A shrinking bag after a withdraw now ENDS the visit
   (withdraw-anomaly): the world stopped matching the index.
2. **Destination-packed trips** (`packTripByDest`, core/gearSort.ts): each
   bag-load takes the largest destination groups whole, tops off with the
   next group's items while everything still fits, and refuses NEW
   destinations once an item has overflowed — a trip deposits in 1-3 hops
   instead of one per scattered class. This is the user's "grab every ring /
   body armour together" request verbatim.
3. **The Highlight (search) box is never touched again** — clearSearch,
   searchCleared, and the searchBox click surface are deleted from the
   sorter (the assistive service keeps its own, separate search flow). The
   user confirmed the box is unused; ground truth does not care about
   dimming.

**Mission** (user's words, 2026-08-31): update the sorter so that sorting the
quad **Dump** tab into the **Gear** folder is the DEFAULT behavior of
`scripts/sort-gear.ts` (no flags needed). Top-level tabs NO LONGER use the
right-hand tab-list dropdown; the Gear folder's tabs STILL do. The dropdown
must be clicked **once** to show and once to hide, with its visibility
**detected** from content — never toggled blind, never fought. Tests must
pass, "make it perfect", the run must not stop while the bag still holds
items, and the sorter must detect off-screen/mis-aimed clicks and other
anomalies and fix them itself.

Read docs/HANDOFF-sort-performance.md FIRST — its "Invariants" and "Live
findings" sections rule everything here; do not regress them.

## The user's current stash layout (verify live before assuming)

- Top level strip: **Dump** (silver quad — its label NEVER OCRs, found by
  brightHeaderRuns pixel elimination), **Gear** (folder), **AFFINITIES**,
  **Extra**. No T tabs. No Weapons quad.
- Gear folder: ~18 per-class tabs (1h Mace, 2h Mace, QuarterStaff,
  Bow/Crossbow, Spears, Wands, Sceptres, Staves, Shields, Jewels, Amulets,
  Rings, Helmets, OffHands, Body Armour, Gloves, Belts, Boots). Names in
  `GEAR_TAB_NAMES` (src/core/gearSort.ts) — reconcile against the live list.
- Semantics: every identified gear item in Dump leaves for its class tab;
  junk STAYS in Dump. Full/dead destinations bail items back to Dump
  (fullDests/deadDests) — report them at the end.
- Known full: Rings overflowed last run. Homeless classes (axe/sword/claw/
  dagger/flail → dest "Weapons" which no longer exists) stay in Dump BY
  DESIGN until the user names a home — ask them.

## Required changes

1. **Default invocation**: `npx tsx scripts/sort-gear.ts` (plus --no-triage
   until triage is re-validated) must mean "sort Dump into Gear". The old
   gear-folder verification sweep and T-tab scope become opt-in flags, not
   defaults. Update the CLI header comment.

2. **Split navigation, by construction not by fallback**:
   - Top-level (Dump, and any bail/return hops): STRIP-HEADER clicks only.
     Never open the dropdown for a top-level hop; the top-list toggle at
     (1287,212) does not render in this layout. Keep brightHeaderRuns for
     the silver Dump header (threshold 88) and the top-tab-by-brightness
     guard.
   - Gear-folder tabs: the right-hand dropdown list, as today
     (openFolderList → row click at LIST_ROW_CLICK_X), with folderRowsCache.
   - Delete or quarantine openTopList/gotoTopTab dropdown paths that this
     layout can never satisfy — every dead path is a livelock candidate
     (three separate livelocks came from list-state confusion; see the
     perf handoff).

3. **Dropdown discipline — one click, verified**: a single chevron click
   opens the folder list; a single click closes it. Before ANY toggle click,
   DETECT current visibility from a read (rows present + folder context =
   open; no rows = closed) and click only when the state must change.
   After the toggle, verify the state actually changed (re-read or pixel
   change on the list region) before proceeding; if unchanged, ONE retry,
   then fall to recovery — never alternate blind toggles. The existing
   `folderListOpen` flag must be set from OBSERVATION, not assumption
   (top-list flows and Escape/panel events can close it underneath us).

4. **Empty-bag guarantee**: the run may not end (other than Numpad 0 /
   fatal stash loss) while identified items remain in the bag. After the
   last tab, `distributeBag` must run to a verified-empty bag (pixel
   occupancy + read model agree), with undepositable leftovers explicitly
   REPORTED (cell, item class, why) — never silently carried. If a dest is
   full, bail to Dump counts as "handled" only when the bail is VERIFIED to
   have landed (double-read; the bounce animation fakes landings — see
   deposit-bounce-detected in the perf handoff).

5. **Click-anomaly self-healing**: every click that matters must have a
   postcondition, and a failed postcondition triggers a diagnosis pass, not
   a blind retry:
   - Clicks outside the game's client rect, or landing while the expected
     panel is absent, must be refused before sending (extend the
     clampToArea idea to ALL click surfaces: strip bands, dropdown region,
     dialog rects — a strip click when the strip is not on screen was the
     "clicking top-left of my screen" incident).
   - After a tab-select click: the grid repaints (pixwait) or the header
     highlight moves; neither ⇒ guard + re-read, and after two misses run
     ensureStash's full-screen diagnosis (pause menu, options panel, toast
     covering the title, stash closed — all have known signatures).
   - After a deposit/withdraw burst: bag occupancy must move in the right
     direction; wrong direction ⇒ stop the trip and re-identify (never
     re-burst on a stale model).
   - Log every anomaly + its self-fix to bench.jsonl (guards) so misfires
     are measurable.

6. **Tests**: unit-test the pure parts of the above (visibility decision,
   click-surface refusal, empty-bag completion decision, bail accounting)
   in tests/. `npx tsc --noEmit -p tsconfig.node.json` (vendorStaging
   errors are another session's) and the full vitest suite must be green.
   Then validate live: `--dry-run` first, then a full live Dump run,
   watching "read N/M", guard fire-rates, and bench phase times against
   the baselines in the perf handoff (goto was 12.2s avg last session —
   the tuning list there is still open).

## Where things live

- src/adapters/gearSorter.ts — state machine (goto/cleanTab/distributeBag),
  guards, caches. src/adapters/stashTabKit.ts — strip/dropdown/dialog kit
  (pointer() draws the red click markers; POE2_SHOW_CLICKS=0 disables).
- src/core/gearSort.ts — pure decisions + GEAR_TAB_NAMES + destForItemClass.
  src/core/itemSprites.ts — pixel scoring, brightestCellPoint,
  cellEdgeContinuity (variance floor 60 — glare must not chain),
  brightHeaderRuns. src/core/tabList.ts — snapRows (own-position clickY),
  labelsEqualFolded/labelsSimilar (confusable folding).
- scripts/win-input-host.ps1 — host ops (copysweep, pixwait, waitkey,
  cursor, marks). artifacts/tab-admin/ — grid-calibration.json (user-taught
  bounds; NEVER regress to perception-first), bench.jsonl, pace.json.
- Numpad: 8 good · 9 wrong · 5 pause · 0 stop. Kill running node
  sort-gear/tsx PIDs AND orphan win-input-host.ps1 before relaunching after
  any code edit — the running process never sees edits.

## Recent incidents this doc must prevent recurring

- Toggle fights and livelocks from blind list clicks (scrolled combined
  list, special-group strip row, ambiguous re-read loops).
- Row-click drift (fixed: clickY = each label's own OCR position) and
  containment mismatches (fixed: labelsEqualFolded for writes; "Staff" once
  boomeranged into QuarterStaff, a rename once hit the wrong tab).
- The strip/scroll-arrow click spray at the screen's top-left while the
  stash was CLOSED (fix generalized in item 5).
- "Stuck on the empty Dump tab": glare cells ground through phantom retry
  rounds (fixed: continuity variance floor + probeless-empty short-circuit
  — keep both).
