# Test Plan

## Unit tests
- item parsing/normalization;
- numeric rolls/pseudos;
- item fingerprints;
- market comparable filtering/outliers;
- confidence calculation;
- desirability scoring;
- sort rules;
- pricing/repricing thresholds;
- loot ranking;
- navigation decision rules;
- state-machine transitions;
- rate-limit/backoff logic;
- runtime capability checks;
- kill-switch latch behavior.

## Replay/simulation tests
Use recorded frames/video and deterministic clocks.

Scenarios:
- target acquired and followed;
- target lost/reacquired;
- stuck/recovery;
- desirable vs undesirable loot;
- multiple loot priorities;
- inventory full;
- stash tab selection;
- bulk sorting;
- failed transfer retry;
- full destination tab;
- listing/repricing;
- successful trade;
- wrong currency;
- insufficient currency;
- wrong item request;
- cancelled trade;
- timeout;
- disconnect;
- emergency stop during every major workflow.

Replay must never send real OS input.

## Input-boundary tests
- no module imports native input libraries except `GameInputController` implementation;
- `public-companion` cannot arm automation;
- kill switch blocks all new inputs immediately;
- pending action queue clears on stop;
- inactive/non-allowlisted process blocks execution;
- dry-run records intended actions but emits none;
- per-module flags work;
- action-rate caps work.

## Integration tests
- capture/perception -> state estimator -> controller -> fake input sink;
- item observation -> quote -> valuation -> desirability -> loot decision;
- inventory observation -> catalog -> sort planner -> action sequence;
- listing policy -> UI action plan;
- trade state machine -> perception -> verification -> accept/reject;
- settings/migrations;
- provider 429/5xx/offline behavior.

## UI smoke tests
- overlay opens/closes;
- QA banner visible in authorized mode;
- automation cannot arm in public mode;
- arm/disarm controls work;
- emergency-stop state visible;
- perception confidence/state visible;
- trace viewer shows reason/evidence/action;
- catalog search works;
- settings persist.

## Live QA test checklist
Run only in the intended authorized test context.
- Verify process/window allowlist.
- Verify visible QA banner.
- Verify dry-run first.
- Verify kill switch before enabling live input.
- Run one module at a time.
- Validate trace completeness.
- Run full-loop scenario only after module gates pass.

## Fixture policy
Use sanitized/static fixtures. Do not store private session cookies, auth tokens, internal credentials, or unnecessary account identifiers.

## Release gate
- lint passes;
- typecheck passes;
- unit/integration/replay tests pass;
- packaging succeeds;
- clean Windows VM starts;
- public build cannot expose QA automation;
- QA build cannot arm without explicit QA configuration;
- emergency stop tested live;
- full-loop QA scenario produces complete trace.
