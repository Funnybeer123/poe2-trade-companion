# Replay Backlog

Phase 02 added `fixtures/replay/scheduler-priority/` (8 JSON world snapshots, no pixels) plus `tests/replay/scheduler-priority.test.ts`. Snapshot-in / selected-state-out through the live `ScenarioScheduler`.

Phase 04 added the replay runner + `FrameSource`. `fixtures/replay/follow-acquired/` runs the live `ScenarioScheduler` and `GameInputController` against derived frames with `NoopInputSink` only.

Phase 05 added `fixtures/replay/perception-estimate/` (target present then omitted; freshness `fresh` → `missing` after `AGING_MAX_AGE_MS`) through `FixturePerceptionAdapter` + `StateEstimator` + the live scheduler.

Phase 06 added `follow-lost-reacquire`, `follow-stuck-recovery`, and `follow-emergency-stop` through the live `FollowController` / `RecoveryController`.

Phase 07 added `loot-desirable-vs-junk`, `loot-inventory-full`, and `loot-unreachable-backoff` through the live `LootController` / `InventoryController` and `FixtureDesirabilityScorer`.

Phase 08 added `loot-market-aware` (derived loot includes clipboard text; `DesirabilityEngine` + fixture quotes).

Phase 09 added `inventory-stale` (12/12 occupancy → `InventoryFull`; fixture drop cell → no longer full) through the live estimator + `InventoryController`.

Phase 10 added `stash-sort-success`, `stash-full-fallback`, `stash-failed-move-retry`, `stash-wrong-tab`, and `stash-emergency-stop` through the live `StashController`. Success is observed on the next fixture frame, never assumed from the drag.

Planned packs from `plans/IMPLEMENTATION_PLAN.md`:

| Phase | Fixture / suite |
| --- | --- |
| 02 | `fixtures/replay/scheduler-priority/` — JSON world snapshots, no pixels |
| 04 | `fixtures/replay/follow-acquired/` |
| 05 | `fixtures/replay/perception-estimate/` |
| 06 | `follow-lost-reacquire`, `follow-stuck-recovery`, `follow-emergency-stop` — added |
| 07 | `loot-desirable-vs-junk`, `loot-inventory-full`, `loot-unreachable-backoff` — added |
| 08 | `loot-market-aware` — added |
| 09 | `inventory-stale` — added |
| 10 | `stash-sort-success`, `stash-full-fallback`, `stash-failed-move-retry`, `stash-wrong-tab`, `stash-emergency-stop` — added |
| 11 | `listing-apply-price`, `listing-reprice-stale`, `listing-low-confidence-skip` |
| 12 | trade success + listed failure classes |
| 13 | `full-loop`, interrupt-trade, interrupt-loot, emergency-stop |

Rule: replay must use the same controllers/scheduler as live and emit zero native input.
