# Review State

**Phase under review:** 06 — Navigation / follow / recovery  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 06 acceptance criteria are implemented. Gate commands are green. Replay follow scenarios use the same `FollowController` / `RecoveryController` as live. Recovery loops terminate.

## Scope reviewed

Actual Phase 06 diff vs `cursor/phase-05-perception-estimator-1b5a`:

- `packages/core/src/controllers/followController.ts`
- `packages/core/src/controllers/recoveryController.ts`
- `packages/core/src/controllers/controllerMap.ts`
- `packages/core/src/navigation/*`
- `packages/core/src/recovery/defaultRecovery.ts`
- `packages/core/src/perception/stateEstimator.ts` (writes `world.stuck`)
- `packages/core/src/scheduler/predicates.ts` (`stuck-exhausted`, `lost-target-exhausted`)
- `packages/core/src/loop/automationLoop.ts` (`createControllerMap`, `recoveryOf` / `retryIndex`)
- replay fixtures `follow-lost-reacquire`, `follow-stuck-recovery`, `follow-emergency-stop`
- unit/integration/replay tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `test` (173), `test:replay` (7), `lint`, `typecheck` run on this host — green.
- [x] Searched for TODOs / placeholders / `Math.random` / SendInput / unbounded loops in new follow/recovery code: none. Phase 04 `follow-placeholder` removed from the live map. `placeholderDecision` remains only for later-phase states (loot/stash/listing/trade).
- [x] Failures recorded and fixed, not muted.

## Navigation / recovery

- [x] Target fresh → `Follow` + `follow-target` click when outside the 140px band; inside-band noop.
- [x] Target omitted past the stale window → `RecoverTarget` + `lost-target` bounded scan (max 5 clicks).
- [x] Reacquire uses the Phase 05 estimator merge path (omit + stale → missing, then a new observation replaces).
- [x] No progress for 12 ticks → `stuck-recovery`; after `follow.stuck` maxAttempts (3) → `SafetyHold` + `stuck-exhausted`.
- [x] Emergency stop from a follow tick → `EmergencyStop` + `emergency-stop`, no click.
- [x] Controllers do not import sinks / native input. All input still goes through `GameInputController`.
- [x] Replay sink remains `NoopInputSink`; `executed === false`.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `fixtures/replay/follow-lost-reacquire` + merge rules | A confidence-1 `target: null` observation could not be replaced by a later 0.92 reacquire while still fresh. | Fixed: lost frames omit `target` and advance past `AGING_MAX_AGE_MS`, matching `perception-estimate`. |
| LOW | `recoveryController.ts` | Unused `scenario` parameter failed lint. | Fixed: honor `scenario.retryLimits.recovery` when present. |
| IMPROVEMENT | `recoveryController.ts` | RecoverTarget with a visible low-confidence point would have issued a blind scan. | Fixed: click toward the visible point via `followDirection`. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 07–15 (loot/stash/listing/trade, packaging). Live Windows follow click-move remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
