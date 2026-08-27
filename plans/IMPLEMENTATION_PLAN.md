# PoE2 QA Trade Companion — Implementation Plan

**Authority:** Sol Max (planning only).  
**Implementer:** Grok 4.6 with `xhigh` reasoning, Fast variant when available.  
**Plan date:** 2026-08-27.  
**Audited base commit:** `3bf2f91398a16a5250d351be818a41ca39e32762` (`main`).  
**Do not implement this plan in the Sol Max pass.** Grok executes it phase-by-phase.

This document is the executable architecture. Grok must implement it without casually redesigning the system. Amend only when code, tests, or current external evidence proves an assumption wrong, and document every amendment in `grok/IMPLEMENTATION_STATE.md`.

---

## 1. Executive summary

`Funnybeer123/poe2-trade-companion` is a **documentation-only** repository. There is no application source, no test harness, no package manifest, no CI, no SQLite schema, no Electron shell, and no `plans/IMPLEMENTATION_PLAN.md` on `main`.

The product is a Windows-first Path of Exile 2 accessory with two hard-separated modes:

1. **`public-companion`** — price check, desirability, catalog, sort/sell recommendations, market watcher, loot-filter generation. No automated game input.
2. **`authorized-qa`** — authorized GGG test automation: follow, loot, inventory/stash, listing, trade sessions, traces, and deterministic replay.

Build the **runtime kernel first** (canonical `WorldState`, deterministic scheduler, capability/interlock/`GameInputController` boundary, replay/trace), then perception and controllers, then valuation, then operator UI and packaging.

`docs/IMPLEMENTATION_PHASES.md` is item-parser-first. That order is **not** used. Repository evidence: there is no parser or other production code to preserve, so kernel-first avoids rewriting every controller later. Phase 07 uses a `DesirabilityPort` with a fixture scorer; Phase 08 plugs in the real parser/valuation engine. Loot-filter local export lives in Phase 14; optional official filter API sync lives in Phase 15.

---

## 2. Repository audit (verified 2026-08-27)

### 2.1 What exists

| Path | Role |
| --- | --- |
| `AGENTS.md` | Persistent project rules |
| `README.md` | Product overview + workflow |
| `SOL_MAX_PLAN_ONLY_PROMPT.md` | Authoritative Sol Max planning prompt |
| `GROK_BOT_START_HERE.md` | Grok bootstrap |
| `GROK_46_XHIGH_FAST_BUILD_PROMPT.md` | Grok implementation prompt |
| `GROK_BOT_QA_PROMPT.md` | Grok self-review gate |
| `SOL_MAX_BUILD_PROMPT.md` | Deprecated redirect (keep) |
| `CURSOR_PLAN_PROMPT.md` | Legacy planning context (keep) |
| `docs/*` | Spec, architecture, compliance, tests, workflow |
| `plans/.gitkeep` | Empty plans directory |
| `.gitignore` | Ignores `node_modules`, `dist`, `release`, `coverage`, logs, env, sqlite, `.cursor/plans/` |

### 2.2 What does not exist

No `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE`, `src/`, `apps/`, `packages/`, `tests/`, `fixtures/`, `migrations/`, `.github/workflows/`, `electron-builder` config, `grok/`, or any TypeScript/Vue/Electron code.

`plans/IMPLEMENTATION_PLAN.md` did **not** exist at audit time.

### 2.3 Recorded command failures

Run from `/workspace` on `3bf2f91`:

| Command | Result |
| --- | --- |
| `npm test` | `ENOENT` — no `package.json` (exit 254) |
| `npm run lint` | `ENOENT` — no `package.json` (exit 254) |
| `npx tsc --noEmit` | No TypeScript project; `npx` resolved deprecated `tsc@2.0.4` and failed |
| `npm run typecheck` | Does not exist |
| `npm run replay` | Does not exist |

These are **missing-project** failures, not flaky tests. Do not hide them. Phase 01 makes them into real commands.

### 2.4 Docs vs implementation

Every architecture name in `docs/ARCHITECTURE.md` is unimplemented: `RuntimeCapabilities`, `WorldState`, `GameInputController`, controllers, SQLite tables, replay ports, overlay UI.

`docs/IMPLEMENTATION_PHASES.md` phases 0–14 are all incomplete. `docs/TEST_PLAN.md` has no tests to run.

### 2.5 Code classification

| Class | Finding |
| --- | --- |
| Working production code to preserve | **None.** |
| Partial code to finish | **None.** |
| Dead/duplicate code to remove | **None.** Keep deprecated prompts as redirects. |
| Architecture gaps | Entire product: workspace, domain, kernel, perception, controllers, persistence, UI, packaging, CI. |

### 2.6 Phase-order decision

Keep the Sol Max recommended 15-phase order. Do not switch to `docs/IMPLEMENTATION_PHASES.md` item-first order.

Reasons:

1. No existing parser/workspace to extend.
2. Capability/input/replay bugs are more expensive if discovered after six controllers exist.
3. Loot ranking can consume `DesirabilityPort` before a real market engine exists.
4. Official PoE 2 stash/trade-search APIs are absent; valuation must stay fixture-first anyway.

Mapping from `docs/IMPLEMENTATION_PHASES.md`:

| Docs phase | This plan |
| --- | --- |
| 0 Research/foundation | 01 + parts of 03 |
| 1 Parser/fixtures | 08 |
| 2 Valuation/desirability | 08 |
| 3 Harness/replay/kill switch | 03 + 04 |
| 4 Perception | 05 |
| 5 Follow | 06 |
| 6 Loot | 07 |
| 7 Inventory/stash observation | 09 |
| 8 Stash sorting | 10 |
| 9 Listing | 11 |
| 10 Trade | 12 |
| 11 Orchestrator | 13 (kernel already in 02) |
| 12 Operator UI | 14 |
| 13 Loot filter + optional API | 14 local, 15 optional sync |
| 14 Packaging | 15 |

During Phase 15, add a short pointer at the top of `docs/IMPLEMENTATION_PHASES.md` to this file so the two docs do not diverge silently.

---

## 3. Validated external constraints (2026-08-27)

Re-verify these at the start of any phase that depends on them. Record date + evidence in `grok/RESEARCH_NOTES.md`.

### 3.1 Official GGG developer API

