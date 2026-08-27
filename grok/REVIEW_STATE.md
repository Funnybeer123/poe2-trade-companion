# Review State

**Phase under review:** 14 — Operator / debug / replay UI  
**Date:** 2026-08-27  
**Reviewer:** Grok 4.6 xhigh Fast (self-review per `GROK_BOT_QA_PROMPT.md` + `docs/AI_REVIEW_CHECKLIST.md`)

## Result

`PASS`

Phase 14 acceptance criteria are implemented. Gate commands are green. Operator overlay can show state, arm/disarm (QA only), dry-run status, emergency stop, replay traces, and local filter export. Next work is Phase 15.

## Scope reviewed

Actual Phase 14 tree vs `cursor/phase-13-orchestration-e32b`:

- `packages/core/src/operator/*` — DTO copies, banner/price helpers, `OperatorRuntime`
- `packages/core/src/filter/lootFilter.ts` — local export only
- `packages/persistence-sqlite/src/sqliteSettingsStore.ts`
- `apps/desktop/electron-main.ts`, `preload.ts`, `operatorHost.ts`
- `apps/overlay/src/**` Vue views/banner/error panel
- Unit / integration / Playwright smoke listed in `TEST_GAPS.md`

## Repository health

- [x] Diff inspected.
- [x] `npm test` (367), `npm run test:smoke` (6), `lint`, `typecheck` green on this host after review fixes.
- [x] Searched new code for TODOs / trade2 / POESESSID / packet sniff / native input: none in operator/UI modules.
- [x] Failures recorded and fixed (filter line typing, unused expression, overly broad source-inspection regexes, in-memory Electron DB).

## Runtime / input / state checklist

- [x] Overlay talks DTO copies via `@poe2tc/core/operator`; `packages/core` does not import Electron.
- [x] Public companion cannot arm; `armQa()` returns `public-mode`.
- [x] QA banner required when `qaBannerRequired`; no dismiss control; STOP calls `EmergencyStop.trip()` via `OperatorRuntime`.
- [x] Price-check hotkey reads clipboard / parse only; no `GameInputController.enqueue`.
- [x] Replay path remains `NoopInputSink` (`sinkKind: "noop"`, `executed: false`).
- [x] IPC failures set an error panel and do not rearm.
- [x] Local filter export sets `oauthSync: false`.
- [x] Visible GGG disclaimer on overlay + Disclaimer view.

## Findings

| Severity | File | Observation | Disposition |
| --- | --- | --- | --- |
| MEDIUM | `operatorHost.ts` / `electron-main.ts` | Desktop runtime defaulted to `:memory:`, so operator settings would not survive an Electron restart even though the SQLite `settings` table exists. | Fixed: Electron uses `userData/poe2tc.sqlite` (overridable with `POE2TC_DB_PATH`). Tests still use `:memory:` or a temp file. |
| LOW | `tests/unit/ui/banner.test.ts` | Source regex matched the phrase “cannot be dismissed”. | Tightened assertion. |
| LOW | `tests/unit/filter/lootFilter.test.ts` | Negative OAuth regex matched the “No OAuth filter sync” header. | Tightened assertion. |
| LOW | `electron-main.ts` comment | Source test treated the words `GameInputController` in a “must not call” comment as an import. | Test now requires an import. |
| IMPROVEMENT | Playwright smoke | Headless Chromium + Vite mock IPC, not headed Electron. Real `OperatorRuntime.runReplay` is unit-tested against `full-loop`. | Documented; allowed by the Phase 14 Linux host rule. |

No remaining BLOCKER or HIGH defects for this phase.

## Invariants deferred

Phase 15 (public vs QA packaging, first-run wizard, electron-builder). Live overlay against a real client remains `BLOCKED: windows-native`. See `TEST_GAPS.md`.
