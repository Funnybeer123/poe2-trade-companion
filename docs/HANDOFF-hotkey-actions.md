# Handoff: One-press game actions (Sort / Fill / Vendor / Stash) on numpad mouse keys

## Goal

Bind the companion's core actions to the numpad keys emitted by the user's
mouse side-buttons, so they can walk up to the stash in their hideout and
press one button:

- **Stash** (primary): validate that the stash panel AND inventory are open
  (OCR the STASH / INVENTORY title banners — never grid heuristics). If not
  open and we're in the hideout, locate the world **"Stash" nameplate via
  OCR**, click it to open (character walks over automatically), wait for the
  panels, then **dump the bag** (deposit all bag items).
- **Sort**: run the class-routed sorter (`sort:tabs --run` flow) on the bag.
- **Fill**: run the fill flow (stash → bag).
- **Vendor**: semantics TBD (see open questions).
- **Future**: the Stash action becomes *sorting* stash — items whose type has
  a tab **affinity** get plain ctrl-clicked (the game auto-routes them);
  everything else (body armour, boots, etc.) is identified (hover + Ctrl+C)
  and routed to the correct tab per `tab-routes.json`, eventually into
  folders/subfolders.

## Where everything lives (all live-tested this week, branch `perception-reliability`)

- `src/adapters/drainKit.ts` — the primitives to reuse:
  `ensurePanelsOpen()` (OCR banners at bands (450,100,700x110) and
  (2900,100,800x110); reopens stash via the OCR'd "Stash" nameplate +
  presses `i` for the bag — this IS the Stash action's validation step),
  `depositBag()` (ctrl-clicks all 60 calibrated bag cells — deposit with no
  perception dependency), `gotoLabel()` (tab navigation by label; the tab
  list scrolls ONLY via its scrollbar at x≈2005, direction-ordered grabs).
- `scripts/assistive-sort-tabs.ts` — identification + routed deposits.
- `src/main/assistiveRunService.ts` — audited fill/empty services.
- `scripts/win-input-host.ps1` — host ops incl. `ocr`, `ctrlburst(+shift)`,
  `wheel`, `drag`; `AssistiveWin` already imports **GetAsyncKeyState**.

## Implementation sketch for the hotkey listener

Add a host op `keywatch` (or a dedicated daemon loop): poll
`GetAsyncKeyState` for VK_NUMPAD0-9 (0x60–0x69) at ~50ms, and only while the
foreground window is PoE (existing foreground check). Emit one JSON line per
keypress; a Node daemon (`scripts/action-daemon.ts`) maps keys → actions and
invokes the existing flows. Debounce (ignore repeats within ~1s) and refuse
to start a new action while one runs. Surface progress with the existing
event logging; the kill switch must stop any action instantly.

## Hard-won quirks the next session must respect (see also project memory)

- Panel truth = OCR title banners. A full bag defeats grid detection; world
  floor tiles can hallucinate an open bag.
- Tab strip reorders itself; the dropdown auto-scrolls; user reorders and
  folders tabs live → always address tabs by label at click time. Foldered
  tabs vanish from the flat list (folder support is unbuilt).
- `~price N <currency>` tab names are the public pricing — never rename;
  deposits inherit the tab's price.
- Escape with no panel open = pause menu. `i` toggles (can CLOSE) the bag —
  only press it after OCR confirms the bag is closed.
- Specialty tabs (gem/map/currency/essence/delirium) have phantom occupancy
  and nested sub-views; mapped views are in
  `fixtures/perception/templates/specialty-views.json`.

## User's answers (2026-08-28) — DECIDED

1. **Key mapping**: Num1=Stash, Num2=Sort, Num3=Fill, Num4=Vendor.
2. **Vendor = quick sell**: ctrl-click the **"ZELINA"** nameplate (locate via
   OCR, like the Stash nameplate) — that auto-opens her vendor window — then
   sell EVERYTHING in the bag (populate the sell pane by ctrl-clicking all
   bag cells, then complete the sale). A later feature will inspect each
   item's value before vendoring; for now it sells all.
3. **Affinities are set** on the user's tabs. Affinity tabs CAN FILL UP —
   after a deposit pass, cells that stay in the bag mean the affinity tab is
   full: **log this explicitly to the text logs** (e.g.
   "AFFINITY TAB FULL? N cells stayed: ...").
4. **Hideout-only.** The nameplate requirement (Stash / ZELINA via OCR)
   enforces this naturally — if the nameplate isn't found, log and refuse.

## Build state / remaining steps

DONE: host op `waitkey` in `scripts/win-input-host.ps1` — blocks until a
numpad key (0-9) is pressed while PoE is foreground (edge-triggered,
timeoutMs param, returns `{ok, key}` or timeout). Self-testable by injecting
`keybd_event(0x61)` from a second host instance.

TODO (in order):
1. `scripts/action-daemon.ts`: startWinHost + DrainKit; loop `waitkey`
   (30s timeout, reissue); debounce 1.5s; one action at a time; append every
   action + result to `artifacts/action-daemon.log` AND console.
   - Num1 Stash: `kit.ensurePanelsOpen()` → `kit.depositBag()` → verify via
     `kit.verifiedBag()`; retry once with shift; leftover>0 ⇒ log the
     affinity-tab-full warning with the cell list.
   - Num2 Sort: spawn `npx tsx scripts/assistive-sort-tabs.ts --run`.
   - Num3 Fill: AssistiveRunService kind=fill in-process (copy the service
     construction from `scripts/assistive-drain-tabs.ts`).
   - Num4 Vendor: verify bag non-empty; full-screen-ish OCR for a line
     matching /^zelina$/i; ctrl-click its center; wait ~2.5s; capture and
     OCR the vendor window to find the sell pane / confirm button (UNKNOWN
     UI — capture a PNG on first run, look at it, then wire the exact
     clicks); populate sell pane via `kit.depositBag()`-style ctrl-clicks of
     all 60 bag cells; click the sell/accept control; verify bag emptied;
     log everything.
2. npm script `actions:daemon`; document Num keys in USER_GUIDE.
3. Live-test each action; the vendor window layout needs one
   capture-and-look iteration (same method used for the gem tab and map tab).

## Status (2026-08-28) — built and partly live-tested

DONE: `scripts/action-daemon.ts` — waitkey loop, 1.5s debounce, one action at
a time, logs to `artifacts/action-daemon.log` and console. `npm run
actions:daemon`. USER_GUIDE documents the Num keys.

### Live test results (hideout, 3840x2160, PathOfExileSteam)

- **Num1 Stash — VERIFIED end to end.** From both panels closed: keypress →
  `waitkey` → `clickStashChest` → `i` → `depositBag` → `verifiedBag` →
  "Bag emptied", ~10s. Panels confirmed open afterwards by screenshot.
- **Num3 Fill — runs, but found nothing to withdraw.** The selected tab was a
  unique-collection tab (large "???" placeholder cards), whose layout does not
  match the calibrated stash grid, so perception reported
  `bag-open-stash-closed` / `stashCells=0` and the run ended `reason=failed`.
  The action trace confirms `bag 0->0` — no items moved. Re-test with a normal
  grid tab selected.
- **Num2 Sort — NOT RUN. Do not run it as-is.** Three blockers: the bag was
  empty (the sorter exits early); `tab-routes.json` destinations `ESS`,
  `Runes` and `-price 1 divine` collide with tabs the list shows as
  **(Remove-only)**, and the user's standing instruction is never to select
  Remove-only tabs; and `assistive-sort-tabs.ts` navigates by **cached index**
  (`index: 26`, `index: 0`, …), which contradicts the navigate-by-label-at-
  click-time rule. `DrainKit.gotoLabel` has an `excludeRemoveOnly` flag but it
  defaults to `false` and the sorter never passes it. Fix the sorter's tab
  addressing and add a Remove-only guard before wiring Num2.
- **Num4 Vendor — vendor window reached and mapped; sell path still unwired.**
  Ctrl-clicking the OCR-located ZELINA opens her **"BUY OR SELL"** window
  (she says "Take your time."). Layout at 3840x2160: title ~(1142,399), tab
  row `-1- -2- -3-` plus four `Buyback` tabs at y~518, her stock grid
  (red) spans roughly x 600-1900 / y 550-1700, search box ~(1248,1771),
  close X ~(1908,408). The player inventory opens on the right.
  **The sell/offer pane only appears once items are offered**, so with an
  empty bag there is still no confirm button to wire — repeat this capture
  with a few junk items in the bag to finish `actionVendor()`.

### Bugs found and fixed during the live test

1. `findNameplate()` used the drain kit's `(1200,300,1800x1000)` world region.
   Two independent failures: ZELINA sits at x~1177, left of that region, and
   **Windows.Media.Ocr returns zero lines for mid-size crops** — `1800x1000`
   and `1920x1080` both come back empty while `600x160` and the full
   `3840x2160` grab work. Num4 would have refused every time. Now full-screen.
   (`DrainKit.clickStashChest` has the same dead region and therefore always
   falls back to its hardcoded `(1790,505)`; worth fixing there too.)
2. Fill aborted with `reason=vendor-open`. An open tab-list dropdown covers
   the stash grid, so `stashPanelOpen` goes false and the dropdown's coloured
   rows make the vendor box look open. Suppressed `ventorBagGrid` in the
   daemon's fill service, same as `scripts/assistive-drain-tabs.ts:155`.

### Gaps still to close

- `actionVendor()` does not close the stash/inventory panels first. With them
  open, ZELINA is underneath the stash panel and full-screen OCR cannot see
  her. Press Escape until `panelsViaOcr()` reports both closed before hunting
  the nameplate. Note Escape from the trade window returns to her **dialogue
  menu** ("Buy or Sell items" / "Goodbye"), so exiting cleanly needs a second
  Escape.
- Nameplate positions move with the camera (ZELINA was at `1177,360` and later
  `1137,555`), so they must be OCR'd at click time, never cached.

NEXT UP: re-test Num3 on a normal grid tab; add the Remove-only guard and
label-based tab addressing to the sorter before enabling Num2; put a few junk
items in the bag and repeat the Num4 capture to wire the sell + confirm clicks.

## Num6 — Identify (in-map) — added 2026-08-31, LIVE-VERIFIED same day

`scripts/map-triage.ts` (core logic in `src/core/mapTriage.ts`,
tests in `tests/map-triage.test.ts`): inside a map, with the Scroll of
Wisdom stack parked in bag cell (0,0), identify all unidentified gear
(right-click scroll → left-click cell, verified by re-copy), evaluate each
newly identified item with the value-tier regexes from
`artifacts/tab-admin/triage.json`, and drop the not-good ones on the ground
(pick up → ground click → put-back probe click that converts the ambiguous
"dropped vs still-on-cursor" state into clipboard truth). Num5/0/8/9 remain
harness control keys, which is why this action took Num6.

Safety: only items the run itself identified are ever dropped; safety
verdicts and keep/sell/price/promoted items stay; refuses when the stash
panel is open (hideout/town — ground drops are refused there) or when (0,0)
doesn't Ctrl+C-verify as the scroll. `npm run map:triage` is the no-click
dry-run; `npm run map:triage:run` is what Num6 spawns. Ground click defaults
to client-relative (0.44w, 0.60h) — near the feet, left of the inventory
panel; override with `--drop-x/--drop-y`.

### Live test results (2026-08-31, in-map, 3840x2160)

- Full cycle VERIFIED via `map-triage --run`: bag of 9 unid items across 50
  occupied cells (scroll stack 40 at (0,0)). Identify pass used EXACTLY 9
  scrolls — every extra cell of each multi-cell item skipped as
  `already-identified` by the re-copy, zero waste. Drop pass dropped all 9
  (magic junk + rares with no double-resist: `unknown: matched no keep/sell
  rule`), each pickup → ground click → put-back probe verified clean, no
  aborts. Post-run sweep: 31 scrolls left, 0 unid gear. Default ground point
  (1690,1296) worked.
- `--include-identified` added during the test: a `--max-drops`-capped (or
  aborted) run leaves evaluated-bad items ALREADY identified, and the default
  identified-this-run scope means a rerun won't touch them. The flag widens
  the drop evaluation to identified gear cells from the sweep (re-copy +
  fingerprint pinning still guards every touch). Verified live: second run
  dropped the 6 leftovers, 28 sibling cells correctly skipped `already-gone`.
- NOT yet exercised: the Num6 daemon path itself (it just spawns the exact
  command verified above), the drop-refused hideout abort, and the
  identify-misfire recovery (both are unit-tested in tests/map-triage.test.ts).
- Cosmetic: the plan's "scroll-short" warning counts CELLS, not items, so it
  over-warns on multi-cell bags — budget spend is per-item and correct.

### FAST mode (now the default) — live-verified 2026-08-31, ~27s full bag

Rebuilt for speed the same day (user: one-to-one movement, no redundant
hovers): perception (`detectSpriteItems` on the bag grid) segments items so
every phase touches ONE point per item; copies are batched via `copysweep`;
identify is ONE `clickburst` with **shift HELD across the burst** (new host
op in win-input-host.ps1 — a per-click shift tap CANCELS the game's
repeat-use mode, and clicks sooner than ~300ms after the arming right-click
are silently ignored: both live-learned); drops are two burst round trips
with a first-drop probe (abort after touching one item) and an end probe;
then a greedy left-compaction (`planLeftCompaction`, scroll pinned at (0,0))
verified by perception CELL COUNT, not per-move copies (a one-cell-shifted
placement is a success the top-left-cell copy calls a failure). A live
preflight click on an empty-verified cell parks any item a previous run
left on the cursor. `--careful` keeps the original per-cell flow;
`--no-compact` skips compaction. Fast mode evaluates ALL identified gear in
the bag (not just what it identified this run).

Verified run: 12 items — 7 identified in one chain burst (no fallback), 2
uniques kept via price table, 5 dropped, 6 compaction moves, 27.1s total.
Occasional phantom sprite regions (empty copies) are ignored harmlessly.

Compaction (final form, after a multi-pass version proved slow and
churny): MODEL-DRIVEN, no fresh sweep — the eval phase already
copy-confirmed every item's position/size (`confirmedCompactionItems`:
phantoms vanish, catalog w×h overrides pixel guesses, origins clamp
in-grid) and drops free known cells, so compaction plans ONCE from that
model, executes every move as ONE `clickburst` (pick,place,pick,place…,
gapMs 140), and verifies ONLY the moved targets with one batched copy. On
a failed verify: park any held item at the biggest free rectangle's centre
(`findParkPoint` — a corner CELL click can't seat a held 2x3; a park click
with an empty cursor is a harmless no-op), then ONE corrective pass from
fresh clipboard-confirmed reality. Already-compact bag = zero moves = zero
clicks. Live: 23.6s (4-pass version) → 2.5s. Placement clicks bias a
QUARTER CELL toward top-left on any EVEN dimension — an even footprint's
centre sits exactly on a cell boundary where the game's rounding is a coin
flip and the loser is a refused placement that leaves the item on the
cursor. Never-drop guarantee: the drop phase only touches reads classified
`identified-gear`; currency, waystones/tablets, ultimatums, gems, runes,
soul cores, omens, relics are structurally excluded (unit-tested).

