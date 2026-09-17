# Fable 5.1 handoff: make the existing inventory workflow fast and reliable

Prepared September 17, 2026. This is a continuation prompt, not a request for another design proposal. Read it, inspect the referenced implementation and saved evidence, and start fixing the concrete blockers. The user wants the existing application feature enhanced and tested, not replaced by a different product or a series of manual diagnostic steps.

## 1. User objective and operating context

The user's latest requirement is:

> “I want to get it as fast as possible and as reliable as we can get it. It should be faster than a human identifying all the items and dropping them on the ground.”

Deliver the existing one-action, in-map workflow: inspect the bag, identify eligible unidentified equipment using Wisdom, apply the app's shared assessment, retain useful/crafting/uncertain/protected items, and drop positively classified unwanted equipment. Complete it faster than a competent human performing the comparable job. Measure the whole operation, including scanning, verification, startup, and cleanup—not just mouse-click time.

The user previously clarified **live inventory workflow**, not search/sort controls in a captured-item list. They were frustrated because the previous work expanded into a replacement staged interface. They correctly pointed out that the feature already existed. Preserve their established entry point and enhance its implementation.

The September 14 live test was authorized by “Start the testing.” The latest request on September 17 is to prepare this handoff. **Do not interpret that old prepared-game state as a current idle testing window.** Start immediately with code and saved evidence. Coordinate a brief current live-test window when ready; the user may be playing. The functionality is already authorized—do not repeatedly ask approval for every item within an agreed test batch. No live input was issued while preparing this handoff.

A question about the user's habitual entry point was sent but has no recorded answer: “What button or hotkey normally starts it?” The verified existing entry below is sufficient to proceed; do not make that optional answer a blocker.

## 2. Work in the correct checkout and preserve existing work

**Implementation checkout:**

```text
C:/Users/evanb/OneDrive/Documents/Codex/poe2-trade-companion
```

The similarly named `C:/Users/evanb/OneDrive/Documents/ChatGPT/poe2-trade-companion` is the task's misleading default directory. It is not the implementation checkout. Explicitly set the working directory for commands.

The implementation branch is `codex/ancients-price-helper`. Implementation HEAD before adding this handoff was `75ca74a` (`fix: verify inventory capture against live game evidence`). Relevant history:

| Commit | Meaning |
| --- | --- |
| `55ea75b` | Original-feature baseline referenced by the earlier handoff; inspect its runner to recover the existing fast approach. |
| `af88584` | Replaced the old runner with durable staged sessions/replays and changed Num6 to capture-only. |
| `1858c9c`, `5a6cbfd` | Historical offline/capture-refusal records. |
| `c1b849d` | Added the live adapter, native host, packaged worker, and staged desktop controls. |
| `75ca74a` | Fixed real-client capture, static cursor observation, HUD recognition, item sizes, and companion occlusion. |

**Important: the one-action workflow restoration is already implemented but UNCOMMITTED.** Do not reset or overwrite it. Inspect the working tree before editing. Relevant uncommitted bag changes are in:

- `scripts/map-triage.ts`, `scripts/action-daemon.ts`
- `src/core/bagTriageArgs.ts`
- `src/main/bagTriageService.ts`
- `src/shared/bagTriage.ts`, `src/shared/hotkeyActions.ts`
- `src/renderer/components/tools/BagTriageTool.vue`
- `tests/bag-session.test.ts`, `tests/bag-triage-service.test.ts`, `tests/component/bag-triage-tool.test.ts`, `tests/integration/bag-worker.test.ts`
- `e2e/bag-triage-smoke.ts`
- `docs/BAG_LIVE_TEST_READINESS.md`, `docs/HANDOFF-hotkey-actions.md`, and bag-related hunks in `docs/USER_GUIDE.md`.

There is substantial unrelated, ongoing combat work. Preserve it. At handoff creation, dirty/untracked paths include `README.md`, combat/dashboard/user-guide docs and smoke tests, `scripts/win-combat-host.ps1`, `scripts/test-combat-host.ps1`, `src/core/combatAssist.ts`, `src/core/sigilSequence.ts`, `src/main/combatAssistService.ts`, combat components/composables, `ActionIcon.vue`, `DashboardView.vue`, combat tests, `tests/sigil-sequence.test.ts`, and `fixtures/combat/`. This list is a snapshot; use fresh `git status`.

