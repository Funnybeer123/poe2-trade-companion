# Target Architecture

## High-level components

### Electron main process
Owns:
- lifecycle;
- global hotkeys;
- overlay windows;
- clipboard bridge;
- local database;
- network provider clients;
- OS notifications;
- secure storage;
- QA runtime mode selection;
- emergency-stop registration.

### Renderer
Owns:
- price-check UI;
- automation dashboard;
- perception/debug overlays;
- stash/catalog/search;
- sort planner;
- sell assistant;
- saved searches;
- scenario editor;
- replay viewer;
- filter builder;
- settings/diagnostics.

### Core domain
Framework-independent TypeScript:
- `ItemSnapshot`
- `NormalizedItem`
- `MarketComparable`
- `ValuationResult`
- `DesirabilityResult`
- `ObservedInventoryState`
- `ObservedStashState`
- `CatalogItem`
- `SortRecommendation`
- `SaleRecommendation`
- `LootTarget`
- `NavigationTarget`
- `PerceptionFrame`
- `BotDecision`
- `InputAction`
- `AutomationScenario`
- `QaActionTrace`

## Runtime capabilities
Create `RuntimeCapabilities` with at least:
- `public-companion`
- `authorized-qa`

Every automation service must depend on capabilities and refuse to run outside `authorized-qa`.

## QA automation layers

### 1. Capture/perception
Adapters for:
- Windows screen/window capture;
- OCR;
- template matching;
- object detection;
- clipboard;
- supported logs/APIs.

Convert observations to typed `PerceptionFrame` data. Keep raw perception independent of decision/action logic.

### 2. State estimation
Maintain a short-lived model of:
- player/target location cues;
- visible loot;
- inventory occupancy;
- stash tab/grid state;
- trade-window state;
- UI mode/dialog state;
- confidence and freshness.

### 3. Decision engine
Separate planners/controllers:
- `FollowController`
- `LootController`
- `InventoryController`
- `StashController`
- `ListingController`
- `TradeController`

Controllers produce intended actions, not raw OS input.

### 4. Safety/interlocks
Before actions reach input:
- runtime mode check;
- target process/window allowlist;
- scenario feature flag;
- dry-run check;
- confidence threshold;
- rate limiter;
- kill-switch latch;
- optional realm/account/test-scenario allowlist.

### 5. GameInputController
All game-affecting input must pass through one auditable adapter.

Responsibilities:
- serialize inputs;
- cancel queued input on emergency stop;
- tag actions with scenario/module/reason;
- record before/after action trace;
- expose a fake implementation for replay/tests;
- prevent other modules from importing native input libraries directly.

## Data flow: full QA loop
1. Capture active PoE 2 frame/window state.
2. Perception extracts target, loot, inventory/stash/trade UI state.
3. State estimator reconciles current state.
4. Scenario scheduler chooses eligible controller.
5. Controller produces a typed decision and intended action(s).
6. Safety/interlock layer validates execution.
7. `GameInputController` emits or dry-runs input.
8. Follow-up frame validates result.
9. Trace stores evidence, decision, input, and outcome.
10. Recovery controller handles failure/stuck states.

## Data flow: price/item evaluation
1. Capture/observe item.
2. Parse and normalize.
3. Build market query.
4. Provider fetches/caches results.
5. Valuation filters outliers and computes range/confidence.
6. Desirability engine creates score/reasons.
7. Automation controller uses result according to scenario policy.

## Market provider abstraction
```ts
interface MarketProvider {
  id: string
  supports(item: NormalizedItem): boolean
  quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote>
  health(): Promise<ProviderHealth>
}
```

## Persistence
SQLite with migrations.

Suggested tables:
- `catalog_items`
- `item_observations`
- `inventory_snapshots`
- `stash_snapshots`
- `valuations`
- `market_comparables_cache`
- `saved_searches`
- `sort_rules`
- `listing_history`
- `trade_sessions`
- `automation_scenarios`
- `qa_action_traces`
- `perception_artifacts`
- `filter_profiles`
- `settings`
- `schema_migrations`

