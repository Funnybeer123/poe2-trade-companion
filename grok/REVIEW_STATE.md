# Review State

**Phase under review:** 05 — Perception / state estimation foundation  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 05 acceptance criteria are implemented. Gate commands are green. `StateEstimator` is the only writer of `WorldState` field observations. Derived fixtures go through `FixturePerceptionAdapter` then the estimator. Live capture adapters exist.

## Scope reviewed

Actual Phase 05 diff vs `cursor/phase-04-replay-trace-9afe`:

- `packages/core/src/perception/*`
- `packages/core/src/loop/automationLoop.ts` (identity estimator removed)
- `packages/perception-live/**`
- `scripts/check-native-input-imports.mjs`
- `fixtures/perception/**`, `fixtures/replay/perception-estimate/`
- unit/integration/replay tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `test`, `test:replay`, `lint`, `typecheck` run on this host — green (150 tests).
- [x] Searched for TODOs / `Math.random` / `identityEstimate` / `derived as WorldState` / SendInput in new perception code: none.
- [x] Failures recorded and fixed, not muted.

## Perception / state engine

- [x] Estimator merge: newer `confidence >= prev` replaces; lower confidence only if prev is `stale` or `missing`.
- [x] Freshness recomputed from `clock.nowMs() - observedAtMs`.
- [x] Omitted target after the stale window becomes `freshness: "missing"`.
- [x] Process allowlist computed from arming; derived `allowlisted: true` is overwritten.
- [x] Analyze errors → `ui.kind=unknown`, confidence 0, `SafetyHold`; loop does not throw.
- [x] Estimator does not select automation state; scheduler still does.
- [x] Replay still uses live `ScenarioScheduler` + `GameInputController` + `NoopInputSink`.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `tests/unit/perception/templateMatch.test.ts` | Additive noise saturated white pixels so NCC stayed 1. | Fixed: darken the patch so the noisy score is strictly lower. |
| LOW | `scripts/write-perception-fixtures.mjs` | ESLint `no-undef` on `Buffer`. | Fixed: import `Buffer` from `node:buffer`. |
| IMPROVEMENT | `stateEstimator.ts` | `TARGET_ABSENT_FIELDS` always contained `"target"`. | Simplified to `absentToMissing: true` on the target merge. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 06–15 (real follow math, loot/stash/listing/trade, packaging). Live Windows process-name verification remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