Do not `git add .`. `docs/USER_GUIDE.md` has both our bag edits and unrelated edits. A private pre-bag-edit copy is `artifacts/map-triage/user-guide-before-workflow.md`; use it if needed to isolate our hunks. Commit only completed, scoped work. A previous commit used local command-scoped identity because Git identity was absent: `git -c user.name=Codex -c user.email=codex@openai.com commit ...`; do not change global identity settings.

## 3. Existing feature: reuse it, do not rediscover or replace it again

Original user-facing entry: **Tools → Hotkeys → Identify & drop**, default **Num6**. Its action ID is `identify`. The Hotkeys UI configured bindings/status; the standalone daemon (`npm run actions:daemon`) listened while PoE was foreground. Num6 dispatched `scripts/map-triage.ts --run`.

The original fast runner already performed sprite-based physical-item discovery, advanced clipboard reads, Wisdom identification, item assessment, dropping, and left compaction. It used one representative per physical item, batch copy helpers, and Shift identification. Review it with:

```powershell
git show 55ea75b:scripts/map-triage.ts
git show 55ea75b:scripts/action-daemon.ts
git show 55ea75b:src/shared/hotkeyActions.ts
```

Reusable original code remains in [`src/core/mapTriage.ts`](../src/core/mapTriage.ts), [`src/core/itemSprites.ts`](../src/core/itemSprites.ts), [`src/adapters/bagKit.ts`](../src/adapters/bagKit.ts), and [`src/adapters/gearSorter.ts`](../src/adapters/gearSorter.ts). `identifyBagItems` in the sorter means copying item text, not using Wisdom. The separate **Num2 Sort** action is the stash sorter; do not confuse it with the in-map workflow.

Historical August 31 notes in [`HANDOFF-hotkey-actions.md`](HANDOFF-hotkey-actions.md) describe approximately **27 seconds**, with approximately **23 seconds** for an optimized run. They are historical reports, not proof for today's code. The notes explicitly say the Num6 daemon dispatch itself was not live-tested. The old implementation also had defects: unknown items could be dropped, burst drops had only first/end verification, and stop/focus/journal guarantees were incomplete. Recover its efficient architecture without restoring those failures.

Current UNCOMMITTED restoration:

- `--run` with no explicit stage means `workflow`, not capture-only.
- `--stage=workflow --run` captures once, then identifies and drops with the **same live adapter/ports instance and cache**.
- Normal workflow limits default to 59 identifications and 59 drops; explicit diagnostic identify/drop stages default to one.
- Num6 is again labeled **Identify & drop** and invokes the complete workflow.
- **Tools → Bag triage → Identify & drop** is the equivalent primary desktop action. It requires no prior saved capture. Individual stages are under collapsed **Diagnostic controls**.
- Each normal workflow creates a fresh UUID journal and refuses reuse of an existing journal. Pending actions remain explicit; they are never silently restarted.
- Windows standalone CLI and Num6 now default to `%APPDATA%/poe2-trade-companion`. Explicit data-root overrides are retained.
- **Compaction is still disabled.** Do not claim that the entire original feature has been restored and verified. Keep compaction out of initial identify/drop benchmarking; if restored, validate it separately and retain the existing user's workflow.

## 4. What is proven and what is not

**Proven live on September 14:** one complete bag capture, 60 unique cells, 57 occupied cells plus three empty cells, 30 physical items, zero unread/unknown-footprint cells. Wisdom was 34/40. The durable journal validated and matched its assessment.

**Not proven live:** even one completed identification, any equipment pickup/drop, the restored full workflow, compaction, or current Num6 dispatch. The one-item identification test performed one Wisdom right-click and then stopped during cursor verification. It left a pending `arm` receipt. No subsequent identification click or ground-drop click was issued by that test.

The user was told to cancel Wisdom mode with a right-click on an empty inventory area. No subsequent confirmation or fresh observation is recorded. **Do not assume the cursor, bag, map, counts, process IDs, or window handles are unchanged three days later.**

### Measured performance problem

Read `input-trace.jsonl`, not `report.startedAt/finishedAt`: those report timestamps currently both represent the final observed frame and do not measure elapsed scan time.

| Recorded operation | Observed timing / input count |
| --- | --- |
| Successful capture attempt 08 | Focus `2026-09-14T22:10:59.909Z` to last park `22:11:56.121Z`: **56.212 seconds**, excluding final OCR/serialization. 245 emitted inputs: one focus, 124 moves, 120 copy chords. |
| Separate identify invocation | Started `22:13:24.634Z`; last copy `22:14:25.856Z`: another **61.222 seconds** before finishing its redundant full scan. |
| First actual mutation | Wisdom right-click `22:14:27.717Z`: **63.083 seconds** after identify invocation start. Cursor proof failed afterward. |

