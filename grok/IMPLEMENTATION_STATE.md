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
| Phase 08 first cut | `bdfa3c1` on `cursor/phase-08-item-valuation-45b0` (PR #9) | Parse / valuation / desirability |
| Current commit | `91da7e2` | Phase 08 docs note on `cursor/phase-08-item-valuation-45b0` (PR #9) |
| Phase 09 branch | `cursor/phase-09-inventory-observe-a61e` | Inventory / stash observation (this work) |

## Active phase

Phase 09 — Inventory / stash observation and reconciliation.

## Completed phases (01–08)

Unchanged. Phase 09 implementation is on this branch and not yet gate-complete.

## Phase 09 work in this revision

- `gridDetector` (fixture cells + pixel occupancy + clipboard hover fingerprint)
- `ShadowState` + `reconcile` (`ShadowItem` / `ReconcileResult`)
- Estimator fills inventory/stash cells and recomputes occupancy/`full`
- Real `InventoryController` (sets `stashSessionActive` when full via existing post-decision effect; no transfers)
- SQLite `inventory_snapshots` / `stash_snapshots` via `SqliteInventoryStore`
- Restart path: last snapshots load with `freshness: "stale"`
- Replay `inventory-stale`: 12/12 → `InventoryFull`; drop cell → no longer full

## Completed phases

- Phase 01 — workspace, CI, MIT license, hello-world Electron/Vue apps, `workspaceOk()`, migration file, Grok tracking.
- Phase 02 — canonical `WorldState`, freshness, `Clock`/`FrozenClock`, deterministic `ScenarioScheduler`, 8 scheduler-priority replay snapshots.
- Phase 03 — `RuntimeCapabilities`, `InterlockGate`, `GameInputController`, emergency-stop latch, Noop/Forbidden/Recording sinks, `packages/native-input` SendInput adapter, native-import CI guard, Electron `Ctrl+Shift+F12` hotkey.
- Phase 04 — `FixtureFrameSource`, `ReplayRunner`, `QaTraceWriter`, `InMemoryTraceSink`, `AutomationLoop`, SQLite migration runner + `SqliteTraceStore`, `follow-acquired` replay fixture, scenario catalog JSON.
- Phase 05 — `StateEstimator`, `FixturePerceptionAdapter`, merge/freshness/allowlist, `templateMatch`, `packages/perception-live` (Win32 process, `desktopCapturer` frame source, read-only clipboard), perception fixtures + `perception-estimate` replay.
- Phase 06 — `FollowController`, `RecoveryController`, `direction.ts` click-to-move, `stuckDetector`, `lostTargetTicks`, `DEFAULT_RECOVERY`, replay packs `follow-lost-reacquire` / `follow-stuck-recovery` / `follow-emergency-stop`.
- Phase 07 — `lootLabelDetector`, `LootController`, `InventoryController` stub, `FixtureDesirabilityScorer` / `DesirabilityPort`, rank/skip/suppression, replay packs `loot-desirable-vs-junk` / `loot-inventory-full` / `loot-unreachable-backoff`.
- Phase 08 — English `parseItem` adapter, SHA-256 fingerprint, fixture + official Currency Exchange providers, Tukey 1.5 IQR valuation, `DesirabilityEngine` / composite router, `loot-market-aware` replay.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 08 gate (2026-08-27, this host) — **green**:

- `npm test` — 216 tests
- `npm run test:replay` — 11 tests
- `npm run lint`
- `npm run typecheck`

Self-review: `PASS` (`grok/REVIEW_STATE.md`).

## Blockers

- **BLOCKED: windows-native** — unchanged. Live clipboard parse against a real item skipped on this Linux host.
- External / later-phase: Windows live client, OAuth registration freeze, no official PoE 2 stash/trade-search API.

## Plan deviations

Phase 01–07 deviations unchanged.

Phase 08:

- EE2 `LICENSE` re-verified MIT at `acc7653f05629228f12e273ab1b8da3e46d6bcd1` (2026-06-20) on 2026-08-27 **before** any copy. See `packages/core/src/vendor/exiled-exchange-2/SOURCE.txt`.
- Vendored `renderer/src/parser/*` plus the `renderer/src/assets/data` files those import (`index.ts`, `interfaces.ts`). Did **not** vendor overlay/input/hotkey/trade-site code.
- `parseClipboard` is **not executed**. `Parser.ts` imports `@/web/Config` and `@/assets/data`, and the data module imports `@/web/background/TradeData` plus Vite-hosted ndjson that is not in the EE2 git tree. Calling it would pull a trade-site client, which Phase 08 forbids. `parseItem` is the English clipboard adapter using EE2 `itemTextToSections` / nameplate grammar and vendored `ItemCategory` from `parser/meta.ts` (the only compiled vendor module).
- Outlier method locked: Tukey 1.5 IQR (`OUTLIER_METHOD`). Samples with n < 4 are not filtered; low/fair/high then use min/median/max.
- Default market path: fixtures + optional official Currency Exchange (`realm=poe2` only). No `trade2` client, no POESESSID/cookie capture.
- `FixtureDesirabilityScorer` kept for label-only and adversarial loot. `DesirabilityEngine` runs when a `NormalizedItem` is available. Default port is `CompositeDesirabilityPort`.
- `LootTarget.clipboardText` added so derived loot can carry clipboard dumps. Existing label-only fixtures unchanged.
- SQLite cache writes go through `MarketCachePort` (`MemoryMarketCache` in core, `SqliteMarketCache` in persistence-sqlite). No new migration; uses `market_comparables_cache` / `valuations` from `001_init.sql`.

## Replay fixtures added

- `fixtures/replay/loot-market-aware/` — clipboard-bearing unique picked via engine + fixture quotes; Wisdom skipped.

Phase 02/04/05/06/07 fixtures remain.

## Next exact work item

Phase 09 — Inventory / stash observation and reconciliation.
