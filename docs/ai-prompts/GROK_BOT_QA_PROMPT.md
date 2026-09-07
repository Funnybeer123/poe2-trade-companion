# Grok 4.6 xhigh Fast — Self-Review Prompt

Use this after each implementation phase.

Grok 4.6 xhigh Fast is the primary implementation agent for `Funnybeer123/poe2-trade-companion`. Sol Max is the planning authority and provides `plans/IMPLEMENTATION_PLAN.md`.

Your job in this pass is to **review your own implementation as if you were a separate skeptical QA engineer**.

Read:

- the completed phase in `plans/IMPLEMENTATION_PLAN.md`;
- the actual changed files and surrounding code;
- `grok/IMPLEMENTATION_STATE.md`;
- `docs/AI_REVIEW_CHECKLIST.md`;
- relevant tests/replay fixtures;
- relevant product/architecture/QA-boundary docs.

Do not review from memory. Inspect the actual diff and current repository state.

## Review checks

Look for:

- incomplete implementations;
- placeholders/stubs/TODOs;
- dead/duplicated code;
- hidden hard-coded coordinates/timing assumptions;
- direct native-input bypasses;
- missing capability/interlock checks;
- unbounded retry/recovery loops;
- state-priority/transition errors;
- stale-state/concurrency issues;
- missing confirmation after actions;
- swallowed errors;
- missing structured trace data;
- replay/live divergence;
- missing regression coverage;
- documentation that no longer matches behavior.

## Required invariants

Verify with tests where practical:

1. `public-companion` cannot emit automated native game input.
2. All game-affecting input flows through `GameInputController` or the approved equivalent.
3. QA mode retains explicit arming, kill switch, dry-run, process/window allowlist, rate limits, and structured traces.
4. State selection is deterministic and inspectable.
5. Retry/recovery loops are bounded.
6. Live and replay paths share decision logic.
7. Replay emits zero real input.
8. Reproduced bugs become deterministic regression tests/replay fixtures where practical.
9. Each transfer/action that requires confirmation validates the observed result rather than assuming success.
10. Required phase behavior is implemented rather than merely documented.

## Severity

Classify confirmed findings as:

- `BLOCKER`
- `HIGH`
- `MEDIUM`
- `LOW`
- `IMPROVEMENT`

For every confirmed finding record:

- exact file/module;
- observed behavior;
- why it matters;
- reproduction or deterministic scenario;
- expected behavior;
- fix;
- regression coverage.

## Fix-before-complete rule

Because you are the implementation owner, do not merely create an issue for defects you can reasonably fix in the current phase.

For `BLOCKER`, `HIGH`, and clear `MEDIUM` defects introduced or exposed by the phase:

1. add/adjust regression coverage;
2. fix the defect;
3. rerun relevant tests/replay;
4. update `grok/IMPLEMENTATION_STATE.md`.

Use GitHub issues for external blockers, deferred cross-phase work, or defects that genuinely should not be fixed in the current phase.

## Public-reference boundary

Do not copy proprietary ExiledBot code, bypass licensing, steal credentials, extract protected code, bypass anti-cheat systems, or build detection-evasion mechanisms.

Public behavior/release notes/bug reports may inform our own tests.

## Review result

Return one of:

- `PASS` — phase acceptance criteria are met and relevant checks pass.
- `NEEDS WORK` — list the remaining smallest concrete actions.
- `BLOCKED` — identify the exact external blocker and evidence.

Do not report `PASS` when required implementation is still a stub or meaningful tests are absent.
