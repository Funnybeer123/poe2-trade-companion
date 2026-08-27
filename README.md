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

### Manual deal finder

The **Deal finder** is available in public-companion mode and does not generate game input. Evaluate an
item from the Price check tab, open Deal finder, then enter the seller's asking price and an optional
fee/slippage percentage. It shows potential profit and return using the recommended listing estimate,
along with confidence, comparable sample size, estimated costs, and stale-data warnings. These are
estimates for manual decision support, not guaranteed sale prices.

## Item intelligence

The companion now keeps item-finding work in five connected workspaces:

- **Items** parses clipboard or pasted item text into identity, properties,
  ordered modifier sections, numeric rolls, valuation, desirability, and a
  durable local catalog.
- **Finder** builds validated stash-search expressions without truncating an
  over-limit regex. Large selections are split into labeled searches.
- **Builds** imports user-supplied official trade links or exported query JSON
  into local gear-slot targets. Opaque search IDs are retained as unsupported
  provenance and are never fetched automatically.
- **Rules** uses one OR-of-AND rule parser/evaluator for editing, validation,
  matching, and near-miss explanations.
- **Scans** reviews imported or QA-generated scan sessions and slot outcomes.

Item, build, rule, and scan state is stored in a local SQLite database under
the Electron user-data directory. Legacy scan history, regex history, trade
presets, and scan JSONL can be imported idempotently and exported through the
versioned item-intelligence contract.

The bundled fixture market provider is deterministic test/demo data, not live
market data and not a guaranteed sale price. The undocumented Trade2 provider
is disabled; a live provider must use a documented API or explicit service
authorization.

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
- `docs/USER_GUIDE.md` — how to install and use the companion.
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — authorized source revision and reuse boundaries.
- `docs/IMPLEMENTATION_PHASES.md` — implementation order.
- `docs/TEST_PLAN.md` — test strategy.

`CURSOR_PLAN_PROMPT.md` remains available as legacy planning context, but the current handoff starts with `SOL_MAX_PLAN_ONLY_PROMPT.md`.

## Current official API limitation

GGG's current developer reference marks Account Stashes, Guild Stashes, and Public Stashes as PoE 1 only. Do not invent a PoE 2 stash API. For QA automation, use observable client UI state, clipboard/screen perception, or a dedicated internal test interface only if one is explicitly supplied later.

## How to use the app

See **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** for install, copying items from PoE 2, each workspace (Items, Finder, Builds, Rules, Scans, Tools), and authorized-QA gates.

Quick start (public companion, no game input):

```
npm install
npm run dev
```

Hover an item in Path of Exile 2, copy it (`Ctrl+C`), then press **Ctrl+D** in the companion or use **Items → Read clipboard**.

## Develop
```
npm install
npm test
npm run typecheck
npm run lint
npm run dev
```

- Public build: `npm run build:public`
- QA build (separate artifact, still requires local acknowledgement to arm): `npm run build:qa`
- Full local quality gate: `npm run test:full`

See `plans/IMPLEMENTATION_PLAN.md`.