BENCHMARK (artifacts/map-triage/benchmark.jsonl, printed each --run,
best = lowest ms/item): baseline 46208ms/2567ms-per-item → best
23001ms/1278ms-per-item (18 items). Speed pass 2 (same day): ONE capture
serves client-resolve + sprites (was two, ~700ms saved); bag-open truth =
the scroll copy itself, OCR only as fallback (~1s saved warm; the cold
path — bag closed at start — costs ~5s and is the price of reliability);
preflight park point rides the eval copysweep as one extra point (was two
2-attempt copies ≈ 2.4s); drop probes are single copysweep reads (~0.5s vs
1.2s); stash-panel OCR guard runs only when drops are imminent (a held
item would DEPOSIT, not drop, with stash UI under the ground point).
Post-pass run: 25908ms/1439ms-per-item but on a COLD start + 15 drops —
ms/item is workload-sensitive, so compare like bags. Warm-path phase costs:
read ≈ 1.7s fixed + ~200ms/item · identify ≈ 0.5s + ~300ms/unid · drop ≈
0.9s + ~570ms/drop · compact ≈ 0 when already packed, else ~550ms/move.
Remaining cuts all trade reliability (hover 100, arm 320 are live-proven
floors) — do not lower them without a verification story.

## Hotkeys UI (Tools → Hotkeys) — added 2026-08-31

