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

Stash transfer, sort, scan, and voice features are on in the default app. **Ctrl+Shift+Esc** stops generated input.

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

## Market data and valuation

Every number the app shows is an estimate, never a guaranteed sale price. The
signals, in the order a price check trusts them:

- **Price table** (`Sort → Prices`). The single price source automation is
  allowed to act on. **Refresh market prices** pulls the current league's
  currency, stackables, and unique prices from poe2scout into read-only
  `feed:*` rows (one or two requests per refresh, never more often than every
  five minutes; optional daily auto-refresh). Manual rows are never overwritten and
  outrank a feed row for the same item.
- **Trade2 comps** (`Item log → Market comps`). On-demand listings for one
  item from the official trade site: one search + one fetch, serialized and
  paced from the server's own `X-Rate-Limit` headers (the pacing log is shared
  across the app and the CLI), raw listings cached on disk — six hours for
  base-type searches, one hour for unique-name searches — and re-scored per
  item by mod-family similarity. Works without a session cookie; `POESESSID`
  is optional. Never bulk scans.
- **Appraisal** — the mod-tier heuristic in `src/core/appraisal.ts` (value
  score + confidence), used when neither of the above knows the item.

**Ctrl+D / Read clipboard / Evaluate text** builds the valuation from those
signals (`src/core/localValuation.ts`): a price-table hit wins, then cached
comps, then the appraisal; otherwise the item is marked **no data**. A
deliberate check with no cached comps fires one trade2 lookup in the
background and re-publishes the evaluation when listings arrive; the passive
clipboard watcher and stash scans never touch the network. The Item log shows
which provider produced the number as a chip (price table / trade listings /
appraisal / no data).

The **league** is set under `Tools → Settings → Market data`. The picker lists
poe2scout's current leagues; `auto` is accepted only while exactly one current
softcore league exists and is refused when poe2scout lists more than one, so a
new league never silently prices against the wrong economy.

The bundled fixture quotes (`fixtures/market/quotes.json`) remain for tests,
replay, and the browser-only preview; the Electron app uses them only with
`POE2_FIXTURE_MARKET=1`, and the UI badges them **demo prices**.

**Loot filter** (`Tools → Loot filter`): generates a PoE2 item filter from the
price table — chase / valuable / pickup tiers in exalted, unique prices rated
per base type (filters cannot see names), currency by unit value, a Hide rule
only for low-level Normal (optionally Magic) gear, and nothing else ever
hidden. **Save…** opens the OS file dialog; the app never writes game files on
its own.

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

`docs/ai-prompts/SOL_MAX_PLAN_ONLY_PROMPT.md`

Sol Max should inspect the repository, create/update `plans/IMPLEMENTATION_PLAN.md`, identify risks, define phase acceptance criteria, then stop.

### 2. Grok 4.6 xhigh Fast implements it

Hand the repo/plan to Grok using:

`docs/ai-prompts/GROK_BOT_START_HERE.md`

and:

`docs/ai-prompts/GROK_46_XHIGH_FAST_BUILD_PROMPT.md`

Preferred Grok configuration:

- Grok 4.6;
- reasoning `xhigh`;
- Fast variant when available in the current platform.

Grok owns production implementation, tests, replay fixtures, fixes, phase commits, and implementation-state tracking.

Do not click Build in Sol Max under the current workflow. Sol Max is planning-only.

## Key documents

- `docs/ai-prompts/SOL_MAX_PLAN_ONLY_PROMPT.md` — authoritative Sol Max planning instructions.
- `docs/ai-prompts/GROK_BOT_START_HERE.md` — authoritative Grok bootstrap/handoff instructions.
- `docs/ai-prompts/GROK_46_XHIGH_FAST_BUILD_PROMPT.md` — authoritative Grok implementation instructions.
- `docs/ai-prompts/GROK_BOT_QA_PROMPT.md` — Grok per-phase self-review gate.
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

`docs/ai-prompts/CURSOR_PLAN_PROMPT.md` remains available as legacy planning context (as does the deprecated `docs/ai-prompts/SOL_MAX_BUILD_PROMPT.md`), but the current handoff starts with `docs/ai-prompts/SOL_MAX_PLAN_ONLY_PROMPT.md`.

## Current official API limitation

GGG's current developer reference marks Account Stashes, Guild Stashes, and Public Stashes as PoE 1 only. Do not invent a PoE 2 stash API. For QA automation, use observable client UI state, clipboard/screen perception, or a dedicated internal test interface only if one is explicitly supplied later.

## How to use the app

See **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** for install, copying items from PoE 2, each workspace (Items, Finder, Builds, Rules, Scans, Tools), and authorized-QA gates.

Quick start:

```
npm install
npm run dev
```

Hover an item in Path of Exile 2, copy it (`Ctrl+C`), then press **Ctrl+D** in the companion or use **Items → Read clipboard**. To empty the bag into stash, calibrate under Tools, open stash and inventory in-game, then use **Tools → Transfers → Empty**. **Ctrl+Shift+Esc** stops generated input.

Numpad hotkeys (via `npm run actions:daemon`, editable under **Tools → Hotkeys**): Num1 Stash, Num2 Sort, Num3 Fill, **Num4 Shop** (price the bag from the live feed + trade2 comps and list it in price-bucket merchant tabs through Ange's Manage Shop), Num6 Identify & drop (in map), Num7 Vendor cycle (in map). Num0 stops, Num5 pauses, Num8/9 are step-mode verdicts.

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
- Pre-commit gate (lint + both typechecks + unit tests, no packaging): `npm run check`
- Full local quality gate: `npm run test:full`

See `plans/IMPLEMENTATION_PLAN.md`.
