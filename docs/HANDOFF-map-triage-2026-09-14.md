# Map triage: live bag test completed September 14

## Problem reproduced

The September 14 live preview read one Crossbow twice, one Body Armour
twice, and one Sceptre twice. The two anchors of each item copied the same
fingerprint, but disconnected sprite regions survived deduplication.
The old move planner then expanded/clamped those regions to guessed sizes.
The same runner verified only the first and final ground drops, and accepted
any nonempty compaction target as success. Neither check could detect every
cursor swap or incorrect placement.

## Current process

1. Verify the open inventory by copying a nonempty Scroll of Wisdom at
   `(0,0)`. A failed copy stops; OCR never triggers a blind inventory toggle.
2. Read one complete 12×5 clipboard layout in bounded batches. Resolve each
   item's rectangle using measured base sizes first, then class sizes.
   Every cell in the rectangle must agree. Adjacent identical items remain
   separate. Unknown sizes or inconsistent layouts stop before mutation.
3. Verify the stash is closed. Pin unidentified gear and the scroll, arm
   for 320 ms, then identify with one Shift-held chain. The host copies and
   checks each item before clicking the next, preserving the 200 ms settle
   and 80 ms minimum click gap. A missed arm is restored once and aborts.
   If copying while Shift is held is unavailable, a normal copy must prove
   the current item identified correctly before the remaining items use
   individually armed, verified clicks. No unchecked burst is retried.
4. Evaluate through `triage.evaluate`, including learned modifier tiers.
   Only identified gear is eligible. Keep/sell and safety verdicts stay.
   Unknown values now stay for review by default; `--drop-unknown` explicitly
   opts into the old behavior (`--keep-unknown` takes precedence). Positive
   saved price lessons, including stale/conflicting evidence, protect their
   matching items. Unknown items enter the local Price training review queue.
   This uses saved data without fresh trade searches. See
   [Price training](features/price-training.md). Historical runs below retain
   their original outcomes and predate this policy correction.
5. Pin each drop candidate, pick up, click the ground with a minimum 200 ms
   gap and 100 ms hover at each click target, then run the put-back probe. Finish that item's proof before the
   next pickup. Refused or changed items stop the run before compaction.
6. Plan compaction once from the verified remaining layout. The scroll is
   fixed; each item moves at most once with two clicks. One-cell holes take
   the furthest available one-cell item directly, avoiding a chain of shifts.
   Pin the source and
   check newly occupied destination cells are empty before pickup. Placement
   uses the quarter-cell bias on even dimensions and a minimum 35 ms gap.
   Verify destination corners by exact fingerprint and a vacated origin cell.
   A refused placement can be restored once only after complete source and
   destination copies prove the recovery is safe. Then stop.

Already packed keepers cause no execution copies or clicks after the scan.
No automatic corrective compaction loops or downward ground-drop tuning remain.
The size-calibration path now uses the same verified move transaction.

## Shared code and scope

- `src/core/mapTriage.ts`: footprints, per-item budget, safety, compaction plan.
- `src/core/mapTriageExecution.ts`: injectable identify/drop/move transactions.
- `src/core/mapTriageRun.ts`: testable orchestration and retained-item model.
- `src/adapters/mapTriageHost.ts`: map-only guarded commands and complete-reply checks.
- `scripts/map-triage.ts`: live glue, complete snapshot, summaries and evidence.
- `scripts/win-input-host.ps1`: opt-in guarded batches check stop, pause and focus
  during input; clipboard and held modifiers are restored in `finally`.
- `src/adapters/winHost.ts`: optional unlimited request lifetime for user-paused
  commands; default deadlines and process-exit cleanup remain unchanged.

Copy and OCR operations reuse `bagKit` through the strict map adapter. The
duplicated sprite-capture implementation was removed: this flow now resolves
the client rectangle without segmenting sprites. That small window/capture
probe remains local because the shared helper also segments sprites.
Vendor, stash, fill, listing and flask flows were not rewritten. Legacy host
requests keep existing behavior unless the new guard is explicitly enabled.
No live requests are made by the new test suites.

## Evidence and limits

Final offline validation, including the drop-hover fix: `npm run test:all`
passed **2,812 tests across 232 files**. Focused ESLint and both Node/renderer
TypeScript checks passed. Full-suite output is saved at
`artifacts/map-triage/offline-suite-live-final-20260914.log`.

