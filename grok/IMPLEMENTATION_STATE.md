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
| Phase 03 first cut | `7f136ba` | Capabilities, interlocks, GameInputController |
| Current commit | `f6e72b0` | Gate + self-review on `cursor/phase-03-capabilities-interlock-input-9d76` (PR #4) |

## Active phase

None. Phase 03 is complete. Next is Phase 04.

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.
- Phase 03 — `RuntimeCapabilities`, `InterlockGate`, `GameInputController`, emergency-stop latch, Noop/Forbidden/Recording sinks, `packages/native-input` SendInput adapter, native-import CI guard, Electron `Ctrl+Shift+F12` hotkey.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 03 gate (2026-08-27, this host) — **green**:

- `npm run lint`
- `npm run typecheck`
- `npm test` — 107 tests (unit + integration + replay)
- `node scripts/check-native-input-imports.mjs`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — host is Linux. `NativeInputSink` binds `koffi` → `user32.SendInput` / `SetCursorPos` with a typed `INPUT` struct. Construction throws `native-unavailable` when `koffi` cannot load or `platform !== "win32"` (both paths tested). Live SendInput and a real `globalShortcut` display session are not available here. The plan allows closing Phase 03 without Windows live input.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API. See `RESEARCH_NOTES.md`.

## Plan deviations

Phase 01–02 deviations unchanged.

Phase 03:

- `InterlockContext` adds optional `retryIndex` and `identity` so retry-exhausted and realm/account/character allowlists can be evaluated without inventing WorldState fields.
- `createInputSink()` returns `ForbiddenInputSink` when `canEmitNativeInput` is false, otherwise `NoopInputSink`. Core never constructs `NativeInputSink`.
- `GameInputController` rejects a `kind: "native"` sink when `canEmitNativeInput` is false and substitutes `ForbiddenInputSink`.
- Default sleeper is no-op. Timing jitter uses seeded `mulberry32` (`scenario.id` + `tickId`); `default` / `instant` profiles are 0 ms.
- `evaluateQaArming` / `armQa` implement the “cannot arm without acknowledgement + allowlist + hotkey” invariant.
- Electron accelerator is `CommandOrControl+Shift+F12` (Ctrl+Shift+F12 on Windows/Linux).

## Replay fixtures added

None in Phase 03. Intended actions are captured in memory by `GameInputController.recordedActions` and `RecordingInputSink`. Scheduler fixtures from Phase 02 remain.

## Next exact work item

Phase 04 — Deterministic replay + trace model.

Suggested commit from the plan: `feat: add replay runner, QA traces, and fixture frame source`.
