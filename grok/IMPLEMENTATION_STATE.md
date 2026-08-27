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
| Phase 06 | `684f24d` on `cursor/phase-06-follow-navigation-8044` (PR #7) | Follow/recovery complete |
| Phase 07 first cut | `ca1357e` on `cursor/phase-07-loot-detection-944f` (PR #8) | Loot detector / rank / pickup |
| Current branch | `cursor/phase-07-loot-detection-944f` | Phase 07 complete after gate + self-review |

## Active phase

None. Phase 07 is complete. Next is Phase 08.

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.
- Phase 03 — `RuntimeCapabilities`, `InterlockGate`, `GameInputController`, emergency-stop latch, Noop/Forbidden/Recording sinks, `packages/native-input` SendInput adapter, native-import CI guard, Electron `Ctrl+Shift+F12` hotkey.
- Phase 04 — `FixtureFrameSource`, `ReplayRunner`, `QaTraceWriter`, `InMemoryTraceSink`, `AutomationLoop`, SQLite migration runner + `SqliteTraceStore`, `follow-acquired` replay fixture, scenario catalog JSON.
- Phase 05 — `StateEstimator`, `FixturePerceptionAdapter`, merge/freshness/allowlist, `templateMatch`, `packages/perception-live` (Win32 process, `desktopCapturer` frame source, read-only clipboard), perception fixtures + `perception-estimate` replay.
- Phase 06 — `FollowController`, `RecoveryController`, `direction.ts` click-to-move, `stuckDetector`, `lostTargetTicks`, `DEFAULT_RECOVERY`, replay packs `follow-lost-reacquire` / `follow-stuck-recovery` / `follow-emergency-stop`.
- Phase 07 — `lootLabelDetector`, `LootController`, `InventoryController` stub, `FixtureDesirabilityScorer` / `DesirabilityPort`, rank/skip/suppression, replay packs `loot-desirable-vs-junk` / `loot-inventory-full` / `loot-unreachable-backoff`.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 07 gate (2026-08-27, this host) — **green**:

- `npm test` — 197 tests
- `npm run test:replay` — 10 tests
- `npm run lint`
- `npm run typecheck`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — unchanged. Live dry-run loot highlights / one armed pickup skipped on this Linux host.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API.

## Plan deviations

Phase 01–06 deviations unchanged.

Phase 07:

- `AutomationScenario.lootMinScore` is optional (default 40). Adversarial means `lowConfidencePolicy === "adversarial-execute"`.
- `FixtureDesirabilityScorer` is the real `DesirabilityPort` for this gate. Keyword/rarity/fixture-score mapping only; no parser or market (Phase 08).
- `lootLabelDetector` prefers `derived.loot`, otherwise color-blob rarity detection on `frame.pixels` plus optional `OcrPort`. No `tesseract.js` in `packages/core`.
- Pickup attempt / 15s suppression lives on `WorldState.flags` (`pendingLootPickup`, `lootAttemptCounts`, `lootLastAttemptMs`, `lootSuppressedUntilMs`). Estimator observes success (label gone or occupancy up) and applies `DEFAULT_RECOVERY["loot.unreachable"]`. Controllers stay stateless.
- Inventory controller is a Phase 07 stub: `InventoryFull` → noop `inventory-full`; `applyPostDecisionEffects` sets `flags.stashSessionActive`. Real inventory/stash observation is Phase 09.
- `hasHighValueLoot` ignores items with `skipReason` so suppressed or junk labels do not keep HighValueLoot selected.
- Scoring/skip annotation runs in `AutomationLoop` after the estimator and before the scheduler so `LootTarget.score` / `skipReason` are visible to `HighValueLoot` / `LootPickup`.

## Replay fixtures added

- `fixtures/replay/loot-desirable-vs-junk/` — Divine picked, Wisdom skipped, observed pickup → Idle.
- `fixtures/replay/loot-inventory-full/` — full inventory → `InventoryFull`, no pickup clicks.
- `fixtures/replay/loot-unreachable-backoff/` — two failed pickups → 15s suppress.

Phase 02/04/05/06 fixtures remain.

## Next exact work item

Phase 08 — Item parsing / market valuation / desirability.

Suggested commit from the plan: `feat: add PoE2 item parse, valuation, and desirability engine`.
