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
| Phase 03 | `67ea3ae` on `cursor/phase-03-capabilities-interlock-input-9d76` (PR #4) | Capabilities, interlocks, GameInputController |
| Phase 04 | `b2e17a5` on `cursor/phase-04-replay-trace-9afe` (PR #5) | Replay runner, traces, fixture frame source |
| Phase 05 | `1f1a0d3` on `cursor/phase-05-perception-estimator-1b5a` (PR #6) | Perception estimator complete |
| Phase 06 first cut | `0016d72` on `cursor/phase-06-follow-navigation-8044` (PR #7) | Follow/recovery controllers + fixtures |
| Current branch | `cursor/phase-06-follow-navigation-8044` | Phase 06 complete (gate + self-review) |

## Active phase

None. Phase 06 is complete. Next is Phase 07.

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.
- Phase 03 — `RuntimeCapabilities`, `InterlockGate`, `GameInputController`, emergency-stop latch, Noop/Forbidden/Recording sinks, `packages/native-input` SendInput adapter, native-import CI guard, Electron `Ctrl+Shift+F12` hotkey.
- Phase 04 — `FixtureFrameSource`, `ReplayRunner`, `QaTraceWriter`, `InMemoryTraceSink`, `AutomationLoop`, SQLite migration runner + `SqliteTraceStore`, `follow-acquired` replay fixture, scenario catalog JSON.
- Phase 05 — `StateEstimator`, `FixturePerceptionAdapter`, merge/freshness/allowlist, `templateMatch`, `packages/perception-live` (Win32 process, `desktopCapturer` frame source, read-only clipboard), perception fixtures + `perception-estimate` replay.
- Phase 06 — `FollowController`, `RecoveryController`, `direction.ts` click-to-move, `stuckDetector`, `lostTargetTicks`, `DEFAULT_RECOVERY`, replay packs `follow-lost-reacquire` / `follow-stuck-recovery` / `follow-emergency-stop`.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 06 gate (2026-08-27, this host) — **green**:

- `npm test` — 173 tests
- `npm run test:replay` — 7 tests
- `npm run lint`
- `npm run typecheck`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — unchanged. Live follow dry-run overlay / one armed click-move is skipped on this Linux host. Defaults stay `PathOfExile.exe` / `PathOfExile_x64.exe` / `PathOfExileSteam.exe` and title include `Path of Exile 2`. See `RESEARCH_NOTES.md`.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API.

## Plan deviations

Phase 01–05 deviations unchanged except: Phase 04 Follow placeholder noops are removed from the live controller map.

Phase 06:

- `FollowConfig` matches the plan. Screen size used for v1 click-to-move is the existing replay default `1920x1080` (`DEFAULT_SCREEN_WIDTH/HEIGHT`), not a new WorldState field.
- Estimator writes `world.stuck` (`ticks`, `lostTargetTicks`, `isStuck`, `reason`) so controllers stay stateless and do not keep a parallel world model. Fixture `derived.stuck` still overrides when provided.
- `SafetyHold` is eligible when `stuck.reason === "stuck-exhausted"`. `RecoverTarget` is ineligible when `stuck.reason === "lost-target-exhausted"` so lost-target recovery terminates at Idle.
- Recovery scan clicks are bounded by `DEFAULT_RECOVERY["follow.lost-target"].maxAttempts` (5). `lostTargetTicks` (default 8) is the consecutive-missing counter and the RecoverTarget eligibility window.
- Lost-target replay frames omit `target` and advance past `AGING_MAX_AGE_MS` so the estimator marks `missing` (same merge path as Phase 05). A confidence-1 `target: null` observation would block a later lower-confidence reacquire.
- `createPhase04ControllerMap` is replaced by `createControllerMap` (Follow + Recovery + Idle + EmergencyStop/SafetyHold).
- Loot/stash/listing/trade are not implemented (Phase 07+).

## Replay fixtures added

- `fixtures/replay/follow-lost-reacquire/` — follow → lost → recover → reacquire.
- `fixtures/replay/follow-stuck-recovery/` — no-progress ticks → stuck-recovery → SafetyHold `stuck-exhausted`.
- `fixtures/replay/follow-emergency-stop/` — follow tick then emergency latch.

Phase 02/04/05 fixtures remain.

## Next exact work item

Phase 07 — Loot detection / ranking / pickup.

Suggested commit from the plan: `feat: add loot detection, ranking, and pickup controller`.
