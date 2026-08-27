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
| Phase 10 | `0fee99f` on `cursor/phase-10-stash-sort-b8bf` (PR #11) | Stash sort complete |
| Phase 11 first cut | `a4faa0f` on `cursor/phase-11-listing-reprice-e0c0` (PR #12) | Listing machine + replay packs |
| Current commit | (this revision) | Gate + self-review on `cursor/phase-11-listing-reprice-e0c0` (PR #12) |

## Active phase

None. Phase 11 is complete. Next is Phase 12.

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
- Phase 11 — `pricePolicy`, table-driven `listingStateMachine`, `ListingController`. Recommended listing = `fair * (1 - undercutPct)` unless below `low`. Persist `listing_history`. Replay packs `listing-apply-price` / `listing-reprice-stale` / `listing-low-confidence-skip` / `listing-emergency-stop`.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 11 gate (2026-08-27, this host) — **green**:

- `npm test` — 291 tests
- `npm run test:replay` — 21 tests
- `npm run lint`
- `npm run typecheck`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — unchanged. Live listing UI against a real client skipped on this Linux host.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search/listing API.

## Plan deviations

Phase 01–10 deviations unchanged.

Phase 11:

- No listing API. Visible client UI only (named QA fixture coordinates in `listing/geometry.ts`, same pattern as stash tab clicks).
- Recommended listing = `fair * (1 - undercutPct) * (1 + markupPct)` then floor at `low`, then `minPrice`. `markupPct` default 0 so the locked formula is `fair * (1 - undercutPct)` unless below `low`.
- `FailedOrTimedOut` is a `ListingState`. The automation state used on that tick is `SafetyHold` because `FailedOrTimedOut` is not an `AutomationStateId`.
- Verify mismatch retries once (`DEFAULT_RECOVERY["listing.verify-mismatch"].maxAttempts = 2` apply attempts). 429 uses `MarketCachePort` or skip.
- Listing machine session lives on `world.flags.listingSession` / `listingCatalog`. Controllers stay stateless.
- Trade-session machine was not started.

## Replay fixtures added

- `fixtures/replay/listing-apply-price/` — select → open UI → apply 14.55 → verify `priceText`.
- `fixtures/replay/listing-reprice-stale/` — open stale listing → reprice → verify.
- `fixtures/replay/listing-low-confidence-skip/` — skip + reason, no listing clicks.
- `fixtures/replay/listing-emergency-stop/` — emergency stop during ApplyPrice.

Phase 02–10 fixtures remain.

## Next exact work item

Phase 12 — Trade-session QA state machine. Do not start the full-loop orchestrator.
