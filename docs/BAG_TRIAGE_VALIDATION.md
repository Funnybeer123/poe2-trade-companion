# Bag triage offline implementation and remaining live blockers

Date: 2026-09-14. Implementation checkout: `Documents/Codex/poe2-trade-companion`.
Baseline: `0f008a1`, with shared assessment from `55ea75b`.
Tested implementation: **`af88584`** (`feat: add durable staged bag triage replays`).

## Status

**Not ready for controlled live bag testing.** No live capture, Num6 invocation,
identification, ground drop or compaction was performed. No game preparation
is requested yet. The automatic feature remains the intended outcome; this
delivery implements and tests its offline stages but does not claim the full
handoff is complete.

The previous runner used legacy appraisal, incomplete physical coverage,
touching-fingerprint deduplication and bulk drops. It started native hosts
before sufficiently validating flags and could not prove each item's departure.
It has been replaced at `scripts/map-triage.ts`; its historical implementation
remains in Git. Vendor-cycle and legacy pure map helpers retain their existing
APIs and behavior; their tests pass, but their safety is not certified by this
bag workflow. In particular, vendor's old unknown-disposal behavior is not the
new bag policy.

## Implemented and tested

- `bagAssessment.ts`: all 60 inventory cells are represented; item cells require
  matching independent text reads, and empty cells require explicit evidence.
  Missing, ambiguous, stale or incomplete footprint observations remain unread.
  The existing shared physical-item audit splits fully supported footprints,
  preserving touching identical copies and items with different rolls.
- The bag adapter calls `assessRow`/`assessBatch`, using embedded knowledge and
  saved weights/feedback/quote rules. Default: **Forbidden Rites normal trade**,
  **batch-triage-v1**, **forbidden-rites-0.5.5b-2026-09-14.1**. It does not contain
  a separate pricing/quality model or use starter prices. Ordinary assessment
  performs zero requests. The default replay capture uses the bundled profile;
  saved-report assessment honors that report's selected profile.
- Eligible unidentified equipment consumes at most one verified scroll per
  physical item per attempt. Identification uses separate arm/identify actions,
  exact before/after base/class/rarity/level and position, full-bag reconciliation,
  cursor state and exact stack decrement. A spent last scroll remains in the
  historical ledger at quantity zero. Already identified and unsupported items
  consume none. A short stack leaves remaining items unidentified.
- Scope is the entire captured bag. Shared Keep/Craft/Review outcomes, explicit
  feedback, unknown evidence, protected classes and fresh adequate market quotes
  retain items. Only shared Low-priority with complete known evidence permits a
  preview. This is a local heuristic, not proof that market value is zero.
- `bagSession.ts`: separate identification/drop/read-only reconciliation stages,
  default one-drop limit, no compaction or blind retries. Pickup requires current
  map instance, focus, inventory, modal/death/loading, calibration, ground and
  exact full-bag state. Release additionally requires intended held-item evidence.
  Claimed drops require source absence, empty cursor and a new ground receipt
  associated with that action. A failed middle drop stops before the next item.
- `bagSessionStore.ts`: exclusive writer lock, append-only full-state journal,
  chained hashes and `fsync` before input. Originals and receipts survive restart.
  Torn/corrupt histories fail closed. Reconciliation can recognize an already
  completed identification/drop only with matching observation receipts; pending
  arming/pickup requires inspection and never triggers recovery clicks.
- `bagReplay.ts` and the CLI use the same staged runner. Invalid arguments and
  saved files fail before native adapters. Offline and replay execution are
  independently tested with network/socket/child-process entry points made fatal.
  Num6 dispatches the same capture stage, currently blocked by readiness checks.

## Verification

- `npm run lint`: passed.
- `npm run typecheck`: passed after correcting the parameter shape in a table-driven
  CLI test.
- `npm run test:all`: **132 files, 1,459 tests passed**, including integration,
  component, performance and existing replay suites. The new cases include
  empty/full coverage, multi-cell/duplicate layouts, unsupported classes, Wisdom
  faults, source/cursor/scroll mismatch, context changes, stop checkpoints,
  individual drop failures, malformed inputs and durable restart outcomes.
- Seeded stress: seeds **1–32**, three bounded drop cycles per layout, **1,195
  physical items**, **371 individually receipted synthetic drops**, **30,705 ms**
  in the final full-suite run. Mixed sizes, gaps, identical copies and Keep/Review
  controls were included; protected IDs survived. These are synthetic scene/input
  replays, **not recorded game screenshot replays**.
- `npm run pack:smoke`: both desktop packages built. Final focused Playwright
  run: **4 passed in 9.0 seconds**, covering the bag worker and existing stash
  settings/report/worker flow in both packages with isolated data. No installed
  app was replaced. The final worker SHA-256 is
  `a0d9bbc6ccce179ca5d492b11585ef9becc804dd6d2e03cc91301d4e7072e709`.
  Build directories: `release/smoke-public-1789409145674-6452-1` and
  `release/smoke-qa-1789409159053-12584-1`. These are offline test builds, not
  certified live bag builds.