This is much too slow. The restored same-process workflow removes the redundant phase-start scan, but its **first capture still double-copies every one of 60 cells**, including multi-cell duplicates and empty cells. That remaining algorithmic cost must be addressed.

## 5. Exact saved evidence—start here, no new recordings needed first

All paths below are local/private. Do not commit raw captures, item text, account details, or client logs.

Desktop data root:

```text
C:/Users/evanb/AppData/Roaming/poe2-trade-companion
```

Successful capture / interrupted identification journal:

```text
C:/Users/evanb/AppData/Roaming/poe2-trade-companion/artifacts/map-triage/live-authorized-20260914-08.jsonl
```

Sibling files:

```text
live-authorized-20260914-08.jsonl.assessment.json
live-authorized-20260914-08.jsonl.worker.log
live-authorized-20260914-08.jsonl.identify.log
live-authorized-20260914-08.jsonl.evidence/input-trace.jsonl
```

The journal currently has two records: initial capture, then one pending arm action:

```text
action ID: live-authorized-20260914-08:action:0
kind: arm
item ID: live-authorized-20260914-08:Inventory:0,2
actual input cell: Wisdom at row 0, col 0
target: unidentified Unique Lapis Amulet, item level 79, row 0, col 2
original implicit: +15(10-15) to Intelligence
verifiedIdentifications: 0
verifiedDrops: 0
```

Within that evidence directory, the identification-run frame prefix is:

```text
frame-09cb463b-e217-4ad5-a6e3-341a6847f3f4-
```

- `00003.bmp` is `receipt.before.evidence`, timestamp `2026-09-14T22:14:26.5804888Z`.
- `00004.bmp` is the first armed-cursor observation, `22:14:28.2141166Z`.
- `00005.bmp` is the second, `22:14:28.5927750Z`; approximately 379 ms separates the pair.
- Each BMP has `.bmp.json` native metadata, including pointer coordinates, cursor hash, and `rgbaBase64`; cursor PNGs are also saved.
- `00005.bmp.cursor-proof.json` contains the final rejection. **It hides the earlier payload rejection**, because the adapter overwrites an unknown payload result with the empty-cursor fallback result.
- `.bmp.scene.json` sidecars, when reached, contain exact cell read pairs plus OCR results. The durable receipt contains the before-scene even when the after-scene could not be built.

Earlier attempts 03–07 in the same appdata directory are useful regression images. Attempt 03 proves that animated ground cannot pass the old exact-static empty check; attempts 04–07 expose OCR failures. Attempt 07 obtained all 60 cell reads but failed final HUD verification, so its journal was not a successful session. Do not relabel these failures as passes.

Useful private checkout artifacts:

- `artifacts/map-triage/ocr-life-live4567-confirmed.json` and `ocr-life-live456.ps1`: saved-frame Life OCR experiments.
- `artifacts/map-triage/stock-cursor-render.json`: transparent stock/native cursor rendering investigation.
- `artifacts/map-triage/run-current.cjs`: runs the freshly built local worker with packaged Electron in Node mode and waits for exit.
- `artifacts/map-triage/run-packaged.cjs`: runs the worker inside the current manifest's package.
- `artifacts/map-triage/saved-regression/summary.json`: 276-item policy regression, zero false discards in that projection, original data unchanged, two historical moved receipts retained.
- `artifacts/map-triage/stress-summary.json`: latest synthetic stress output; 32 seeds, three cycles each, 1,195 physical items and 371 verified **synthetic** drops, no native input. Its runtime is not live gameplay performance.
- `artifacts/tab-admin/stash-valuation-report.json`: private original 276-item batch used by the offline regression.

## 6. Immediate live blocker: normal Wisdom-mode appearance is rejected

Relevant code:

- [`src/core/bagCursorVision.ts`](../src/core/bagCursorVision.ts): `sourceFeatures`, `matchFeatures`, `frameMatches`, `proveBagCursorPayload`, `proveBagCursorEmpty`.
- [`src/adapters/liveBag.ts`](../src/adapters/liveBag.ts): `cursorSource`, `capturePair`, and `observe`.
- [`src/core/bagPixels.ts`](../src/core/bagPixels.ts): `bagCellPixels`, `sameBagPixels`, `emptyBagPixels`.

