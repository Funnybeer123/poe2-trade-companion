# Handoff: rework the gear-sort feature

> **2026-08-30 addendum — appraisal-driven triage in the ground-truth flow.**
> The Ctrl+C identity sweep now feeds an appraisal engine
> (`src/core/modKnowledge.ts` + `src/core/appraisal.ts`): every identified
> item gets a value score (0-100) and a confidence (0-100%), and
> `src/core/sortTriage.ts` routes confident keeps/sells to the Review/Sell
> tabs from BOTH `distributeBag` and `cleanTab` (dump detours stay
> rule/price-only; triage tabs are never cleaned; a full or unreachable
> triage tab cancels detours for the session instead of looping). Detours are
> gated by `minDetourConfidence` (triage.json, default 55). Finds are
> journaled to `artifacts/tab-admin/finds.jsonl` and surfaced on the app's
> Sort screen. Not yet live-tested against the game.

> **FINAL 2026-08-30: sort complete + architecture superseded.** After a full
> day of live iteration, pixel/search-dim matching was RETIRED for
> classification: the shipped sorter identifies every occupied cell by
> hover + Ctrl+C (`Item Class:` parse — `destForItemClass` in
> src/core/gearSort.ts), withdraws everything foreign to the tab, and files
> each item to its true tab (junk → T*). See `GearSorter.cleanTab` /
> `distributeBag` / `identifyCells`. Key live lessons: a stale Highlight
> query dims cells below the occupancy thresholds (clear it before every
> scan); perception can go fully blind on one tab (Boots) — cleanTab then
> sweeps the calibration profile's quad grid cell-by-cell; duplicate uniques
> deposit only via SHIFT+ctrl-click; ctrl-click routes affinity items to
> their affinity tab regardless of the open tab. All 11 folder tabs verified
> pure on 2026-08-30; ~500+ cells relocated across the session.

> **2026-08-29 addendum — value triage is integrated.** Between withdraw and
> deposit the sorter now reads every bag cell (Ctrl+C, sentinel-verified,
> clipboard restored) and routes keep/sell/dump items to the tabs configured
> in `artifacts/tab-admin/triage.json` (exported by the app's Sort screen;
> `--no-triage` disables). Decision logic: `src/core/valueTiers.ts` +
> `src/core/bagTriage.ts` (pure, tested). Failed copies and unidentified
> items never dump. Vendor staging exists as a planned-only core module
> (`src/core/vendorStaging.ts`) — it must never click accept/confirm.

> **Status 2026-08-29: implemented.** The sorter now lives in three modules —
> `src/core/gearSort.ts` (routes, clamps, round decisions; pure, unit-tested),
> `src/adapters/sortHarness.ts` (overlays, step mode, corrections capture,
> pacing, bench log), `src/adapters/gearSorter.ts` (ensureSession / gotoTab /
> route state machine, side-list-only navigation) — with
> `scripts/sort-gear.ts` as a thin CLI keeping the same flags, so the
> Tools → Stash tabs panel integration is unchanged. New:
> `--review-corrections` prints the per-step corrections summary;
> `artifacts/tab-admin/bench.jsonl` records per-phase timings and per-guard
> check/fire tallies. Tests: `tests/gear-sort.test.ts`,
> `tests/sort-harness.test.ts`.
>
> **LIVE-VALIDATED 2026-08-29 (evening):** a real `--sources=Rings
> --max-trips=1 --no-triage` run moved ~241 cells with zero mis-clicks and
> pace self-tuning 2.43→0.94. Corrections found and fixed during validation:
> (1) there are TWO side-list toggles — (1287,212) opens the TOP-LEVEL list,
> the folder row's own chevron at (1287,278) opens the FOLDER list (user
> screenshot); (2) the folder list is ~330px wide, so rows are clicked at
> x=1430, not the drain tooling's 1700; (3) the Highlight box is invisible to
> OCR (region AND full-screen), so search focus is proven by pixel change of
> the box, and title bands use full-screen OCR filtered client-side; (4) the
> red Weapons label often OCRs unreadable — a session row-slot cache clicks
> the remembered row, and depositCascade falls back to the SOURCE tab before
> any other class tab. Known gaps: no folder-list rows named "Boots" or
> "Jewels" (a second tab reads "Rings" — likely mis-named), so those routes
> return items to the source; the folder list does not auto-close after row
> selection (guard closes it each hop, 30/30 fires).

