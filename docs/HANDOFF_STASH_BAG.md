# Handoff: grab specific stash items (belts / body armour)

Copy everything below the line into a new chat.

---

## Prompt

You are continuing assistive Path of Exile 2 work in `C:\Users\evanb\OneDrive\Documents\Cursor Repos\poe2-trade-companion`.

The user has a stroke. This is authorized assistive / QA automation (`authorized-qa`), not a public-companion toy. Do not strip automation. Read `AGENTS.md`, `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/GGG_COMPLIANCE.md`, and `docs/QA_AUTOMATION_BOUNDARY.md` before changing architecture.

### Your only job

Make **Fill bag from quad stash** able to **withdraw specific item classes**, then deposit as before.

The user wants to say “grab belts” or “grab body armour” and have the bot Ctrl+click **only those items** from the already-open 24×24 quad stash into the 12×5 bag. Do not keep filling leftover unused cells of whatever happens to be left.

Default request to implement and test first:

1. `--class=Belts` — PoE2 `Item Class: Belts` (2×1).
2. `--class=Body Armours` — PoE2 `Item Class: Body Armours` (2×3). Aliases: `body`, `body armour`, `body armor`.
3. Comma list: `--class=Belts,Body Armours`.

If no `--class` is passed, keep today’s unused-cell leftover fill so existing cycle tests still work.

Then deposit the bag back to stash. Repeat with **different unused matching cells** each cycle. Target remains **accuracy over speed**, ~10–15s per fill+deposit when enough matching items exist. Never leave an item on the cursor.

### Do not work on opening the stash

STASH nameplate / world clicking is **disabled on purpose**. Do not re-enable it, do not click the hideout chest, waypoint, or labels, and do not spend time on hover-to-reveal STASH.

The click path is commented out in:

- `scripts/assistive-cycle.ts` — `ensurePanels` waits for the user; `clickStashChest` is not called.
- `src/core/skills.ts` — `FillBagFromStash` and `DepositBagToStash` abort with `chest-click-disabled` instead of `click-stash-nameplate`.

If stash+bag are not open, wait or ask the user to open them. Press `I` only when stash is already open and bag is closed. **Never Esc** unless a vendor/reforge/teleport UI is open **and** stash is not open. A false “world” look after a successful empty must not Esc the real UI.

`parkOffGrid` in `src/core/skills.ts` parks on **stash window chrome** (inside `stashRegion`, top-left). `src/core/skillRunner.ts` and `scripts/assistive-cycle.ts` must keep using that. Never right-click or left-click the world.

### What already works (keep this)

Live 3840×2160, user-opened stash+bag, hybrid identify + packing fix:

- Deposit 47→0 in ~8–10s.
- Unfiltered fill 0→38 / 0→45 / 0→47 in ~8–11s.
- Wall ~20–31s per full cycle (still slower than the 10–15s target; do not chase speed until class filter is correct).

Hybrid identify (`src/core/fillIdentify.ts` + `scripts/fillIdentifyHost.ts`) copies **at most 8** items from the **first burst** using Codex quad hover+Ctrl+C timing (`STASH_SCAN.quad` ≈ 25/8/10ms). It already parses clipboard with `parseItemText` and looks up sizes in `itemSizeStore` (`Belts` 2×1, `Body Armours` 2×3). That path is the right place to learn **class**, not just size.

Packing: `bagCellsForItem` uses `w * h` (quad 2×2 helm costs 4 bag cells). `BAG_FILL_TARGET` / `BAG_LOOKS_FULL` = 48. `MAX_FILL_CLICKS` = 8, `MAX_FILL_BURSTS` = 6.

Unused-cell memory still applies: `fixtures/benchmarks/assistive-used-cells.json` and `fixtures/benchmarks/assistive-memory.json` (gitignored). `--reset-used` clears used cells. When filtering by class, only mark cells you actually withdrew (or confirmed as the requested class). Do not burn unused memory on skipped non-matching sprites.

A pre-copy skip (`if (lastCells >= 56) break`) used to skip all copies when the unconfirmed plan already looked full. That break was removed; the unit test is “still copies the first burst when the unconfirmed plan already looks full.” Do not put that skip back.

### Why leftover-cell fill is not enough

Sprites from occupancy clustering do **not** know `itemClass`. A 2×1 blob might be a belt; a 2×3 blob might be body armour, shield, quiver, or a bad cluster. You cannot Ctrl+click every unused 2×1 and call it a belt.

Required approach:

1. Cluster unused stash sprites as today.
2. Hover + Ctrl+C candidates (reuse `sizeFillPool` / `copyHovered`). Prefer sprites whose measured footprint **could** match the requested class (Belts → 2×1; Body Armours → 2×3). If the cluster is wrong, still copy a bounded set rather than clicking blind.
3. Parse `Item Class:` from clipboard (`parseItem.ts`). Keep only matches after alias normalize (`Belts`, `Body Armours`).
4. Fit known `w×h` with `fitKnownSize` / `lookupItemSize`.
5. Ctrl+click **only** matching items into the bag. Skip everything else. Do not remember skipped cells as used.
6. If a copy fails or class is unknown, leave that cell unused and try another candidate. Cap copies so fill stays fast (today’s 8 is the default; raise only if belts/armour cannot be found).
7. Deposit unchanged: empty bag to 0; Shift+Ctrl then return leftovers to `lastWithdrawn`; park on chrome.