There are **multiple independent problems**, not just one threshold:

1. **Wisdom use changes/pulses inventory background tints.** Replaying the actual after-arm frames causes `proveBagCursorPayload` to fail first with “An unrelated bag cell changed during cursor observation.” The source stack also highlights. The items themselves remain visibly present.
2. `capturePair` has another blanket `sameBagPixels(a,b)` loop after cursor proof. Prior saved-image analysis found it rejects 18 cells across the two armed frames because the tints pulse.
3. `observe` checks armed/held frames against its baseline; for Wisdom, any changed cell currently throws “Unexpected bag change with an armed/held cursor.” Fixing only the first check will just expose the next blocker.
4. The actual Wisdom cursor is **software-rendered**. The native cursor remains the ordinary empty-arrow hash. Therefore a known OS arrow is not proof that no item/currency payload exists.
5. The sprite matcher samples raw before-image colors at fixed scales 0.5/1 with even offsets ±12, requiring 98% of features within 24 RGB and mean error ≤12. The live downsampled software sprite does not satisfy this simplistic transform/color model.
6. Diagnostics overwrite the useful payload failure with the empty-check failure. Preserve both candidate results, timings, scores, and reasons before tuning anything.

Prior agent analysis of these exact saved files found the following. These are **observations to reproduce**, not implemented fixes or universal thresholds; no dedicated saved matcher-analysis report was found:

- Moving software art: approximately 48×48 at `(2686,875)` in frame 04, and 47×48 at `(3656,875)` in frame 05, moving 970 px with the pointer. Approximately 1,028/965 changed pixels isolate it against the opposite-position frame.
- Current search with 79 source features: best 0.5-scale/even-offset matches were only approximately 32.9%/34.2% within 24 RGB. Testing odd offsets improved to approximately 45.6%/46.8% at `dx=-7, dy=-3`, still inadequate. Merely adding odd offsets will not solve downsampling, alpha/background blending, and source-feature differences.
- A promising **positive item-art preservation** mask selects pixels from the BEFORE image only, excludes each cell's four-pixel grid border, and uses bright edge pixels. At brightness ≥200 and diagonal-two-pixel edge contrast ≥18, every one of the 30 items had 50–1,624 pixels spanning at least 25% of its width/height. All selected pixels stayed within 1 RGB in both armed frames; Wisdom had 221 such pixels spanning 71×88, and the target amulet had 224 spanning 46×79. All three empty cells were byte-identical.
- That suggests checking item art and count glyphs separately from intentional tint changes, rather than treating every background pixel as identity. Insufficient-feature dark objects must remain uncertain. Test wrong art, missing/changed counts, swapped objects, altered protected items, and deceptive highlights; do not tune only to this one bag.

Already fixed in `75ca74a`, do not redo:

- Wisdom source matching excludes the **top-left** count-digit region (45% width ×33% height), not the bottom of the item art.
- Native-art matching uses the cursor bitmap's center rather than its click hotspot; hotspot validity and alpha checks remain. This helps actual native payloads but cannot solve the software Wisdom sprite above.

Replay the saved before/after frames directly through pure vision code. Supply the real paired source text, decode cursor RGBA metadata, and set replay `now` to the saved second-frame timestamp; never change timestamps in a real live observation. Add realistic positive/negative replay fixtures before further live iteration. Synthetic sprites copied pixel-for-pixel into frames passed while the actual game failed, so those tests alone are insufficient.

## 7. Speed work: eliminate redundant work before reducing timing margins

Treat existing algorithms and thresholds as implementation choices, not sacred requirements. Preserve the outcome guarantees below while replacing expensive or ineffective mechanisms.