Owner request (2026-08-29): rebuild `scripts/sort-gear.ts` into a reliable,
app-integrated sorter. The current script works in bursts but degrades into
mis-clicks; this document is the complete state of knowledge — what is proven,
what failed and why, and the required design for the rework.

## What the feature must do

Redistribute items between the Gear folder's per-slot tabs (Amulets, Rings,
Weapons, Helmets, OffHands, Body Armour, Gloves, Belts, Boots, Jewels) so each
tab holds only its class. End goal: the user dumps mixed loot into tab T1 and
the sorter files everything.

## REQUIRED design changes (owner-specified)

1. **Navigate ONLY via the side tab list** (the vertical dropdown at
   x≈1345-1750). With any sub-tab active it lists the whole folder, unclipped,
   in stable order. The horizontal strip must never be used for tab
   addressing: its labels clip ("~price 5 exalted" → "exalted"), merge
   ("Rings Weapons"), its scroll arrows stall before the row end, and
   phantom entries appear over the grid when a row is closed.
   - The list follows the ACTIVE tab's container: with a top-level tab active
     it shows top-level; with a sub-tab active it shows the folder. Enter the
     folder context ONCE at startup (click a proven folder-row header), then
     stay inside the dropdown for every subsequent hop.
   - `StashTabKit.readTabList/ensureTabListOpen/selectTabListRow` are the
     working primitives (full-screen OCR + label-column/chat/NPC filters; see
     the memory notes for every filter's reason).
2. **Clear every overlay immediately after its click resolves.** Stale labels
   from prior steps were still on screen stacking with new ones (screenshot in
   session 2026-08-29). One overlay at a time; `hidemark` after every
   confirm/skip/timeout, no exceptions, including on every error path.
3. **Keep the troubleshooting harness and make it first-class**, not bolted on:
   - Bullseye + purpose label on EVERY single click before it lands.
   - Grid overlay (lime found / red click-targets) before every burst.
   - Step mode: Numpad 8 = good (execute), Numpad 9 = wrong, Numpad 5 =
     pause/resume, Numpad 0 = instant stop (checked every ≤100ms, including
     inside sleeps and bursts).
   - On Numpad 9 the user clicks or DRAGS A BOX where the click/detection
     should have been; record to `artifacts/tab-admin/corrections.jsonl`
     (`{why, planned:{x,y}, corrected:{x,y}, box?}`) and flash "learned".
4. **Corrections must feed back into code.** After a session, read
   corrections.jsonl and update the constants/logic they contradict (anchor
   coordinates, region bounds, label matching). A correction is a bug report
   with pixel-exact repro — treat it as such.

## Proven-working pieces (keep them)

- **Class search + differential dim detection**: type a query into the
  Highlight box; matching cells stay bright, others dim. Detect matches with
  `searchMatchedCells(beforeFrame, afterFrame)` (`src/core/itemSprites.ts`).
  Verified live: "56 lit (41% dimmed) → withdraw → re-search: 4 left".
  PLAIN occupancy cannot distinguish lit from dimmed — never use it.
- **Search queries**: quoted regex works in the game box, e.g.
  `"class: (belt|charm)"`, `"class: (axe|mace|sword|bow|claw|dagger|flail|quarterstav|sceptre|spear|stav|wand)"`.
  Multiple quoted terms AND together — use one regex, never several terms.
- **Withdraw**: ctrl-burst on the matched cells (`DrainKit.burst`), capped by
  bag room; loop controlled by the RE-SEARCH lit count (must fall each round),
  not by bag arithmetic.
- **Deposit like the user demonstrated**: ctrl-click ONLY occupied bag cells
  (`facts.occupiedBag`, clamped to the bag area x2450-3800, y1150-1760),
  re-capture, repeat until empty/stalled. Blanket 60-cell sweeps looked like
  "clicking the same corners over and over".
- **Bag/stash clamps**: withdraw targets must lie in x30-1310 **y340**-1760
  (y<340 is the tab strip — a phantom lit cell over a tab header once
  switched tabs mid-burst and scattered clicks into the wrong tab).
- **Stash opening**: find the `^stash$` nameplate by full-screen OCR at click
  time, excluding Guild (±300px) and the MINIMAP/quest area (x>3000): the
  minimap prints "Stash" and clicking it walks the character into a corner.
  Playfield bounds: x500-3000, y150-1800. Max 2 attempts, ~5s pathing wait
  each, then abort loudly. The minimap label IS useful as an optional
  walk-toward-stash navigation click (cap 2).
- **Adaptive pace** (`artifacts/tab-admin/pace.json`): speed up ~10% per clean
  trip, slow 1.5x on any retry. Started at 1.6x, meant to reach <1x.

## Hard-won environmental rules (violating any caused real failures)

- `type` keystrokes that miss the search box are GAME HOTKEYS (o=Options,
  g=gems, c=character, i=inventory). NEVER type until focus is PROVEN: probe
  with `---` (unbound), OCR the box, only then type. Also gate `setSearch` on
  the stash title band being visible.
- Overlay windows MUST set WS_EX_NOACTIVATE **before** `.Show()`
  (`scripts/win-input-host.ps1` Show-ClickMark/Show-Marks — already fixed).
  An activatable overlay steals fullscreen focus and the game closes panels.
- A process killed mid-click leaves the virtual left button LATCHED: the game
  eats all clicks while keyboard works. Fix: tiny drag in the dead zone
  (660,1900→662,1902) at every script start.
- Title-band OCR checks need the cursor PARKED first (tooltips cover titles)
  and a second read before any recovery action; wrong recoveries (blind
  Escape, blind `i`) opened the pause menu / closed the inventory.
- Windows.Media.Ocr: full-screen reads are reliable; mid-size region crops
  (~400-1900px wide) intermittently return ZERO lines. OCR whole-screen and
  filter client-side.
- Kill orphaned `win-input-host.ps1` processes on start; they accumulate and
  break new spawns.
- Never fight a toggle: at most one corrective `i` press, one dropdown-toggle
  click, two chest clicks per recovery, then stop loudly.

## Current file map

- `scripts/sort-gear.ts` — the sorter (all of the above, tangled; rework me).
- `scripts/win-input-host.ps1` — input/OCR host: `marks` overlay op (labelled
  rects, solid label plates), `record` op (observe user clicks/drags),
  `waitkey` (numpad 0-9 = 0-9, `+`=10, `-`=11).
- `scripts/record-teach.ts` — teach-by-demonstration recorder
  (`npm run teach:record`); session data in `artifacts/teach/`.
- `src/adapters/stashTabKit.ts` — tab list + strip + settings-dialog driver.
- `src/main/stashTabAdminService.ts` + Tools → Stash tabs panel — app
  integration (runs the scripts via IPC with live log; keep as the packaging).
- `artifacts/tab-admin/corrections.jsonl` — user-taught corrections.
- `artifacts/teach/2026-08-29T17-14-30-008Z/` — the user's 4-minute
  demonstration: 260 clicks with modifiers + 253 frames. Their real
  coordinates: search box ≈ (1035,1786); deposits = ctrl-clicks on occupied
  bag cells ~90ms apart; navigation via folder row headers and its arrows.

## Suggested rework shape

State machine with explicit preconditions, one module per concern:

1. `ensureSession`: unstick mouse → stash+inventory open (bounded recovery)
   → folder context entered (ONE proven strip click) → all further nav via
   the side list.
2. `route(source, class, dest)`: select source (list) → settle (grid region
   sane: x<200, w>900) → search with proven focus → differential match →
   clamp targets → overlay → burst → re-search verify loop → select dest
   (list) → deposit occupied bag cells → verify empty.
3. `harness`: overlay/step/pause/panic + corrections capture, wrapping every
   click uniformly (no bare host.send click calls anywhere in the sorter).
4. `bench`: per-phase timings to a JSONL so speed work is measured, and
   guards that never fired in N sessions get retired.

Every failure mode listed above has a regression note in
`~/.claude/.../memory/stash-tab-settings-ui.md` — read it before changing
navigation or OCR code.
