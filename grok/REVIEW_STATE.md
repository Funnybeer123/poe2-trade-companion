# Review State

**Phase under review:** 04 — Deterministic replay + trace model  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 04 acceptance criteria are implemented. Gate commands are green. Replay uses the live `ScenarioScheduler` and `GameInputController` with `NoopInputSink` only.

## Scope reviewed

Actual Phase 04 diff vs `cursor/phase-03-capabilities-interlock-input-9d76`:

- `packages/core/src/replay/*`
- `packages/core/src/loop/*`
- `packages/core/src/trace/*`
- `packages/core/src/controllers/*`
- `packages/core/src/perception/types.ts` (contracts only)
- `packages/persistence-sqlite/**`
- `fixtures/replay/follow-acquired/`, `fixtures/scenarios/*`
- unit/integration/replay tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `test:replay`, `test`, `lint`, `typecheck` run on this host — green (121 tests).
- [x] Searched for TODOs / `Math.random` / native imports in the new packages: none except a documented Phase 04 identity-estimator comment.
- [x] Failures recorded and fixed, not muted.

## Replay and input ownership

- [x] `ReplayRunner` constructs `NoopInputSink` only and refuses a non-noop sink after `GameInputController` construction.
- [x] `run()` throws if any trace has `executed === true`.
- [x] Live `createScenarioScheduler()` and `createGameInputController()` are used. No forked replay scheduler.
- [x] FrozenClock is advanced from frame `atMs` through the loop into trace `clockMs` / `timestamp`.
- [x] Missing frame → `end-of-stream`. Corrupt manifest throws `corrupt-manifest`.

## Telemetry

- [x] Traces include selected state, decision reason, intended actions, interlock code, executed/dry-run.
- [x] Tokens always redacted. Character names redacted only when `redactIdentifiers === true`.
- [x] SQLite store maps 1:1 onto `qa_action_traces`.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `packages/persistence-sqlite/src/migrate.ts` | Apply + `schema_migrations` insert were not transactional. | Fixed: one better-sqlite3 transaction per file. Idempotent re-apply tested. |
| LOW | `packages/core/src/trace/redact.ts` | Missing process title became `"[redacted]"` when identifier redaction was on. | Fixed: leave `undefined` undefined. |
| IMPROVEMENT | `replayRunner.ts` | Replay invariant was convention-only. | Fixed: refuse non-noop sink; throw if any trace executed. |
| IMPROVEMENT | FollowController | Placeholder emits a click when a screen point exists (required by `follow-acquired`) and noop otherwise. Real navigation is Phase 06. | Keep. Documented in `IMPLEMENTATION_STATE.md`. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 05–15 (real estimator, follow math, loot/stash/listing/trade, packaging). See `TEST_GAPS.md`.
