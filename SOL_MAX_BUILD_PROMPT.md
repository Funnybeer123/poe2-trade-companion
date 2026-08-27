# Sol Max Build Prompt — PoE2 QA Trade Companion

Use this file as the authoritative execution prompt for the current repository.

You are **Sol Max operating as the primary implementation agent in Cursor**. Your job is to inspect the entire repository, create or update the implementation plan, and then execute the work phase-by-phase until the repository is in the strongest working state you can produce in this session.

Do not blindly rewrite working code. Preserve verified functionality, remove dead/redundant code, and migrate incrementally.

## Mission

Turn this repository into a reliable Windows-first Path of Exile 2 companion with two hard-separated capabilities:

1. `public-companion` — normal price-check, valuation, stash intelligence, recommendations, market monitoring, and loot-filter features. Automation must not arm.
2. `authorized-qa` — explicitly authorized test automation for bot-behavior QA, with automated following/navigation, loot pickup, inventory/stash handling, listing workflows, trade scenarios, recovery, deterministic replay, and full action traces.

The authorized-QA features are intentional requirements. Keep the existing safety boundary and do not weaken them into manual-only recommendations.

## Mandatory first action: inspect before changing

Before writing implementation code:

1. Read the entire repository, including at minimum:
   - `AGENTS.md`
   - `README.md`
   - `CURSOR_PLAN_PROMPT.md`
   - `docs/PRODUCT_SPEC.md`
   - `docs/ARCHITECTURE.md`
   - `docs/GGG_COMPLIANCE.md`
   - `docs/QA_AUTOMATION_BOUNDARY.md`
   - `docs/IMPLEMENTATION_PHASES.md`
   - `docs/TEST_PLAN.md`
   - everything under `plans/`
2. Inventory every source file, package, test, config file, script, dependency, partially implemented feature, TODO, stub, placeholder, duplicate abstraction, and dead path.
3. Run the existing install/build/lint/typecheck/test commands before refactoring when possible.
4. Record the current failures rather than hiding or deleting failing tests.
5. Inspect recent upstream/public references before selecting third-party packages or copying MIT-licensed code.
6. Verify current PoE 2 official API limitations. Do not invent a stash/listing API that is not available.
7. Treat ExiledBot 2 as a **behavioral and architectural reference only**. Do not crack licensing, bypass premium controls, copy proprietary code, or depend on decompiling protected binaries.

## Primary architectural change

Refactor the runtime around a deterministic state engine.

The application should not behave like a loose collection of scripts. It should behave like one system that repeatedly:

```text
observe
  -> normalize world state
  -> evaluate candidate states
  -> select highest-priority valid state
  -> calculate typed intended action
  -> validate safety/interlocks
  -> execute or dry-run
  -> observe result
  -> record trace
  -> repeat
```

Create a canonical short-lived `WorldState` / `GameStateSnapshot` that represents everything the automation currently believes about the client.

Include, as available:

- timestamp/frame ID;
- active window/process;
- runtime mode and armed state;
- current area/UI context;
- player cues/position estimate;
- leader/follow-target cues;
- visible hostile/encounter cues where required for test scenarios;
- visible loot targets;
- inventory occupancy/items;
- stash tab/grid state;
- trade/listing UI state;
- navigation observations;
- current objective/scenario;
- confidence and freshness for each observation;
- recent action/result history;
- stuck/retry/recovery counters.

Perception must update this state. Controllers must consume it. Controllers must not reach directly into screen-capture/native-input implementations.

## Priority state machine

Implement a priority-driven finite-state machine or equivalent deterministic scheduler.

Start with a state hierarchy similar to:

1. `EmergencyStopState`
2. `InvalidTargetWindowState`
3. `DisconnectedOrLoginRecoveryState`
4. `DeathOrFailureRecoveryState`
5. `TradeState`
6. `InventoryFullState`
7. `StashState`
8. `HighPriorityLootState`
9. `EncounterState`
10. `CombatSafetyState` if needed by an authorized scenario
11. `FollowState`
12. `NavigationState`
13. `ExplorationOrIdleState`

Do not hard-code this exact ordering if repository evidence shows a better one. Document the final priorities and interruption rules.

Each state should expose a small contract such as:

```ts
interface AutomationState {
  id: string
  priority: number
  canEnter(ctx: StateContext): boolean
  step(ctx: StateContext): Promise<StateStepResult>
  onEnter?(ctx: StateContext): Promise<void> | void
  onExit?(ctx: StateContext): Promise<void> | void
}
```

