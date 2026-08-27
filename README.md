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

## AI development workflow

This repo uses two distinct AI roles.

### 1. Sol Max creates the plan

Open the repo in Cursor with Sol Max and use:

`SOL_MAX_PLAN_ONLY_PROMPT.md`

Sol Max should inspect the repository, create/update `plans/IMPLEMENTATION_PLAN.md`, identify risks, define phase acceptance criteria, then stop.

### 2. Grok 4.6 xhigh Fast implements it

Hand the repo/plan to Grok using:

`GROK_BOT_START_HERE.md`

and:

`GROK_46_XHIGH_FAST_BUILD_PROMPT.md`

Preferred Grok configuration:

- Grok 4.6;
- reasoning `xhigh`;
- Fast variant when available in the current platform.

Grok owns production implementation, tests, replay fixtures, fixes, phase commits, and implementation-state tracking.

Do not click Build in Sol Max under the current workflow. Sol Max is planning-only.

## Key documents

- `SOL_MAX_PLAN_ONLY_PROMPT.md` — authoritative Sol Max planning instructions.
- `GROK_BOT_START_HERE.md` — authoritative Grok bootstrap/handoff instructions.
- `GROK_46_XHIGH_FAST_BUILD_PROMPT.md` — authoritative Grok implementation instructions.
- `GROK_BOT_QA_PROMPT.md` — Grok per-phase self-review gate.
- `docs/AI_DEVELOPMENT_WORKFLOW.md` — shared AI ownership/workflow.
- `docs/AI_REVIEW_CHECKLIST.md` — implementation review checklist.
- `AGENTS.md` — persistent project instructions.
- `docs/PRODUCT_SPEC.md` — required features/acceptance criteria.
- `docs/ARCHITECTURE.md` — architecture.
- `docs/QA_AUTOMATION_BOUNDARY.md` — automation gates and testing boundary.
- `docs/GGG_COMPLIANCE.md` — public guidance vs authorized QA separation.
- `plans/IMPLEMENTATION_PLAN.md` — authoritative executable phase order (01→15).
- `docs/IMPLEMENTATION_PHASES.md` — historical item-first list; not the execution order.
- `docs/TEST_PLAN.md` — test strategy.

`CURSOR_PLAN_PROMPT.md` remains available as legacy planning context, but the current handoff starts with `SOL_MAX_PLAN_ONLY_PROMPT.md`.

## Current official API limitation

GGG's current developer reference marks Account Stashes, Guild Stashes, and Public Stashes as PoE 1 only. Do not invent a PoE 2 stash API. For QA automation, use observable client UI state, clipboard/screen perception, or a dedicated internal test interface only if one is explicitly supplied later.

Official item-filter OAuth sync is **BLOCKED: oauth-registration** (GGG is not accepting new applications; no test client is supplied). Local `.filter` export works without OAuth.

## Commands

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:replay
npm run test:smoke
node scripts/check-native-input-imports.mjs
node scripts/verify-public-build-excludes-native.mjs --files-from fixtures/packaging/public-file-list.txt
```

### Packaging

Public and QA artifacts are split. The public pack must not include `packages/native-input` or an armable QA mode.

```bash
npm run pack:public    # directory pack; bakes POE2TC_MODE=public-companion
npm run pack:qa        # directory pack; productName "PoE2 QA Automation (Authorized)"
```

These scripts produce **directory packs** (`electron-builder --dir`). They do **not** invent a Windows installer on Linux. An NSIS installer requires a Windows runner (`BLOCKED: windows-vm` on Linux CI).

Configs: `electron-builder.public.yml`, `electron-builder.qa.yml`.

### Runtime modes

- Public artifact: compile-time `POE2TC_MODE=public-companion`. Setting `POE2TC_RUNTIME_MODE=authorized-qa` cannot enable QA.
- QA artifact: compile-time `POE2TC_MODE=authorized-qa`. First-run must type `AUTHORIZED QA` and tick the acknowledgement checkbox before QA is selected.

Visible disclaimer: `This product isn't affiliated with or endorsed by Grinding Gear Games in any way.`
