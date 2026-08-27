# AI Development Workflow

This repository uses two AI roles with GitHub as the shared source of truth.

## Roles

### Sol Max / Cursor
Primary implementation authority.

Owns:

- architecture changes;
- production implementation;
- refactors;
- migrations;
- fixes;
- packaging;
- documentation tied to implementation.

### Grok Bot
Independent QA/review authority.

Owns:

- architecture review;
- diff review;
- failure analysis;
- deterministic regression-test design;
- replay backlog;
- test-gap tracking;
- public external-reference research;
- GitHub issue creation for confirmed defects;
- verification of Sol Max fixes.

## Shared workflow

```text
Sol Max implementation
  -> commit/PR
  -> Grok review
  -> tests + replay analysis
  -> GitHub findings
  -> Sol Max fix
  -> Grok re-review
  -> PASS / NEEDS WORK
```

## Branch rules

- Sol Max may use normal feature branches or the user-approved implementation flow.
- Grok should not broadly modify `main`.
- Grok code changes should use a branch such as `grok/qa-<topic>`.
- Grok should prefer tests, fixtures, diagnostics, documentation, and narrow fixes.
- Avoid simultaneous broad refactors by both agents.

## Handoff rule

A Grok issue handed to Sol Max should include enough evidence that Sol Max does not need to repeat the investigation:

- exact file/module;
- reproduction;
- expected behavior;
- actual behavior;
- severity;
- recommended regression test;
- relevant trace/replay evidence.

## Objective arbiter

Neither agent's confidence is the final authority. Prefer:

1. deterministic tests;
2. deterministic replay;
3. structured action traces;
4. reproducible live QA evidence;
5. code review.

## Bug workflow

```text
failure observed
  -> minimize failing state/input sequence
  -> define expected transition/action
  -> add/propose regression fixture
  -> confirm failure
  -> create issue
  -> Sol Max fixes
  -> regression passes
  -> Grok validates
```

## Review gates

A phase should not be treated as complete when meaningful behavior is only documented or stubbed.

For stateful automation work, require evidence that:

- state selection is deterministic;
- recovery is bounded;
- replay uses the same controller logic as live mode;
- native input cannot bypass the approved adapter;
- public mode cannot generate automated game input;
- failures are observable through structured traces.

## Safety boundary

The authorized QA mode remains test-only and must preserve its existing controls. Do not introduce license bypass, credential theft, anti-cheat bypass, detection-evasion mechanisms, or proprietary-code copying.