Prefer pure decision logic. Return typed intentions rather than sending native input from state classes.

## Core module boundaries

Target a clean structure along these lines, adapting names to the existing repo instead of creating unnecessary duplicates:

```text
src/
  core/
    world-state/
    state-machine/
    scheduler/
    events/
    clock/
  perception/
    capture/
    clipboard/
    ocr/
    templates/
    detection/
    state-estimation/
  navigation/
    planner/
    pathing/
    target-following/
    stuck-detection/
  loot/
    detection/
    scoring/
    pickup/
  items/
    parsing/
    normalization/
    valuation/
    desirability/
  inventory/
  stash/
  listing/
  trade/
  encounters/
  recovery/
  input/
  telemetry/
  replay/
  market/
  persistence/
  ui/
  tests/
```

Do not create empty folders merely to match this tree. Create only modules needed by real functionality.

## Single input boundary

Keep and strengthen the existing `GameInputController` rule.

All game-affecting input must pass through one auditable interface. No state, controller, Vue component, service, utility, or test helper may import native keyboard/mouse automation libraries directly.

It must support:

- native/live sink for authorized QA;
- fake/no-op sink;
- cancellation;
- queue clearing;
- global kill switch;
- process/window allowlist;
- module/scenario attribution;
- reason/decision attribution;
- rate limiting;
- dry-run;
- pre/post-action trace;
- result confirmation.

Add a static/lint/test rule if practical to prevent native input imports outside the input adapter.

## Perception and state estimation

Prefer external, observable client state rather than modifying the game client.

Use the smallest reliable combination of:

- Windows window/screen capture;
- clipboard item text;
- supported game logs;
- template matching;
- OpenCV/image processing;
- OCR only where useful;
- ONNX/object detection only where deterministic perception is insufficient;
- official APIs where they actually support PoE 2.

Do not add ML simply because it sounds sophisticated.

Every observation should have confidence/freshness metadata where uncertainty matters.

## Navigation and following

Build navigation as a dedicated subsystem rather than scattered mouse-coordinate logic.

It should support:

- target/leader tracking;
- target loss and reacquisition;
- movement objective generation;
- configurable follow distance;
- bounded retries;
- stuck detection;
- progress measurement;
- unreachable-target suppression;
- interruption by higher-priority states;
- deterministic replay.

If a true navmesh cannot be obtained reliably from observable state, build the best screen-visible/local planning abstraction available and clearly document the limitation. Do not fake a navmesh API.

## Loot engine

Separate:

1. detection;
2. item parsing/identification;
3. valuation/desirability;
4. target ranking;
5. pickup action;
6. pickup confirmation;
7. failure suppression/retry.

Prevent repeated clicking on inaccessible loot. Track recent failed targets with expiration/backoff.

Support reasons such as:

- estimated value;
- configured category;
- crafting potential;
- rarity/base rule;
- explicit QA scenario override;
- inventory capacity;
- confidence threshold.

## Inventory and stash

Maintain an observed local model of inventory and stash state.

Implement reconciliation after every transfer. Never assume a click succeeded.

Support:

- item position/size;
- occupied cells;
- destination rules;
- configured stash categories;
- full-tab detection;
- fallback destinations;
- transfer retry limits;
- UI focus/tab recovery;
- bulk-sort workflow;
- inventory-full transition;
- deterministic fixtures/replay.

## Item valuation and trading data

Reuse mature MIT-licensed parsing/query code where appropriate, especially Exiled Exchange 2 components, after verifying the current license and attribution requirements.

Keep market providers behind an interface.

Valuation should return:

- low/fair/high estimate;
- recommended list price;
- currency;
- comparable count;
- confidence;
- provider;
- timestamp;
- outlier handling;
- human-readable explanation;
- machine-readable factors.

Handle throttling, stale cache, outages, timeouts, malformed responses, and offline/replay mode.

## Listing and trade scenarios

Keep listing and trade automation as explicit authorized-QA state machines.

Do not assume an API can complete actions that currently require visible UI interaction.

Model trade transitions explicitly and test failure cases:

- wrong item;
- wrong currency;
- wrong amount;
- partial stack;
- timeout;
- cancelled trade;
- disconnect;
- UI desync;
- missing item;
- emergency stop at every state.

## Recovery system

Recovery is a first-class subsystem.

