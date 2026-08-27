# Review State

**Phase under review:** 08 — Item parsing / market valuation / desirability  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 08 acceptance criteria are implemented. Gate commands are green. Corpus parses. Valuations expose confidence + sample size and are never a guaranteed sale price. No undocumented trade client. MIT notices present.

## Scope reviewed

Actual Phase 08 diff vs `cursor/phase-07-loot-detection-944f`:

- `packages/core/src/vendor/exiled-exchange-2/` (LICENSE, SOURCE.txt, parser/*, assets/data)
- `NOTICE`, eslint ignore, core tsconfig excludes for non-compilable vendor files
- `packages/core/src/items/{parseItem,fingerprint,desirabilityEngine,compositeDesirability}.ts`
- `packages/core/src/market/{rateLimitFetch,valuation,fixtureMarketProvider,officialCurrencyExchangeProvider,marketCache}.ts`
- `LootTarget.clipboardText`, composite default on loop / LootController / annotateLoot
- `SqliteMarketCache`
- fixtures `items/*`, `market/*`, `replay/loot-market-aware/`
- unit/integration/replay tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `npm test` (216), `test:replay` (11), `lint`, `typecheck` green on this host after review fixes.
- [x] Searched new non-vendor code for TODOs / trade2 / POESESSID storage / retry storms: none. Upstream vendor TODOs left untouched.
- [x] Failures recorded and fixed (gem `Level:` overwritten by Requirements; `isGuaranteedSalePrice` asserted on `MarketQuote`).

## Valuation / desirability checklist

- [x] Market 429 honors Retry-After and does not retry.
- [x] 5xx / offline fail closed or reuse cache within `maxAgeMs`.
- [x] Price confidence + sample size on every quote.
- [x] Offline/replay fixtures exist (`fixtures/market/*.json`).
- [x] Outlier method locked: Tukey 1.5 IQR.
- [x] `FixtureDesirabilityScorer` kept for label-only / adversarial loot.
- [x] `DesirabilityEngine` used when a `NormalizedItem` is available.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `automationLoop` / `LootController` / `annotateLoot` | Default port was still fixture-only, so clipboard text would be ignored unless a composite was injected. | Fixed: default is `CompositeDesirabilityPort`. |
| LOW | `parseItem.ts` | Gem `Level: 5` overwritten by Requirements `Level: 14`. | Fixed: first gem level wins. |
| LOW | `currencyExchange.test.ts` | Asserted `isGuaranteedSalePrice` on `MarketQuote`. | Fixed: field lives on `ValuationResult`. |
| IMPROVEMENT | EE2 `parseClipboard` | Not executed; requires TradeData + Vite ndjson. | Documented deviation; adapter implements English grammar. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phases 09–15 (stash/listing/trade, packaging). Live Windows clipboard parse remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
