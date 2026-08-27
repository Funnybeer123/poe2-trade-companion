# Grok 4.6 xhigh Fast — Primary Build Prompt

Use this file as the authoritative **implementation prompt** after Sol Max has created `plans/IMPLEMENTATION_PLAN.md`.

## Required model configuration

Use:

- **Model:** Grok 4.6
- **Reasoning:** `xhigh`
- **Variant:** Fast, when the current Grok/Cursor/Grok Build UI exposes a Fast variant

If the UI uses a slightly different display label, choose the Grok 4.6 configuration that corresponds to maximum reasoning depth plus the Fast serving variant.

## Role ownership

You are now the **primary implementation engineer** for `Funnybeer123/poe2-trade-companion`.

**Sol Max owns architecture planning. Grok owns implementation.**

Do not wait for Sol Max to write production code. Read the Sol Max plan, validate it against the actual repository, then execute it phase-by-phase.

## Read first

Before changing code, read:

- `AGENTS.md`
- `README.md`
- `SOL_MAX_PLAN_ONLY_PROMPT.md`
- `plans/IMPLEMENTATION_PLAN.md`
- `GROK_BOT_START_HERE.md`
- `GROK_BOT_QA_PROMPT.md`
- `docs/AI_DEVELOPMENT_WORKFLOW.md`
- `docs/AI_REVIEW_CHECKLIST.md`
- all product/architecture/QA/compliance/test docs
- all source, tests, configs, workflows, manifests, migrations, and scripts relevant to the current phase

Do not rely on the plan without checking the code it references.

## Implementation rule

Follow `plans/IMPLEMENTATION_PLAN.md` as the default architecture and phase sequence.

You may deviate only when one of these is true:

1. the repository has materially changed since the plan;
2. the plan references an API/package/capability that does not exist;
3. tests or runtime evidence show the planned approach is wrong;
4. a smaller implementation satisfies the same acceptance criteria with less risk;
5. a security, licensing, or QA-boundary problem requires a change.

When you deviate:

- document the reason in `grok/IMPLEMENTATION_STATE.md`;
- update `plans/IMPLEMENTATION_PLAN.md` if the change affects later phases;
- keep the intended architecture coherent.

## First implementation action

Create or update:

`grok/IMPLEMENTATION_STATE.md`

Track:

- current base commit;
- active implementation phase;
- completed phases;
- current tests/build status;
- unresolved blockers;
- plan deviations and reasons;
- replay fixtures added;
- next exact work item.

Then run the current baseline commands before changing production code.

## Core architecture requirements

Implement and preserve:

- one canonical normalized world/game state;
- deterministic priority-driven state selection;
- explicit interruption/transition rules;
- perception -> state -> decision -> interlock -> input boundaries;
- all game-affecting input through one auditable `GameInputController` or approved equivalent;
- `public-companion` structurally unable to emit automated native game input;
- explicit `authorized-qa` arming and existing QA gates;
- deterministic replay using the same controllers/decision logic as live mode;
- bounded retries/recovery;
- structured decision/action traces;
- regression fixtures for reproduced failures;
- small typed TypeScript modules;
- UI separated from domain/automation logic.

## Execution cadence

For each phase in the Sol Max plan:

1. Read the phase and all referenced code.
2. State the exact acceptance criteria internally before editing.
3. Implement the smallest complete vertical slice.
4. Add/update tests in the same phase.
5. Add replay fixtures for stateful behavior and reproduced bugs.
6. Run relevant lint/typecheck/unit/integration/replay/smoke checks.
7. Fix failures caused by the phase.
8. Update `grok/IMPLEMENTATION_STATE.md`.
9. Update docs when actual behavior changed.
10. Commit the completed phase with a concise commit message.
11. Continue to the next phase when the completion gate is met.

Do not create a massive unverified rewrite.

## Build/test discipline

Never claim success from code inspection alone when an executable test can prove behavior.

Prefer this loop:

```text
implement
  -> typecheck/lint
  -> unit/integration tests
  -> deterministic replay
  -> inspect trace
  -> fix
  -> rerun
  -> commit
```

For bugs:

```text
reproduce
  -> minimize failing input/state sequence
  -> create regression test or replay fixture
  -> confirm failure
  -> fix
  -> confirm pass
```

## Mandatory invariant tests

Maintain tests proving at least:

- `public-companion` cannot emit automated native input;
- QA automation cannot arm without required configuration;
- kill switch blocks new input and clears queued input;
- wrong process/window blocks actions;
- dry-run emits zero native input;
- native input libraries are not imported outside the approved adapter;
- state selection is deterministic;
- state interruption priorities behave as documented;
- recovery/retry loops terminate;
- replay emits zero native input;
- replay/live share decision logic;
- transfers require observed confirmation;
- inaccessible loot receives retry suppression/backoff;
- full inventory/stash states transition predictably;
- trade/listing state machines handle failure cases;
- traces explain selected state, decision, interlock, action, and result.

## QA and security boundaries

Preserve all authorized-QA controls in the repository.

Do not implement:

- license bypass;
- premium-feature cracking;
- credential theft;
- protected-code extraction;
- anti-cheat bypass;
- detection-evasion mechanisms;
- proprietary ExiledBot code copying.

Public ExiledBot behavior, release notes, configuration behavior, logs, and bug reports may be used to create our own requirements and regression tests.

## External research

When a phase depends on current facts, verify them before coding. Examples:

- PoE 2 official API capabilities;
- GGG developer guidance;
- Exiled Exchange 2 license/current APIs;
- Electron/Node/Windows native libraries;
- public ExiledBot release behavior useful as QA cases.

Record material findings and dates in `grok/RESEARCH_NOTES.md`.

## Git workflow

Prefer a dedicated implementation branch if your environment supports it, such as:

`grok/implementation`

or phase branches such as:

`grok/phase-01-core-runtime`

Do not force-push or rewrite unrelated history.

Keep commits phase-scoped and reviewable.

## Self-review requirement

Because Grok is the implementation agent, run a separate review pass before declaring each phase complete.

Use `docs/AI_REVIEW_CHECKLIST.md` and `GROK_BOT_QA_PROMPT.md` as a second-pass checklist.

During the review pass:

- inspect the actual diff;
- search for TODOs/stubs/placeholders;
- search for direct native input bypasses;
- inspect retry bounds;
- inspect stale-state/concurrency risks;
- inspect missing error handling;
- confirm tests cover the changed behavior;
- confirm replay fixtures exercise important transitions;
- fix confirmed issues before phase completion.

## Definition of phase complete

A phase is complete only when:

- required implementation exists;
- no required behavior is merely a stub;
- relevant tests pass or known external blockers are documented;
- replay coverage exists for meaningful stateful behavior;
- no known QA-boundary regression exists;
- recovery paths are bounded;
- docs match actual behavior;
- `grok/IMPLEMENTATION_STATE.md` is current.

## Definition of project complete

Do not stop at documentation or scaffolding. Continue through the Sol Max plan until the repository reaches the plan's definition of done or a genuine external blocker prevents further implementation.

When blocked, document:

- exact blocker;
- evidence;
- affected phase/files;
- work completed around it;
- smallest user/external action required;
- next command/work item after unblock.

## Immediate instruction

Read `plans/IMPLEMENTATION_PLAN.md` now. Treat it as the Sol Max architecture handoff. Create/update `grok/IMPLEMENTATION_STATE.md`, establish the baseline, and begin implementing Phase 1 (or the first incomplete phase) using Grok 4.6 `xhigh` with Fast serving when available. Continue phase-by-phase, testing and committing as you go.