Create typed recovery reasons and bounded policies for:

- no visual progress;
- repeated same action;
- failed pickup;
- target loss;
- wrong window/focus;
- wrong stash tab;
- full stash destination;
- UI mismatch;
- trade timeout;
- navigation failure;
- unexpected state transition;
- stale perception.

Never permit infinite click/movement/tab-switch loops.

Every retry policy needs:

- max attempts;
- timeout;
- backoff where useful;
- fallback action;
- terminal outcome;
- trace record.

## Deterministic replay — top priority

Treat replay as one of the main implementation tools, not a future feature.

Live and replay mode must execute the same state machine/controllers.

Provide abstractions such as:

```ts
interface FrameSource {
  next(): Promise<FrameInput | null>
}

interface InputSink {
  execute(action: InputAction): Promise<InputResult>
}

interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}
```

Implement:

- live frame source;
- recorded frame/session source;
- deterministic clock;
- native input sink;
- fake/no-op input sink;
- fixture market provider;
- session recorder;
- replay runner;
- regression fixture format.

When any live QA bug occurs, the architecture should make it possible to save the relevant observations/actions and turn them into a replay regression test.

## Telemetry and trace viewer

Persist an append-only structured trace with at least:

- timestamp;
- frame/session/scenario ID;
- runtime mode;
- selected state;
- candidate states and priority where useful;
- relevant world-state excerpt;
- perception confidence;
- decision reason;
- intended action;
- interlock result;
- executed/dry-run status;
- input result;
- follow-up observation;
- retry/recovery relation;
- failure/timeout information.

Add a readable UI/replay/debug view so a developer can answer: **Why did the bot do that?**

## Behavioral-reference research

Use public ExiledBot 2 materials to identify useful behavior patterns and failure cases, not code to copy.

Research at least:

- current public feature set;
- current release notes;
- public setup/configuration behavior;
- publicly visible bug reports;
- state/recovery concepts exposed in logs or documentation;
- stash loop failures;
- map/navigation failures;
- boss/encounter transitions;
- loot-label obstruction failures;
- follow behavior;
- stuck detection;
- restart/recovery behavior.

Translate these into our own requirements and replay tests.

Do not implement license bypass, anti-detection evasion, credential theft, protected-code extraction, or proprietary-code copying.

## Public vs authorized-QA separation

Preserve the repository's central capability boundary.

### `public-companion`

May provide:

- price checking;
- item parsing;
- valuation;
- desirability scoring;
- stash/catalog intelligence where data is legitimately available;
- manual sort/sell recommendations;
- market watchers;
- loot-filter generation.

It must be structurally unable to generate automated game input.

### `authorized-qa`

May enable the test automation modules required by the repository only after explicit QA arming/configuration.

Keep:

- persistent QA visual indicator;
- global emergency stop;
- dry-run first-run/default behavior;
- process/window allowlist;
- module feature flags;
- action-rate limits;
- optional test environment/account/scenario allowlists when real identifiers exist;
- complete traces.

## Code-quality rules

- TypeScript strict mode.
- Keep modules small and understandable.
- Prefer explicit types over `any`.
- Remove duplicate abstractions.
- Do not add speculative frameworks.
- Do not create giant god services.
- Keep UI separate from automation/domain logic.
- Prefer pure functions for scoring/state transitions.
- Make all time/network/input dependencies injectable where replay needs them.
- Never swallow errors silently.
- Use structured errors/reasons.
- Preserve working features during migration.
- Delete dead code only after verifying it is unused.
- Update documentation with architecture changes.

## Test requirements

Build a strong regression suite.

At minimum prove:

- public mode cannot emit native game input;
- authorized QA cannot arm without explicit configuration;
- kill switch immediately blocks and clears pending input;
- wrong process/window blocks actions;
- dry-run emits zero native input;
- native input imports exist only inside the approved adapter;
- state priority is deterministic;
- higher-priority states interrupt lower-priority states correctly;
- target loss/reacquisition works;
- stuck detection terminates loops;
- failed loot gets suppression/backoff;
- inventory-full transitions correctly;
- stash-full fallback works;
- transfers require observed confirmation;
- valuation is deterministic under fixtures;
- trade scenarios handle all failure cases;
- recovery policies are bounded;
- replay generates no native input;
- replay and live paths use the same decision logic;
- each reproduced bug can become a regression fixture.

## Execution strategy

Do not attempt one enormous rewrite.

