# Test Gaps

**Updated:** 2026-08-27 (Phase 03 implemented)

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

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Scheduler priority / interrupt / determinism | 02 (covered) |
| Public mode cannot emit native input | 03 (covered) |
| QA arming, kill switch, allowlist, dry-run, rate limit | 03 (covered) |
| Native-import guard script | 03 (covered) |
| Replay runner + traces | 04 |
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

Phase 02 replay snapshots exist. `npm run test:replay` now has `tests/replay/scheduler-priority.test.ts`. Full replay runner / `FrameSource` still Phase 04. See `REPLAY_BACKLOG.md`.