Source: [https://www.pathofexile.com/developer/docs](https://www.pathofexile.com/developer/docs) and [reference](https://www.pathofexile.com/developer/docs/reference).

Documented facts:

- Header note: **“There are currently limited APIs that return PoE2 game information.”**
- Server: `https://api.pathofexile.com`.
- **Account Stashes, Guild Stashes, Public Stashes: PoE 1 only.** Do not invent a PoE 2 stash API.
- **Account Leagues, League Accounts, PvP Matches: PoE 1 only.**
- **Account Characters** accept `realm=poe2` for list/get. Character object: `skills` is PoE2-only; **`inventory` and `rucksack` are PoE1 only.** Do not use this API as live inventory/stash truth for PoE 2.
- **Item Filters** support `realm=poe2` (create/update/list). Optional later; requires OAuth `account:item_filter`.
- **Leagues** support `realm=poe2`.
- **Currency Exchange** public endpoint supports `realm=poe2`:  
  `GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]`  
  Hourly aggregate digests, not live item search. Wait until the next hourly boundary when `next_change_id` equals the requested id.
- OAuth 2.1. Portal text: **“We are currently unable to process new applications.”** Do not block the product on OAuth.
- Rate limits are dynamic; parse `X-Rate-Limit-*` and `Retry-After`.
- Required User-Agent: `OAuth {$clientId}/{$buildVersion} (contact: {$contact}) ...` when using official APIs.
- **Available resources only.** Reverse-engineering undocumented website/in-game endpoints is against GGG Terms of Use §7i.
- New-application freeze means official `account:profile` / `account:characters` / `account:item_filter` sync is **optional and blocked** until GGG accepts an app or supplies a test client.

### 3.2 Official trade search

There is **no documented official PoE 2 trade-search API** in the developer reference. Community `/api/trade2` usage and `POESESSID` cookie flows are undocumented.

**Plan rule:** default market path is fixtures + optional official Currency Exchange. Do **not** implement undocumented `trade2` clients, cookie/session capture, or POESESSID storage. If GGG later documents a trade-search API, add an `OfficialTradeSearchProvider` behind `MarketProvider` after recording evidence.

### 3.3 Published third-party / macro guidance

Public companion mode must follow current published rules:

- Macros must be invoked manually (no timers, file-watch, or screen-reactive invocation).
- One set function per invocation; one game-affecting action.
- Reading logs is allowed if the user knows.
- Do not present the app as GGG-official. Visible disclaimer:  
  `This product isn't affiliated with or endorsed by Grinding Gear Games in any way.`

`authorized-qa` intentionally exceeds public macro rules and must stay behind explicit QA gates. Do not downgrade QA features to manual-only recommendations.

### 3.4 Exiled Exchange 2 (reuse candidate)

- Repo: [Kvan7/Exiled-Exchange-2](https://github.com/Kvan7/Exiled-Exchange-2)
- License: **MIT** (file `LICENSE`; copyright notice currently “Copyright (c) 2020 Alexander Drozdov”, inherited from Awakened PoE Trade). Latest release observed: **0.15.8** (2026-06-20).
- Stack observed: Electron `^40.9.1`, TypeScript `5.9.x`, Node types `22.x`, `uiohook-napi`, `electron-overlay-window`, Vue renderer, Vite.
- Reusable MIT surface: `renderer/src/parser/*`  
  (`Parser.ts`, `ParsedItem.ts`, `advanced-mod-desc.ts`, `calc-base.ts`, `calc-q20.ts`, `magic-name.ts`, `meta.ts`, `modifiers.ts`, `stat-translations.ts`, `index.ts`) plus required `renderer/src/assets/data` tables those files import.
- Do **not** vendor EE2 overlay/input/trade-site query/hotkey code as the product kernel. Those pieces either automate input or talk to undocumented trade endpoints.
- Preserve MIT copyright/license in `NOTICE` and next to vendored files.
- Re-verify license + revision immediately before first copy (Phase 08).

### 3.5 ExiledBot 2 public material

Behavioral/QA reference only: visible release notes, configuration concepts, bug reports, logs.

**Forbidden:** proprietary-code copying, license/premium bypass, credential theft, protected-code extraction, anti-cheat bypass, detection-evasion.

### 3.6 Native Windows libraries (defaults)

Lock these unless implementation evidence forces a swap:

| Concern | Default | Why |
| --- | --- | --- |
| Window enumerate / foreground | `koffi` → Win32 (`user32`/`kernel32`) | Small FFI, prebuilds, no extra native addon |
| Screen capture v1 | Electron `desktopCapturer` + window bounds from Win32 | Ships with Electron; good enough for replay fixture capture |
| Screen capture v2 (if v1 too slow) | Windows.Graphics.Capture behind `LiveFrameSource` | Do not adopt an unproven npm capture package in Phase 01 |
| Game input | `koffi` → `SendInput` inside `packages/native-input` only | Smallest auditable surface |
| Global emergency hotkey | Electron `globalShortcut` in **main**, outside the worker loop | Must work even if the automation loop is wedged |
| OCR v1 | `tesseract.js` | No extra native build |
| Image ops v1 | `sharp` + in-process template correlation | Avoid `opencv4nodejs` native-build pain |
| SQLite | `better-sqlite3` | Sync, typed-enough, standard Electron pattern |
| Overlay | Electron windows; `electron-overlay-window` only if click-through attach is required | Add in Phase 14 if needed |

If a default package is incompatible with Electron 40 / Node 22 at implement time, swap the adapter only. Do not change the TypeScript ports.

---

## 4. Locked architecture

### 4.1 Loop

```text
FrameSource -> Perception -> StateEstimator -> WorldState
    -> ScenarioScheduler (priority + interrupts)
    -> Controller (typed BotDecision, no OS input)
    -> InterlockGate
    -> GameInputController -> InputSink
    -> follow-up frame / result
    -> QaTraceWriter
    -> RecoveryPolicy
```

Live and replay share the same scheduler, controllers, interlocks, and trace writer. Only `FrameSource`, `InputSink`, `MarketProvider`, and `Clock` are swapped.

### 4.2 Mode boundary

`public-companion` is structurally unable to emit automated native game input:

- Public builds omit `packages/native-input`.
- `createInputSink()` returns `ForbiddenInputSink` unless `capabilities.canEmitNativeInput === true`.
- Controllers may still produce recommendations in public mode; `InterlockGate` denies execution.
- No silent fallback from `authorized-qa` into public automation.

`authorized-qa` requires all of:

1. Build/runtime mode `authorized-qa`
2. Local acknowledgement file/config `qa.acknowledged === true`
3. Process/window allowlist configured
4. Persistent QA banner visible
5. Emergency-stop hotkey registered
6. Explicit arm (`qa.armed === true`)
7. Module + scenario flags
8. Dry-run unless the scenario sets `executionMode: "live"`

### 4.3 Locked defaults (do not bikeshed)

- Package manager: **npm workspaces** (npm 10+).
- Node: **22 LTS**. Pin exact version in `.nvmrc` and `engines`.
- Language: TypeScript **5.9**, `strict: true`, `module: Node16` / `bundler` as appropriate per package.
- App: Electron **40.x** (verify against current stable at Phase 01; EE2 used `^40.9.1`).
- UI: Vue **3.5** + Vite **6 or 7** (pin what installs cleanly with Electron 40).
- Tests: Vitest **3.x** for unit/integration/replay; Playwright for overlay smoke from Phase 14.
- Lint: ESLint 9 flat config + typescript-eslint + Prettier.
- English client text only in v1.
- PoE 2 **Windowed** or **Windowed Fullscreen** only.
- Default process allowlist (verify real image names in Phase 05): `PathOfExile.exe`, `PathOfExile_x64.exe`, `PathOfExileSteam.exe`.
- Default window-title include: `Path of Exile 2`.
- Destructive/trade tests default to **dry-run**.
- No telemetry except explicit local QA traces.
- Repo license: **MIT** (add `LICENSE` in Phase 01).
- Disclaimer on first-run and settings.

### 4.4 Target repository tree

Create this tree. Do not invent extra packages.

```text
.
├── package.json                          # workspaces + scripts
├── package-lock.json
├── .nvmrc                                # 22
├── .gitignore                            # keep existing; add /artifacts /grok local sqlite
├── LICENSE                               # MIT
├── NOTICE                                # EE2 + other attributions (filled in Phase 08)
├── tsconfig.base.json
├── vitest.workspace.ts
├── electron-builder.public.yml
├── electron-builder.qa.yml
├── .github/workflows/ci.yml
├── apps/desktop/                         # Electron main + preload
│   ├── package.json
│   ├── electron-main.ts
│   ├── preload.ts
│   └── tsconfig.json
├── apps/overlay/                         # Vue 3 renderer
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
├── packages/core/                        # framework-free domain + kernel
│   ├── package.json
│   └── src/
│       ├── world-state/
│       ├── scheduler/
│       ├── capabilities/
│       ├── interlock/
│       ├── input/                        # GameInputController + ports; NO native SendInput
│       ├── replay/
│       ├── trace/
│       ├── perception/                   # ports + estimator
│       ├── controllers/
│       ├── items/
│       ├── market/
│       ├── persistence/                  # ports only
│       └── vendor/                       # empty until Phase 08
├── packages/persistence-sqlite/
├── packages/perception-live/             # Electron/Win32 capture adapters
├── packages/native-input/                # QA-only SendInput sink; public build excludes
├── packages/testkit/
├── fixtures/
│   ├── items/
│   ├── market/
│   ├── replay/
│   └── traces/
├── migrations/                           # numbered SQL
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── replay/
│   └── smoke/
├── grok/                                 # Grok-maintained; create in Phase 01
└── scripts/
    ├── check-native-input-imports.mjs
    └── verify-public-build-excludes-native.mjs
```

`packages/core` must not import `electron`, `koffi`, `better-sqlite3`, `tesseract.js`, or `packages/native-input`.

---

## 5. Exact contracts (implement these types)

Put shared types in `packages/core/src`. Names below are canonical.

### 5.1 Clock, ids, confidence

```ts
export interface Clock {
  nowMs(): number
}

export class SystemClock implements Clock {
  nowMs(): number { return Date.now() }
}

export class FrozenClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number { return this.ms }
  advance(deltaMs: number): void { this.ms += deltaMs }
}

export type IsoTimestamp = string
export type HexSha256 = string
export type ScenarioId = string
export type ModuleId =
  | "follow"
  | "loot"
  | "inventory"
  | "stash"
  | "listing"
  | "trade"
  | "recovery"
  | "orchestrator"
  | "perception"
  | "input"

export type Confidence = number // 0..1 inclusive
export type ConfidenceBucket = "high" | "medium" | "low" | "none"
export type Freshness = "fresh" | "aging" | "stale" | "missing"

export type LowConfidencePolicy = "skip" | "confirm" | "adversarial-execute"
```

### 5.2 Runtime capabilities

```ts
export type RuntimeMode = "public-companion" | "authorized-qa"

export interface RuntimeCapabilities {
  readonly mode: RuntimeMode
  readonly canEmitNativeInput: boolean
  readonly qaBannerRequired: boolean
  readonly modules: Record<ModuleId, boolean>
}

export interface QaArmingState {
  acknowledged: boolean
  armed: boolean
  emergencyStopLatched: boolean
  dryRunDefault: boolean
  allowlistedProcessNames: string[]
  allowlistedWindowTitleIncludes: string[]
  realmAllowlist?: string[]
  accountAliasAllowlist?: string[]
  characterAliasAllowlist?: string[]
  scenarioAllowlist?: ScenarioId[]
}

export function createCapabilities(mode: RuntimeMode): RuntimeCapabilities {
  if (mode === "public-companion") {
    return {
      mode,
      canEmitNativeInput: false,
      qaBannerRequired: false,
      modules: {
        follow: false, loot: false, inventory: false, stash: false,
        listing: false, trade: false, recovery: false,
        orchestrator: false, perception: true, input: false
      }
    }
  }
  return {
    mode,
    canEmitNativeInput: true, // still gated by InterlockGate + native package presence
    qaBannerRequired: true,
    modules: {
      follow: true, loot: true, inventory: true, stash: true,
      listing: true, trade: true, recovery: true,
      orchestrator: true, perception: true, input: true
    }
  }
}
```

Public mode: `canEmitNativeInput` is always `false`. QA mode: the flag means “native input is *eligible*”, not “armed”.

### 5.3 World state

```ts
export type AutomationStateId =
  | "EmergencyStop"
  | "SafetyHold"
  | "TradeSession"
  | "InventoryFull"
  | "HighValueLoot"
  | "Listing"
  | "StashSort"
  | "LootPickup"
  | "Follow"
  | "RecoverTarget"
  | "Idle"

export const STATE_PRIORITY: Record<AutomationStateId, number> = {
  EmergencyStop: 0,
  SafetyHold: 1,
  TradeSession: 2,
  InventoryFull: 3,
  HighValueLoot: 4,
  Listing: 5,
  StashSort: 6,
  LootPickup: 7,
  Follow: 8,
  RecoverTarget: 9,
  Idle: 10
}

export interface Observation<T> {
  value: T
  confidence: Confidence
  observedAtMs: number
  freshness: Freshness
  evidenceId?: string
}

export interface TargetCue {
  identity: string
  boundingBox?: PixelBox
  screenPoint?: PixelPoint
  estimatedDistance?: "near" | "mid" | "far" | "unknown"
}

export interface LootTarget {
  id: string
  labelText?: string
  screenPoint: PixelPoint
  boundingBox?: PixelBox
  rarityCue?: string
  score?: number
  skipReason?: string
}

export interface GridCell {
  tabId?: string
  x: number
  y: number
  w: number
  h: number
  occupied: boolean
  itemFingerprint?: string
}

export interface UiModeState {
  kind:
    | "unknown"
    | "gameplay"
    | "inventory"
    | "stash"
    | "trade"
    | "listing"
    | "dialog"
    | "loading"
  details?: string
}

export interface WorldState {
  tickId: number
  capturedAtMs: number
  clockMs: number
  runtimeMode: RuntimeMode
  selectedState: AutomationStateId
  previousState: AutomationStateId
  activeScenarioId: ScenarioId
  process: Observation<{ pid?: number; name?: string; title?: string; allowlisted: boolean }>
  target: Observation<TargetCue | null>
  loot: Observation<LootTarget[]>
  inventory: Observation<{ occupied: number; capacity: number; cells: GridCell[]; full: boolean }>
  stash: Observation<{ tabId?: string; tabName?: string; cells: GridCell[]; tabFull: boolean }>
  trade: Observation<TradeWindowView | null>
  listing: Observation<ListingUiView | null>
  ui: Observation<UiModeState>
  stuck: Observation<{ isStuck: boolean; reason?: string }>
}

export interface PixelPoint { x: number; y: number }
export interface PixelBox { x: number; y: number; w: number; h: number }

export interface TradeWindowView {
  open: boolean
  ourSlots: GridCell[]
  theirSlots: GridCell[]
  acceptEnabled?: boolean
  counterOfferText?: string
}

export interface ListingUiView {
  open: boolean
  itemFingerprint?: string
  priceText?: string
  currency?: string
}
```

`WorldState` is the only snapshot controllers may read. Controllers must not keep a parallel long-lived world model.

### 5.4 Decisions and input

```ts
export type InputAction =
  | { type: "key-down"; key: string }
  | { type: "key-up"; key: string }
  | { type: "key-tap"; key: string }
  | { type: "mouse-move"; x: number; y: number }
  | { type: "mouse-click"; x: number; y: number; button: "left" | "right"; holdMs?: number }
  | { type: "mouse-drag"; from: PixelPoint; to: PixelPoint; button: "left" }
  | { type: "wait"; durationMs: number }
  | { type: "noop"; reason: string }

export interface BotDecision {
  module: ModuleId
  state: AutomationStateId
  reason: string
  confidence: Confidence
  intendedActions: InputAction[]
  evidenceIds: string[]
  suppressTargetIds?: string[]
}

export interface InputResult {
  accepted: boolean
  executed: boolean
  dryRun: boolean
  blockedReason?: string
  startedAtMs: number
  finishedAtMs: number
}

export interface GameInputController {
  enqueue(decision: BotDecision, ctx: InterlockContext): Promise<InputResult[]>
  emergencyStop(): void
  clearQueue(): void
  isStopped(): boolean
}

export interface InputSink {
  readonly kind: "native" | "recording" | "forbidden" | "noop"
  execute(action: InputAction): Promise<InputResult>
  cancel(): void
}
```

Rules:

- Only `GameInputController` may call an `InputSink`.
- Only `packages/native-input` may import `koffi` / `SendInput` / any native input library.
- `ForbiddenInputSink.execute` always returns `{ accepted: false, executed: false, blockedReason: "public-companion-forbids-native-input" }`.
- `NoopInputSink` records intended actions, never executes.
- `RecordingInputSink` wraps another sink and appends actions to the trace.

### 5.5 Interlocks

```ts
export interface InterlockContext {
  capabilities: RuntimeCapabilities
  arming: QaArmingState
  scenario: AutomationScenario
  world: WorldState
  decision: BotDecision
}

export type InterlockCode =
  | "ok"
  | "public-mode"
  | "qa-not-acknowledged"
  | "qa-not-armed"
  | "emergency-stop"
  | "window-not-allowlisted"
  | "scenario-disabled"
  | "module-disabled"
  | "dry-run"
  | "low-confidence"
  | "rate-limited"
  | "retry-exhausted"
  | "allowlist-denied"

export interface InterlockVerdict {
  code: InterlockCode
  allowExecute: boolean
  allowRecord: boolean
  message: string
}

export interface InterlockGate {
  evaluate(ctx: InterlockContext): InterlockVerdict
}
```

Evaluation order (first denying code wins, except `dry-run` which allows record and denies execute):

1. `emergency-stop`
2. `public-mode` if `!capabilities.canEmitNativeInput` for any native sink
3. `qa-not-acknowledged` / `qa-not-armed` when mode is `authorized-qa` and execute is requested
4. `window-not-allowlisted`
5. `allowlist-denied`
6. `scenario-disabled` / `module-disabled`
7. `low-confidence` unless scenario policy is `adversarial-execute`
8. `retry-exhausted`
9. `rate-limited`
10. `dry-run` if `scenario.executionMode !== "live"` or global dry-run

`dry-run` is a successful planning path: record intended input, emit none.

### 5.6 Scheduler

```ts
export interface ScenarioScheduler {
  select(world: WorldState, scenario: AutomationScenario): {
    state: AutomationStateId
    reason: string
    interrupt: boolean
  }
}

export interface AutomationScenario {
  id: ScenarioId
  title: string
  enabled: boolean
  executionMode: "dry-run" | "live"
  enabledModules: ModuleId[]
  actionsPerMinute: number
  confidenceThreshold: Confidence
  lowConfidencePolicy: LowConfidencePolicy
  timingProfileId: string
  retryLimits: Partial<Record<ModuleId, number>>
  interruptRules: InterruptRule[]
  marketProviderId: string
  failureInjection?: FailureInjection
}

export interface InterruptRule {
  higher: AutomationStateId
  lower: AutomationStateId
  when: string // documented predicate name, implemented in scheduler
}

export const DEFAULT_INTERRUPT_RULES: InterruptRule[] = [
  { higher: "EmergencyStop", lower: "Follow", when: "always" },
  { higher: "EmergencyStop", lower: "LootPickup", when: "always" },
  { higher: "EmergencyStop", lower: "StashSort", when: "always" },
  { higher: "EmergencyStop", lower: "Listing", when: "always" },
  { higher: "EmergencyStop", lower: "TradeSession", when: "always" },
  { higher: "TradeSession", lower: "Follow", when: "trade-active" },
  { higher: "TradeSession", lower: "LootPickup", when: "trade-active" },
  { higher: "InventoryFull", lower: "LootPickup", when: "inventory-full" },
  { higher: "InventoryFull", lower: "Follow", when: "inventory-full" },
  { higher: "HighValueLoot", lower: "Follow", when: "loot-above-interrupt-threshold" },
  { higher: "StashSort", lower: "Follow", when: "stash-session-active" },
  { higher: "Listing", lower: "Follow", when: "listing-session-active" }
]
```

Selection algorithm (deterministic):

1. If emergency latch → `EmergencyStop`.
2. Else collect eligible states whose predicates are true **and** whose module is enabled.
3. Choose the eligible state with the **lowest** `STATE_PRIORITY` number.
4. If the new state priority is strictly higher than the current state’s priority (lower number), set `interrupt: true`.
5. Tie-break: keep current state if still eligible; otherwise `Idle`.
6. Never use `Math.random` in selection. Timing jitter is applied only inside `GameInputController` after interlock, using `scenario.timingProfileId` and a seeded RNG (`mulberry32`) with seed from `scenario.id + tickId` so replay is deterministic.

### 5.7 Perception and replay ports

```ts
export interface PerceptionFrameInput {
  tickId: number
  capturedAtMs: number
  width: number
  height: number
  pixels?: Uint8Array // optional; fixtures may supply derived observations instead
  pngPath?: string
  derived?: Partial<WorldState>
}

export interface FrameSource {
  nextFrame(): Promise<PerceptionFrameInput | null>
}

export interface PerceptionAdapter {
  analyze(frame: PerceptionFrameInput): Promise<PerceptionFrame>
}

export interface PerceptionFrame {
  tickId: number
  capturedAtMs: number
  evidenceId: string
  target?: Observation<TargetCue | null>
  loot?: Observation<LootTarget[]>
  inventory?: Observation<WorldState["inventory"]["value"]>
  stash?: Observation<WorldState["stash"]["value"]>
  trade?: Observation<TradeWindowView | null>
  listing?: Observation<ListingUiView | null>
  ui?: Observation<UiModeState>
  process?: WorldState["process"]
}

export interface StateEstimator {
  estimate(prev: WorldState, frame: PerceptionFrame): WorldState
}
```

Replay fixtures may populate `derived` and skip raw pixels. Live perception must still produce the same `PerceptionFrame` shape.

### 5.8 Trace

```ts
export interface QaActionTrace {
  id: string
  timestamp: IsoTimestamp
  clockMs: number
  tickId: number
  scenarioId: ScenarioId
  runtimeMode: RuntimeMode
  module: ModuleId
  selectedState: AutomationStateId
  previousState: AutomationStateId
  process?: { name?: string; title?: string }
  evidenceId?: HexSha256
  observedSummary: string
  confidence: Confidence
  decisionReason: string
  intendedActions: InputAction[]
  interlockCode: InterlockCode
  executed: boolean
  dryRun: boolean
  result?: string
  followUpSummary?: string
  recoveryOf?: string
  retryIndex?: number
}
```

Append-only. Persistence maps 1:1 to `qa_action_traces`. Never put account/session tokens in traces. Redact character names if `settings.redactIdentifiers === true` (default true for general logs, false for explicit QA traces unless the operator enables redaction).

### 5.9 Items, market, desirability

```ts
export interface ItemSnapshot {
  rawText: string
  source: "clipboard" | "ocr" | "fixture" | "api"
  capturedAtMs: number
}

export interface NormalizedItem {
  fingerprint: string
  class?: string
  rarity?: string
  name?: string
  base?: string
  itemLevel?: number
  quality?: number
  sockets?: string
  modifiers: Array<{ text: string; value?: number; tier?: number; kind?: string }>
  pseudos: Record<string, number>
  corrupted?: boolean
  unidentified?: boolean
}

export interface QuoteContext {
  league: string
  realm: "poe2"
  maxAgeMs: number
}

export interface MarketQuote {
  providerId: string
  quotedAtMs: number
  currency: string
  low?: number
  fair?: number
  high?: number
  recommendedListing?: number
  candidateCount: number
  comparableCount: number
  confidence: ConfidenceBucket
  lowConfidenceReason?: string
  comparables: MarketComparable[]
}

export interface MarketComparable {
  id: string
  price: number
  currency: string
  listedAtMs?: number
  outlier: boolean
}

export interface MarketProvider {
  readonly id: string
  supports(item: NormalizedItem): boolean
  quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote>
  health(): Promise<{ ok: boolean; detail?: string }>
}

export type DesirabilityCategory =
  | "KeepUse"
  | "HighValueSell"
  | "Sell"
  | "BulkCommodity"
  | "CraftCandidate"
  | "VendorLowValue"
  | "Dump"
  | "ManualReview"

export interface DesirabilityResult {
  score: number // 0..100 integer
  category: DesirabilityCategory
  factors: Array<{ id: string; weight: number; contribution: number; detail: string }>
  reasons: string[]
}

export interface DesirabilityPort {
  score(item: NormalizedItem | LootTarget, ctx: { scenario: AutomationScenario; quote?: MarketQuote }): DesirabilityResult
}
```

Every valuation shown to a user must include provider, timestamp, candidate/comparable counts, low/fair/high, recommended listing, confidence, and must **never** be labeled a guaranteed sale price.

### 5.10 Controllers

```ts
export interface Controller {
  readonly module: ModuleId
  decide(world: WorldState, scenario: AutomationScenario): BotDecision
}

export class FollowController implements Controller { readonly module = "follow"; decide!: Controller["decide"] }
export class LootController implements Controller { readonly module = "loot"; decide!: Controller["decide"] }
export class InventoryController implements Controller { readonly module = "inventory"; decide!: Controller["decide"] }
export class StashController implements Controller { readonly module = "stash"; decide!: Controller["decide"] }
export class ListingController implements Controller { readonly module = "listing"; decide!: Controller["decide"] }
export class TradeController implements Controller { readonly module = "trade"; decide!: Controller["decide"] }
export class RecoveryController implements Controller { readonly module = "recovery"; decide!: Controller["decide"] }
```

Controllers return decisions only. They do not import sinks, Electron, or native input.

### 5.11 Recovery

```ts
export interface RecoveryPolicy {
  maxAttempts: number
  backoffMs: number[]
  suppressMs: number
  terminalState: "FailedOrTimedOut" | "Idle" | "SafetyHold"
}

export const DEFAULT_RECOVERY: Record<string, RecoveryPolicy> = {
  "follow.lost-target": { maxAttempts: 5, backoffMs: [250, 500, 1000, 2000, 4000], suppressMs: 0, terminalState: "Idle" },
  "follow.stuck": { maxAttempts: 3, backoffMs: [400, 800, 1600], suppressMs: 5000, terminalState: "SafetyHold" },
  "loot.unreachable": { maxAttempts: 2, backoffMs: [300, 800], suppressMs: 15000, terminalState: "Idle" },
  "stash.failed-move": { maxAttempts: 3, backoffMs: [200, 400, 800], suppressMs: 0, terminalState: "FailedOrTimedOut" },
  "stash.wrong-tab": { maxAttempts: 3, backoffMs: [200, 400, 800], suppressMs: 0, terminalState: "FailedOrTimedOut" },
  "trade.timeout": { maxAttempts: 1, backoffMs: [0], suppressMs: 0, terminalState: "FailedOrTimedOut" }
}
```

No unbounded click/move/retry loop. Every retry increments `retryIndex` and sets `recoveryOf` on the trace.

### 5.12 SQLite schema (Phase 01 stub + Phase 04/08/09 fill)

`migrations/001_init.sql` creates empty-but-real tables:

```sql
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE catalog_items (
  fingerprint TEXT PRIMARY KEY,
  normalized_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

CREATE TABLE item_observations (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  location TEXT NOT NULL,
  raw_text TEXT,
  observed_at_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE inventory_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE stash_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  tab_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE valuations (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE market_comparables_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE sort_rules (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  rule_json TEXT NOT NULL
);

CREATE TABLE listing_history (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  price REAL,
  currency TEXT,
  created_at_ms INTEGER NOT NULL,
  result TEXT
);

CREATE TABLE trade_sessions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE automation_scenarios (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE qa_action_traces (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  clock_ms INTEGER NOT NULL,
  tick_id INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE perception_artifacts (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  path TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE filter_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
```

Use `packages/persistence-sqlite` with `better-sqlite3`. Migrations runner applies numeric files in order and inserts into `schema_migrations`.

---

## 6. Scenario catalog (create as JSON fixtures in Phase 04)

| id | Modules | executionMode default |
| --- | --- | --- |
| `follow-only` | follow, recovery | dry-run |
| `loot-only` | loot, recovery | dry-run |
| `stash-sort` | inventory, stash | dry-run |
| `list-and-reprice` | listing | dry-run |
| `trade-session` | trade | dry-run |
| `full-loop` | all | dry-run |
| `adversarial-low-confidence` | follow, loot | dry-run |
| `rate-limit-injection` | listing, trade | dry-run |

Live execution requires an explicit scenario field `executionMode: "live"` **and** operator arming. Defaults stay dry-run.

---

## 7. Phases

Each phase is a vertical slice that must be buildable/testable. Grok commits each completed phase separately.

---

### Phase 01 — Baseline and repository audit

**Purpose.** Turn the docs-only repo into a typed, tested workspace with CI, license, and Grok tracking files. Record the empty-repo failures as the starting baseline.

**Current state.** No toolchain. `npm test` / lint / tsc fail as documented in §2.3.

**Add.**

- Root `package.json` workspaces: `apps/*`, `packages/*`
- Scripts: `lint`, `typecheck`, `test`, `test:unit`, `test:integration`, `test:replay`, `build`
- `.nvmrc` (`22`)
- `tsconfig.base.json`, `vitest.workspace.ts`, `eslint.config.js`, `.prettierrc`
- `LICENSE` (MIT)
- `apps/desktop`, `apps/overlay` hello-world (window title `PoE2 QA Trade Companion`)
- `packages/core` with `src/index.ts` exporting a `workspaceOk(): true` constant
- `packages/testkit` empty index
- `.github/workflows/ci.yml` — Node 22, `npm ci`, lint, typecheck, unit tests
- `grok/IMPLEMENTATION_STATE.md`, `grok/BASELINE_ASSESSMENT.md`, `grok/REVIEW_STATE.md`, `grok/TEST_GAPS.md`, `grok/REPLAY_BACKLOG.md`, `grok/RESEARCH_NOTES.md`, `grok/EXILEDBOT_BEHAVIORAL_REFERENCES.md`
- `migrations/001_init.sql` (tables from §5.12)
- `NOTICE` stub (“Third-party notices will be added when code is vendored.”)

**Change.** `.gitignore` — add `/artifacts`, `*.db`, `playwright-report`. Do not ignore `grok/*.md`.

**Remove.** Nothing.

**Types/contracts.** None beyond `workspaceOk`. Do not stub fake controllers here.

**Dependencies to verify / pin.**

- `node` 22 LTS
- `typescript` 5.9.x
- `vitest` 3.x
- `eslint` 9 + `typescript-eslint`
- `prettier` 3.x
- `electron` 40.x (desktop)
- `vue` 3.5.x + `vite` (overlay)
- `better-sqlite3` (persistence package may be added empty; actual open in Phase 04 is acceptable if Phase 01 only adds the migration file)

**Data flow.** N/A.

**State transitions.** N/A.

**Failure/recovery.** CI must fail if lint/typecheck/unit fail. Do not add passing empty tests that hide missing behavior.

**Unit tests.** `tests/unit/workspace-ok.test.ts` asserts `workspaceOk() === true`.

**Integration tests.** `tests/integration/migrations-exist.test.ts` asserts `migrations/001_init.sql` contains `qa_action_traces`.

**Replay tests.** None yet. Add `tests/replay/.gitkeep` and document in `grok/REPLAY_BACKLOG.md`.

**Live QA checks.** None.

**Commands.**

```bash
node -v   # 22.x
npm install
npm run lint
npm run typecheck
npm test
```

**Completion gate.**

- `package.json` exists and the four commands above pass on CI-equivalent
- Electron main can start in dev (headless smoke optional; `apps/desktop` compiles)
- `grok/IMPLEMENTATION_STATE.md` records base commit, this phase, and the pre-phase ENOENT failures
- No production automation stubs pretending to be complete

**Suggested commit.** `chore: bootstrap workspace, CI, and baseline tracking`

**Depends on.** None.

---

### Phase 02 — Canonical world state + deterministic scheduler

**Purpose.** Create the only game-state snapshot and the only state-selection function.

**Current state.** Types exist only in this plan.

**Add.**

- `packages/core/src/world-state/types.ts`
- `packages/core/src/world-state/createEmptyWorldState.ts`
- `packages/core/src/world-state/freshness.ts` — `fresh < 250ms`, `aging < 1000ms`, `stale >= 1000ms`, `missing` if never observed
- `packages/core/src/scheduler/priorities.ts`
- `packages/core/src/scheduler/predicates.ts`
- `packages/core/src/scheduler/scenarioScheduler.ts`
- `packages/core/src/clock.ts`
- `tests/unit/scheduler/*.test.ts`
- `tests/replay/scheduler-priority/*.` fixtures (JSON world snapshots, no pixels)

**Change.** `packages/core/src/index.ts` exports the contracts.

**Remove.** Nothing.

**Types/contracts.** §5.3 and §5.6 exactly.

**Dependencies.** None new.

**Data flow.** `WorldState` + `AutomationScenario` → `ScenarioScheduler.select` → `{ state, reason, interrupt }`.

**State transitions / priorities.** `STATE_PRIORITY` in §5.3. Predicates:

| State | Eligible when |
| --- | --- |
| `EmergencyStop` | `arming.emergencyStopLatched` (scheduler receives latch via world or a `RuntimeFlags` arg — add `world.flags.emergencyStopLatched: boolean`) |
| `SafetyHold` | process not allowlisted OR confidence policy skip with no alternative |
| `TradeSession` | module enabled AND trade observation `open` or fixture `tradeRequested` |
| `InventoryFull` | `inventory.full === true` AND stash module enabled |
| `HighValueLoot` | any loot `score >= scenario.highValueInterruptScore` (default 85) |
| `Listing` | listing session active flag on world/scenario |
| `StashSort` | stash session active flag |
| `LootPickup` | loot module enabled AND any loot without skipReason |
| `Follow` | follow module enabled AND target confidence ≥ threshold |
| `RecoverTarget` | follow enabled AND target missing/low confidence |
| `Idle` | always fallback |

Add to `WorldState`:

```ts
flags: {
  emergencyStopLatched: boolean
  tradeRequested: boolean
  stashSessionActive: boolean
  listingSessionActive: boolean
  highValueInterruptScore: number
}
```

**Failure/recovery.** Scheduler never throws on missing observations; it uses `freshness: "missing"` and falls through. No hidden randomness.

**Unit tests.**

- Priority order table: given flags, exact `selectedState`
- Interrupt true when moving to a higher-priority state
- Tie-break keeps current if still eligible
- Identical inputs → identical outputs (frozen clock)
- Disabled module cannot be selected
- Emergency stop beats trade
- Inventory full beats loot and follow
- High-value loot beats follow, not trade

**Integration tests.** Load 8 JSON world snapshots from `fixtures/replay/scheduler-priority/` and assert selected states.

**Replay tests.** Same fixtures; treat as the first deterministic replay suite (no `FrameSource` yet — snapshot-in, state-out).

**Live QA checks.** None.

**Commands.** `npm run lint && npm run typecheck && npm test`

**Completion gate.** All scheduler tests pass; no controller or input code required.

**Suggested commit.** `feat: add WorldState model and deterministic scenario scheduler`

**Depends on.** Phase 01.

---

### Phase 03 — Capability / interlock / input boundary

**Purpose.** Make public mode structurally unable to emit native input. Put every game-affecting action through one auditable controller.

**Current state.** No capabilities, no interlocks, no input package.

**Add.**

- `packages/core/src/capabilities/createCapabilities.ts`
- `packages/core/src/interlock/interlockGate.ts`
- `packages/core/src/interlock/rateLimiter.ts` — token bucket, `actionsPerMinute`
- `packages/core/src/input/types.ts`
- `packages/core/src/input/gameInputController.ts`
- `packages/core/src/input/sinks/noopInputSink.ts`
- `packages/core/src/input/sinks/forbiddenInputSink.ts`
- `packages/core/src/input/sinks/recordingInputSink.ts`
- `packages/core/src/input/emergencyStop.ts` — latch: `trip()`, `isLatched()`, `reset()` only via `rearm({ explicit: true })`
- `packages/native-input/src/nativeInputSink.ts` — `koffi` SendInput **implementation**, not wired in public build
- `packages/native-input/package.json` with `"private": true` and export `./nativeInputSink`
- `scripts/check-native-input-imports.mjs` — fail CI if any file outside `packages/native-input/**` imports `koffi`, `uiohook-napi`, `@nut-tree`, `robotjs`, `nut-js`
- `apps/desktop/electron-main.ts` registers `globalShortcut` for emergency stop (default `Ctrl+Shift+F12`) and calls `emergencyStop.trip()`
- `tests/unit/interlock/*.test.ts`
- `tests/unit/input/*.test.ts`

**Change.** Desktop package depends on `native-input` only when `POE2TC_RUNTIME_MODE=authorized-qa`. Public start path must not `require` the native sink.

**Remove.** Nothing.

**Types/contracts.** §5.2, §5.4, §5.5.

**Dependencies to verify.** `koffi` latest 2.x compatible with Node 22 / Electron 40. If koffi cannot load in Electron, keep `NativeInputSink` throwing `native-unavailable` and still pass all non-native tests. Do not call that phase complete for *live* input, but unit/replay gates can pass with the throw path tested.

**Data flow.** `BotDecision` → `InterlockGate.evaluate` → if `allowExecute` then `InputSink.execute` else record-only.

**State transitions.** `emergencyStop.trip()` forces next scheduler tick to `EmergencyStop`, clears queue, rejects new enqueue.

**Failure/recovery.**

- Queue clear is synchronous
- Rearm requires explicit call; a new scenario start does not implicitly rearm
- Rate limiter returns `rate-limited` and records a trace, no busy-loop

**Unit tests.**

- `public-companion` + any decision → `ForbiddenInputSink` / `public-mode`, `executed: false`
- QA not acknowledged / not armed → no execute
- Kill switch blocks new input and clears queue
- Dry-run records, `executed: false`
- Wrong process allowlist blocks
- Module flag off blocks
- Rate limit blocks the N+1 action
- Native import script passes
- `GameInputController` serializes actions (no parallel SendInput)

**Integration tests.** Fake controller produces a click decision; public mode records and does not call a spy native function.

**Replay tests.** N/A beyond recording sink capturing intended actions in memory.

**Live QA checks (manual, Windows).** Only after native sink loads: arm QA, dry-run, press emergency hotkey, confirm latch. Do not require this to close the phase if the agent host is not Windows; document `BLOCKED: windows-native` and keep tests green.

**Commands.**

```bash
npm run lint && npm run typecheck && npm test
node scripts/check-native-input-imports.mjs
```

**Completion gate.** Mandatory invariant tests in `GROK_46_XHIGH_FAST_BUILD_PROMPT.md` that apply to input/capabilities are implemented and passing. Native SendInput may remain Windows-only.

**Suggested commit.** `feat: add capabilities, interlocks, and auditable GameInputController`

**Depends on.** Phase 01. Uses `WorldState` from Phase 02 for interlock context.

---

### Phase 04 — Deterministic replay + trace model

**Purpose.** Run the same decision loop against fixtures with zero native input and persist traces.

**Current state.** Scheduler + interlock exist; no loop runner, no trace writer.

**Add.**

- `packages/core/src/replay/fixtureFrameSource.ts`
- `packages/core/src/replay/replayRunner.ts`
- `packages/core/src/trace/qaTraceWriter.ts`
- `packages/core/src/trace/inMemoryTraceSink.ts`
- `packages/core/src/loop/automationLoop.ts` — one tick: frame → (identity estimator stub) → schedule → controller map (stub `IdleController` + `FollowController` placeholder that returns `noop` if selected) → interlock → input → trace
- `packages/persistence-sqlite` migration runner + `SqliteTraceStore`
- `fixtures/replay/follow-acquired/manifest.json`
- `tests/replay/follow-acquired.test.ts`
- `tests/unit/trace/redaction.test.ts`

**Change.** Wire `FrozenClock` through the loop.

**Remove.** Nothing.

**Types/contracts.** §5.7, §5.8. `ReplayManifest`:

```ts
export interface ReplayManifest {
  id: string
  scenarioId: ScenarioId
  seed: number
  frames: Array<{
    tickId: number
    atMs: number
    pngPath?: string
    derived: Partial<WorldState>
  }>
  expect: Array<{
    tickId: number
    selectedState: AutomationStateId
    decisionReasonIncludes?: string
    executed: false
    sinkKind: "noop" | "forbidden"
  }>
}
```

**Dependencies.** `better-sqlite3` (verify Electron ABI later in Phase 15; unit tests run in Node).

**Data flow.** Manifest frames → `FixtureFrameSource` → `AutomationLoop.tick` → traces + expected assertions.

**State transitions.** Replay must never select a native sink. `replayRunner` constructs `NoopInputSink` only.

**Failure/recovery.** Missing frame ends the run with `result: "end-of-stream"`. Corrupt manifest fails the test, not hang.

**Unit tests.** Trace redaction; writer append-only; clock timestamps match `FrozenClock`.

**Integration tests.** SQLite store round-trip of one `QaActionTrace`.

**Replay tests.** `follow-acquired`: derived target present → `Follow`; intended `mouse-click` or `key-tap` **recorded**; `executed === false`; sink kind `noop`.

**Live QA checks.** None.

**Commands.** `npm run test:replay && npm test`

**Completion gate.** Replay suite runs the real `ScenarioScheduler` + `GameInputController`. A comment-only or forked “replay scheduler” is a phase failure.

**Suggested commit.** `feat: add replay runner, QA traces, and fixture frame source`

**Depends on.** Phases 01–03.

---

### Phase 05 — Perception / state estimation foundation

**Purpose.** Convert frames (live or fixture) into typed observations and a reconciled `WorldState`.

**Current state.** Replay uses `derived` blobs. No estimator, no live capture adapter.

**Add.**

- `packages/core/src/perception/stateEstimator.ts`
- `packages/core/src/perception/confidence.ts`
- `packages/core/src/perception/uiMode.ts`
- `packages/perception-live/src/win32Process.ts` — koffi window/process query
- `packages/perception-live/src/electronFrameSource.ts` — `desktopCapturer` adapter implementing `FrameSource`
- `packages/perception-live/src/clipboardSource.ts` — read-only clipboard text
- `packages/core/src/perception/templateMatch.ts` — pure function: score a patch (fixtures use PNG + expected box)
- `fixtures/perception/{inventory,stash,loot-label,target-cue,ui-mode}/*`
- `tests/unit/perception/*.test.ts`
- `tests/replay/perception-estimate.test.ts`

**Change.** `AutomationLoop` uses `StateEstimator` instead of copying `derived` straight into `WorldState`. `derived` is an input to a `FixturePerceptionAdapter` that still goes through the estimator.

**Remove.** Direct `world = derived as WorldState` in the loop.

**Types/contracts.** §5.7. Estimator merge rules:

- Newer observation with `confidence >= prev` replaces field
- Lower-confidence newer observation updates only if `prev.freshness === "stale" | "missing"`
- `freshness` recomputed from `clock.nowMs() - observedAtMs`
- Process allowlist computed here from arming config

**Dependencies.** `koffi` (live), `sharp` (PNG load in tests). OCR (`tesseract.js`) may be added as `OcrPort` with a fixture implementation; live OCR can wait until Phase 07 if unit tests cover the port.

**Data flow.** `FrameSource` → `PerceptionAdapter.analyze` → `PerceptionFrame` → `StateEstimator.estimate` → `WorldState`.

**State transitions.** Estimator does not choose automation state. Scheduler still does.

**Failure/recovery.** Analyze errors become `ui.kind = "unknown"` with `confidence: 0` and `SafetyHold` eligibility. No throw through the loop.

**Unit tests.** Freshness buckets; merge rules; template-match score monotonicity on fixture patches; allowlist true/false.

**Integration tests.** PNG fixture → adapter → estimator → expected occupancy/target/loot counts (synthetic colored fixtures are acceptable if labeled).

**Replay tests.** Sequence of two frames: target present then absent → world target freshness goes `fresh` → `missing` after the configured stale window (advance `FrozenClock`).

**Live QA checks (Windows).** Confirm PoE 2 window title/process detection against the real client; update allowlist constants if names differ. Record actual names in `grok/RESEARCH_NOTES.md`.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Estimator is the only writer of `WorldState` field observations. Live capture adapter exists even if the CI host cannot open PoE.

**Suggested commit.** `feat: add perception adapters and WorldState estimator`

**Depends on.** Phases 02–04.

---

### Phase 06 — Navigation / follow / recovery

**Purpose.** Follow a configured target using perceived cues; bound loss/stuck recovery.

**Current state.** Scheduler can select `Follow` / `RecoverTarget`. No real `FollowController`.

**Add.**

- `packages/core/src/controllers/followController.ts`
- `packages/core/src/controllers/recoveryController.ts`
- `packages/core/src/navigation/direction.ts` — screen-center to target vector → `{ dx, dy, action: InputAction[] }`
- `packages/core/src/navigation/stuckDetector.ts` — no progress for `N` ticks
- `fixtures/replay/follow-lost-reacquire/`
- `fixtures/replay/follow-stuck-recovery/`
- `fixtures/replay/follow-emergency-stop/`
- `tests/unit/navigation/*.test.ts`
- `tests/replay/follow-*.test.ts`

**Change.** `AutomationLoop` controller map uses real `FollowController` / `RecoveryController`.

**Remove.** Follow placeholder noops.

**Types/contracts.**

```ts
export interface FollowConfig {
  maxFollowDistancePx: number // default 140
  clickMove: boolean          // default true
  lostTargetTicks: number     // default 8
  stuckTicks: number          // default 12
}
```

Movement v1: click toward target point if distance > `maxFollowDistancePx`; `noop` if inside band. Do not plan WASD injection unless live QA shows click-to-move is insufficient; if swapped, keep it as `InputAction` key-taps through the same controller.

**Dependencies.** None new.

**Data flow.** `world.target` → follow decide → interlock → recorded/live click.

**State transitions.**

- Target fresh → `Follow`
- Target missing → `RecoverTarget` (strafe/scan clicks bounded)
- Stuck → recovery policy `follow.stuck`
- After `maxAttempts` → `SafetyHold` + reason `stuck-exhausted`
- Emergency stop from any follow tick

**Failure/recovery.** Unreachable / no-progress targets get suppression via `DEFAULT_RECOVERY["follow.stuck"]`. No infinite move.

**Unit tests.** Vector/click math; inside-band noop; stuck detector; lost-target tick count.

**Integration tests.** Loop with fixture frames: acquire → move → lost → recover → idle/safety.

**Replay tests.** The three fixture packs above; assert traces contain reasons `follow-target`, `lost-target`, `stuck-recovery`, `emergency-stop`.

**Live QA checks.** Authorized environment only: dry-run follow overlay points; kill switch mid-follow; then one live click-move if explicitly armed. Skip on non-Windows CI.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Replay follow scenarios pass using the same `FollowController` as live.

**Suggested commit.** `feat: add follow navigation controller and bounded recovery`

**Depends on.** Phases 02–05.

---

### Phase 07 — Loot detection / ranking / pickup

**Purpose.** Detect visible loot labels, rank them through `DesirabilityPort`, pick or skip with reasons, handle inventory-full.

**Current state.** `LootPickup` / `HighValueLoot` predicates exist; no loot controller or detector.

**Add.**

- `packages/core/src/perception/lootLabelDetector.ts` (fixture + color/OCR port)
- `packages/core/src/controllers/lootController.ts`
- `packages/core/src/items/fixtureDesirabilityScorer.ts` — map label keywords / fixture scores
- `packages/core/src/items/desirabilityPort.ts`
- `fixtures/replay/loot-desirable-vs-junk/`
- `fixtures/replay/loot-inventory-full/`
- `fixtures/replay/loot-unreachable-backoff/`
- `tests/unit/loot/*.test.ts`

**Change.** Scheduler `HighValueLoot` uses scores from the port (already on `LootTarget.score`).

**Remove.** Nothing.

**Types/contracts.** `LootTarget`, `DesirabilityPort` in §5.3 / §5.9.

Ranking: sort by `score` desc, then nearest `screenPoint` to player/center, then `id` asc. Skip if `score < scenario.lootMinScore` (default 40) unless scenario is adversarial.

**Dependencies.** `tesseract.js` optional; fixture labels can be `derived.loot`.

**Data flow.** Perception loot list → score via port → rank → click top eligible → next frame confirms cell occupancy increase or label disappearance.

**State transitions.**

- Eligible loot → `LootPickup` or `HighValueLoot`
- Inventory full → interrupt to `InventoryFull` (stash session flag set by inventory controller stub: set `flags.stashSessionActive = true` when full; Phase 09 implements real inventory)
- Failed pickup twice → suppress id 15s

**Failure/recovery.** `DEFAULT_RECOVERY["loot.unreachable"]`. Pickup success must be **observed**, not assumed.

**Unit tests.** Deterministic rank; skip reasons; suppression; inventory-full does not issue pickup clicks.

**Integration tests.** Perception → score → decision → noop sink.

**Replay tests.** Three packs above.

**Live QA checks.** Dry-run loot highlights; one armed pickup in authorized context.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Pick/skip reasons appear on traces. Phase 08 is not required for this gate because `FixtureDesirabilityScorer` is a real, tested implementation of the port, not an empty stub.

**Suggested commit.** `feat: add loot detection, ranking, and pickup controller`

**Depends on.** Phases 02–06.

---

### Phase 08 — Item parsing / market valuation / desirability

**Purpose.** Parse PoE 2 clipboard item text, value through `MarketProvider`, replace fixture scoring with explainable desirability.

**Current state.** `DesirabilityPort` has a keyword fixture scorer only. No parser, no live/official market.

**Add.**

- `packages/core/src/vendor/exiled-exchange-2/` — MIT parser files + `LICENSE` copy + `SOURCE.txt` (commit SHA, date)
- `NOTICE` updated
- `packages/core/src/items/parseItem.ts` — `ItemSnapshot` → `NormalizedItem` via adapter over vendored parser
- `packages/core/src/items/fingerprint.ts`
- `packages/core/src/market/fixtureMarketProvider.ts`
- `packages/core/src/market/officialCurrencyExchangeProvider.ts` — documented hourly API only
- `packages/core/src/market/rateLimitFetch.ts` — parse GGG rate-limit headers; backoff; no retry storm
- `packages/core/src/market/valuation.ts` — outlier filter (Tukey 1.5 IQR or drop >3σ; lock one and test it)
- `packages/core/src/items/desirabilityEngine.ts` — real port implementation
- `fixtures/items/*.txt` — sanitized clipboard dumps (no account names)
- `fixtures/market/*.json`
- `tests/unit/items/*.test.ts`
- `tests/unit/market/*.test.ts`

**Change.** `LootController` and later stash/listing use `DesirabilityEngine` when a `NormalizedItem` is available; otherwise fall back to fixture scorer.

**Remove.** Do not delete `FixtureDesirabilityScorer`; keep for adversarial/label-only loot.

**Types/contracts.** §5.9. Valuation output must include every field in the product-spec valuation acceptance list.

**Dependencies to verify immediately before coding.**

1. EE2 still MIT at the copied revision.
2. Parser file list still matches §3.4.
3. Currency Exchange `realm=poe2` still documented.
4. Still no documented item trade-search API — do not add one.

**Data flow.** Clipboard/OCR/fixture text → parse → normalize → `MarketProvider.quote` (cache in SQLite) → valuation → desirability → controllers.

**State transitions.** None new. Low-confidence quotes do not block parse; they mark `ManualReview` / skip per policy.

**Failure/recovery.**

- HTTP 429 → honor `Retry-After`, return last cache if `maxAgeMs` allows, else fail quote with `confidence: "none"`
- 5xx / timeout / offline → cache or fail closed
- Malformed item text → parse error, category `ManualReview`
- Never throw through the automation loop

**Unit tests.**

- Representative unique/rare/currency/waystone/gem fixtures parse
- Fingerprint stability
- Outlier drop
- Desirability determinism (same inputs → same score/reasons)
- Fixture provider + 429/5xx/offline behaviors
- Currency exchange parser against a saved hourly digest fixture (do not hit network in unit tests)

**Integration tests.** Item → quote → valuation → desirability → loot decision change vs fixture-only score.

**Replay tests.** `fixtures/replay/loot-market-aware/` where derived loot includes clipboard text for one item.

**Live QA checks.** Manual clipboard parse against a real item in authorized/public companion; no live trade-site calls.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Corpus parses; valuations expose confidence + sample size; no undocumented trade client; MIT notices present.

**Suggested commit.** `feat: add PoE2 item parse, valuation, and desirability engine`

**Depends on.** Phases 01, 04, 07 (port). Can proceed without Phase 06 if needed, but keep order.

---

### Phase 09 — Inventory / stash observation and reconciliation

**Purpose.** Observe inventory/stash grids, persist shadow state, mark stale/mismatch explicitly.

**Current state.** `WorldState.inventory/stash` exist; estimator may have synthetic occupancy only.

**Add.**

- `packages/core/src/perception/gridDetector.ts`
- `packages/core/src/inventory/shadowState.ts`
- `packages/core/src/inventory/reconcile.ts`
- `packages/core/src/controllers/inventoryController.ts` — sets `stashSessionActive` when full; no transfers yet
- `packages/persistence-sqlite` inventory/stash snapshot writes
- `fixtures/perception/inventory-grid/`
- `fixtures/perception/stash-tab/`
- `tests/unit/inventory/*.test.ts`
- `tests/replay/inventory-stale.test.ts`

**Change.** Estimator fills grid cells from detector. App restart loads last snapshots with `freshness: "stale"`.

**Remove.** Nothing.

**Types/contracts.**

```ts
export interface ShadowItem {
  fingerprint: string
  location: { kind: "inventory" | "stash"; tabId?: string; x: number; y: number }
  lastConfirmedMs: number
  stale: boolean
  mismatch: boolean
}

export interface ReconcileResult {
  confirmed: ShadowItem[]
  missing: ShadowItem[]
  unexpected: ShadowItem[]
  stale: ShadowItem[]
}
```

Success of a future transfer is `confirmed` after reconcile, never because an input was sent.

**Dependencies.** None new. Still **no** PoE 2 stash API.

**Data flow.** Frame → grid/OCR/clipboard hover → cells → shadow reconcile → SQLite.

**State transitions.** `inventory.full` → `InventoryFull` → stash session flag.

**Failure/recovery.** Mismatch sets `mismatch: true` and trace reason `shadow-mismatch`; does not invent items.

**Unit tests.** Reconcile cases: match, missing, unexpected, stale, full.

**Integration tests.** Snapshot persist + reload after new DB connection.

**Replay tests.** Occupancy 12/12 → `InventoryFull`; after a fixture “drop” cell → no longer full.

**Live QA checks.** Open inventory/stash in Windowed mode; confirm debug overlay cell count (Phase 14 overlay may be a minimal Electron DevTools dump until then).

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Observed state survives restart; mismatches are explicit.

**Suggested commit.** `feat: observe inventory/stash grids and reconcile shadow state`

**Depends on.** Phases 05, 07, 08 (fingerprints).

---

### Phase 10 — Automated stash sorting

**Purpose.** Plan and execute bounded transfers into configured tabs with observed confirmation.

**Current state.** Shadow state exists; no stash controller transfers.

**Add.**

- `packages/core/src/stash/sortRules.ts`
- `packages/core/src/stash/transferPlanner.ts`
- `packages/core/src/controllers/stashController.ts`
- `fixtures/replay/stash-sort-success/`
- `fixtures/replay/stash-full-fallback/`
- `fixtures/replay/stash-failed-move-retry/`
- `fixtures/replay/stash-wrong-tab/`
- `tests/unit/stash/*.test.ts`

**Change.** `InventoryFull` / `StashSort` use the real controller.

**Remove.** Nothing.

**Types/contracts.**

```ts
export type SortBucket =
  | "Currency" | "Waystones" | "Uniques" | "HighValueSell"
  | "NormalSell" | "Crafting" | "Bulk" | "Dump" | "Vendor"

export interface SortRule {
  id: string
  bucket: SortBucket
  tabId: string
  fallbackTabId?: string
  match: { category?: DesirabilityCategory[]; class?: string[]; rarity?: string[] }
}

export interface TransferPlanStep {
  fingerprint: string
  from: ShadowItem["location"]
  to: ShadowItem["location"]
  reason: string
}
```

Default destinations as in the product spec. Planner is pure.

**Dependencies.** None.

**Data flow.** Shadow inventory → rules → plan → tab click + drag/ctrl-click as `InputAction`s → observe → reconcile → retry or fallback.

**State transitions.** Active plan → `StashSort`. Empty plan → clear `stashSessionActive`. Tab full → fallback tab. Fallback full → `FailedOrTimedOut` / `SafetyHold`.

**Failure/recovery.** `stash.failed-move`, `stash.wrong-tab` policies. Max 3 retries. Never assume success.

**Unit tests.** Rule matching; planner order (high value first); fallback; empty plan.

**Integration tests.** Loop: planned drag → fixture next frame shows new cell → shadow confirmed.

**Replay tests.** Four packs above + emergency stop mid-sort.

**Live QA checks.** Dry-run plan printed to trace; one live transfer only when scenario `executionMode: "live"`.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Fixture inventory sorts to expected tabs; traces explain every move.

**Suggested commit.** `feat: add stash sort planner and confirmed transfer controller`

**Depends on.** Phases 03, 09, 08.

---

### Phase 11 — Listing / repricing QA state machine

**Purpose.** Price eligible items and drive listing UI through visible client controls in QA mode.

**Current state.** `Listing` state exists; no controller.

**Add.**

- `packages/core/src/listing/pricePolicy.ts`
- `packages/core/src/listing/listingStateMachine.ts`
- `packages/core/src/controllers/listingController.ts`
- `fixtures/replay/listing-apply-price/`
- `fixtures/replay/listing-reprice-stale/`
- `fixtures/replay/listing-low-confidence-skip/`
- `tests/unit/listing/*.test.ts`

**Change.** Persist `listing_history`.

**Remove.** Nothing.

**Types/contracts.**

```ts
export type ListingState =
  | "Idle"
  | "SelectItem"
  | "OpenListingUi"
  | "ReadCurrentPrice"
  | "ApplyPrice"
  | "VerifyPrice"
  | "StaleReprice"
  | "FailedOrTimedOut"
  | "Done"

export interface PricePolicy {
  undercutPct: number      // default 0.03
  markupPct: number        // default 0
  minPrice?: number
  minConfidence: ConfidenceBucket // default "medium"
  staleAfterMs: number     // default 6h
}
```

Recommended listing = `fair * (1 - undercutPct)` unless below `low`, then `low`. Never claim guaranteed sale.

**Dependencies.** Phase 08 market. No listing API — UI only.

**Data flow.** Catalog item + quote → policy → UI actions → verify `listing.priceText`.

**State transitions.** Table-driven. Emergency stop legal in every state. Low confidence → skip + reason.

**Failure/recovery.** Verify mismatch → retry once → `FailedOrTimedOut`. 429 from market → use cache or skip.

**Unit tests.** Policy math; skip on low confidence; stale detection.

**Integration tests.** State machine + fixture listing UI.

**Replay tests.** Three packs + emergency stop during `ApplyPrice`.

**Live QA checks.** Dry-run first; live only in authorized hideout/test realm.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Expected listing values applied in replay; dry-run emits zero native input.

**Suggested commit.** `feat: add listing and repricing QA state machine`

**Depends on.** Phases 03, 08, 09.

---

### Phase 12 — Trade-session QA state machine

**Purpose.** Configurable trade QA including invite/party/window/item/currency/accept/cleanup.

**Current state.** `TradeSession` priority exists; no machine.

**Add.**

- `packages/core/src/trade/tradeStateMachine.ts`
- `packages/core/src/controllers/tradeController.ts`
- `packages/core/src/trade/tradeEventPort.ts` — fixture events; live adapter only from **supported** sources (client log whisper lines the user opted to share, or a future GGG test interface). No packet sniffing.
- Replay packs for: success, wrong currency, insufficient currency, wrong item, missing item, partial stack, timeout, cancelled, disconnect, UI desync, emergency stop in each major state
- `tests/unit/trade/*.test.ts`

**Change.** `trade_sessions` table updates on each transition.

**Remove.** Nothing.

**Types/contracts.**

```ts
export type TradeState =
  | "Idle"
  | "TradeRequestReceived"
  | "ValidateRequestedItem"
  | "InviteOrJoinParty"
  | "PrepareItem"
  | "NavigateToTradeContext"
  | "OpenTrade"
  | "PlaceItem"
  | "ObserveCounterOffer"
  | "ValidateCurrencyOrItems"
  | "AcceptOrReject"
  | "ConfirmCompletion"
  | "CleanupPartySession"
  | "FailedOrTimedOut"
```

Every transition records `reason`. Accept only if observed offer matches expected currency + amount within scenario tolerance. Default: reject on any mismatch.

**Dependencies.** None new. Do not use undocumented trade-site APIs for this machine.

**Data flow.** `TradeEvent` + `world.trade` → machine → decisions → interlock → input → observe.

**State transitions.** Strict allowed-edges map in `tradeStateMachine.ts`. Illegal edges throw in tests and become `FailedOrTimedOut` in prod.

**Failure/recovery.** Timeouts from scenario (default 20s per wait state). Emergency stop from all states. Disconnect fixture → cleanup → failed.

**Unit tests.** Allowed edges; each adversarial case; reject path.

**Integration tests.** Event + perception sequence → accept or reject.

**Replay tests.** Full pack listed above. All `executed: false` under replay sink.

**Live QA checks.** Authorized paired test accounts only; dry-run entire machine first.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** Deterministic replay covers success and every listed failure class.

**Suggested commit.** `feat: add trade-session QA state machine and replay corpus`

**Depends on.** Phases 03, 06 (navigate-to-context), 09, 11 optional.

---

### Phase 13 — Full orchestration / interruption / recovery

**Purpose.** One orchestrator runs the full loop with documented interrupts and action budgets.

**Current state.** Scheduler already picks one state per tick. Controllers exist independently.

**Add.**

- `packages/core/src/loop/scenarioOrchestrator.ts` — owns session flags, action budget, controller dispatch
- `packages/core/src/loop/actionBudget.ts`
- `fixtures/replay/full-loop/`
- `fixtures/replay/full-loop-interrupt-trade/`
- `fixtures/replay/full-loop-interrupt-loot/`
- `fixtures/replay/full-loop-emergency-stop/`
- `tests/replay/full-loop*.test.ts`

**Change.** `AutomationLoop` uses orchestrator as the only tick entry.

**Remove.** Ad-hoc flag sets scattered in controllers; flags become orchestrator-owned functions (`beginStashSession`, etc.).

**Types/contracts.**

```ts
export interface ScenarioOrchestrator {
  tick(): Promise<QaActionTrace>
}
```

**Dependencies.** None.

**Data flow.** Full loop in §4.1.

**State transitions.** Use `DEFAULT_INTERRUPT_RULES`. Trade beats loot/follow. Inventory full beats loot/follow. High-value loot beats follow, not trade. Emergency stop beats all.

**Failure/recovery.** Global action budget: `actionsPerMinute`. Exhaustion → `SafetyHold` until window refills. Recovery policies already defined; orchestrator must not reset counters implicitly on interrupt except for the interrupted module’s in-flight step (record `interrupted: true` on trace).

**Unit tests.** Interrupt matrix; budget exhaustion; flag ownership.

**Integration tests.** Multi-module fake perception sequence.

**Replay tests.** Full-loop pack: follow → loot → inventory full → stash → list → trade event → complete trace fields present on every tick.

**Live QA checks.** Run full-loop dry-run on recorded frames; live only after module gates.

**Commands.** `npm test && npm run test:replay`

**Completion gate.** End-to-end fixture scenario produces a complete timestamped QA trace with state, reason, interlock, intended action, dry-run/execute, result.

**Suggested commit.** `feat: orchestrate full-loop interrupts, budgets, and recovery`

**Depends on.** Phases 02–12.

---

### Phase 14 — Operator / debug / replay UI

**Purpose.** Let an operator see state, arm/disarm, dry-run, stop, inspect traces, and use public companion features.

**Current state.** Overlay is a hello-world window.

**Add.** Vue routes/views in `apps/overlay/src`:

- `PriceCheckView.vue`
- `CatalogView.vue`
- `AutomationDashboard.vue` — arm, modules, scenario, dry-run, emergency-stop status
- `QaBanner.vue` — persistent, cannot be dismissed in QA mode
- `PerceptionDebugView.vue`
- `TraceReplayView.vue`
- `ScenarioEditorView.vue`
- `SettingsView.vue`
- `FilterBuilderView.vue` — **local** loot-filter generation/export
- `DisclaimerView.vue`

IPC (preload typed API): `getCapabilities`, `getWorldState`, `getTraces`, `armQa`, `disarmQa`, `tripStop`, `rearmStop`, `runReplay(id)`, `parseClipboard`, `exportFilter`.

Playwright smoke: overlay open, banner visible in QA, arm control disabled in public, settings persist.

**Change.** Desktop main creates overlay + hidden worker. QA banner window is always-on-top, non-interactive except “STOP” button which trips the latch.

**Remove.** Placeholder hello-world view.

**Types/contracts.** Renderer talks DTO copies of core types; no Electron imports in `packages/core`.

**Dependencies.** Vue 3, Vite, Playwright. `electron-overlay-window` only if click-through is required; default is a normal always-on-top window.

**Data flow.** Main holds orchestrator; renderer is a view. Manual price-check in public mode: user hotkey copies item (user-invoked, one action) → clipboard parse → valuation. That hotkey must **not** generate additional game actions.

**State transitions.** Arm/disarm and kill-switch visible and bound to Phase 03 objects.

**Failure/recovery.** IPC failures show an error panel; they do not rearm automation.

**Unit tests.** Banner component required when `qaBannerRequired`. Price formatting shows estimate, not guarantee.

**Integration tests.** Settings persist via SQLite `settings` table.

**Replay tests.** UI can load a replay id and show expected states (Playwright + fixture).

**Live QA checks.** Banner visible; stop button works; public build cannot arm.

**Commands.**

```bash
npm test
npm run test:smoke   # playwright
```

**Completion gate.** Operator can see state, arm/disarm, dry-run, stop, and inspect reasons. Local filter export works without OAuth.

**Suggested commit.** `feat: add operator dashboard, QA banner, replay viewer, and filter export`

**Depends on.** Phases 03, 04, 08, 13.

---

### Phase 15 — Packaging / performance / hardening / documentation

**Purpose.** Separate public vs QA artifacts, harden logging, document actual behavior, close the product gate.

**Current state.** No electron-builder configs, no public/QA split, docs still describe a future system.

**Add.**

- `electron-builder.public.yml` — does **not** package `packages/native-input`
- `electron-builder.qa.yml` — packages native input; productName `PoE2 QA Automation (Authorized)`
- `scripts/verify-public-build-excludes-native.mjs`
- Redacting logger in desktop
- First-run wizard: mode select; QA requires typing `AUTHORIZED QA` + checkbox
- `docs/IMPLEMENTATION_PHASES.md` header pointer to this plan
- Update `README.md` with actual commands
- Optional `OfficialItemFilterSync` behind OAuth — **only if** GGG is accepting apps or a test client is supplied; otherwise document `BLOCKED: oauth-registration` and keep local export
- CPU/latency budget notes in `grok/RESEARCH_NOTES.md` (capture ≤ 15 fps default; loop tick 100–200 ms)

**Change.** CI matrix: unit/replay on Linux; note Windows packaging as required on a Windows runner (add `windows-latest` job if available). If GitHub-hosted Windows is unavailable, document the gap; do not fake a Windows installer on Linux.

**Remove.** Nothing required.

**Types/contracts.** Unchanged.

**Dependencies.** `electron-builder` 26.x. Re-verify Electron ABI for `better-sqlite3` and `koffi`.

**Data flow.** N/A.

**State transitions.** Public artifact cannot set `mode=authorized-qa` without the QA build flag baked at compile time (`import.meta.env.POE2TC_MODE` / `process.env.POE2TC_RUNTIME_MODE`).

**Failure/recovery.** Crash-safe trace append (open-append-fsync optional); never lose the emergency-stop registration.

**Unit tests.** Public-mode compile-time flag test; redaction.

**Integration tests.** `verify-public-build-excludes-native` against the public package file list (can run on a directory pack, not only NSIS).

**Replay tests.** Existing suite still green.

**Live QA checks.** Clean Windows VM: public build cannot arm; QA build cannot arm without acknowledgement; emergency stop live; full-loop dry-run.

**Commands.**

```bash
npm run lint && npm run typecheck && npm test && npm run test:replay && npm run test:smoke
npm run pack:public
npm run pack:qa
node scripts/verify-public-build-excludes-native.mjs
```

**Completion gate.** Release gate in `docs/TEST_PLAN.md` is satisfied or remaining items are external (`windows-vm`, `oauth-registration`, `poe-client-access`) and listed in `grok/IMPLEMENTATION_STATE.md`.

**Suggested commit.** `chore: split public/QA packaging and harden release docs`

**Depends on.** Phases 01–14.

---

## 8. Invariant tests (keep green from the phase that introduces them)

| Invariant | From phase |
| --- | --- |
| `public-companion` cannot emit native input | 03 |
| QA cannot arm without acknowledgement + allowlist + hotkey registration | 03, 14 |
| Kill switch blocks and clears | 03 |
| Wrong process/window blocks | 03, 05 |
| Dry-run zero native input | 03, 04 |
| Native imports only in `packages/native-input` | 03 |
| Scheduler deterministic + interrupt order | 02, 13 |
| Recovery loops terminate | 06–12 |
| Replay zero native input; same controllers as live | 04+ |
| Transfers require observed confirmation | 10 |
| Unreachable loot suppressed | 07 |
| Full inventory/stash transitions | 09–10 |
| Trade/listing failure cases | 11–12 |
| Traces explain state, decision, interlock, action, result | 04, 13 |

---

## 9. Packaging / security / licensing

- Local-first SQLite under Electron `userData`.
- No default network telemetry.
- Tokens (if OAuth ever exists) in OS-protected storage (`safeStorage`). Never commit `.env` secrets.
- Redact account/session identifiers from general logs.
- QA traces are local and operator-enabled. They are not a public analytics channel.
- Public artifact must not ship `packages/native-input` or an armable QA dashboard.
- QA artifact product name must not be marketed as a normal player utility.
- Visible disclaimer: `This product isn't affiliated with or endorsed by Grinding Gear Games in any way.`
- Repository license: MIT (`LICENSE` in Phase 01).
- Vendored EE2 parser: keep upstream MIT copyright and `NOTICE` entries. Re-verify before copy.
- Do not vendor GPL code.
- Do not copy ExiledBot proprietary code.
- Do not store `POESESSID`, OAuth client secrets, or GGG internal credentials in the repo or fixtures.

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| No PoE 2 stash/public-stash API | Perception + clipboard + shadow state only. Never invent endpoints. |
| No documented trade-search API | Fixture + official currency-exchange only until docs change. |
| New OAuth apps closed | Companion/QA work without account APIs. Filter sync optional. |
| Electron native ABI (`better-sqlite3`, `koffi`) | Pin versions in Phase 01; rebuild in Phase 15; keep ports swappable. |
| `desktopCapturer` too slow / occluded | Keep `LiveFrameSource` swappable; Windows.Graphics.Capture is v2, not a Phase 01 rewrite. |
| PoE 2 UI layout patches break templates | All detectors take fixtures; prefer label/OCR + grid geometry over one hardcoded pixel map. |
| Click-to-move insufficient for follow | Swap follow actuation to key-taps via the same `InputAction` contract. |
| Cloud agent is Linux, product is Windows-first | Unit/replay must pass on Linux. Native/live marked `BLOCKED: windows-native` when the host cannot run them. Do not stub-pass live gates. |
| EE2 parser drift / license change | Re-verify at Phase 08 copy time; adapter isolates `NormalizedItem`. |
| Docs phase list disagrees with this plan | This file wins. Phase 15 adds a pointer on `docs/IMPLEMENTATION_PHASES.md`. |

---

## 11. Definition of done

The authorized QA build can, in a configured test scenario (live or replay):

1. Acquire and follow a target character.
2. Detect and automatically collect desirable loot.
3. Evaluate inventory items.
4. Transition when inventory is full.
5. Sort items into configured stash destinations.
6. Price and list eligible items through visible UI where the client permits.
7. Process a configured automated trade scenario.
8. Recover from common failures with bounded retries.
9. Stop immediately through the global emergency stop.
10. Produce a complete action trace.
11. Reproduce controller decisions in deterministic replay with zero native input.

The public companion build/mode retains non-automation features and cannot arm QA automation.

A phase is not done if required behavior is only a stub, TODO, mock, or document.

---

## 12. Highest-risk assumptions

1. **PoE 2 still has no official stash or public-stash API** (verified 2026-08-27). Grok must re-check the developer reference before Phase 09. If an official PoE 2 stash API appears, add a `StashApiObservationPort` *in addition to* UI observation; do not delete perception.
2. **PoE 2 inventory is not available via Account Characters** (`inventory` is documented PoE1-only). Character list/get may still help optional allowlists if OAuth exists.
3. **No documented official item trade-search API.** Live comparable pricing may remain fixture/currency-exchange-only until GGG documents one. That does not block QA automation, which can run on fixture quotes.
4. **GGG is not accepting new OAuth applications.** Official filter sync and character allowlists are optional. Do not block Phases 01–14 on OAuth.
5. **EE2 remains MIT** and its `renderer/src/parser` can be vendored without pulling undocumented trade clients. Re-verify immediately before Phase 08.
6. **Electron `desktopCapturer` + Win32 window metadata is enough for v1 perception.** If live QA proves otherwise, replace only `LiveFrameSource`.
7. **Click-to-move is enough for v1 follow.** If not, change actuation, not the scheduler.
8. **English client text is enough for v1 OCR/label parsing.**
9. **Linux CI can prove domain/replay correctness** while native SendInput stays Windows-only. Grok must not call the project complete without documenting the Windows live gap.
10. **Public ExiledBot material is behavioral reference only.** No plan or implementation may copy proprietary bot code or add detection-evasion.
11. **A dedicated GGG test interface does not exist today.** If one is later supplied, prefer it over CV for the affected ports; keep replay fixtures.
12. **`koffi` + `SendInput` is a sufficient native input surface.** If Electron sandboxing blocks it, keep the `InputSink` port and swap the one native file.

---

## 13. Blockers Grok must verify first (Phase 01 / before Phase 03 native)

1. Node 22 is available in the implementation environment; if not, install it. Do not silently use Node 18 without recording a deviation.
2. `npm install` of Electron 40, Vue 3, Vitest 3, TypeScript 5.9 succeeds on the implementation host.
3. Official API pages still match §3 (stash PoE1-only, limited PoE2 APIs, OAuth registration status, currency-exchange `poe2`).
4. EE2 `LICENSE` is still MIT before any file copy (Phase 08).
5. Actual PoE 2 process image names and window title on the target Windows build (Phase 05). Defaults in §4.3 are placeholders.
6. Whether the implementation host can load `koffi` and `better-sqlite3`. If not, keep ports and document `BLOCKED`.
7. Whether a Windows runner exists for packaging. If not, Linux replay remains the merge gate and Windows pack is an external blocker.

---

## 14. Grok working artifacts

Create in Phase 01 and keep current:

```text
grok/IMPLEMENTATION_STATE.md    # required checkpoint
grok/BASELINE_ASSESSMENT.md
grok/REVIEW_STATE.md
grok/TEST_GAPS.md
grok/REPLAY_BACKLOG.md
grok/RESEARCH_NOTES.md
grok/EXILEDBOT_BEHAVIORAL_REFERENCES.md
```

`IMPLEMENTATION_STATE.md` must always include: base/current commit, active phase, completed phases, build/test status, blockers, plan deviations, replay fixtures added, next exact work item.

---

# GROK 4.6 XHIGH FAST IMPLEMENTATION HANDOFF

1. **Grok is the primary implementation owner.** Sol Max planned only. Do not wait for Sol Max to write production code.
2. **Use Grok 4.6 with `xhigh` reasoning and the Fast variant when available.** Follow `GROK_46_XHIGH_FAST_BUILD_PROMPT.md` and `GROK_BOT_START_HERE.md`.
3. **Implement this plan phase-by-phase rather than redesigning it casually.** Phase order is 01→15 as written. `docs/IMPLEMENTATION_PHASES.md` is historical/item-first and is not the execution order.
4. **Amend the plan only when code, tests, or current external evidence proves a plan assumption wrong.** Document every amendment in `grok/IMPLEMENTATION_STATE.md` and patch this file when later phases are affected.
5. **Each phase must end buildable/testable where practical.** Prefer a small passing slice over a large untested rewrite.
6. **Run relevant tests before committing.** Minimum: `npm run lint`, `npm run typecheck`, `npm test`, plus `npm run test:replay` from Phase 04, plus smoke from Phase 14. Record failures; do not delete or mute tests to create a green run.
7. **Reproducible bugs must become regression tests or replay fixtures before or with the fix.**
8. **Maintain `grok/IMPLEMENTATION_STATE.md`** with completed phase, current commit, failures, next work, and plan deviations.
9. **Do not report a phase complete when required behavior is only a stub or document.** `FixtureDesirabilityScorer` in Phase 07 is an intentional real port implementation; an empty `TODO` controller is not.
10. **Preserve the repository safety/QA boundaries.** `public-companion` cannot emit automated native game input. `authorized-qa` keeps acknowledgement, banner, allowlist, emergency stop, dry-run, rate limits, module flags, and structured traces. Do not implement license bypass, credential theft, protected-code extraction, anti-cheat bypass, detection-evasion, or proprietary ExiledBot copying.

Immediate Grok instruction: create/update `grok/IMPLEMENTATION_STATE.md`, establish the Phase 01 baseline from the recorded ENOENT failures, and implement Phase 01.