1. Instrument phase durations and counts: startup, initial perception, clipboard reads, OCR, Wisdom arm/use, assessment, pickup, release verification, journal flush, cleanup. Log per-item latency and median/p95 over comparable runs. Include the three-second desktop countdown in user-visible time, or report it separately and explicitly.
2. First verify the restored same-process workflow actually reuses its cache across capture → identify → drop. A worker restart legitimately needs fresh evidence; normal phase transitions should not restart and rescan the whole bag.
3. Replace repeated per-cell copying with **physical-item** discovery and confirmed footprints. Retain full 12×5 coverage, including dim objects and positive empty cells, but do not perform identical clipboard work on every occupied subcell. Reuse known size/catalogue information, sprite segmentation, and the original representative-item scan with explicit ambiguity fallback. Touching identical items must remain separate.
4. Cache exact advanced text while fresh image evidence proves that physical item unchanged. Re-read identified/changed targets and Wisdom counts, not every unrelated cell. Avoid recomputing the full assessment for every intermediate observation if only one item changed; retain parity with shared assessment.
5. Replace unconditional delays with measured, bounded readiness polling where possible. The 250 ms hover fixed missed early currency reads after 140 ms failed; do not simply lower it again without validating the real failure. Clipboard sentinels, pointer binding, focus checks, and bounded timeout remain necessary.
6. Avoid repeatedly decoding/hashing full 3840×2160 BMPs and running whole-screen OCR when cached decode data or targeted current-frame regions provide equivalent evidence. Keep trustworthy original capture time and enough saved evidence for failures. Consider reuse of one frame across independent checks, incremental evidence, or cheaper durable action records; preserve flush-before-input semantics.
7. Investigate the original Shift-Wisdom identification approach for a bounded batch once actual mode recognition works. Any batching must preserve exact target identities, counted scroll use, stop/focus release, and restart reconciliation. Do not copy the old unverified burst-drop strategy. Serial verified drops may be necessary; optimize their observations/input transitions, not their accountability.
8. Separate optional network pricing from the normal identification/drop critical path. Local capture and assessment already make zero market requests. A missing price must never turn an item into junk.

Benchmark a human on a comparable item count, size mix, already-identified mix, and intended keep/drop choices. Use existing timing evidence or a short cooperative baseline if needed. The acceptance goal is **automated end-to-end faster than that human baseline**, not merely faster than the current 56-second scan. Seek a substantial margin and compare the historical 23–27-second implementation where workloads match. If no human baseline is available, report measured times and state that the faster-than-human claim is still unproven.

## 8. Reliability requirements and scope

- Use the app's shared assessment; do not invent a second bag price/quality model. Relevant modules are [`batchTriage.ts`](../src/core/batchTriage.ts), [`batchCapture.ts`](../src/core/batchCapture.ts), [`batchPricing.ts`](../src/core/batchPricing.ts), [`leagueKnowledge.ts`](../src/core/leagueKnowledge.ts), [`stashValuation.ts`](../src/core/stashValuation.ts), [`savedStashPricing.ts`](../src/core/savedStashPricing.ts), [`parseItem.ts`](../src/core/parseItem.ts), and [`priceFeedService.ts`](../src/main/priceFeedService.ts).
- Last tested profile: Forbidden Rites normal trade, `batch-triage-v1`, bundled knowledge `forbidden-rites-0.5.5b-2026-09-14.1`. Verify current local settings rather than assuming an old build uses them.
- Keep/Craft/Review, unknown modifiers/coverage, explicit overrides, supported valuable opportunities, and protective market evidence retain the item. Only positively supported low-priority equipment may drop. Currency, Wisdom, gems, waystones/tablets, special/unsupported objects, and equipped gear are protected.
- Identify once per physical item, not per occupied cell. Confirm same class/base/rarity/level/position after identification and the exact Wisdom decrement. No scroll for already-identified or unsupported items.
- Before a drop, confirm the current intended source, decision, held item, and target ground; after it, prove release and source departure with appropriate ground evidence. Current adapter expects a new matching world label. That receipt path has **never passed a live drop** and may expose further issues; test it without changing unknown into discard permission.
- Preserve process/window allowlisting, native emergency stop, user-held modifier checks, focus/map/loading/death/modal checks, and generated action traces through `GameInputController`.
- Maintain durable intent before input and verified results afterward. A crash or uncertainty must not cause a second arm/pickup/drop to be blindly replayed. Preserve original captures and stable physical IDs; fingerprints may change on identification.
- Stop on ambiguity, but distinguish expected UI transitions from actual identity loss. Reliability includes avoiding false stops that make the feature unusable.
- Inventory compaction remains a separate test. Do not claim sorting/compaction works merely because total occupied-cell count matches.

Read [`AGENTS.md`](../AGENTS.md), [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`GGG_COMPLIANCE.md`](GGG_COMPLIANCE.md), and [`QA_AUTOMATION_BOUNDARY.md`](QA_AUTOMATION_BOUNDARY.md). The repository requires preserving automation capabilities and existing interlocks; do not redesign the requested feature into manual-only advice.

## 9. Calibration, native host, and already-solved integration problems

Active profile and log:

