# AI Review Checklist

Use this checklist for every meaningful Sol Max phase, PR, or refactor.

## Repository health

- [ ] Read the actual diff and surrounding code.
- [ ] Identify affected requirements and modules.
- [ ] Run/inspect install, build, lint, typecheck, unit, integration, replay, and smoke checks that apply.
- [ ] Record failures rather than deleting or muting tests.
- [ ] Search for TODOs, placeholders, stubs, duplicated abstractions, dead paths, and hidden hard-coded assumptions.

## Runtime boundaries

- [ ] `public-companion` cannot emit automated game input.
- [ ] `authorized-qa` requires explicit arming/configuration.
- [ ] QA visual indicator remains present where required.
- [ ] Dry-run produces zero native input.
- [ ] Wrong process/window blocks input.
- [ ] Rate limits and module/scenario gates remain active.

## Input ownership

- [ ] All game-affecting input passes through `GameInputController` or approved equivalent.
- [ ] No UI/controller/state/helper imports native input packages directly.
- [ ] Kill switch blocks new actions.
- [ ] Kill switch clears queued actions.
- [ ] Input actions carry module/scenario/reason attribution.

## State engine

- [ ] Canonical world state exists and is used consistently.
- [ ] Observation confidence/freshness is represented where needed.
- [ ] Candidate states and priorities are deterministic.
- [ ] Higher-priority states interrupt lower-priority states correctly.
- [ ] State transitions are traceable.
- [ ] No major automation state lives only inside UI code.

## Recovery

- [ ] No unbounded movement/click/retry/tab-switch/trade loops.
- [ ] Retry limits are explicit.
- [ ] Timeouts exist.
- [ ] Fallback/terminal behavior exists.
- [ ] Recovery attempts are traced.
- [ ] Repeated failed loot/navigation targets receive suppression/backoff where appropriate.

## Replay and regression

- [ ] Replay emits zero native input.
- [ ] Live and replay use the same decision/controller logic.
- [ ] Time is injectable/deterministic where required.
- [ ] Network/market dependencies have fixtures where required.
- [ ] New stateful bugs receive a deterministic regression test or replay plan.
- [ ] Recorded failures can be converted into reusable fixtures.

## Navigation/follow

- [ ] Target loss is handled.
- [ ] Reacquisition is bounded.
- [ ] Progress/stuck detection exists.
- [ ] Unreachable targets do not create infinite movement.
- [ ] Higher-priority states can interrupt navigation.

## Loot

- [ ] Detection, scoring, pickup, and confirmation are separated.
- [ ] Pick/skip reason is traceable.
- [ ] Failed pickup is bounded and suppressed/backed off.
- [ ] Inventory-full transition works.
- [ ] Deterministic ranking tests exist.

## Inventory/stash

- [ ] Local observed/shadow state is reconciled after transfers.
- [ ] Transfer success is observed rather than assumed.
- [ ] Full destination handling exists.
- [ ] Fallback destination handling exists.
- [ ] Wrong tab/focus recovery is bounded.
- [ ] Bulk-sort behavior has regression coverage.

## Valuation/listing/trade

- [ ] Market provider failures/timeouts/throttling are handled.
- [ ] Price confidence/sample information is represented.
- [ ] Offline/replay fixtures exist where needed.
- [ ] Listing changes verify resulting UI state.
- [ ] Trade state machine handles wrong item/currency/amount, partial stack, timeout, cancel, disconnect, UI desync, and emergency stop.

## Telemetry/debugging

- [ ] Trace explains selected state and decision reason.
- [ ] Intended action is recorded.
- [ ] Interlock result is recorded.
- [ ] Execution vs dry-run status is recorded.
- [ ] Follow-up state/result is recorded.
- [ ] Recovery/retry relationships are visible.

## External references and licensing

- [ ] Current official PoE 2/API guidance is checked when relevant.
- [ ] Third-party licenses are verified before reuse.
- [ ] Public ExiledBot material is used only as behavioral/test reference.
- [ ] No proprietary-code copying, licensing bypass, anti-cheat bypass, credential theft, or detection-evasion work is introduced.

## Review result

Return one of:

### PASS
Use only when the reviewed scope is implemented, tested, deterministic where required, and has no unresolved BLOCKER.

### NEEDS WORK
List the smallest next actions, ordered by severity and dependency.