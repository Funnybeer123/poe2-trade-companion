# Cursor Plan Mode Prompt — PoE2 Authorized QA Trade Bot

You are in **Plan Mode**. Do not write implementation code yet.

Create the implementation plan for this repository and save it to:

`plans/IMPLEMENTATION_PLAN.md`

## Mission

Build a production-quality Windows-first **Path of Exile 2 authorized QA automation bot and trading accessory**.

The user is testing bot behavior for Grinding Gear Games. The project intentionally requires automation that normal public players should not run under GGG's published third-party rules.

Do **not** remove or downgrade the automation requirements into manual-only recommendations.

The finished QA system must be capable of:

- following a configured character/leader automatically;
- detecting desirable items on the ground;
- automatically moving to/picking up desirable loot;
- evaluating all collected items;
- deciding keep/sell/vendor/craft/dump;
- automatically managing inventory and stash organization;
- moving items into configured stash tabs;
- identifying valuable/desirable items;
- calculating current market value and recommended sale price;
- automatically applying listing/repricing workflows through visible client UI where possible;
- executing configurable automated trade-session QA scenarios;
- recording every perceived state, decision, and generated input;
- replaying recorded sessions without generating real input.

The same codebase must retain a separate `public-companion` mode in which automation cannot arm.

# Mandatory first steps

Before writing the plan:

1. Read every repository document:
   - `AGENTS.md`
   - `README.md`
   - `docs/PRODUCT_SPEC.md`
   - `docs/ARCHITECTURE.md`
   - `docs/GGG_COMPLIANCE.md`
   - `docs/QA_AUTOMATION_BOUNDARY.md`
   - `docs/IMPLEMENTATION_PHASES.md`
   - `docs/TEST_PLAN.md`

2. Research current official GGG developer documentation.
3. Verify current PoE 2 official API capabilities. Never assume a PoE 1 endpoint exists for PoE 2.
4. Research current Cursor Plan/Agent best practices.
5. Inspect the current upstream `Kvan7/Exiled-Exchange-2` repository and license.
6. Identify reusable MIT-licensed item parsing/stat normalization/trade-query components.
7. Research current Windows desktop screen-capture/input libraries suitable for Electron/Node/TypeScript.
8. Research practical low-latency perception choices for this project: OpenCV, ONNX Runtime, OCR, template matching, object detection, or a small native helper when appropriate.
9. Record external dependencies, licenses, native-build risks, undocumented assumptions, and required test fixtures.

Do not ask clarification questions unless a decision truly blocks planning. Pick sensible defaults and document them.

# Runtime modes

Design two hard-separated runtime/build capabilities.

## `public-companion`

Provide normal companion features only:
- price check;
- desirability scoring;
- local catalog;
- sort recommendations;
- sell recommendations;
- market watcher;
- loot-filter generation.

Automation must not arm in this mode.

## `authorized-qa`

Enable all automation test modules required below.

Require:
- explicit mode selection;
- persistent visible QA banner/watermark;
- explicit local QA acknowledgement/configuration;
- target process/window allowlist;
- global emergency-stop hotkey;
- dry-run mode;
- per-module feature flags;
- action-rate limits;
- structured QA action traces;
- deterministic replay.

Where PoE/test infrastructure exposes reliable identifiers, support optional realm/account/character/scenario allowlists. Do not invent identifiers the client does not expose.

# Architecture rule: perception -> state -> decision -> interlock -> input

Keep these layers separate.

## Perception

Create typed adapters for:
- Windows game-window capture;
- screenshot/frame capture;
- OCR;
- template matching;
- optional object detection;
- clipboard;
- supported logs;
- supported official APIs.

Do not couple perception to input generation.

## State estimation

Maintain typed current state for:
- target/leader cues;
- movement/navigation cues;
- visible loot;
- inventory occupancy/items;
- stash tab/grid/items;
- current UI/dialog state;
- listing UI;
- trade-window state;
- confidence;
- frame age/freshness.