```text
%APPDATA%/poe2-trade-companion/perception-templates/calibration.json
%APPDATA%/poe2-trade-companion/artifacts/map-triage/live-perception.json
C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2/logs/Client.txt
```

Last validated client: 3840×2160. Bag grid: `x=2530,y=1173,w=1289,h=541,cols=12,rows=5`. Inventory-title chrome patch: `x=2940,y=104,w=490,h=62`. Drop ground: `(1500,1300)`. Separate cursor probes: `(2710,900)` and `(3680,900)`, on blank statue backgrounds above the bag. Full software-payload observation rectangles are 263×481 at `(2578,659)` and `(3548,659)`; both were exactly static in fresh empty-cursor observations. Do not apply these coordinates to a different resolution/layout without validation.

Known empty native arrow SHA-256:

```text
968bdeb0a6388fd51a9d3be919e2d22189410c7891d9bb910bed257bc4d52bb9
```

The same native arrow hash occurs while Wisdom is software-rendered. Transparent 48×48 hash `7c6745d5354d9a39981badf273b32a3b25660180d51870df077c4618e6518c4e` was observed during occlusion/native-render problems; **do not calibrate transparent pixels as proof of an empty cursor**.

Already-solved details to preserve:

- Companion topmost occlusion: `src/main/bagCountdownWindow.ts` releases always-on-top and minimizes during countdown; `src/main/index.ts` wires it outside background smoke. The product's `CopyFromScreen` sees occluders, while the computer-use screenshot could show an unobstructed game through them. This discrepancy caused misleading early observations.
- Empty cursor observation was moved off animated map terrain. No permissible world pair had zero changes, so merely choosing a slightly quieter ground position did not work. Observation positions and the actual drop point are now separate.
- Full-frame OCR could garble/rotate labels. `visibleLifeInHud` binds a Life label to its same-row numeric value. Fallback OCR uses **the same saved frame**: tight label `(85,1580,75,47)` at scale 2 and wide value `(70,1570,440,60)` at scale 1. Numeric-only wide lines avoid duplicate labels. This combination was tested against seven saved frames. Inventory-open proof uses its calibrated title image patch. Do not freshen timestamps when OCR finishes.
- Native helper: [`scripts/win-bag-host.ps1`](../scripts/win-bag-host.ps1). It has its own approximately 5 ms monitor, stop-file/parent watchdog, pause, input release, expected cursor binding for copy chords, and saved-file-only `-OfflineOcr` / injected `-SelfTest` modes. **Num5 toggles pause; Num0, Insert, or Ctrl+Shift+Esc stop input.** These offline modes do not start the live monitor.
- `SetCursorPos` is also used by the original host; no evidence established it as the current failure. New copy hover is 250 ms, park 150 ms, mutation settle 180 ms. Native chord hold is 20 ms. Inter-key dwell differs from the old copy helper, but no causal failure was established; measure before changing.
- Physical-size fixes: Augment, Pinnacle Keys, Map Fragments are supported 1×1; exact `Shields` + `Vaal Tower Shield` is 2×4, leaving other shield defaults unchanged. Both grouping and completeness use `knownPhysicalItemSize`. Relics with unknown variable footprints remain uncertain.

## 10. Runtime paths, entry-point issues, and packaging

Core execution/ledger references:

| Purpose | Files |
| --- | --- |
| CLI and workflow orchestration | `scripts/map-triage.ts`, `src/core/bagTriageArgs.ts` |
| Live observation/input boundary | `src/adapters/liveBag.ts`, `src/adapters/bagMapContext.ts`, `src/adapters/winHost.ts`, `src/adapters/winHostInputSink.ts` |
| Session/receipt rules | `src/core/bagSession.ts`, `src/main/bagSessionStore.ts` |
| Physical identity and decision policy | `src/core/bagAssessment.ts`, `src/core/dumpValuationRun.ts`, `src/core/itemSizeCatalog.ts` |
| Desktop launch/status/stop | `src/main/bagTriageService.ts`, `src/shared/bagTriage.ts`, `src/renderer/components/tools/BagTriageTool.vue` |
| Hotkey dispatch | `scripts/action-daemon.ts`, `src/shared/hotkeyActions.ts`, `src/core/hotkeyBindings.ts` |
| Bundling and UI smoke | `scripts/build-stash-worker.mjs`, `e2e/bag-triage-smoke.ts`, `artifacts/playwright/electron-builds.json` |

