# Test Gaps

**Updated:** 2026-08-27 (Phase 06 complete)

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

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Loot rank / pickup | 07 |
| Parser / valuation | 08 |
| Inventory / stash reconcile | 09 |
| Stash transfers | 10 |
| Listing machine | 11 |
| Trade machine | 12 |
| Full-loop orchestrator | 13 |
| Playwright overlay smoke | 14 |
| Public vs QA packaging | 15 |

## Replay

`npm run test:replay` now also includes `follow-lost-reacquire`, `follow-stuck-recovery`, and `follow-emergency-stop`. See `REPLAY_BACKLOG.md`.
