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
