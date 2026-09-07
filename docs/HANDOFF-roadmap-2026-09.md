# HANDOFF — 2026-09-07 audit roadmap (branch `roadmap-2026-09`)

Everything below was built from the 2026-09-07 code audit, in parallel by
several agents on isolated worktrees, then merged onto `roadmap-2026-09`
(based on `perception-reliability` @ a10d8ca, the flask-guard commit).
**Nothing in this branch has been run against the live game.** Every
new live path follows the repo's capture-and-stop rule (verify by Ctrl+C,
screenshot + abort on unknown UI) and lists its first live check below.

Quality gates at merge time: `tsc` (node), `vue-tsc` (app), `eslint .
--max-warnings=0`, `npm run build`, and `npm run test:all` (992 tests) all
clean. Tests now run under Electron-as-Node (see "Tooling").

## Read this first — behaviour changes you will notice

1. **League must be unambiguous.** poe2scout currently lists TWO current
   softcore leagues (Forbidden Rites, divine ≈ 98 ex, listed first; Runes
   of Aldur, divine ≈ 624 ex). `league: "auto"` used to pick the first
   silently; it now REFUSES with the candidate list. Pin the league in
   **Tools → Settings → Market data** (picker + "Check leagues") or pass
   `--league=NAME` to the CLIs. `shop-buckets` aborts before touching the
   game while the league is ambiguous.
2. **One config dir.** The app's price feed, comps cache, trade2 pacing
   log, and market-trends cache now live in `artifacts/tab-admin/` — the
   same directory every CLI uses — so the app and the scripts share one
   rate-limit budget. Existing files are copied from the Electron userData
   dir once, on first launch.
3. **Starter placeholders are gone.** The starter price table no longer
   ships "Divine Orb = 40" / "Chaos Orb = 0.5"; unedited copies of those
   rows are stripped on load. Orb costs come from the live feed or the
   accurate defaults in `crafting.ts`. Every CLI now loads prices through
   `src/adapters/triageLoader.ts`, which also merges the newest feed
   snapshot (`artifacts/tab-admin/feed-snapshot.json`, written by any
   process that refreshes) and the learned mod tiers.
4. **Ctrl+D is real now.** The valuation on the Item log comes from the
   price table → cached trade2 comps → appraisal heuristic (provider chip
   on the item card); the fixture provider only runs with
   `POE2_FIXTURE_MARKET=1`. A deliberate price check fetches comps in the
   background and republishes when they arrive; the 750 ms clipboard
   poller never hits the network.
5. **Tests run under Electron's Node** (`ELECTRON_RUN_AS_NODE=1`), so the
   native sqlite module matches the app. `.nvmrc` is 24.

## What shipped, by area

### Pricing core (`src/core/priceFeed.ts`, `priceFeedService.ts`, `priceTable.ts`, `triageLoader.ts`)
- `currentScoutLeagues`, `AmbiguousLeagueError`, `status().leagueCandidates /
  leagueAmbiguous`, `leagues()` (10-min cache), league picker UI, Shop
  hero shows the pricing league.
- `feed-snapshot.json` written on every refresh; merged on construction
  when newer (`applyFeedSnapshotIfNewer`).
- `stripStarterPlaceholders`; shared CLI loader replaces five copies.

### Price check + loot filter + docs (`localValuation.ts`, `lootFilter.ts`)
- `valueItemLocally` (providers: price-table / trade2-comps / appraisal /
  none), `PriceFeedService.peekComps` (cache only), provider chip.
- Loot filter generator driven by the price table: chase / valuable /
  pickup tiers, uniques grouped by base type at the max unique value,
  currency by unit value, valuable jewel bases, never-hide classes,
  `Hide Rarity Normal ItemLevel < N`. Tools → Loot filter: thresholds,
  preview, Copy, Save… (user-chosen path via the OS dialog).
- README / USER_GUIDE rewritten to match the code; AI prompt files moved
  to `docs/ai-prompts/`.

### Comps precision (`statIds.ts`, `tierLearning.ts`, `learnedTiersStore.ts`)
- Stat ids are resolved at runtime from `GET /api/trade2/data/stats`
  (cached 7 days in `artifacts/tab-admin/trade-stats.json`); all 40 mod
  families resolve (four needed `statText` pins for PoE2 wording).
- Two-stage comps: stat-filtered search (top-3 notable families, min =
  judged × 0.85) when it returns ≥ 3 ids, else the base-type search.
  `basis: "stat-filtered"` in summaries; 1 h cache TTL.
- Learned tiers: every fetch's `explicitMods[].mods[].tier` + magnitudes
  accumulate into `artifacts/tab-admin/mod-tiers.json` (keyed by stat id
  and item class); `matchModFamily` prefers learned tiers (≥ 2
  observations) over the hand thresholds. Verified shape: tier data sits
  on `item.explicitMods[]` (NOT `extended.mods`), lower tier number =
  better.

### Shop keeper (`shopKeeper.ts`, `shopPricing.ts`, `shopListings.ts`)
- Earnings sub-tab scan → `earnings-snapshot.json`; `diffEarnings` +
  `verifySalesWithEarnings` upgrade heuristic "sold" rows to verified;
  `shop.ts` scans Earnings first (`--no-earnings`, `--collect-earnings`).
- Targeted verification: occupancy diff → hover only the landing cell;
  `--full-verify` keeps the whole-tab rescan.
