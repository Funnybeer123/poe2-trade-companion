# Implementation State

**Updated:** 2026-08-27  
**Implementer:** Grok 4.6 xhigh Fast  
**Plan:** `plans/IMPLEMENTATION_PLAN.md` (Sol Max, 2026-08-27)

## Commits

| Ref | SHA | Notes |
| --- | --- | --- |
| Audited base (`main`) | `3bf2f91398a16a5250d351be818a41ca39e32762` | Docs-only repo; no toolchain |
| Plan branch | `176b090` (`cursor/implementation-plan-05a4`, PR #1) | Adds this implementation plan |
| Phase 01 | `8c3ba93` on `cursor/phase-01-baseline-f3a0` (PR #2) | Workspace/CI baseline complete |
| Phase 02 | `ece3287` on `cursor/phase-02-world-state-scheduler-ca64` (PR #3) | WorldState + scheduler complete |
| Current branch | `cursor/phase-03-capabilities-interlock-input-9d76` | Phase 03 capability / interlock / input |

## Active phase

Phase 03 — Capability / interlock / input boundary (implementation in progress; gate pending).

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 03 implementation added. Gate commands not yet recorded on this revision.

## Blockers

- **BLOCKED: windows-native** — host is Linux. `NativeInputSink` exists and throws `native-unavailable` when `koffi` cannot load or the platform is not `win32`. Live `SendInput` and a real `globalShortcut` display session are not available here. Unit/non-native tests cover the throw path and the public-mode/input invariants.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API. See `RESEARCH_NOTES.md`.

## Plan deviations

Phase 01–02 deviations unchanged.

Phase 03:

- `InterlockContext` adds optional `retryIndex` and `identity` so retry-exhausted and realm/account/character allowlists can be evaluated without inventing WorldState fields (those identifiers are not on `WorldState` yet).
- `createInputSink()` returns `ForbiddenInputSink` when `canEmitNativeInput` is false, otherwise `NoopInputSink`. It never constructs `NativeInputSink` (core must not import `packages/native-input`).
- `GameInputController` defaults to a no-op sleeper. Timing jitter uses seeded `mulberry32` (`scenario.id` + `tickId`); the `default` / `instant` profiles are 0 ms in this phase.
- QA arming helper `evaluateQaArming` / `armQa` is not named in §5.2 but is required for the “cannot arm without acknowledgement + allowlist + hotkey” invariant.
- Electron accelerator is `CommandOrControl+Shift+F12` (Ctrl+Shift+F12 on Windows/Linux). `globalShortcut.register` is compiled in; it may fail at runtime without a display.

## Replay fixtures added

None in Phase 03. Recording sink / controller `recordedActions` cover intended-action capture in memory. Scheduler fixtures from Phase 02 remain.

## Next exact work item

Finish Phase 03 gate (`lint`, `typecheck`, `test`, `check-native-input-imports`), self-review, then Phase 04 — deterministic replay + trace model.
