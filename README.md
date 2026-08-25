# PoE2 QA Trade Bot / Trade Companion

A Windows-first Path of Exile 2 automation and trading project with two operating modes:

- **Public Companion Mode** for price checks, item valuation, stash intelligence, market monitoring, and loot filters.
- **Authorized QA Automation Mode** for testing bot behavior including following, auto-loot, stash management, automated listing/selling flows, and automated trade scenarios.

> Public-player use of the automation features would conflict with GGG's published third-party guidance. The QA automation mode is intended only for explicitly authorized testing.

## Authorized QA goal

Build a fully functional PoE 2 test bot that can:

- follow a configured character/leader;
- identify and automatically pick up desirable ground loot;
- evaluate items using market data and explainable desirability scoring;
- monitor inventory capacity;
- move items into configured stash tabs;
- bulk-sort stash/inventory items;
- identify items worth selling;
- calculate listing prices;
- automate listing/repricing workflows where the visible client supports them;
- execute configurable end-to-end trade scenarios;
- record a complete action/perception/decision trace for QA review;
- replay recorded sessions without sending input.

## QA controls

The automation implementation must include:
- explicit `authorized-qa` runtime/build mode;
- persistent QA banner;
- global emergency stop;
- process/window allowlist;
- optional realm/account/scenario allowlists when identifiers are actually available;
- dry-run mode;
- per-module enable/disable switches;
- action-rate limits;
- structured QA traces;
- deterministic replay.

## Public Companion Mode

The same codebase should also retain:
- price-check overlay;
- desirable-item scoring;
- local item/stash catalog;
- manual sort recommendations;
- sell recommendations;
- market watchers;
- loot-filter generation.

Automation modules must not arm in this mode.

## Preferred stack
- Electron
- TypeScript
- Vue 3
- Vite
- SQLite
- Vitest
- Playwright
- Electron Builder

Prefer reusing suitable MIT-licensed Exiled Exchange 2 parsing/trade-query code rather than rewriting mature parsing logic.

## Start in Cursor Plan Mode

1. Clone/open this repository in Cursor.
2. Open Agent and switch to **Plan Mode**.
3. Paste `CURSOR_PLAN_PROMPT.md`.
4. Have Cursor save the plan to `plans/IMPLEMENTATION_PLAN.md`.
5. Review the highest-risk assumptions.
6. Click **Build**.
7. Implement and commit one phase at a time.

## Key documents
- `CURSOR_PLAN_PROMPT.md` — authoritative Cursor Plan Mode instructions.
- `AGENTS.md` — persistent project instructions.
- `docs/PRODUCT_SPEC.md` — required features/acceptance criteria.
- `docs/ARCHITECTURE.md` — architecture.
- `docs/QA_AUTOMATION_BOUNDARY.md` — automation gates and testing boundary.
- `docs/GGG_COMPLIANCE.md` — public guidance vs authorized QA separation.
- `docs/IMPLEMENTATION_PHASES.md` — implementation order.
- `docs/TEST_PLAN.md` — test strategy.

## Current official API limitation
GGG's current developer reference marks Account Stashes, Guild Stashes, and Public Stashes as PoE 1 only. Cursor must not invent a PoE 2 stash API. For QA automation, use observable client UI state, clipboard/screen perception, or a dedicated internal test interface only if one is explicitly supplied later.
