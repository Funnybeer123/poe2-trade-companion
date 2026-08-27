# Review State

**Phase under review:** 03 — Capability / interlock / input boundary  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 03 acceptance criteria are implemented. Gate commands are green. Native live `SendInput` remains an external host blocker (`BLOCKED: windows-native`), which the plan allows.

## Scope reviewed

Actual Phase 03 diff vs `cursor/phase-02-world-state-scheduler-ca64`:

- `packages/core/src/capabilities/*`
- `packages/core/src/interlock/*`
- `packages/core/src/input/*`
- `packages/native-input/**`
- `scripts/check-native-input-imports.mjs`
- `apps/desktop/electron-main.ts` emergency-stop hotkey
- unit/integration tests listed in `TEST_GAPS.md`
- CI step for the native-import guard

## Repository health

- [x] Diff inspected.
- [x] `lint`, `typecheck`, `test`, `check-native-input-imports` run on this host — green (107 tests).
- [x] Searched for TODOs / stubs / `Math.random` / native imports outside `packages/native-input`: none.
- [x] Failures (unused args, script globals, `InputAction` widening, unstructured SendInput) recorded and fixed, not muted.

## Runtime boundaries

- [x] `public-companion.canEmitNativeInput` is always `false` and frozen.
- [x] `createInputSink` returns `ForbiddenInputSink` in public mode.
- [x] `GameInputController` replaces a `kind: "native"` sink with `ForbiddenInputSink` when native input is ineligible.
- [x] QA arming requires acknowledgement, process/window allowlists, and hotkey registration.
- [x] Dry-run records intended actions and does not call the sink.
- [x] Wrong process/window, disabled module/scenario, and rate limits block execute.

## Input ownership

- [x] Production sink `execute` is only called from `GameInputController` (and `RecordingInputSink` wrapping an inner sink).
- [x] `packages/core` does not import `koffi` or `@poe2tc/native-input`.
- [x] Electron public start path does not import native-input.
- [x] Kill switch trips the latch, cancels the sink, and clears the queue.
- [x] Rearm requires `{ explicit: true }`.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `packages/native-input/src/nativeInputSink.ts` | First cut passed a plain object to `SendInput` as `void*` with a guessed size. | Fixed: named koffi `INPUT` struct/union and `sizeof("INPUT")`. Still untestable live on Linux. |
| MEDIUM | `gameInputController.ts` | A caller could pass `kind: "native"` under public capabilities. Interlock already denied execute. | Fixed: public mode swaps a native-kind sink for `ForbiddenInputSink`. |
| LOW | lint | Unused `_ms` / `_action`; script `process`/`console` globals. | Fixed. |
| IMPROVEMENT | `InterlockContext` | Optional `retryIndex` / `identity` are not in §5.5. | Keep. Needed for retry-exhausted and realm/account/character allowlists without inventing WorldState fields. |
| IMPROVEMENT | sleeper | Default sleeper is no-op; jitter profiles are 0 ms. | Keep. Seeded RNG is wired; Phase 04 can pass a real sleeper. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 04–15 (replay runner, perception, controllers, packaging). See `TEST_GAPS.md`.