- Bucket ladder: `planBucketLadder` / `applyBucketLadder`,
  `scripts/shop-ladder.ts` (`shop:ladder`, `shop:ladder:live`), Shop view
  button, hotkey action `ladder` (unbound), `ShopConfig.ladderWithoutComps`.
- `ShopConfig.stackPricing: "whole" | "per-unit"`; first live stack
  listing always step-gated.
- `shop-buckets --source=review` stages the Review tab into the bag first.
- ZELINA lookup uses the cached nameplate finder.

### Market intelligence (`priceTrends.ts`, `marketTrendsService.ts`, `exchangeArbitrage.ts`)
- poe2scout `PriceLogs` (from `Currencies/ByCategory`, NOT `/Items`) →
  1/3/7-day change, volatility, volume, rising/falling/stable, stack
  hold/sell advice, farm ranking. Cache `price-trends.json` (12 h).
  Tools → Market; trend column on feed rows in the price table editor.
- Exchange arbitrage maths + `scripts/exchange-arb.ts` +
  `docs/EXCHANGE_ARBITRAGE.md` (what to record with `record-teach.ts`
  before the OCR reader can be built).

### Inventory + crafting (`inventoryLedger.ts`, `sortTriage.ts`, `craft-gear.ts`)
- The sorter records every identified item to
  `artifacts/tab-admin/inventory.jsonl`; **Wealth** view (`/wealth`):
  net worth in ex/div, per-location table, top items, 1–5 ex sell list,
  search; observations mirrored into the SQLite catalog.
- `TriageRouting.craftTab`: craft-base rares route to a Craft tab;
  `craft-gear --from-tab=<label>` and `--then-list` (spawns shop-buckets
  after a live crafting pass, only when no other input host runs).

### Sorter split (`src/adapters/gearSorter.ts` → `src/adapters/gearSorter/`)
- Purely mechanical: 114 of 114 method bodies byte-identical after the
  `this.` → context rewrite; every log line, step label, timing constant
  and guard preserved; the public `GearSorter` API is unchanged so no
  consumer changed. Layout: orchestrator (1,236 lines) + `context.ts`
  (types, constants, `SorterContext`), `stashPerception.ts`,
  `tabNavigation.ts`, `itemIdentification.ts`, `transfers.ts`. Shared
  mutable state stays on the orchestrator behind accessors.

### Ops
- `npm run clean` (`clean:artifacts` prunes images per dir, never
  `artifacts/teach`, never `.json/.jsonl`; `clean:release` empties
  `release/`). `SortHarness.dispose` prunes its own outDir. ~50 GB
  reclaimed on 2026-09-07.
- Clipboard poll: 750 ms only while the app is focused or PoE was seen in
  the last 60 s, else 3 s; skipped while minimized/hidden.
- Nameplate cache (`artifacts/nameplates.json`): band OCR around the
  cached position first, full-screen fallback. Used for Stash, ZELINA
  (daemon, vendor-cycle, shop keeper).

## First live checks, in order (all in `--step` / dry-run first)

1. `npx tsx scripts/shop-buckets.ts` (dry-run) — must abort with the
   ambiguity message until the league is pinned; then prints
   `screen: …` and per-item `comps … (stat-filtered)` lines. Watch that
   stat-filtered lookups return listings (the `stats[]` grammar is
   unverified on PoE2).
2. App: Tools → Settings → Market data → Check leagues → pick one;
   Sort → Prices → Refresh; confirm `artifacts/tab-admin/feed-snapshot.json`
   appears and the divine rate on the Prices tab matches the league.
3. Ctrl+D on a rare: provider chip flips from "appraisal" to "trade
   listings" once the background comps land.
4. `shop:ladder` dry-run (offline, from the ledger), then
   `shop:ladder:live --step`: the DELIST gesture (ctrl-click on a listed
   item → item appears in the bag by Ctrl+C) is UNVERIFIED — approve one.
5. `shop.ts --record` with a sale pending: Earnings sub-tab selection by
   its strip label; `earnings-snapshot.json`; a "sold" row with
   `certainty: "verified"`.
6. One listing with `--step`: targeted verification reads only the
   landing cell (log shows the fallback reason if not).
7. A stack in the bag during a live `shop:buckets`: the forced gate
   fires; read the tooltip to settle `stackPricing`.
8. Vendor step (`vendorBagItems` → ZELINA) with a white item — still
   never run live (pre-existing gap); band-OCR "band hit"/"band miss"
   lines in the log tell you whether the nameplate cache helps.
9. `sort-gear --dry-run` then live: `inventory.jsonl` fills; Wealth view
   totals look sane; Craft tab routing when `craftTab` is set.
10. Loot filter: Save… into `My Games\Path of Exile 2\`, reload the filter
    in-game, confirm the `PlayEffect`/`MinimapIcon` lines are accepted.
11. Tools → Market → Refresh: ~12 paced poe2scout requests; movers and
    farm ranking populate.

## Known gaps / not done
- Live verification of everything above (no game during the build).
- `scripts/shop.ts` still owns a private triage loader copy (works; could
  move to `loadTriageExport`).
- Exchange arbitrage has no OCR reader yet (needs the recording in
  `docs/EXCHANGE_ARBITRAGE.md`).
- The stale worktree `.claude/worktrees/festive-ritchie-07137a` predates
  this work and was left alone.