The saved **276-item** private regression produced the same **8 Keep, 6 Craft,
255 Review and 7 Low-priority** outcomes. The bag-policy projection falsely
discarded **zero** shared Keep/Craft/Review rows. Both historical moved amulet
receipts and all original text/quotes were preserved; the source SHA-256 stayed
`ea4cd8cfbbee2f2bef79b8cd692bd55ed1eef7cf2794c882f1beecfaac576f5e`.
Projection coordinates are synthetic policy inputs, not a new bag capture or
permission to act at historical stash coordinates. No private text was sent to
an external service. No installed app/report was changed.

Ignored local evidence:

- `artifacts/map-triage/saved-regression/{assessment,policy-projections,summary}.json`
- `artifacts/map-triage/stress-summary.json`
- `artifacts/map-triage/capture-search/`: local capture inventory and contact sheets;
  see [search findings](BAG_CAPTURE_SEARCH.md).
- `artifacts/bag-real-regression.log`, `bag-all-tests.log`, `bag-lint.log`,
  `bag-typecheck.log`, `bag-package.log`, `bag-desktop-smoke.log`
- `artifacts/playwright/electron-builds.json` and isolated smoke artifacts.

Reproduce the core checks:

```powershell
npx vitest run tests/bag-session.test.ts tests/bag-session-store.test.ts tests/integration/bag-worker.test.ts tests/performance/bag-layout-stress.test.ts
npm run lint
npm run typecheck
npm run test:all
npm run pack:smoke
npx playwright test --grep 'bag triage worker|dump values persist'
```

The private regression script accepts only `--from-scan=FILE` and
`--output-dir=IGNORED_DIRECTORY`; build it with the local esbuild dependency
and run the bundle under `artifacts/batch-offline-guard.cjs` to enforce zero
network/child-process access, as done in `bag-real-regression.log`.

## Remaining work before readiness

1. **Actual perception adapter.** The native host exposes cursor coordinates,
   not a verified held-item identity/state. There is no validated positive map
   instance signal or current ground/modal/death verifier in this repository.
   The old absence-of-stash check is insufficient. `BagScene` requires those
   observations explicitly; synthetic evidence does not establish them live.
   A broader search found real map screenshots and older teaching frames in
   other folders, but no verified complete Wisdom-use/pickup/drop/cursor sequence
   in the inspected material. Reuse [those findings](BAG_CAPTURE_SEARCH.md)
   when implementing and validating this adapter with representative recorded map,
   inventory, cursor-held, currency-use, ground-label and obstruction frames.
2. **Actual native cancellation.** Wire that adapter's actions through
   `GameInputController`, a dedicated stop monitor and native cancellation/input
   release that survives pause, focus changes, worker termination and a blocked
   JavaScript loop. Test actual interruption during native execution, not only
   the tested JavaScript checkpoints. Never enable live because replay passes.
3. **App/staged worker integration.** Add the live staged button/worker/session
   controls and propagate the app's selected profile, data paths and emergency
   stop into the worker. Packaged offline bundling is not this integration.
4. **Optional pricing stage.** Wire explicit selected IDs to the existing
   `priceBatch`/`PriceFeedService` queue (default ten searches). The bag adapter
   already honors saved market protections; the map CLI does not yet dispatch
   pricing. Keep this disabled for initial live trials.
5. **Recorded replay and staged live validation.** The user confirmed on
   September 14 that their bags are full and they are in a map, and explicitly
   requested live testing. That authorization remains in effect; do not ask for
   the same preparation permission again. After the above tests and package
   checks pass, report the exact build/commit and readiness. Reobserve the current
   map, foreground calibrated client, inventory, verified top-left Wisdom stack
   and Keep/Review controls before acting; preparation may have changed.
   State exact scroll count, hard drop limit, validated ground point and stop
   keys. Under the existing authorization run capture, identify-only, one drop,
   then bounded mixed/repeated batches. No supported live commands are offered
   here because the missing adapters cannot yet satisfy those guarantees.

## September 14 authorized live attempt: capture blocked

The user requested testing with their full bag in a map. A read-only Windows
computer-use observation confirmed the open inventory, a visible checkpoint,
and a 40-count scroll sprite in the top-left bag cell. Exact advanced item text,
the scroll's identity, a stable map-instance signal and held-cursor state were
not programmatically verified. This screenshot is real evidence of the prepared
scene, not a complete physical-item capture or a passing perception test.

The source worker and both packaged workers were invoked with `--stage=capture`
and distinct new journal/output paths while the game was running. All three
exited with status 1 and `Live bag testing is NOT ready`; none created a session
journal. This is the worker's explicit missing-adapter guard, not an approval
rejection or a problem with the user's preparation. Identification, pickup,
dropping and compaction were not attempted; this attempt generated no game input.

Both packaged bag workers had SHA-256
`a0d9bbc6ccce179ca5d492b11585ef9becc804dd6d2e03cc91301d4e7072e709`.
The public package used was `release/smoke-public-1789412540165-34176-1`;
the QA package was `release/smoke-qa-1789409159053-12584-1`. The separately
running companion window belonged to an older public package
(`smoke-public-1789285261261-27460-1`); it was not used to trigger item actions.

Private evidence remains ignored under
`artifacts/map-triage/live-2026-09-14/`: `before.jpg`, `observation.json`,
`entrypoint-results.json`, and the reproducible `check-entrypoints.mjs` runner.
The result is **live stage 1 blocked before capture**, not an end-to-end live
pass. The integration tasks above still need implementation before identification
or drop trials can proceed.
