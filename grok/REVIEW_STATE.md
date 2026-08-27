# Review State

**Phase under review:** 07 — Loot detection / ranking / pickup  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 07 acceptance criteria are implemented. Gate commands are green. Replay loot scenarios use the same `LootController` / `InventoryController` / `FixtureDesirabilityScorer` as live. Unreachable loot is bounded and suppressed.

## Scope reviewed

Actual Phase 07 diff vs `cursor/phase-06-follow-navigation-8044`:

- `packages/core/src/perception/lootLabelDetector.ts`, `ocrPort.ts`, `fixturePerceptionAdapter.ts`
- `packages/core/src/items/{types,desirabilityPort,fixtureDesirabilityScorer}.ts`
- `packages/core/src/loot/{rankLoot,annotateLoot,estimateLootPickup,skipReasons}.ts`
- `packages/core/src/controllers/{lootController,inventoryController,controllerMap}.ts`
- `packages/core/src/loop/automationLoop.ts` (score before schedule; post-decision pending pickup / stash flag)
- `packages/core/src/perception/stateEstimator.ts` (observed pickup success/failure)
- `packages/core/src/scheduler/predicates.ts` (`hasHighValueLoot` ignores `skipReason`)
- replay fixtures `loot-desirable-vs-junk` / `loot-inventory-full` / `loot-unreachable-backoff`
- unit/integration/replay tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `test` (197), `test:replay` (10), `lint`, `typecheck` run on this host — green after review fixes.
- [x] Searched for TODOs / placeholders / `Math.random` / SendInput / unbounded loops in new loot code: none. `placeholderDecision` remains only for later-phase states (stash/listing/trade).
- [x] `FixtureDesirabilityScorer` is a real tested port, not an empty stub.
- [x] Failures recorded and fixed, not muted.

## Loot checklist

- [x] Detection (`lootLabelDetector`), scoring (`DesirabilityPort`), pickup (`LootController`), confirmation (`estimateLootPickup`) are separated.
- [x] Pick/skip reasons appear on traces (`decisionReason`, `observedSummary`, `followUpSummary`).
- [x] Failed pickup: max 2 attempts, backoff `[300, 800]`, suppress 15s (`loot.unreachable`).
- [x] Inventory full → `InventoryFull`, no pickup clicks; stub sets `stashSessionActive`.
- [x] Deterministic ranking tests exist.
- [x] Pickup success is observed (label gone or occupancy increased), not assumed.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| LOW | `inventoryController.ts`, `fixtureDesirabilityScorer.ts` | Unused params failed lint (`_scenario`, `_ctx`). | Fixed: `void` the required contract args. |
| LOW | `lootLabelDetector.test.ts` | Raw `derived.loot` array failed `Partial<WorldState>` typecheck. | Fixed: wrap as an `Observation`. |
| IMPROVEMENT | `estimateLootPickup.ts` | Always writes empty attempt/suppression maps onto flags. | Left as-is; follow/replay still green and maps are cheap. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 08–15 (parser/market, stash transfers, listing/trade, packaging). Live Windows loot highlight / one armed pickup remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
