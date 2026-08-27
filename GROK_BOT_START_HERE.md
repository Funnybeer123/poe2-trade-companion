# Grok Bot — Start Here

This is the authoritative bootstrap instruction for Grok working on `Funnybeer123/poe2-trade-companion`.

## Current ownership model

The repository uses a two-stage AI workflow:

1. **Sol Max = architecture/planning authority only.**
2. **Grok 4.6 + `xhigh` reasoning + Fast variant when available = primary implementation authority.**

Sol Max creates the implementation plan. Grok executes it.

Do not revert to the old workflow where Sol Max broadly implements production code.

## Step 1 — Sol Max plan

Before Grok implementation begins, Sol Max must follow:

`SOL_MAX_PLAN_ONLY_PROMPT.md`

Sol Max must inspect the entire repository and create/update:

`plans/IMPLEMENTATION_PLAN.md`

The plan must end with the `GROK 4.6 XHIGH FAST IMPLEMENTATION HANDOFF` section.

If that plan does not exist yet, do not invent a competing architecture. Ask the user to run the Sol Max planning step first, unless the user explicitly instructs Grok to create a temporary plan itself.

## Step 2 — Grok implementation

After the Sol Max plan exists, Grok must follow:

`GROK_46_XHIGH_FAST_BUILD_PROMPT.md`

Use:

- model: Grok 4.6;
- reasoning: `xhigh`;
- Fast variant when the current platform exposes it.

Grok is responsible for:

- production implementation;
- refactors specified by the plan;
- tests;
- deterministic replay fixtures;
- fixes;
- migrations;
- documentation tied to implementation;
- implementation-state tracking;
- phase commits;
- self-review before declaring a phase complete.

## Files to read before implementation

At minimum read:

- `AGENTS.md`
- `README.md`
- `SOL_MAX_PLAN_ONLY_PROMPT.md`
- `plans/IMPLEMENTATION_PLAN.md`
- `GROK_46_XHIGH_FAST_BUILD_PROMPT.md`
- `GROK_BOT_QA_PROMPT.md`
- `docs/AI_DEVELOPMENT_WORKFLOW.md`
- `docs/AI_REVIEW_CHECKLIST.md`
- `docs/PRODUCT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/GGG_COMPLIANCE.md`
- `docs/QA_AUTOMATION_BOUNDARY.md`
- `docs/IMPLEMENTATION_PHASES.md`
- `docs/TEST_PLAN.md`
- all relevant source, tests, configs, workflows, manifests, migrations, and scripts.

Compare the Sol Max plan with actual code before editing.

## Working artifacts Grok should maintain

Create/update as needed:

```text
grok/
  IMPLEMENTATION_STATE.md
  BASELINE_ASSESSMENT.md
  REVIEW_STATE.md
  TEST_GAPS.md
  REPLAY_BACKLOG.md
  RESEARCH_NOTES.md
  EXILEDBOT_BEHAVIORAL_REFERENCES.md
```

`IMPLEMENTATION_STATE.md` is the primary execution checkpoint and should record:

- base/current commit;
- active phase;
- completed phases;
- build/test status;
- blockers;
- plan deviations;
- replay fixtures added;
- next exact work item.

## Implementation rules

- Follow the Sol Max plan phase-by-phase.
- Do not casually redesign architecture during implementation.
- Amend the plan only when repository/test/current external evidence proves an assumption wrong.
- Document every material plan deviation.
- Keep each phase buildable/testable where practical.
- Add tests with behavior changes.
- Convert reproduced bugs into deterministic regression tests/replay fixtures.
- Run relevant lint, typecheck, unit, integration, replay, and smoke checks before phase completion.
- Do not report completion when required behavior is only documentation, scaffolding, TODOs, mocks, or stubs.

## Core invariants

Preserve and test:

- canonical world/game state;
- deterministic state priorities/transitions;
- perception -> state -> decision -> interlock -> input separation;
- one auditable `GameInputController` boundary;
- `public-companion` structurally unable to emit automated native game input;
- explicit `authorized-qa` arming and QA controls;
- deterministic replay with zero native input;
- live/replay sharing the same decision logic;
- bounded recovery/retry loops;
- structured traces explaining decisions/actions/results.

## Public-reference boundary

Public ExiledBot 2 release notes, behavior, configuration concepts, bug reports, and visible logs may be used as behavioral references and QA scenarios.

Do not implement or create:

- licensing bypass;
- premium cracking;
- credential theft;
- protected-code extraction;
- anti-cheat bypass;
- detection-evasion systems;
- proprietary-code copying.

## Grok self-review

Grok is now the primary implementer, so perform a separate review pass before each phase is marked complete.

Use:

- `GROK_BOT_QA_PROMPT.md`
- `docs/AI_REVIEW_CHECKLIST.md`

Review the actual diff, not only your intentions. Fix confirmed problems before completion.

## Git workflow

Prefer a Grok implementation branch when supported, for example:

`grok/implementation`

or phase branches:

`grok/phase-01-core-runtime`

Keep commits phase-scoped. Do not force-push unrelated history.

## Immediate assignment when given this link

> Read this file and all referenced repository instructions. Confirm `plans/IMPLEMENTATION_PLAN.md` was created by the Sol Max planning step. Then follow `GROK_46_XHIGH_FAST_BUILD_PROMPT.md` as the primary implementation agent. Create/update `grok/IMPLEMENTATION_STATE.md`, establish the baseline, and begin the first incomplete phase. Continue phase-by-phase with tests, deterministic replay coverage, self-review, and commits until the plan is complete or a genuine external blocker prevents further work.
