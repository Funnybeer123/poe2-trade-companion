# Review State

**Phase under review:** 12 — Trade-session QA state machine  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 12 acceptance criteria are implemented. Gate commands are green. Accept requires observed currency + amount within tolerance (default 0). Replay uses `NoopInputSink` and `executed: false`. Emergency stop is legal in every trade state. Illegal edges throw in tests and become `FailedOrTimedOut` in prod. No packet sniffing. No undocumented trade-site APIs. Phase 13 orchestrator rewrite was not started.

## Scope reviewed

Actual Phase 12 diff vs `cursor/phase-11-listing-reprice-e0c0`:

- `packages/core/src/trade/*` (`types`, `tradeStateMachine`, `tradeEventPort`, `offerMatch`, `geometry`, `reasons`, `session`, `store`)
- `TradeController` + `createControllerMap` maps `TradeSession` to it
- `applyPostDecisionEffects` writes `tradeSession` / `trade_sessions` pending record
- `SqliteTradeSessions` + `MemoryTradeSessionStore`
- Replay packs `trade-success` / `trade-wrong-currency` / `trade-insufficient-currency` / `trade-wrong-item` / `trade-missing-item` / `trade-partial-stack` / `trade-timeout` / `trade-cancelled` / `trade-disconnect` / `trade-ui-desync` / `trade-emergency-stop`
- Unit / integration tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `npm test` (332), `test:replay` (33), `lint`, `typecheck` green on this host after review fixes.
- [x] Searched new code for TODOs / trade2 / POESESSID / packet sniff / native input: none in production trade modules.
- [x] Failures recorded and fixed (partial-stack fixture used whisper expected without `stackSize`; unused lint imports).

## Valuation / listing / trade checklist

- [x] No trade-search / listing HTTP client.
- [x] Offer match is observed, never assumed from the accept click.
- [x] Default reject on currency / amount / stack mismatch.
- [x] Timeout, cancel, disconnect → cleanup → failed, UI desync, emergency stop covered.
- [x] Replay zero native input; same `TradeController` as live.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `tradeController.ts` / `trade-partial-stack` | Whisper `expected` without `stackSize` overrode the session expected and accepted a 3/5 stack. | Fixed: in-progress session expected wins; fixture includes `stackSize`; controller unit test added. |
| LOW | `trade/types.ts`, machine test | Unused type imports after the first cut. | Fixed. |
| IMPROVEMENT | `geometry.ts` | Default trade UI points are named QA fixture constants, not live client calibration. | Kept; live paired-account trade remains `BLOCKED: windows-native`. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phase 13–15 (orchestrator, UI, packaging). Live trade against a real client remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
