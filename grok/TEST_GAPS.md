# Test Gaps

**Updated:** 2026-08-27 (Phase 10 complete)

## Covered in Phase 01

- `workspaceOk() === true` (`tests/unit/workspace-ok.test.ts`)
- `migrations/001_init.sql` contains `qa_action_traces` (`tests/integration/migrations-exist.test.ts`)
- Lint, typecheck, and workspace compile via CI

## Covered in Phase 02

- Scheduler priority order table (`tests/unit/scheduler/priority-order.test.ts`)
- Interrupts, tie-break, frozen-clock identity, disabled modules
- EmergencyStop vs trade; InventoryFull vs loot/follow; HighValueLoot vs follow-not-trade
- Freshness buckets and `FrozenClock` / `createEmptyWorldState`
- 8 replay/integration snapshots in `fixtures/replay/scheduler-priority/`

## Covered in Phase 03

- `public-companion` `canEmitNativeInput` is always false; `createInputSink` returns `ForbiddenInputSink`
- QA cannot arm without acknowledgement, process/window allowlists, and emergency hotkey registration
- Interlock evaluation order including dry-run record/deny-execute
- Kill switch blocks new input and clears the queue
- Wrong process/window and module flags block execute
- Token-bucket rate limiter blocks the N+1 action
- `GameInputController` serializes sink calls
- Native import guard script; `koffi` only in `packages/native-input`
- `NativeInputSink` throws `native-unavailable` when koffi cannot load or host is not Windows
- Electron main source registers `Ctrl+Shift+F12` and does not import native-input

## Covered in Phase 04

- Replay runner uses live `ScenarioScheduler` + `GameInputController` and constructs `NoopInputSink` only
- `follow-acquired`: derived target → `Follow`; intended `mouse-click` recorded; `executed === false`; sink kind `noop`
- Missing frame / exhausted source ends with `result: "end-of-stream"`
- Corrupt manifest throws `corrupt-manifest` and does not hang
- FrozenClock timestamps flow through the loop into traces
- Trace redaction always strips tokens; character names only when `redactIdentifiers === true`
- `QaTraceWriter` is append-only
- SQLite migration runner + `SqliteTraceStore` round-trip of one `QaActionTrace`

## Covered in Phase 05

- Freshness buckets on the estimator (`fresh` / `aging` / `stale` / target `missing` after the stale window)
- Observation merge rules (higher/equal confidence replaces; lower confidence only if prev is stale|missing)
- Process/window allowlist true/false, including estimator overwrite of derived `allowlisted`
- `templateMatch` monotonicity on synthetic PNG fixtures
- Analyze errors → `ui.kind=unknown`, confidence 0, `SafetyHold`; loop does not throw
- PNG fixture → `FixturePerceptionAdapter` → `StateEstimator` occupancy/target/loot counts
- Replay `perception-estimate`: two frames, target present then absent, FrozenClock past stale window
- Live adapters exist: `ElectronFrameSource`, `Win32ProcessQuery`, `ClipboardSource` (injected / unavailable off Windows)

## Covered in Phase 06

- Screen-center → target vector and click-to-move when distance > 140px
- Inside-band noop
- Stuck detector: no progress for 12 ticks
- Lost-target consecutive tick count (default 8)
- FollowController uses the same class as live/replay; RecoveryController scan is bounded
- Replay: `follow-lost-reacquire`, `follow-stuck-recovery`, `follow-emergency-stop`
- Traces include `follow-target`, `lost-target`, `stuck-recovery`, `emergency-stop`
- Recovery loops terminate (maxAttempts / lost-target-exhausted / stuck-exhausted)

## Covered in Phase 07

- Deterministic loot rank: score desc, nearest to screen center, id asc
- Skip reasons: `below-min-score` (default 40), adversarial-execute does not skip, `inventory-full`
- `loot.unreachable`: two observed failed pickups → suppress id 15s; success is label disappearance or occupancy increase
- `LootController` issues no pickup clicks when inventory is full
- `FixtureDesirabilityScorer` keyword/rarity/fixture-score mapping (real port, not an empty stub)
- `lootLabelDetector` fixture path + color-blob/OCR port (loot-label PNG gold `220,180,40`)
- Replay: `loot-desirable-vs-junk`, `loot-inventory-full`, `loot-unreachable-backoff`
- Traces include pick/skip reasons (`decisionReason`, `observedSummary`, `followUpSummary`)

## Covered in Phase 08

- English clipboard corpus: unique / rare / currency / waystone / gem (`fixtures/items/*.txt`)
- Fingerprint SHA-256 stability; changes when a modifier value changes
- Tukey 1.5 IQR outlier drop; valuation never labeled a guaranteed sale price
- DesirabilityEngine determinism; FixtureDesirabilityScorer remains for labels
- Fixture market + official Currency Exchange digest parser (saved hourly JSON, no network)
- 429 (Retry-After, no retry), 5xx, offline; cache reuse when `maxAgeMs` allows
- Integration: label-only skip vs market-aware pickup
- Replay: `loot-market-aware`

## Covered in Phase 09

- Reconcile match / missing / unexpected / stale / full
- Occupied cells without fingerprints do not invent shadow items
- `gridDetector` fixture cells + pixel occupancy + clipboard hover fingerprint
- Estimator fills grid cells from the detector and recomputes `full`
- `InventoryController` sets `stashSessionActive` when full and emits no transfers
- Trace reason `shadow-mismatch` when reconcile reports missing/unexpected
- SQLite inventory/stash snapshot persist + reload after a new DB connection (`freshness: "stale"`)
- Replay `inventory-stale`: 12/12 → `InventoryFull`; drop cell → no longer full

## Covered in Phase 10

- Rule matching: class / rarity / desirability category → product-spec tabs
- Planner order: high value first; fallback tab when primary is full; empty plan; fallback-full block
- `StashController` on `InventoryFull` / `StashSort`; empty plan clears `stashSessionActive` when inventory is not full
- Failed move / wrong tab bounded to `DEFAULT_RECOVERY` maxAttempts 3
- Transfer success is reconcile/cell confirmation, never the emitted drag
- Integration: planned drag → next fixture frame new cell → shadow confirmed
- Replay: `stash-sort-success`, `stash-full-fallback`, `stash-failed-move-retry`, `stash-wrong-tab`, `stash-emergency-stop`

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Parser / valuation | 08 (done) |
| Inventory / stash reconcile | 09 (done) |
| Stash transfers | 10 (done) |
| Listing machine | 11 |
| Trade machine | 12 |
| Full-loop orchestrator | 13 |
| Playwright overlay smoke | 14 |
| Public vs QA packaging | 15 |

## Replay

`npm run test:replay` now also includes `inventory-stale`. See `REPLAY_BACKLOG.md`.