The app now edits the daemon's key map. Shared catalog + normalization:
`src/shared/hotkeyActions.ts` (pure — renderer-safe); file persistence:
`src/core/hotkeyBindings.ts` → `artifacts/hotkey-bindings.json`; IPC:
`hotkeys:get/save/daemon-status` (ad-hoc channels in main/index.ts, bridge
`window.poe2.hotkeys`); UI: `HotkeyActionsTool.vue`. The daemon re-reads
the bindings file on EVERY keypress, so app-side edits apply live. The
normalizer refuses the reserved control keys (0/5/8/9), out-of-range keys,
and duplicate keys (earlier catalog action wins). Browser preview renders
the catalog with defaults and marks saves as not persisted. Verified in
the Vite preview: render, duplicate-blocking dropdowns, save/revert,
preview note. Tests: tests/hotkey-bindings.test.ts.

## Num7 — Vendor cycle: LIVE-VERIFIED 2026-08-31 (iterated live, see below)

End-to-end proven across the live session: bag read + junk verdicts →
hideout → sold at ZELINA → back into the same map through its portal
(final clean run 21.5s). GAME-MECHANIC TRUTHS this flow uncovered, all
live-learned — do not re-derive:

1. **/hideout from a map does NOT teleport — it SPAWNS A PORTAL at the
   player**, labeled "<name> HIDEOUT". Click the portal's NAMEPLATE (label
   centre, no offset) to enter. The label fooled the first arrival check.
