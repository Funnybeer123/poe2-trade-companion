# Test Gaps

**Updated:** 2026-08-27 (Phase 04 implemented)

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

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Perception / estimator | 05 |
| Follow / recovery | 06 |
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

`npm run test:replay` now includes `tests/replay/scheduler-priority.test.ts` and `tests/replay/follow-acquired.test.ts`. See `REPLAY_BACKLOG.md`.
