# Review State

**Phase under review:** 11 — Listing / repricing QA state machine  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 11 acceptance criteria are implemented. Gate commands are green. Recommended listing is policy math, never a guaranteed sale. Dry-run/replay emit zero native input. Verify mismatch retries once. Emergency stop is legal in every listing state. No trade-session machine. No listing API.

## Scope reviewed

Actual Phase 11 diff vs `cursor/phase-10-stash-sort-b8bf`:

- `packages/core/src/listing/*` (`types`, `pricePolicy`, `listingStateMachine`, `geometry`, `reasons`, `session`, `history`, `quoteResolve`)
- `ListingController` + `createControllerMap` maps `Listing` to it
- `applyPostDecisionEffects` writes `listingSession` / `listing_history` pending record
- `SqliteListingHistory` + `MemoryListingHistoryStore`
- Replay packs `listing-apply-price`, `listing-reprice-stale`, `listing-low-confidence-skip`, `listing-emergency-stop`
- Unit / integration tests listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `npm test` (291), `test:replay` (21), `lint`, `typecheck` green on this host after review fixes.
- [x] Searched new code for TODOs / trade2 / listing HTTP / guaranteed sale: none.
- [x] Failures recorded and fixed (prefer-const; listing_history re-append).

## Valuation / listing checklist

- [x] Market 429 / throttle uses cache or skip.
- [x] Price confidence / sample represented on catalog quotes.
- [x] Offline / replay fixtures exist.
- [x] Listing changes verify observed `listing.priceText` (never assume apply succeeded).
- [x] Trade machine not started (Phase 12).

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `automationLoop.ts` | After a terminal listing write, `pendingListingHistory` stayed on world flags and could be appended again on a later tick. | Fixed: clear the pending record after persist; integration asserts a single history row. |
| LOW | `quoteResolve.ts` | `let quote` was never reassigned. | Fixed: `const`. |
| IMPROVEMENT | `geometry.ts` | Default listing UI points are named QA fixture constants, not live client calibration. | Kept; live overlay remains `BLOCKED: windows-native`. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phase 12–15 (trade machine, packaging). Live listing UI remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
