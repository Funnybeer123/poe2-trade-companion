# AI Development Workflow

This repository uses a deliberate two-stage AI workflow with GitHub as the shared source of truth.

## Roles

### Sol Max / Cursor — Planning authority

Sol Max owns:

- full repository audit before implementation;
- target architecture;
- phase ordering;
- exact implementation plan;
- interfaces/contracts to build;
- acceptance criteria;
- test/replay requirements;
- dependency/risk analysis;
- highest-risk assumptions.

Sol Max writes/updates:

`plans/IMPLEMENTATION_PLAN.md`

Sol Max then stops. It is not the primary implementation agent under the current workflow.

Use:

`SOL_MAX_PLAN_ONLY_PROMPT.md`

### Grok 4.6 xhigh Fast — Implementation authority

Grok owns:

- production code;
- refactors;
- migrations;
- tests;
- replay fixtures;
- bug fixes;
- implementation documentation;
- phase commits;
- implementation-state tracking;
- self-review before completion.

Preferred configuration:

- Grok 4.6;
- reasoning `xhigh`;
- Fast variant when the platform exposes it.

Use:

`GROK_46_XHIGH_FAST_BUILD_PROMPT.md`

## Shared workflow

```text
Sol Max repository audit
  -> architecture + detailed implementation plan
  -> plans/IMPLEMENTATION_PLAN.md
  -> Grok 4.6 xhigh Fast handoff
  -> Grok implements one phase
  -> tests + deterministic replay
  -> Grok separate self-review pass
  -> fix findings
  -> commit phase
  -> update grok/IMPLEMENTATION_STATE.md
  -> next phase
```

## Planning rule

Grok should treat the Sol Max plan as the default architecture.

Grok may amend it only when actual code, tests, current dependencies/APIs, licensing, or QA-boundary evidence proves a plan assumption wrong.

Material deviations must be documented in:

`grok/IMPLEMENTATION_STATE.md`

and reflected back into `plans/IMPLEMENTATION_PLAN.md` when later phases are affected.

## Branch rules

- Sol Max planning work may be committed directly as documentation if the user permits.
- Grok should prefer `grok/implementation` or phase branches such as `grok/phase-01-core-runtime`.
- Keep Grok commits phase-scoped and reviewable.
- Do not force-push or rewrite unrelated history.
- Avoid simultaneous broad implementation by multiple agents.

## Objective arbiter

Neither model's confidence is the final authority. Prefer evidence in this order:

1. deterministic tests;
2. deterministic replay;
3. structured action traces;
4. reproducible live QA evidence;
5. code review.

## Per-phase Grok loop

```text
read Sol Max phase
  -> inspect actual code
  -> implement smallest complete vertical slice
  -> add/update tests
  -> add replay fixtures
  -> lint/typecheck/test/replay
  -> inspect traces
  -> self-review actual diff
  -> fix findings
  -> commit
  -> update implementation state
```

## Bug workflow

```text
failure observed
  -> minimize failing state/input sequence
  -> define expected transition/action
  -> add regression test or replay fixture
  -> confirm failure
  -> fix
  -> confirm pass
  -> update implementation/review state
```

## Review gates

A phase should not be treated as complete when meaningful behavior is only documented or stubbed.

Require evidence that:

- state selection is deterministic;
- recovery is bounded;
- replay uses the same controller logic as live mode;
- replay emits zero native input;
- native input cannot bypass the approved adapter;
- public mode cannot generate automated game input;
- failures are visible through structured traces;
- required tests for the phase pass or an external blocker is documented.

## Safety boundary

The authorized QA mode remains test-only and must preserve its controls. Do not introduce license bypass, credential theft, anti-cheat bypass, detection-evasion mechanisms, protected-code extraction, or proprietary-code copying.
