# Implementation Phases

**Executable order:** `plans/IMPLEMENTATION_PLAN.md` is the authoritative phase sequence (01→15, kernel-first). This file is the historical item-parser-first list and is **not** the implementation order. Keep the mapping in the plan’s §2.6 when both docs are edited.

## Phase 0 — Research and foundation
- Verify current GGG docs, PoE 2 APIs, Cursor behavior, and Exiled Exchange 2 upstream/license.
- Implement runtime capability model.
- Define QA build/runtime gate.
- Lock package manager and Node version.
- Add CI for lint/typecheck/tests.

Gate: architecture decision recorded, QA/public mode separation designed, and no licensing unknown blocks implementation.

## Phase 1 — Item capture, parsing, valuation fixtures
- Clipboard capture.
- Item parser.
- Normalized domain model.
- Fixture corpus.
- Market provider abstraction and fixture provider.

Gate: representative PoE 2 items parse reliably from saved fixtures.

## Phase 2 — Market data, valuation, desirability
- Live supported provider(s).
- Cache/rate limits/backoff.
- Valuation engine.
- Explainable desirability.

Gate: deterministic corpus returns explainable market-aware decisions and failures do not hang/spam.

## Phase 3 — QA automation harness and replay
- `FrameSource` abstraction.
- `InputSink`/`GameInputController` abstraction.
- Recorded-session replay.
- QA action trace.
- Scenario model.
- Emergency stop and capability checks.

Gate: replay can run a scripted scenario and produce intended actions without sending real input.

## Phase 4 — Screen capture and perception foundation
- PoE window detection/allowlist.
- Low-latency screen capture.
- UI region detection.
- OCR/template/object-detection strategy.
- Confidence model.
- Debug overlay.

Gate: stable perception fixtures for inventory, stash, loot labels, and selected navigation cues.

## Phase 5 — Automated following/navigation
- Target acquisition.
- Relative direction estimation.
- Movement controller.
- Lost-target behavior.
- Stuck detection/recovery.
- Scenario timing/rate control.

Gate: follow scenarios pass in replay and live authorized QA test with kill-switch verification.

## Phase 6 — Automatic loot detection/pickup
- Loot target detection.
- Label/item classification.
- Market/desirability ranking.
- Path/click decision.
- Pickup result verification.
- Inventory-full transition.

Gate: replay/live test collects eligible loot and skips excluded loot according to scenario policy.

## Phase 7 — Inventory and stash perception
- Inventory grid/cell detection.
- Stash tab/grid detection.
- Item observation/fingerprinting.
- Local shadow state reconciliation.
- SQLite snapshots/history.

Gate: observed state survives restart and mismatches/stale observations are handled explicitly.

## Phase 8 — Automated stash sorting
- Destination rule engine.
- Bulk transfer planner.
- Input execution.
- Move verification/retry.
- Recovery from wrong tab/full tab/failed move.

Gate: configured QA stash scenario sorts a fixture/live inventory into expected destinations and trace explains every move.

## Phase 9 — Automated listing/repricing
- Price recommendation.
- Listing policy.
- UI workflow for setting price where supported.
- Stale listing/reprice loop in QA scenario.
- Listing history.

Gate: fixture/live QA scenario applies expected listing values and can run in dry-run mode.

## Phase 10 — Automated trade scenarios
- Trade-event fixture/live signal adapter.
- Party/invite state machine.
- Trading-context navigation.
- Trade-window perception.
- Item/currency verification.
- Accept/reject rules.
- Completion/cleanup.

Gate: deterministic replay covers success, wrong currency, missing item, timeout, cancelled trade, partial stack, disconnect, and emergency stop.

## Phase 11 — Full-loop orchestrator
- Scenario scheduler.
- Priority arbitration among follow/loot/stash/trade.
- State transitions.
- Recovery policies.
- Action budget/rate limiting.

Gate: end-to-end scenario follows target, loots, stashes, lists, and executes a test trade with complete trace.

## Phase 12 — Companion UI and diagnostics
- Price-check overlay.
- Catalog/search.
- Automation dashboard.
- Scenario editor.
- Live perception status.
- Action trace/replay viewer.
- Settings/hotkeys.

Gate: operator can see state, arm/disarm modules, dry-run, stop automation, and inspect reasons.

## Phase 13 — Loot filter and optional official API sync
- Filter generator.
- Local export.
- Optional supported OAuth filter sync.

Gate: local export works without OAuth; sync is isolated/optional.

## Phase 14 — Packaging and hardening
- Separate public/QA packaging where practical.
- Windows installer.
- Crash-safe logging/redaction.
- First-run setup.
- Clean VM smoke tests.
- CPU/GPU/latency profiling.

Gate: clean-install acceptance tests pass and automation cannot arm without QA gating.
