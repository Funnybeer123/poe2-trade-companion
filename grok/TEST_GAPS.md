# Test Gaps

**Updated:** 2026-08-27 (end of Phase 01)

## Covered in Phase 01

- `workspaceOk() === true` (`tests/unit/workspace-ok.test.ts`)
- `migrations/001_init.sql` contains `qa_action_traces` (`tests/integration/migrations-exist.test.ts`)
- Lint, typecheck, and workspace compile via CI

## Intentionally absent (later phases)

| Gap | First phase |
| --- | --- |
| Scheduler priority / interrupt / determinism | 02 |
| Public mode cannot emit native input | 03 |
| QA arming, kill switch, allowlist, dry-run, rate limit | 03 |
| Native-import guard script | 03 |
| Replay runner + traces | 04 |
| Perception / estimator | 05 |
| Follow / recovery | 06 |
| Loot rank / pickup | 07 |
| Parser / valuation | 08 |
| Inventory / stash reconcile | 09 |
| Stash transfers | 10 |
| Listing machine | 11 |
| Trade machine | 12 |
| Full-loop orchestrator | 13 |
| Playwright overlay smoke | 14 |
| Public vs QA packaging | 15 |

## Replay

No replay tests yet. `npm run test:replay` is wired and allowed to pass with zero files (`passWithNoTests`). See `REPLAY_BACKLOG.md`.