Do not scan the whole 24×24 with hover+copy. Do not add OCR. Do not re-enable chest clicks.

### Perfect means

- `npx --yes tsx scripts/assistive-cycle.ts --class=Belts --cycles=2` withdraws only belts (or stops with a clear `no-matching-items` / `stash-no-unused-belts` reason if none remain).
- `--class=Body Armours` withdraws only body armour.
- Bag may be **short of 48 cells** if the stash does not have enough matching items. That is success, not `fill-stalled` from clicking currency/jewels.
- Wrong-class items must not move. Log copied class + `w×h` + cell for each withdraw.
- Unused-cell memory still prevents re-grabbing the same matching item next cycle.
- Deposit still empties to 0. No item left on the cursor. Right-click only on panel chrome.
- Perception flicker must not abort a successful empty or click the world.
- Tests cover class match / alias / skip-non-match / remember-only-withdrawn.

### Key files

- `src/core/fillIdentify.ts` — `sizeFillPool`, `applyCopiedSize`, `pickCopyTargets`. Extend so copied text can **filter by class**, not only resize sprites.
- `scripts/fillIdentifyHost.ts` — `copyHovered` + `prepareFillItems`. Thread wanted classes through.
- `src/core/skills.ts` — `FillBagFromStash` must receive the **filtered** pool (or filter inside). Do not burst-click the unfiltered leftover list when `--class` is set.
- `src/core/bagPack.ts` — packing, unused cells, `BAG_FILL_TARGET` 48.
- `src/core/itemSizeStore.ts` — class defaults already include Belts 2×1 and Body Armours 2×3.
- `src/core/parseItem.ts` — clipboard `Item Class:`.
- `src/core/scanRules.ts` — regex DSL exists; **do not** start there. Class equality + aliases first. Optional later: `--regex=` using scan rules.
- `src/core/skillRunner.ts` — burst Ctrl+click, post-burst park/right-click.
- `src/core/assistiveMemory.ts` — used/blocked/withdrawn cells.
- `scripts/assistive-cycle.ts` — add `--class=`; keep `--cycles=N`, `--reset-used`, `--no-teach`.
- `scripts/assistive-deposit.ts` — same `--class=` on `--fill --run`.
- `scripts/win-input-host.ps1` — `click`, `ctrlclick`, `shiftctrlclick`, `ctrlburst`, `rightclick`, `move`, `hotkey` (`i`, `escape`).
- `fixtures/perception/templates/calibration.json` — stash/quad/bag grids.
- Tests to add/update: `tests/fill-identify.test.ts`, `tests/fill-bag-skill.test.ts`, plus a focused class-filter test (e.g. `tests/fill-class-filter.test.ts`). Existing: `tests/bag-pack.test.ts`, `tests/deposit-skill.test.ts`, `tests/assistive-memory.test.ts`.

### How to run

User stands in hideout with **stash and bag already open**, then:

```
npx --yes tsx scripts/assistive-cycle.ts --class=Belts --cycles=2
npx --yes tsx scripts/assistive-cycle.ts --class=Body Armours --cycles=2
npx --yes tsx scripts/assistive-deposit.ts --fill --run --class=Belts
```

Unfiltered leftover fill (old behavior): `npx --yes tsx scripts/assistive-cycle.ts --cycles=1`.

Dump without input: `npm run assistive:dump`.

Windows PowerShell: do not use `&&`. Run lint/typecheck/unit tests for any behavior change. Do not commit secrets or `assistive-memory.json`. Do not commit unless asked.

### Suggested attack order

1. Add a pure function: normalize wanted classes (`belt` → `Belts`, `body armor` → `Body Armours`) and `itemMatchesWantedClass(parsed, wanted)`. Tests first.
2. After each successful copy in `sizeFillPool` / a sibling `classFillPool`, keep or drop the sprite by class. Return `{ items, skipped, copies, classes }` so the skill only clicks matches.
3. Wire `--class=` through `assistive-cycle.ts` and `assistive-deposit.ts` into `prepareFillItems` and `FillBagFromStash`.
4. When `--class` is set and the filtered pool is empty, finish with a specific reason — do not fall back to clicking unused leftovers.
5. Live: user opens stash+bag with visible belts and/or body armour. Confirm only those leave the stash. Then deposit to 0.
6. Only after that, tighten speed if copies are the bottleneck (still cap copies; do not scan the whole quad).

Defaults already chosen: Windows-first; quad 24×24 + bag 12×5; unused matching cells only; Shift+Ctrl then return-to-origin for stuck deposit items; park on stash chrome; no silent fallback to public-companion automation; no chest click; class filter does not silently become leftover-cell fill.