`node scripts/build-stash-worker.mjs` rebuilds `dist-electron/map-triage.cjs` quickly without a full desktop package. The private `run-current.cjs` harness uses the manifest's Electron executable with `ELECTRON_RUN_AS_NODE=1`, an absolute current worker path, appdata data root, `windowsHide:true`, and a Node parent waiting for completion. A bare PowerShell `& <GUI Electron exe> ...` previously returned immediately and lost the worker when its caller ended; use the waiting harness or a proper child process lifecycle.

As of this handoff, the manifest points to newer builds than the September 14 trial:

```text
release/smoke-public-1789663448695-30456-1/win-unpacked/PoE2 Trade Companion.exe
release/smoke-qa-1789625888533-33848-1/win-unpacked/PoE2 QA Trade Bot.exe
```

These paths were read on September 17. Their existence does **not** establish which bag source/version is packaged or live-tested. Builds also change during unrelated work. Inspect fresh manifest/bundle contents and build from the intended source before claiming deployment. Do not reuse an older open companion merely because its title matches.

On September 14, an older user-owned action daemon was running from `Documents/Cursor Repos/poe2-trade-companion`. Its current status is unknown. Discover the exact active checkout/process before hotkey testing; do not assume editing this repo updates that process, run competing daemons, or indiscriminately kill Node/PowerShell processes. Never reuse the old recorded PIDs/window handles.

Additional integration checks still needed:

- Installed/packaged app, CLI, and Num6 should use the same calibration, data, profile, knowledge, and implementation. Development `src/main/index.ts` still supplies `process.cwd()` to the valuation/bag services; packaged mode uses user data. Decide/document explicit dev overrides without losing existing data or splitting assessment settings.
- `scripts/action-daemon.ts` still uses the inherited `spawn('npx.cmd', ['--yes','tsx',...])` helper. Verify the actual Windows launch path with an offline/no-input test; direct `.cmd` spawning/runtime bootstrap is a possible portability issue, **not an established diagnosed failure**.
- `npm run map:calibrate` still references legacy `--calibrate-moves`, which the new parser rejects. Legacy `--careful` and old timing flags are also not supported. Resolve/document compatibility deliberately; do not accidentally run old timing calibration that moves inventory items.
- Explicitly reject an incomplete initial ledger before a normal workflow reports success, including a bag with no eligible rows; inspect this edge case because per-item guards can be skipped when there are no candidates.
- Keep the actual payload-failure diagnosis alongside empty-fallback diagnostics.

## 11. Validation commands and evidence limits

Known previous results, not a claim about all current unrelated edits:

- At `75ca74a`: full lint, Node/Vue typechecks, and **1,644 tests in 142 files** passed, including offline native tests.
- Workflow restoration: 111 focused CLI/session/integration tests passed, and 27 desktop service/component/countdown/preload tests passed; targeted lint/typechecks passed.
- A later full verification command was interrupted from the conversation. Its process result is no longer retrievable; **do not claim that run passed**.
- Earlier packaged bag smoke tests passed before the latest restoration. The smoke source now opens Diagnostic controls and checks the primary action, but current packaged full-workflow validation must be rerun/extended.
- The 276-item policy regression and seeded stress tests are offline evidence. They prove neither real cursor recognition nor faster-than-human speed.

From the implementation checkout, run focused tests first:

```powershell
npx vitest run tests/bag-cursor-vision.test.ts tests/bag-pixels.test.ts tests/live-bag.test.ts tests/bag-session.test.ts tests/bag-session-store.test.ts tests/item-size-catalog.test.ts tests/integration/bag-worker.test.ts
```

Relevant additional tests: `tests/map-triage.test.ts`, `tests/bag-triage.test.ts`, `tests/item-sprites.test.ts`, `tests/hotkey-bindings.test.ts`, `tests/bag-triage-service.test.ts`, `tests/component/bag-triage-tool.test.ts`, `tests/integration/bag-native-host.test.ts`, `tests/performance/bag-layout-stress.test.ts`. Confirm filenames with `rg --files tests`; do not assume a similarly named test exercises the selected runtime path.

Before delivery:

```powershell
npm run lint
npm run typecheck
npm run test:all
npm run pack:smoke
npx playwright test --grep "bag triage worker runs offline" --workers=1
```

Packaging/smoke is expensive; run it after a coherent fix, not after every threshold experiment. Keep packaged tests in isolated hidden profiles with native-process/network guards. Extend packaged replay coverage to the restored full workflow. Test the actual Num6 dispatch as well as the direct worker; testing one entry does not prove another.

