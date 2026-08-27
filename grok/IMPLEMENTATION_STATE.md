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
| Phase 07 | `d7e6286` on `cursor/phase-07-loot-detection-944f` (PR #8) | Loot detector / rank / pickup |
| Phase 08 | `91da7e2` on `cursor/phase-08-item-valuation-45b0` (PR #9) | Parse / valuation / desirability |
| Phase 09 | `53072a6` on `cursor/phase-09-inventory-observe-a61e` (PR #10) | Inventory / stash observation |
| Phase 10 first cut | `0474568` on `cursor/phase-10-stash-sort-b8bf` (PR #11) | Planner + StashController |
| Current commit | (this revision) | Gate + self-review on `cursor/phase-10-stash-sort-b8bf` (PR #11) |

## Active phase

None. Phase 10 is complete. Next is Phase 11.

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.
- Phase 03 — `RuntimeCapabilities`, `InterlockGate`, `GameInputController`, emergency-stop latch, Noop/Forbidden/Recording sinks, `packages/native-input` SendInput adapter, native-import CI guard, Electron `Ctrl+Shift+F12` hotkey.
- Phase 04 — `FixtureFrameSource`, `ReplayRunner`, `QaTraceWriter`, `InMemoryTraceSink`, `AutomationLoop`, SQLite migration runner + `SqliteTraceStore`, `follow-acquired` replay fixture, scenario catalog JSON.
- Phase 05 — `StateEstimator`, `FixturePerceptionAdapter`, merge/freshness/allowlist, `templateMatch`, `packages/perception-live` (Win32 process, `desktopCapturer` frame source, read-only clipboard), perception fixtures + `perception-estimate` replay.
- Phase 06 — `FollowController`, `RecoveryController`, `direction.ts` click-to-move, `stuckDetector`, `lostTargetTicks`, `DEFAULT_RECOVERY`, replay packs `follow-lost-reacquire` / `follow-stuck-recovery` / `follow-emergency-stop`.
- Phase 07 — `lootLabelDetector`, `LootController`, `InventoryController` stub, `FixtureDesirabilityScorer` / `DesirabilityPort`, rank/skip/suppression, replay packs `loot-desirable-vs-junk` / `loot-inventory-full` / `loot-unreachable-backoff`.
- Phase 08 — English `parseItem` adapter, SHA-256 fingerprint, fixture + official Currency Exchange providers, Tukey 1.5 IQR valuation, `DesirabilityEngine` / composite router, `loot-market-aware` replay.
- Phase 09 — `gridDetector`, `ShadowState` / `reconcile` (`ShadowItem`, `ReconcileResult`), estimator fills grid cells, real `InventoryController` (sets `stashSessionActive` when full; no transfers), SQLite inventory/stash snapshot persist + stale reload, replay `inventory-stale`.
- Phase 10 — `sortRules`, `transferPlanner` (pure, high value first), `StashController` for `InventoryFull` / `StashSort`. Transfers confirm after reconcile only. Max 3 attempts via `stash.failed-move` / `stash.wrong-tab`. Replay packs `stash-sort-success` / `stash-full-fallback` / `stash-failed-move-retry` / `stash-wrong-tab` / `stash-emergency-stop`.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 10 gate (2026-08-27, this host) — **green**:

- `npm test` — 263 tests
- `npm run test:replay` — 17 tests
- `npm run lint`
- `npm run typecheck`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — unchanged. Live inventory/stash overlay against a real client skipped on this Linux host.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API.

## Plan deviations

Phase 01–08 deviations unchanged.

Phase 09:

- Official stash/inventory APIs re-checked 2026-08-27: still PoE 1 only. No `StashApiObservationPort`. Perception + clipboard hover + shadow state only.
- `stashSessionActive` is still applied by `applyPostDecisionEffects` when inventory is full. Controllers return decisions only (§5.10); this matches the Phase 07 loop path and is not a transfer planner.
- Occupied cells without fingerprints never become `ShadowItem`s. `unexpected` requires an observed fingerprint.
- First fingerprint-bearing observation seeds the empty shadow as confirmed rather than unexpected.
- Sparse observed cell lists honor derived `capacity` when it is larger than `cells.length`, so one occupied cell is not treated as a 1/1 full grid.
- `withShadowMismatchReason` annotates the loop trace whenever `flags.shadowMismatch` is true, including when `InventoryFull` is not the selected state.

Phase 10:

- No invented PoE 2 stash API. Catalog + observed grids only (`flags.stashItemCatalog`).
- `FailedOrTimedOut` is the recovery `terminalState` string on the decision reason. The world/scheduler state used is `SafetyHold` (`flags.stashSafetyHold`) because `FailedOrTimedOut` is not an `AutomationStateId`.
- Empty plan clears `stashSessionActive` only when inventory is not full, so a full unidentified grid still starts a stash session (Phase 09 `inventory-stale` / `loot-inventory-full`).
- Expected pending moves are reclassified by `applyExpectedTransfer` so a confirmed transfer is not a `shadowMismatch`.
- `InventoryFull` / `StashSort` both use `StashController`. `InventoryController` remains observation-only for unit tests.

## Replay fixtures added

- `fixtures/replay/stash-sort-success/` — high-value first, then empty plan.
- `fixtures/replay/stash-full-fallback/` — primary tab full → dump tab click → drag.
- `fixtures/replay/stash-failed-move-retry/` — three observed failed drags → `FailedOrTimedOut`.
- `fixtures/replay/stash-wrong-tab/` — wrong tab retry, then dest visible → drag.
- `fixtures/replay/stash-emergency-stop/` — emergency stop mid-sort.

Phase 02/04/05/06/07/08/09 fixtures remain.

## Next exact work item

Phase 11 — Listing / repricing QA state machine. Do not start the trade machine.