## Replay architecture
Implement provider interfaces so live services can be replaced with fixtures:
- `FrameSource`: live window capture vs recorded frames/video;
- `InputSink`: native input vs no-op/fake recorder;
- `MarketProvider`: live vs fixture;
- `Clock`: real vs deterministic test clock.

This should let Cursor build most bot behavior against deterministic replay before running against a live client.


## Current layout (2026-09-07)

The sections above are the original target design. This is what exists now
and where it lives; `docs/HANDOFF-roadmap-2026-09.md` records what changed
on 2026-09-07 and which live paths are still unverified.

### Processes

- **Electron main** (`src/main/index.ts`) — window, global hotkeys (Ctrl+D
  price check, Ctrl+Shift+Esc e-stop, Ctrl+Alt+V voice), clipboard poll
  (focus-gated), SQLite persistence (`persistence/`), item intelligence
  (`itemIntelligenceService.ts`: catalog, rules, builds, value tiers, price
  table; mirrors tiers + prices to `artifacts/tab-admin/triage.json` for the
  CLIs), price feed + trade2 comps (`priceFeedService.ts`), market trends
  (`marketTrendsService.ts`), deals watchlist (`watchlistService.ts`), the
  packaged script runner (`stashTabAdminService.ts`), assistive transfers and
  the stash sorter services, the dry-run overlay window.
- **Renderer** (`src/renderer`, Vue 3 + hash router) — Home (the landing
  route: character, session, maps, deaths, setup), Sort (run, value tiers,
  prices), Shop, Market (trade browser), Trade (offers & history), Wealth,
  Item log (evaluate + catalog + scan sessions), Search (query builder + rule
  studio), Builds, and Tools & QA (calibration, transfers, sort stash, stash
  tabs, hotkeys, commands & notes, diagnostics, loot filter, settings, market
  trends, deals, pricing, stash tracker, campaign guide). `src/renderer/overlay/`
  mounts the same bundle at `#/overlay` for the in-game panels.
  `services/rendererApi.ts` is the
  typed bridge with a browser-preview fallback; bridge shapes are declared
  once in `src/shared/ipc.ts`.
- **CLI flows** (`scripts/*.ts`, run with the local `tsx`) — the live game
  drivers: `sort-gear`, `shop-buckets`, `shop-ladder`, `shop`, `shop-list-bag`,
  `craft-gear`, `map-triage`, `vendor-cycle`, `stash-tab-admin`, the numpad
  `action-daemon` (with the auto-flask + auto-cast guard, the one
  perception-driven, timer-paced input path — see `docs/GGG_COMPLIANCE.md`),
  and the clean/rebuild tools.
  Every CLI loads tiers and prices through `src/adapters/triageLoader.ts`.
- **Input host** (`scripts/win-input-host.ps1`) — the one PowerShell process
  that captures the screen, OCRs (Windows.Media.Ocr), and sends input; every
  adapter talks to it through `src/adapters/winHost.ts`. It pins the Path of
  Exile window and refuses every op without it.

### Core (pure, `src/core`)

- Item text: `parseItem.ts` (Ctrl+C text incl. `(rune)`/`(desecrated)`
  tags, `isAffixMod`), `itemFingerprint.ts`.
- Valuation: `priceTable.ts` (the single price authority automation trusts),
  `priceFeed.ts` (poe2scout feed merge, league candidates, feed snapshot),
  `tradeComps.ts` (trade2 queries incl. stat-filtered stage, listing parsing,
  similarity), `tradePacing.ts` (header-driven pacer plus HOUSE rules),
  `statIds.ts` (trade2 stat catalogue), `tierLearning.ts` (tiers learned
  from listings), `modKnowledge.ts` (mod families), `appraisal.ts` (value
  score + confidence), `localValuation.ts` (the Ctrl+D valuation),
  `lookupScreen.ts` (which bag items deserve a trade2 lookup),
  `priceTrends.ts`, `exchangeArbitrage.ts`, `lootFilter.ts`.