2. **Zone-state truth = the map-only HUD**: "MAP OBJECTIVES"/"MAP CONTENT"
   lines present ⟺ in a map. Hideout arrival = that HUD gone (hub
   nameplates need proximity and CANNOT be the arrival check).
3. **PoE2 vendors sell on ctrl-click INSTANTLY** — no offer pane, no
   accept button (gold +13,612 and "Zelina: I'll find a use for it." the
   moment the ctrlburst landed). Buyback tab = the undo. The old Num4
   sell-pane mapping plan is obsolete.
4. **The vendor window title is covered by item TOOLTIPS** (the ctrl-click
   leaves the cursor on her stock) — park the mouse (660,1900), then
   verify by the search box text /type keywords here/i.
5. **Return portals spawn as a SET with IDENTICAL labels (the map's
   name)** at the hideout arrival point — remember the duplicate label at
   arrival (`duplicatePortalLabel`), click its centre to return, confirm
   by the map HUD reappearing. Duplicate world labels are the strongest
   portal signal; single-survivor discovery is the fallback.
6. **Nameplates only render in camera/proximity range** — Alt-held OCR
   (new `holdAlt` param on the host `ocr` op) helps but does NOT reveal
   off-screen objects. From the hideout arrival point the hub can be
   entirely off-screen; walkToHub clicks toward landmark labels and the
   drain-kit stash fallbacks.
