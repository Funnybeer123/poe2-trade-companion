# Product Specification

## Product name
PoE2 QA Trade Bot / Trade Companion

## Primary outcome
Build a fully functional Path of Exile 2 automation accessory for authorized QA testing that can follow a character, identify and collect desirable loot, evaluate inventory, manage/sort stash items, price/list items, and execute configurable trading scenarios. Preserve a separate public companion mode for non-automation features.

## Supported environment
- Windows 11 first.
- Path of Exile 2 in Windowed or Windowed Fullscreen.
- Keyboard/mouse input automation in authorized QA mode.
- Recorded screenshot/video replay without live input for deterministic testing.

## Core shared features

### Price check
- Item capture and parse.
- Comparable search/provider request.
- Estimated low/fair/high value.
- Recommended listing price.
- Confidence + comparable count.
- Outlier filtering.
- Market-data timestamp.

### Desirability
- Explainable score from 0-100.
- Recommendation category.
- Reasons displayed/stored.
- Per-category/scenario preference overrides.

### Local item/stash state
- Persist observed items and locations.
- Reconcile observed inventory/stash UI state.
- Search by name, base, class, modifier text, recommendation, tab, and value range.
- Preserve capture and valuation history.
- Track uncertain/stale observations.

## Authorized QA automation features

### Automated following/navigation
- Select/configure a target character/leader.
- Detect target from visible game state.
- Follow target using generated movement inputs.
- Detect lost target, stuck state, and recovery conditions.
- Stop or switch recovery behavior according to scenario configuration.

### Automatic ground-loot pickup
- Detect visible loot/item labels.
- Rank items using desirability/value rules.
- Move/click to eligible loot.
- Skip items below configured thresholds.
- Handle inventory-full transitions.
- Record why each item was picked or skipped.

### Automated stash management
- Detect inventory and stash grids/tabs.
- Evaluate all observed items.
- Categorize items as keep/sell/vendor/craft/dump/bulk.
- Move items to configured stash destinations.
- Support bulk sorting sessions.
- Retry failed moves within scenario limits.
- Reconcile local shadow state after each operation.

### Automated selling/listing
- Calculate price and preferred currency.
- Apply configured price strategy/margins.
- Set item/listing price through visible game UI where possible.
- Reprice stale listings in enabled QA scenarios.
- Maintain sale/listing history.

### Automated trade scenarios
When explicitly enabled by a QA scenario:
- detect/consume trade requests or test-fixture equivalents;
- invite/join party as configured;
- move to expected trading context;
- open trade interaction;
- place correct item(s);
- inspect offered currency/item state using visible perception;
- compare against expected price;
- accept or reject according to scenario rules;
- finish/cleanup party/session state;
- log each decision and action.

### Market watcher
- saved searches;
- threshold alerts;
- value history;
- liquidity/history where available;
- provider abstraction and caching;
- rate-limit/backoff testing;
- failure injection for QA scenarios.

### Loot filter
- Generate market-aware PoE 2 filter profiles.
- Export locally.
- Optional official Account Item Filter API sync when supported/authenticated.

## Public Companion Mode
Retain a separate normal companion experience:
- manual price-check overlay;
- desirability scoring;
- local catalog;
- sort recommendations;
- sell recommendations;
- market watcher;
- loot-filter generation.

Automation modules must be unavailable in this mode.

## Automation acceptance criteria
A live or replayed full-loop scenario should be able to:
1. acquire/follow the configured target;
2. detect a desirable drop;
3. collect it;
4. determine inventory capacity;
5. transition to stash workflow when needed;
6. classify and sort inventory items;
7. identify sellable items;
8. price/list eligible items;
9. execute a configured trade test when a matching trade event is supplied;
10. produce a complete timestamped QA trace.

## Valuation acceptance criteria
Every valuation must include:
- item identifier/type;
- normalized key stats;
- provider name;
- market timestamp;
- candidate observation/listing count;
- comparables used after filtering;
- low/fair/high estimate;
- recommended listing price;
- confidence bucket;
- reason for low confidence when applicable.

## Desirability acceptance criteria
Identical inputs/configuration must produce deterministic results and expose the factors contributing to the score.

## QA trace acceptance criteria
Every generated game action must be attributable to:
- scenario;
- module;
- perceived state/evidence;
- confidence;
- decision rule/reason;
- generated input;
- observed result when available.