- Decisions: `valueTiers.ts` (keep/sell/dump rules), `buildDemand.ts`
  (base + modifier demand patterns over `src/data/demand/buildDemand.ts`,
  the dated knowledge table), `itemDecision.ts` (keep / list / review /
  discard-eligible with the discard audit; `evaluateItemDecision` is the
  entry point the app, the CLIs and the browser preview share),
  `sortTriage.ts` (detours incl. the craft tab), `bagTriage.ts`,
  `crafting.ts` (planner), `shopListings.ts` + `shopPricing.ts` (ledger,
  buckets, ladder, gates), `watchlist.ts`, `inventoryLedger.ts` (Wealth),
  `mapTriage.ts`.
- Perception: `uiPerception.ts`, `cellOccupancy.ts`, `itemSprites.ts`,
  `nameplates.ts`, `nameplateCache.ts`, `calibrationProfile.ts`.

### Adapters (`src/adapters`, game-driving)

`gearSorter.ts` (orchestrator) with `gearSorter/{context,stashPerception,
tabNavigation,itemIdentification,transfers}.ts`; `shopKeeper.ts` (Ange's
Merchant panel); `drainKit.ts`, `bagKit.ts`, `stashTabKit.ts`,
`tabNavigator.ts`; `sortHarness.ts` (every click goes through it: overlays,
step gating, Numpad 0 stop, pacing, bench log); `nameplateFinder.ts`;
`flaskGuardRunner.ts`.

### Feature modules (the PoE Overlay II port, 2026-09-14)

The ported features are self-contained modules registered in order by
`src/main/features/registry.ts` and reached from the renderer through the one
generic `window.poe2.features` bridge (`src/shared/features.ts`,
`src/renderer/services/featureApi.ts`). Foundations first (`clientLog`,
`hotkeys`, `overlay`, `chatCommands`, `liveSearch`), then the ten feature
packages. Every package is offline-tested only; `docs/HANDOFF-overlay-port.md`
tracks what is still unverified against the live game.

