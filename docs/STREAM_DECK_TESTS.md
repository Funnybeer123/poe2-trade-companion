# Stream Deck validation — September 17, 2026

## Automated results

| Check | Result |
|---|---|
| Repository lint and TypeScript | Passed |
| `npm run test:all` | 150 files, 1,803 tests passed, including unit, integration and replay/simulation coverage |
| Plugin TypeScript | Passed |
| Official Elgato manifest/package validation | Passed; installable package created |
| Packaged SDK harness (`npm test` in `stream-deck`) | Passed: SDK registration, key routing, duplicate press, counts, six image states and missing-app alert |
| Latest packaged Electron focused checks | Four passed: bridge and offline bag checks in both app editions |
| Full packaged smoke suite | Nine passed, six failed; not a clean full-suite result |

The bridge checks exercise authenticated loopback routing, all 75 action IDs, forbidden browser/token access, navigation, duplicate rejection, dry-run restrictions, emergency stop, rearm and the existing ring worker's no-input preview. Unit tests cover stale sessions, unavailable calibration, workflow exclusion, asynchronous failures, reconnect/lost-ack non-replay, and emergency cancellation despite status/audit failures. The existing Brood Circle isolated T1 mana rejection test passes; ring evaluation code was not changed.

The six full-suite failures were two combat shortcut-registration assertions while older companion processes were present, public Automation-on and QA-banner expectations, a public item-text label timeout, and QA topmost-window expectations. No clean-master comparison was run, so these are unresolved suite failures rather than proven pre-existing failures. Logs are under `artifacts/stream-deck/`: `test-all.log`, `smoke.log`, `deck-smoke.log` and `pack-app.log`.

## Actual local environment

- Detected connected Stream Deck XL 2022 (8×4 keys, no dials) through USB identification and the saved device model; Stream Deck 7.5.1.22901 is installed.
- Linked the plugin using Elgato's CLI. The real Stream Deck log reported the plugin connected at 21:03:28 local time. This confirms host loading, not physical keypress behavior, and predates the final rebuild.
- Added a separate three-page PoE2 Companion XL profile. Compared hashes for all 75 files of the original Default Profile: zero changed. Backup and hashes remain local under `artifacts/stream-deck/`.
- Launched the newly packaged companion and successfully read its authenticated status with all 75 actions. After the user closed older instances, launched it on the left secondary monitor and confirmed an acknowledged Dry-on command and `dryRun: true`. The app is left open for testing.
- Inspected the generated icon contact sheet with 96-pixel key previews. Raster rendering and SDK image paths are also exercised by the plugin harness; no physical LCD legibility claim is made.

## Remaining physical checks

Windows denied termination of the running elevated Stream Deck process. Quit Stream Deck through its tray menu and reopen normally to load the final plugin/profile. Launch the new companion, select PoE2 Companion XL, and enable **DRY ON** before testing. Saved desktop preferences can initially select Live; confirm the displayed mode.

Test Home, Settings, Dry on, Emergency stop and Rearm; verify page navigation and the fixed stop keys. Confirm disconnected icons when closing the app, reconnect on launch, and the ring preview without input. Physical keypresses, display updates on the actual LCDs, profile navigation on-device, and live purchase/sale/drop/craft workflows have not been verified. Potentially destructive tests used fixtures, replay or no-input previews. No game actions were deliberately executed against the live client.

The standalone legacy action daemon remains outside the app's worker lifecycle and retains its native stop controls. See `STREAM_DECK.md` for workflow-specific preview and pause semantics.