Live command forms below are for a **currently coordinated test window only**, after fixes/replays, using fresh journals and the right built worker:

```text
--stage=capture --journal=NEW.jsonl
--stage=identify --journal=CAPTURED.jsonl --run --max-identifications=1
--stage=drop --journal=CAPTURED.jsonl --run --max-drops=1
--stage=reconcile --journal=PENDING.jsonl
--stage=workflow --run --journal=NEW.jsonl --max-identifications=1 --max-drops=0
```

Do not blindly run identify/drop against the historical 08 pending journal. First understand/reconcile what actually happened; if its original map has ended, keep it as historical evidence and capture the new current situation. Do not edit its hash-chain to mark an unverified action complete.

## 12. Immediate plan and completion criteria

1. Read this handoff, check Git/diffs, and preserve the restored normal workflow and unrelated work. Read the original fast runner and current actual08 receipt/frames in parallel. Do not repeat the broad search for recordings or spend another session rebuilding a diagnostic product.
2. Build a small, reproducible offline diagnostic for the actual Wisdom pair. Preserve every failing reason, reproduce tint/sprite findings, then fix expected armed-mode appearance across **all three guards** and the software sprite matcher. Add meaningful adversarial replay tests, including dark/ambiguous items and wrong counts.
3. Profile and reduce the 120-copy initial scan and repeated perception work. Use physical-item identities and cache invalidation. Prove the same-adapter full workflow eliminates the old redundant pre-identify scan. Use the original efficient helpers where their assumptions can be verified.
4. Finish entry-point/data-root/launch compatibility, review uncommitted restoration, and run focused checks. Make normal app/Num6 use one action; retain diagnostics for debugging, not as mandatory user steps.
5. Coordinate live testing: one identification with exact decrement and unchanged protected identities, then one genuine low-priority drop with complete receipt, then a bounded mixed bag and repeated full bags. If no item qualifies for disposal, retain it and use a known low-priority test item; do not weaken policy just to generate a drop.
6. Measure comparable human and automated end-to-end times. Report item counts, scrolls consumed, decisions, actual drops, full latency breakdown, median/p95 where there are enough samples, false stops, and any errors. Keep benchmark scope identical; disclose cleanup/countdown/optional pricing exclusions.
7. Deliver a working built app/entry point, updated documentation, private before/after evidence and benchmark report, scoped commits, and an honest short status. Do not call it complete from green synthetic tests alone.

Success means the user can trigger the familiar feature once, it finishes the intended inventory work faster than the comparable human baseline, protected items remain intact, every reported action has evidence, and interruptions do not cause duplicated or wrong actions. No finite test proves perfection; state the actual tested scope and remaining limits.

## 13. Other reference documents and precedence

- [`HANDOFF_BAG_IDENTIFY_TRIAGE_LIVE_TEST.md`](HANDOFF_BAG_IDENTIFY_TRIAGE_LIVE_TEST.md): original detailed requirements and fault matrix; its implementation inventory describes an earlier baseline.
- [`BAG_LIVE_TEST_READINESS.md`](BAG_LIVE_TEST_READINESS.md): current implementation/capture notes, plus older readiness instructions that must be read in chronological context.
- [`HANDOFF-hotkey-actions.md`](HANDOFF-hotkey-actions.md): original Num6 flow, historical fast-mode timings, and daemon limitations.
- [`BAG_TRIAGE_VALIDATION.md`](BAG_TRIAGE_VALIDATION.md), [`BAG_CAPTURE_SEARCH.md`](BAG_CAPTURE_SEARCH.md): older offline/refusal and fixture-search history; do not mistake their obsolete “no live adapter” statements for present code.
- [`DUMP_VALUATION.md`](DUMP_VALUATION.md), [`FORBIDDEN_RITES_KNOWLEDGE.md`](FORBIDDEN_RITES_KNOWLEDGE.md), [`BATCH_TRIAGE_VALIDATION.md`](BATCH_TRIAGE_VALIDATION.md): shared assessment, profile, knowledge, and regression policy.
- [`USER_GUIDE.md`](USER_GUIDE.md): user-facing workflow; preserve unrelated edits when updating it.

Where older notes conflict, prefer the user's current request, fresh inspected code/evidence, and this dated handoff's status distinctions. The key correction is to **enhance the existing feature, fix the real Wisdom-mode blocker, and make measured end-to-end speed a first-class acceptance criterion**.