- `src/core/evaluate{Item,Query,Results}.ts` — the pure price-check model.
- `src/main/features/evaluate/` — the `evaluate:*` channels and service.
- `src/renderer/features/evaluate/` — the workbench, overlay panel and Item log section.
- `src/core/market*.ts` — Market's pure model: drafts, tab sessions, favourites, stat autocomplete, exchange and import helpers.
- `src/main/features/market/` — the Market feature module: tab sessions, trade2 requests, live searches, the three `market-*.json` files.
- `src/renderer/features/market/` — the `/market` view: builder, results, favourites explorer, live-search column.
- `src/data/market/` — curated category labels, exchange currency ids and weighted-sum templates.
- `src/main/features/trade/` — offer state machine over Client.txt events, history + shop-ledger merge, notifier; pure logic in `src/core/{tradeOffers,tradeHistory,tradeNotify}.ts`, shared types in `src/shared/trade.ts`.
- `src/renderer/features/trade/` — the `/trade` view, the offer cards and the `trade` overlay panel.
- `src/core/commandsBookmarksNotes.ts`, `src/core/commandsBookmarksNotesMarkdown.ts` — sanitizers, placeholder context, note-image headers, the escape-first markdown subset.
- `src/main/features/commandsBookmarksNotes/` — commands, stash searches, bookmarks and notes: one hotkey per item, one gesture per press.
- `src/renderer/features/commandsBookmarksNotes/` — the Tools editor and the `notes` / `stash-search` overlay panels.
- `src/core/inspect*.ts` — Inspect's pure analysis: tier ladders from learned ranges, map-mod matching, wiki links, the assembled report.
- `src/data/inspect/` — the curated (unverified, community-maintained) waystone/tablet danger table.
- `src/main/features/inspect/` — the `inspect:*` channels, the `Alt+I` hotkey and the overlay panel plumbing.
- `src/renderer/features/inspect/` — the Inspect card, overlay panel, Item log section and settings section.
- `src/core/stashTracker{Snapshot,Timeline,Overlay}.ts` — snapshot/diff model, worth timeline, in-stash price overlay plan (pure).
- `src/main/features/stashTracker/` — snapshot journal + summary mirror under userData, the `{ op: "rect" }` window probe, and the click-through price label window.
- `src/renderer/features/stashTracker/` — Tools → Stash tracker, and the `stash-prices` overlay legend.
- `src/core/session*.ts` — session reducer, history records, Home aggregation, death index (pure).
- `src/main/features/session/` — the session service: Client.txt → runs, recap, death screenshots.
- `src/renderer/features/session/` — Home (`/home`), the Maps/History/Deaths tabs and the `session-recap` overlay panel.
- `src/core/campaignGuide.ts` + `campaignGuideMap.ts` — campaign route sanitizer, merge, area resolution, XP estimate, map layout (pure).
- `src/main/features/campaignGuide/` — the `campaign:*` channels, the auto-showing overlay panel and the `campaign-guide` settings namespace.
- `src/renderer/features/campaignGuide/` — Tools → Campaign guide and the `campaign` overlay panel.
- `src/data/campaign/route.json` — the bundled community route (every entry `verified: false`).
- `src/core/pricingHistory.ts` — pure pricing-history helpers: row building, filters, display units, sparkline/timeline geometry, the stored-history merge.
- `src/main/features/pricingHistory/` — the `pricing:*` channels and the per-league history store under userData.
- `src/renderer/features/pricingHistory/` — Tools → Pricing (table, sparklines, timeline).
- `src/core/appSettings{Checklist,Changelog,Elevation,Window}.ts` — the setup checklist, the changelog reader, the two fixed PowerShell strings, window-bounds maths (pure).
- `src/main/features/appSettings/` — the `app:*` channels: setup checklist, changelog, window bounds, the on-demand elevation probe.
- `src/renderer/features/appSettings/` — the Tools → Settings sections (checklist, overlay, notifications, game client, window, changelog, about).
- `src/renderer/features/hotkeys/` — Tools → Hotkeys, the section that lists every contributed action by group.

### Data on disk

Per-user (`%APPDATA%/poe2-trade-companion`): the SQLite database, the
optional session cookie, scanner journal, capture artifacts, and the ported
features' own files — `companion-settings.json` (one sanitized namespace per
feature), `overlay-hotkeys.json`, `session-current.json`,
`session-history.jsonl`, `deaths/`, `stash-tracker/` plus its
`stash-tracker-summary.json` mirror, `market-{favorites,tabs,live-searches}.json`,
`trade-offers.json`, `trade-history.json`, `trade-webhooks.secret.json`,
`notes-images/` and `pricing-history/<league>.json`. Shared with the
CLIs (`artifacts/tab-admin`, gitignored): price-feed config, feed snapshot,
comps cache, pacing log, stat catalogue, learned tiers, trends cache,
triage export, inventory ledger, shop ledger and settings, watchlist and
alerts. Recordings under `artifacts/teach` are irreplaceable.

### Safety rails that hold everywhere

Dry-run never sends input; every mutating click goes through the harness
(step mode on Numpad 8/9, Numpad 0 stops within ~100 ms); unknown UI is
capture-and-stop, never guessed; unidentified or unreadable items are never
dumped; heuristics may promote an item up but never to dump; the vendor's
accept click is the human's; trade2 traffic is paced and budgeted; the
league must be unambiguous before anything prices.

For the ported feature modules the same rails are enforced by construction:
`tests/input-boundary.test.ts` walks the whole feature tree and fails if any
module imports the input host, the input sink or the game input controller, or
sends a host op. Every in-game gesture they make goes through
`src/main/chatCommandService.ts` — one chat line or one search-box fill per user
gesture, kill switch and foreground check before each key, traced. The single
audited exception is `src/main/features/stashTracker/hostProbe.ts`, whose only
op is the passive `{ op: "rect" }` window query.
