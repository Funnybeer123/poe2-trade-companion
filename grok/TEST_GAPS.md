# Test Gaps

**Updated:** 2026-08-27 (Phase 02 implemented)

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

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Scheduler priority / interrupt / determinism | 02 (covered) |
| Public mode cannot emit native input | 03 |
| QA arming, kill switch, allowlist, dry-run, rate limit | 03 |
| Native-import guard script | 03 |
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
