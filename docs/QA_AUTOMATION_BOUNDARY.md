# Authorized QA Automation Boundary

## Purpose
This repository intentionally includes automation that normal Path of Exile 2 players should not run under GGG's published third-party guidance. These modules exist for authorized QA testing of bots, automation behavior, anti-bot controls, trading flows, stash behavior, and related systems.

## Build/runtime separation
Support two explicit modes:

- `public-companion`
- `authorized-qa`

The build pipeline should optionally produce separate artifacts so an ordinary companion build cannot accidentally expose test-only automation.

## Startup gate for authorized QA
The QA runtime must require all of the following:

1. An explicit `authorized-qa` build/runtime selection.
2. A local QA acknowledgement/config value.
3. A configured target process/window allowlist.
4. A visible persistent QA banner.
5. A functioning emergency-stop hotkey.

Where the test environment provides stable identifiers, also support allowlisting:
- realm/environment;
- account alias;
- character alias;
- test scenario ID.

Do not fabricate environment identifiers that PoE 2 does not expose.

## Core automation modules

### Perception
Read only from normal OS-visible signals unless a dedicated GGG test interface is supplied:
- screen capture;
- UI-region detection;
- OCR where useful;
- template matching;
- object detection;
- clipboard;
- supported public APIs;
- supported log files.

### Navigation/following
- Identify the configured leader/target.
- Estimate target direction and distance from screen state.
- Generate movement toward the target.
- Detect stuck states and recovery attempts.
- Stop when confidence is too low according to scenario policy.
- Record perception confidence and chosen movement action.

### Loot pickup
- Detect visible item labels/loot targets.
- Parse or classify desirability.
- Rank loot by configurable score/value.
- Move/click to collect eligible loot.
- Avoid low-value clutter according to policy.
- Detect inventory-full conditions and transition to stash workflow.

### Inventory/stash automation
- Detect inventory item cells and stash tab/grid state.
- Parse/evaluate items.
- Choose keep/sell/vendor/craft/dump destination.
- Transfer items to configured tabs.
- Support bulk sorting sessions.
- Detect failed moves and retry within configured limits.
- Maintain a local shadow state reconciled against each observed UI state.

### Listing/selling
- Price items from current market data.
- Apply configurable price strategy.
- Set listing/price UI values through the client where possible.
- Detect stale listings and reprice during QA scenarios.
- Support test trade workflows including invite, party, hideout/trade-window interaction, item placement, currency verification, acceptance, completion, and cleanup when that scenario explicitly enables full execution.

### Desirable-item engine
- deterministic score;
- market value;
- liquidity;
- modifiers/rolls;
- pseudo stats;
- bases/item level;
- sockets/quality;
- user/test scenario preferences;
- explanation for every decision.

## Input architecture
All game-affecting input must pass through one `GameInputController`.

Every emitted input action must record:
- timestamp;
- scenario ID;
- module;
- active mode;
- active process/window;
- perception evidence hash/reference;
- confidence;
- decision reason;
- input action;
- result/observed state after action when available.

## Emergency stop
The emergency stop must:
- be global;
- be registered outside the automation worker loop;
- immediately block new input;
- clear pending action queues;
- place the runtime into a latched stopped state;
- require explicit re-arming before automation resumes.

## Simulation/replay
Every perception/decision module should support recorded-session replay where practical.

Replay mode:
- consumes screenshots/video frames/log fixtures;
- produces decisions and intended inputs;
- never sends real input;
- supports deterministic assertions;
- produces the same QA action trace format as live mode.

## Scenario system
Create scenario profiles such as:
- follow-only;
- loot-only;
- stash-sort;
- list-and-reprice;
- trade-session;
- full-loop;
- adversarial-low-confidence;
- rate-limit/failure injection.

Each scenario controls:
- enabled modules;
- action-rate limits;
- confidence thresholds;
- dry-run/live execution;
- retry limits;
- timing profile;
- market provider behavior;
- failure injection.
