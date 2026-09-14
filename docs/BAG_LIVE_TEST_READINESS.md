# Staged bag testing readiness

Updated 2026-09-14. Implementation checkout: `Documents/Codex/poe2-trade-companion`.

## Current operating instruction

The user is playing while the app is repaired **offline**. Do not activate the
game, start a live worker, capture the game, or emit game input until the user
says they are ready to resume testing. Mocked process tests, deterministic
replays, saved-image analysis and isolated packaged-app smoke tests remain
available offline.

**Live identification and ground drops have not been proven.** Earlier live
attempts stopped during readiness/capture checks. New adapter code and offline
tests are not a completed live acceptance run. The older
`BAG_TRIAGE_VALIDATION.md` records the earlier offline-only baseline; this file
describes the current integration and the acceptance work still required.

## Desktop controls and runtime

Open **Tools → Bag triage** (`/tools/bag-triage`). The panel offers separate
Capture bag, Identify one, Drop one low-priority item, Reconcile and Stop
actions. Capture creates a new timestamped journal. Other stages use the
selected live journal; replay journals cannot authorize live actions. Starting
one stage never chains into identification or dropping.

Each stage has a cancellable three-second countdown. Capture and reconciliation
may move the pointer and copy item text; they do not identify or discard items.
Identification and drop buttons each impose a hard one-item limit. Compaction
remains disabled. Ordinary capture and assessment make no market requests.

The panel shows actual missing worker, inventory calibration, cursor/inventory
reference or client-log requirements. **Refresh setup** rechecks local files
without accessing the game. Starting a stage rechecks those files and the
global interlock before launching.

Both development and packaged desktop controls execute the built
`dist-electron/map-triage.cjs` worker with Electron's Node runtime. Development
does not require `tsx` or bootstrap packages on button clicks; if the bundle is
missing, run `npm run build` and refresh setup. Packaged builds resolve the
worker inside `app.asar.unpacked`.

The worker receives the same valuation data root used by the app: the checkout
in development, or the app's user-data folder when packaged. Inventory
calibration comes from the app's `perception-templates/calibration.json`.
Cursor/inventory references default to
`artifacts/map-triage/live-perception.json` inside that data root.
`POE2_BAG_PERCEPTION_FILE` and `POE2_CLIENT_LOG` override the desktop paths;
relative overrides resolve against the selected data root. League/profile
settings and embedded knowledge use the shared valuation service.

## Fixes and evidence boundaries

- The former unconditional “live testing is not ready” entrypoint now routes
  through the staged live adapter after validating configuration and paths.
  Output, temporary output, journal and lock cannot alias inputs or one another,
  including case aliases, linked directories and existing hard links.
- Map context comes from a positive client-log entry sequence: client-safe
  instance ID, generated map area, matching scene and completed loading. Entry
  identity changes on reentry. Transitions, disconnects, process changes and
  incomplete log lines invalidate prior context. This does not prove life,
  focus, inventory visibility or safe ground by itself.
- Cursor payload recognition compares the paired, journaled source item with
  observations at two separated world positions. It uses source pixels and
  cursor movement, including lossless native cursor RGBA/alpha evidence.
  Empty-cursor proof also checks both positions. An intended action or a
  per-item hash entry is not sufficient to infer a held item. Unknown or
  contradictory evidence stops the stage.
- HUD OCR reads the **saved frame** used for cursor/inventory evidence.
  Thresholded life-text OCR is a second view of that same image. Native capture
  timestamps are retained; OCR completion cannot make an old frame fresh.
  This addresses cursor/HUD verification gaps exposed during the earlier
  stopped capture work. End-to-end live confirmation is still pending.
- The native host owns process/window checks and a five-millisecond stop
  monitor. Num0, Ctrl+Shift+Esc, pause and parent loss release its owned keys
  and buttons. User-held modifiers/buttons cannot silently alter generated
  actions. Num5 pauses/resumes; stopping stays latched.
- Desktop Stop writes an owned cancellation file. The native monitor releases
  input before acknowledging it; the app waits for acknowledgement before
  forced worker termination. Global emergency stop and app shutdown signal
  the same worker. Other app input services are blocked during a bag stage.

Private captures, copied item text, cursor proof, OCR, input traces and session
journals remain under ignored local artifacts. Do not commit them or replace
missing live evidence with synthetic fixtures.

## CLI

The following are invocation forms, **not instructions to run live while the
user is playing**. Run the built worker with Node, or through the desktop.

```text
node dist-electron/map-triage.cjs --stage=capture --journal=NEW_SESSION.jsonl
node dist-electron/map-triage.cjs --stage=identify --journal=SESSION.jsonl --run --max-identifications=1
node dist-electron/map-triage.cjs --stage=drop --journal=SESSION.jsonl --run --max-drops=1
node dist-electron/map-triage.cjs --stage=reconcile --journal=SESSION.jsonl
```

Optional explicit paths: `--calibration=FILE`, `--perception=FILE`,
`--client-log=FILE`, `--output=FILE`. Live identification and drop require
`--run`; reconciliation rejects it. Offline forms are
`--from-scan=FILE --output=OTHER_FILE` and
`--replay=FILE --stage=STAGE --journal=FILE`. Replay rejects live flags and never
starts a native host. Old bulk-drop/calibration flags are rejected.

## Required staged acceptance after the user is ready

1. **Full-bag capture:** observe all 60 cells of the 12×5 bag. Confirm complete
   footprints and zero unread cells; preserve distinct identical items and
   different rolls. Verify Wisdom at `(0,0)`, protected classes, current map,
   life, inventory, cursor and ground evidence. Review shared decisions.
2. **One identification:** retain Keep/Review controls in the bag. Arm the
   verified Wisdom stack and identify exactly one eligible physical item.
   Require the same source identity/position, the exact stack decrement of
   one, identified text and an empty cursor. Verify all other items unchanged.
3. **One positive Low-priority drop:** select only a positively assessed,
   fully observed low-priority item. Recheck map/source/policy before pickup;
   prove the intended held payload; then require empty cursor, absent source
   and a new matching ground receipt. Keep/Craft/Review/unknown/protected items
   must remain.
4. Only after the separate stages pass, consider a bounded batch. A stop,
   mismatch or uncertain receipt requires reconciliation/inspection, never a
   blind retry or recovery click. Keep compaction off throughout this test.

## Final verification record

- ESLint and Node/Vue typecheck passed.
- Full regression: 140 test files and 1,616 tests passed on 2026-09-14 at
  16:26 local time. Final focused native/background checks also passed
  (8 tests, including the 20-case injected C# self-test).
- Both unpacked builds succeeded:
  `release/smoke-public-1789421249673-30228-1/win-unpacked/PoE2 Trade Companion.exe`
  and `release/smoke-qa-1789421275498-19780-1/win-unpacked/PoE2 QA Trade Bot.exe`.
- Two packaged bag smoke tests passed. They inspected the hidden desktop panel,
  verified disabled actions without setup, and ran assessment/capture/one-item
  identification replays with native-process and network guards. Both windows
  remained hidden and unfocused. The panel screenshot was visually reviewed.
- Existing 3840×2160 calibration and saved inventory/empty-cursor references
  were validated and placed in the desktop data directory. A read-only check
  of the packaged worker with the actual local settings returned zero setup
  issues; league is Forbidden Rites with the bundled 0.5.5b knowledge snapshot.
  No native host started during that check.

Logs and screenshots remain in ignored `artifacts/bag-live-*` and
`artifacts/playwright/` locations. When the user is ready, launch the prepared
build instead of reusing an older open companion process, then run the staged
acceptance above. Live identification/drop counts are still **zero proven**.