## Decision controllers

Use separate controllers/services such as:
- `FollowController`
- `LootController`
- `InventoryController`
- `StashController`
- `ListingController`
- `TradeController`
- `RecoveryController`
- `ScenarioOrchestrator`

Controllers return typed intended actions. They must not call OS input directly.

## Interlocks

Before any live input, check:
- runtime mode;
- QA armed state;
- emergency-stop latch;
- active process/window allowlist;
- scenario enabled;
- module enabled;
- dry-run/live setting;
- confidence threshold;
- action-rate budget;
- retry budget;
- optional environment/account/scenario allowlist.

## `GameInputController`

All game-affecting input must pass through one narrow auditable controller.

No other module may import native input-generation libraries.

It must support:
- keyboard input;
- mouse movement;
- clicks;
- click/drag when required by tested UI;
- cancellation;
- queued-action clearing;
- fake/no-op input sink for tests;
- tagging every action with scenario/module/reason;
- pre/post action trace;
- emergency stop.

# Required capability 1 — automated target following

Build a QA navigation/follow module.

Plan for:
- user/scenario selects the target/leader identity or visual cue;
- low-latency frame capture;
- target detection/tracking;
- relative direction estimation;
- movement generation;
- configurable follow distance/behavior;
- target loss detection;
- reacquisition;
- stuck detection;
- bounded recovery attempts;
- stop conditions;
- confidence-aware behavior;
- telemetry for every movement decision.

Prefer screen-visible perception and normal input emulation rather than process injection unless an explicitly supplied GGG test interface changes that decision.

# Required capability 2 — automatic loot detection and pickup

The bot must identify desirable visible loot and collect it automatically in authorized QA mode.

Plan:
- detect visible ground item labels/loot targets;
- classify/parse available item information;
- combine market value + desirability rules;
- score/rank nearby loot;
- apply minimum value/category thresholds;
- move/click to collect selected loot;
- confirm pickup success;
- retry safely within scenario limits;
- avoid repeatedly clicking failed/unreachable loot;
- detect inventory-full state;
- transition to stash workflow;
- log why an item was picked or skipped.

Support scenario profiles that intentionally pick bad/low-value items for adversarial testing.

# Required capability 3 — item parsing and valuation

Reuse mature MIT-licensed PoE 2 parsing where practical.

Normalize:
- class;
- rarity;
- name/base;
- item level;
- quality;
- sockets;
- modifiers;
- modifier tiers/rolls where obtainable;
- pseudo stats;
- relevant special properties.

Valuation result:
- low/fair/high;
- recommended listing price;
- currency;
- confidence;
- candidate count;
- comparable count;
- timestamp;
- provider;
- outlier handling;
- explanation.

# Required capability 4 — desirable-item engine

Create deterministic explainable scoring.

Factors may include:
- market value;
- liquidity;
- modifier tiers/rolls;
- pseudo-stat totals;
- useful modifier combinations;
- base;
- item level;
- quality;
- sockets;
- crafting potential;
- scenario/user preference.

Categories:
- Keep / Use
- High-Value Sell
- Sell
- Bulk / Commodity
- Craft Candidate
- Vendor / Low Value
- Dump
- Manual Review

Every decision must contain machine-readable factors plus human-readable reasons.

# Required capability 5 — automated inventory and stash management

The bot must be able to fully sort collected items in authorized QA mode.

Plan perception for:
- inventory grid and occupied cells;
- item positions/sizes;
- stash tab selector/state;
- stash grid positions;
- currently visible items;
- tab-full/invalid-target state.

Plan automation for:
- evaluate all inventory items;
- choose destination tab/category;
- switch tabs;
- transfer items;
- support bulk sorting;
- retry failed transfers;
- detect full destination;
- choose fallback destination;
- reconcile local shadow state against observed UI after each move;
- recover from wrong UI/tab/focus state.

