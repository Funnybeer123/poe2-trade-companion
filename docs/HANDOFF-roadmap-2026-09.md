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

### Deals watchlist (`watchlist.ts`, `watchlistService.ts`, Tools → Deals)
- Watches: unique by name, base type (+ ilvl floor), stat-filtered rare
  (family + min rows, ids from the stats catalogue). Reference price =
  override → poe2scout feed row for uniques → median of the sample; alert
  when ask ≤ 60 % of the reference with ≥ 4 comparable listings; dedupe
  by listing id (re-raised only when the ask drops).
- Scheduler: 30 s tick, one scan (search + fetch) per tick, ≥ 3 spare
  lookups, ≥ 60 s between scheduled scans, ≤ 5 scans per rolling 5 min
  (trade2's unlisted ~25-calls/5-min lockout), ≤ 20 per hour (persisted),
  skipped inside a penalty window. Files: `watchlist.json`,
  `deal-alerts.jsonl`. Windows notification per new alert (toggle).
- "Copy whisper" writes the listing's `listing.whisper` (verified live) to
  the clipboard; the app never sends it. "Watch this item" on the Item
  log seeds a watch from the current item.

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

### Later the same day
- **Parser**: `(rune)` and `(desecrated)` mod tags are recognised
  (`ItemModKind` gained `rune` / `desecrated`; `isAffixMod` in
  `parseItem.ts`). Runes no longer consume an open-affix slot in the
  crafting planner, the appraisal's craft hint, comps similarity (our side),
  trade2 stat filters, the lookup screen's notable count, and watch seeding
  (`ModAppraisal.affix`/`kind`; `tests/affix-consumers.test.ts`). Rune
  rolls still add to the value score — the item sells with them — but they
  are never treated as the item's own substance.
- **End-to-end smoke revived**: both Playwright projects were stale since
  the navigation merge; they now walk every workspace (incl. Wealth,
  Market, Deals, Loot filter), evaluate an item with the real valuation,
  save rules/builds/scans, and verify persistence across a relaunch.
  `npm run pack:public:dir` / `pack:qa:dir` then `npx playwright test`.
- `AGENTS.md` carries a "Current practice" section with the tooling facts.

### Second-pass review (same day, after the merge to main)
Four review agents re-read the new code; each was cut off by the session
limit and finished by hand. What landed:
- Pricing: HOUSE trade2 rate rules (10 searches + 10 fetches per 300 s,
  18 combined) enforced on top of the advertised headers; comps cache hits
  require the entry's league; the pacing log is saved even on timeouts; a
  long Retry-After is remembered, never retried inline; rarity-only price
  rows no longer yield a confident price.
- Shop: live price table during a run, stash-open guard before Ange,
  Earnings scan sanity check, step-gated right-click, no ledger writes in
  dry-run reprice passes, failed-listing bag check, safer ladder put-back;
  `shop.ts` on the shared loader.
- Renderer: typed stash-tabs/market bridges (no casts), loading/empty/error
  states, inventory superseding fix, host close wait, craft-gear arg guard.
- Tooling: `npm run check`, worktree-agnostic tests with visible skips, local
  tsx launch for scripts, memoized process poll, CI on Node 24 with the
  Electron test runner plus the packaged e2e smoke, and a `postinstall`
  that rebuilds better-sqlite3 for Electron after every `npm install`.

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
12. Tools → Deals: add one unique watch, "Scan now", confirm an alert row
    and that "Copy whisper" pastes a full `@name …` whisper; leave the
    master switch on for 10 minutes and confirm the trade2 budget line
    never drops below 3 spare and no 429 appears in the feed status.

## Known gaps / not done
- Live verification of everything above (no game during the build).
- `scripts/shop.ts` still owns a private triage loader copy (works; could
  move to `loadTriageExport`).
- Exchange arbitrage has no OCR reader yet (needs the recording in
  `docs/EXCHANGE_ARBITRAGE.md`).
- The stale worktree `.claude/worktrees/festive-ritchie-07137a` predates
  this work and was left alone.