7. The /hideout spawn's bag-open check must be scroll-copy truth, 3
   attempts — one OCR-banner false negative + blind `i` = closed bag.

NOT yet exercised live: the keeper→Dump-tab deposit leg (no keep-verdict
items in the bag during testing; it reuses the live-proven Num1 primitives
ensurePanelsOpen/gotoLabel(excludeRemoveOnly)/burst + cell-empty verify).

### Perfection pass (same day) — BEST 17.2s (hideout-start; benchmark.jsonl)

8. The cycle now IDENTIFIES unid gear first (scroll chain from Num6:
   arm 320ms → shift-held clickburst gap 80 → batched verify + per-item
   fallback) — a raw loot bag is one keypress. 11/11 identified live.
9. **The skill bar's PORTAL BUTTON at (2953,1959) [3840x2160] spawns the
   hideout portal** — more reliable than racing the chat box (a /hideout
   chat attempt failed once mid-play); chat is the fallback. Coords were
   measured from a native capture after a first click 38px low
   (--portal-x/--portal-y override).
10. A COMPLETED map's return portal is labeled "<Map> (COMPLETED)" — the
   primary return match (then remembered arrival label, duplicate pair,
   single survivor). Hideout NPC names (ALVA, ANGE) are in PORTAL_NOISE.