Use vertical phases that leave the repo buildable after each completed phase.

Recommended order:

### Phase 0 — Baseline
- inspect repository;
- run current checks;
- record failures;
- produce/update `plans/IMPLEMENTATION_PLAN.md`;
- create a current architecture map;
- identify code to preserve/migrate/remove.

### Phase 1 — Core deterministic runtime
- canonical world state;
- state interface;
- priority scheduler;
- event/clock abstractions;
- unit tests.

### Phase 2 — Safety/input boundary
- strengthen capability gates;
- central input adapter;
- kill switch;
- dry-run;
- allowlist/rate limiter;
- tests that prove no bypass.

### Phase 3 — Replay and telemetry
- session format;
- fake input;
- deterministic clock;
- trace model/storage;
- replay runner;
- first regression fixtures.

### Phase 4 — Perception/state estimation
- live capture adapter;
- clipboard/log inputs;
- template/image processing foundations;
- confidence/freshness;
- debug visualization.

### Phase 5 — Navigation/follow/recovery
- target following;
- progress measurement;
- stuck detection;
- reacquisition;
- replay tests.

### Phase 6 — Loot
- detection;
- scoring;
- pickup;
- confirmation;
- failed-target suppression;
- inventory-full transition.

### Phase 7 — Item/market engine
- parser reuse where licensed;
- normalization;
- valuation;
- desirability;
- provider/cache handling.

### Phase 8 — Inventory/stash
- perception;
- shadow model;
- transfer confirmation;
- sorting;
- full-tab/fallback/recovery.

### Phase 9 — Listing/trade
- listing state machine;
- repricing;
- trade scenario state machine;
- adversarial fixtures.

### Phase 10 — Full orchestration
- interruption rules;
- complete QA loop;
- recovery escalation;
- trace/replay viewer.

### Phase 11 — UI/packaging/hardening
- operator controls;
- QA banner;
- diagnostics;
- performance;
- packaging;
- documentation;
- final test matrix.

## Required workflow for every phase

For each phase:

1. State what currently exists.
2. State what will change.
3. Identify exact files/modules to add/change/remove.
4. Implement the smallest complete vertical slice.
5. Add/update unit/integration/replay tests.
6. Run relevant lint/typecheck/tests/build.
7. Fix regressions before continuing.
8. Update docs/plan if reality differed from the plan.
9. Commit the completed phase separately using a concise conventional commit message.
10. Continue to the next phase without asking the user for routine implementation choices that can be resolved from repository context.

## Decision policy

Do not stop for minor uncertainty.

When choices are reversible:

- inspect existing code;
- choose the simplest reliable option;
- record the rationale;
- proceed.

Only stop for information that truly cannot be inferred and blocks implementation, such as missing private credentials or a required external test interface that is not present.

Never invent successful test results. If a live PoE2 client or authorized environment is unavailable, complete deterministic/replay coverage and clearly mark the remaining live validation gate.

## Research policy

Before introducing or upgrading dependencies:

- verify current maintained versions;
- verify Windows/Electron compatibility;
- verify license;
- prefer maintained libraries;
- minimize native dependency count;
- document native build requirements;
- do not copy proprietary code.

## Deliverables

By the end of the execution pass, leave the repository with:

- updated `plans/IMPLEMENTATION_PLAN.md`;
- updated architecture documentation;
- a working deterministic runtime/state-machine foundation;
- centralized world state;
- hard capability/input boundaries;
- deterministic replay infrastructure;
- structured QA traces;
- implemented/refactored feature modules as far as repository/test-environment access allows;
- regression fixtures for known failure modes;
- passing tests for completed phases;
- no silently ignored failing checks;
- clear remaining TODOs only for dependencies that genuinely require unavailable external access.

## Final report format

When finished, report:

1. what you inspected;
2. architecture changes made;
3. features completed;
4. code removed/simplified;
5. tests added and results;
6. replay fixtures added;
7. remaining live-validation items;
8. known limitations;
9. commits created;
10. the single best next action if work remains.

## Start now

Begin by reading `AGENTS.md`, `README.md`, `CURSOR_PLAN_PROMPT.md`, all files under `docs/`, and all existing files under `plans/`.

Then inspect the actual source tree and current build/test status.

Update `plans/IMPLEMENTATION_PLAN.md` to reflect the repository as it exists today.

After planning, execute the phases rather than stopping at the plan unless a genuinely unavailable external dependency blocks further work.