Offline tests reproduce the three split-item cases, adjacent identical items,
measured sizes, missing/empty scroll, keep-unknown, never-drop classes, changed
fingerprints, misfires, refused drops, occupied targets, shifted placements,
recovery, stop and pause. A full-run cursor simulation checks the minimum
mutating click count. Host tests execute PowerShell with inert input substitutes, including a
failed first identify that must stop before reaching a second item.

The complete clipboard scan deliberately spends more reads to prove geometry.
In particular, empty cells take longer to establish than successful copies.
The successful final cleanup took 47.793 seconds: 13.052 seconds scanning,
20.630 seconds for nine verified drops, and 14.111 seconds for eight verified
compaction moves. Identification had already completed in the preceding run.
These timings do not establish faster-than-human performance or repeated
end-to-end reliability. Do not lower hover/arming/drop floors to hide the scan
cost. Further optimization must preserve verified geometry.

## Live results and fixes

The user requested testing with full bags. The first scan stopped without
mutation because Boar Idol and Greater Robust Rune use the `Augment` class.
Both copied from exactly one cell; the catalog now recognises Augment as 1×1,
and the identify/drop exclusion and fixed-size learning lists protect it.
Replay also exposed 30 one-cell shifts for a single hole. Tail-first one-cell
packing reduces that exact case to one move; multi-cell ordering is unchanged.

The retry identified all 13 gear items in one Shift-held chain. Scrolls fell
from 37 to 24. The first ground drop was refused and its put-back probe restored
the same item before stopping, with zero drops or compaction. The old burst
waited 200 ms at the source but only 14 ms after moving to the ground. An
opt-in 100 ms click-target hover succeeded in a one-item probe, followed by
nine more verified drops and eight verified compaction moves. Shared callers
keep the 14 ms default unless they request the new option.

Final read-only verification found 37 bag items plus the scroll stack, all
identified gear evaluated as keep/sell, 24 scrolls and 22 free cells. The
successful runs used saved appraisal rules; they did not fetch fresh trade
comparisons. Detailed evidence is in
`artifacts/map-triage/live-test-report-20260914.md`, the append-only journal,
bag-read snapshots, and `live-test-final-20260914.png`.

## Crafting-base correction and repeat live test

After the live test, the user requested retaining Normal Heavy Belts and Normal
Utility Belts for crafting. `Normal belt crafting bases` now precedes the broad
normal-item dump rule in starter keep rules, the current app's persisted
`value-tiers` setting, and its `artifacts/tab-admin/triage.json` export. It matches
the exact Belts class, Normal rarity, and either exact base name, with no level
threshold. Other rarities still use the remaining rules. The user's Level 50
example and both bases passed through the saved loader as keep/non-droppable.
This correction does not retroactively change the recorded ten-drop live test.

The next user-requested full-bag test completed in one run at
`2026-09-14T23:45:57.167Z`: 13 identified, 11 dropped under saved rules, eight
verified moves in 64.759 seconds (read 12.831 s, identify 9.990 s, drop 25.659 s,
compact 16.279 s). A retained 2×2 pair of gloves moved successfully, alongside
seven one-cell moves. The subsequent clipboard snapshot verified both keepers,
18 total items including two scroll stacks (27 and 40), and 39 free cells.
No Normal Heavy or Utility Belt was in this bag, so that exception remains
verified through offline replay rather than a live item. See
`artifacts/map-triage/belt-rule-live-test-20260914.md` for the comparison.

The initial attempt stopped because inventory was closed. The operator
confirmed that state in the failure capture, opened inventory once, and
restarted. No blind inventory toggle was added to the runner.

## Remaining live coverage

With the user present, inventory open in a map and scrolls at `(0,0)`:

1. Include actual Normal Heavy and Utility Belts to exercise the crafting-base
   exception live.
2. Continue repeated-bag timing and retained 2×3/2×4 compaction coverage. A
   faster-than-human advantage has not been measured.
3. Verify Num6 daemon dispatch and Num5 pause/resume (including a long pause),
   Num0 stop, and Ctrl+Shift+Esc in a controlled scenario.

No commits were made.