Example destinations:
- Currency
- Waystones
- Uniques
- High-Value Sell
- Normal Sell
- Crafting
- Bulk
- Dump
- Vendor

# Required capability 6 — automated selling/listing

Plan automated listing and repricing workflows for authorized QA mode using the visible client/UI where practical.

Requirements:
- current recommended price;
- currency selection;
- configurable undercut/markup strategy;
- minimum sale threshold;
- price-confidence minimum;
- stale listing detection;
- repricing policy;
- listing history;
- UI state verification after price changes;
- dry-run output that shows intended actions without input.

Do not assume an API exists if listing requires the client UI.

# Required capability 7 — automated trade-session QA

Implement a configurable trade state machine.

Plan adapters for trade events from supported/available sources or deterministic fixtures.

When a QA scenario enables end-to-end execution, support states such as:

1. `Idle`
2. `TradeRequestReceived`
3. `ValidateRequestedItem`
4. `InviteOrJoinParty`
5. `PrepareItem`
6. `NavigateToTradeContext`
7. `OpenTrade`
8. `PlaceItem`
9. `ObserveCounterOffer`
10. `ValidateCurrencyOrItems`
11. `AcceptOrReject`
12. `ConfirmCompletion`
13. `CleanupPartySession`
14. `FailedOrTimedOut`

Test:
- correct amount;
- wrong amount;
- wrong currency;
- partial stack;
- wrong requested item;
- item unavailable;
- timeout;
- cancelled trade;
- disconnect;
- UI desync;
- emergency stop at every state.

Every transition requires a reason and trace entry.

# Required capability 8 — full-loop scenario orchestrator

Build a higher-level orchestrator that arbitrates between:
- following;
- looting;
- inventory handling;
- stashing;
- listing/repricing;
- trading;
- recovery.

Define priorities and interruptions.

Example:
- trade may interrupt follow;
- high-value loot may interrupt follow;
- inventory full triggers stash workflow;
- emergency stop interrupts everything;
- lost target may trigger reacquisition or scenario stop.

# Required capability 9 — deterministic replay and simulation

This is mandatory, not optional.

Create abstractions like:

```ts
interface FrameSource {
  nextFrame(): Promise<PerceptionFrameInput>
}

interface InputSink {
  execute(action: InputAction): Promise<InputResult>
}
```

Implement:
- live frame source;
- recorded screenshot/video frame source;
- native input sink;
- fake/no-op input sink;
- deterministic clock;
- fixture market provider.

Replay must exercise the same controller/orchestrator code as live mode while guaranteeing zero real input.

# Required capability 10 — QA action trace

Persist an append-only action trace.

Every action/decision should capture:
- timestamp;
- scenario ID;
- runtime mode;
- module/controller;
- active process/window;
- perception evidence reference/hash;
- relevant observed state;
- confidence;
- decision/reason;
- intended input;
- executed vs dry-run;
- result;
- follow-up observed state;
- retry/recovery relation when applicable.

Build a trace viewer for debugging.

# Market provider architecture

Do not tightly couple valuation to one provider.

Use an interface similar to:

```ts
interface MarketProvider {
  readonly id: string
  supports(item: NormalizedItem): boolean
  quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote>
  health(): Promise<ProviderHealth>
}
```

Handle:
- HTTP 429;
- timeouts;
- 5xx;
- malformed responses;
- stale cache;
- provider outage;
- offline/replay mode;
- failure injection.

# Persistence

Use SQLite + migrations.

Plan tables for at least:
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

# Preferred technology

Favor:
- Electron
- TypeScript
- Vue 3
- Vite
- SQLite
- Vitest
- Playwright
- Electron Builder

Research and select the smallest reliable Windows implementation for:
- low-latency screen/window capture;
- native keyboard/mouse input;
- OpenCV/template matching;
- OCR;
- ONNX inference if object detection materially improves reliability.

Avoid unnecessary ML if deterministic image processing works.

# Security and QA controls