11. Full-screen OCR costs ~2s at 4K — the vendor-open check is now a small
   BAND over the search box (750,1700,1100x150 → /type keyword/) polled at
   450ms, and ZELINA's plate is handed from walkToHub instead of re-OCR'd:
   vendor phase 29.1s → 5.0s.
12. Nothing-to-do runs still RETURN to the map when started in the hideout
   (post-sale stranding fix). Phase timings print per run and append to
   artifacts/vendor-cycle/benchmark.jsonl with best-total tracking.

## Original build notes (superseded where the truths above disagree)

`scripts/vendor-cycle.ts` (+ `src/adapters/bagKit.ts`, the shared capture/
copy/OCR/triage helpers — map-triage.ts still carries its own copies,
unify later). Flow, every phase verified: (1) bag read where you stand
(bag-open truth = cell (0,0) copying — the OCR banner false-negatives and
a blind `i` press on one CLOSES an open bag); junk = the exact map-drop
verdicts (decideDrop; unidentified/currency/waystones never offered);
map-name candidates scraped from the HUD with panels closed (x>2600,
y<700, noise-filtered) for the return leg. (2) `/hideout` via chat (Enter,
type, Enter — `/` is OemKey 0xBF); arrival = ZELINA nameplate within ~15s
else abort harmlessly (if /hideout doesn't work from maps, that's where it
stops). (3) Ctrl-click ZELINA (Escape first only if a panel is open),
window verified by /buy or sell/ text. (4) Offer junk via ctrlburst,
verify each cell reads EMPTY; find the accept control by OCR
(/^(accept|sell|confirm|complete|offer)/i left of x2400) — on a miss:
capture, ESCAPE to recall the offer, verify items back in cells, abort
(wire the button from the capture; same method as the Num4 mapping). Sale
proof = offered cells STAY empty (a cancelled trade returns items to their
exact cells). (5) Close via the dialogue's "Goodbye" line (never a blind
second Escape). (6) Return: full-screen OCR for a portal line matching a
map-name candidate, click +70px below, verify hideout nameplates gone;
no candidate/line → capture + "walk through manually".

FIRST LIVE TEST checklist: does /hideout work from a map at all; the
accept-button capture-and-stop iteration; whether the HUD really shows an
area name for the return candidates (dry-run showed "(none)" with the
inventory open — re-check with panels closed). npm: vendor:cycle /
vendor:cycle:run; daemon Num7 spawns the --run form.

MOVEMENT CALIBRATION (2026-08-31, `--calibrate-moves` / `npm run
map:calibrate`): ping-pongs the bag's smallest confirmed item between two
free regions with EVERY move verified by copy (origin empty + destination
fingerprint), descending 140→35ms. Result: bag-to-bag pick/place is 100%
reliable at 35ms (0 failures in 56 verified moves — the old 140ms gap was
4x too conservative). But a pickup→GROUND-DROP pair is different: the game
REFUSES a drop ~35ms after pickup and lands it at 200ms (a drop cooldown
bag placement does not have). So move-calibration.json carries gapMs (35,
bag moves — drops and compaction placements) plus a SELF-TUNING dropGapMs:
each run's verified first drop is the probe — success steps it down 25ms,
a bounce that the 200ms retry then lands raises a rise-only dropFloorMs
(and an ABORTED retry — environmental, bad spot — deliberately leaves the
calibration untouched). Also fixed the same day: gray sprite detection
misses items on the game's RED cell tint (sceptre, gloves, spear all left
uncompacted) — captureClientSprites now adds an RGB-occupancy net
(scoreGridCellsRgb) whose uncovered cells become synthetic 1x1 regions the
eval sweep copy-confirms or discards.