Requirements:
- local-first;
- no telemetry by default;
- QA trace can be enabled explicitly;
- never commit secrets/internal credentials;
- OS-protected token storage;
- redacted general logs;
- QA artifact separation;
- visible authorized-QA mode state;
- global kill switch;
- process/window allowlist;
- dry-run first-run default;
- per-module arm/disarm;
- action rate limiting;
- input queue cancellation.

# Tests

Plan unit, integration, replay, and live QA test gates.

Must prove:
- public mode cannot generate bot input;
- QA mode cannot arm without explicit QA configuration;
- kill switch blocks/cancels input;
- non-allowlisted window blocks input;
- dry-run emits no real input;
- only `GameInputController` owns native input;
- follow state machine handles loss/stuck/recovery;
- loot ranking is deterministic;
- stash sorting handles failed/full destinations;
- listing calculations are deterministic;
- trade state machine handles adversarial cases;
- full-loop orchestrator follows expected priority rules;
- replay and live use the same decision/controller logic.

# Implementation order

Use this order unless research finds a strong technical reason to change it:

1. Research, repo foundation, mode/capability model
2. Item parser + fixture corpus + market provider abstraction
3. Valuation + desirability engine
4. QA automation harness, scenario model, replay, fake input, traces, kill switch
5. Live screen capture + perception foundation
6. Automated following/navigation
7. Automatic loot detection/pickup
8. Inventory + stash perception and local state
9. Automated stash sorting
10. Automated listing/repricing
11. Automated trade-session state machine
12. Full-loop orchestrator + recovery
13. Operator UI, debug overlay, trace/replay viewer
14. Loot-filter generator + optional supported API sync
15. Packaging, performance, diagnostics, hardening

# Per-phase plan requirements

For every phase include:
- purpose;
- exact files/modules;
- exact types/interfaces;
- dependencies;
- native dependency/build implications;
- test fixtures needed;
- unit tests;
- integration/replay tests;
- live QA manual test;
- commands to run;
- performance targets when relevant;
- failure cases;
- completion gate;
- suggested Git commit message.

# Planning output

Create `plans/IMPLEMENTATION_PLAN.md` with:

1. Executive summary
2. Validated external constraints
3. Current PoE 2 API limitations
4. Public vs authorized-QA mode boundary
5. Chosen stack and native dependencies
6. Architecture and rationale
7. Exiled Exchange 2 reuse decision
8. Exact repository/file tree
9. Domain models
10. SQLite schema
11. Perception architecture
12. State-estimation model
13. Decision-controller architecture
14. Safety/interlock architecture
15. `GameInputController`
16. Follow algorithm plan
17. Loot-detection/pickup plan
18. Inventory/stash perception plan
19. Stash sorting plan
20. Listing/repricing plan
21. Trade state-machine plan
22. Full-loop orchestration plan
23. Replay/simulation plan
24. QA action-trace format
25. Market provider/rate-limit design
26. Detailed implementation phases
27. Per-phase acceptance tests
28. Packaging/build separation
29. Security/privacy controls
30. Licensing/attribution
31. Risks and mitigations
32. Definition of done
33. Highest-Risk Assumptions

# Definition of done

The project is complete when the authorized QA build can, in a configured test scenario:

- acquire and follow a target character;
- detect and automatically collect desirable loot;
- evaluate inventory items;
- transition when inventory is full;
- sort items into configured stash destinations;
- price and list eligible items;
- process a configured automated trade scenario;
- recover from common failures;
- stop immediately through the global emergency stop;
- produce a complete action trace;
- reproduce controller decisions in deterministic replay without live input.

The public companion build/mode must retain the non-automation functionality and must not be capable of arming QA automation.

## Final Plan Mode instruction

Do **not** start coding.

Research the repository and current dependencies, build the complete implementation plan, verify that it preserves every authorized QA automation requirement, save it to `plans/IMPLEMENTATION_PLAN.md`, and finish with **Highest-Risk Assumptions** for review before Build mode.
