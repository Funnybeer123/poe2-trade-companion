# PoE2 Companion · Stream Deck XL

Implemented from remote master `6003765` on `codex/stream-deck`. No merge or cherry-pick of `d98d879`. The working tree was clean before changes. Existing ring evaluation, including the isolated T1 mana rejection, is unchanged.

## Install and launch

1. Close old PoE2 Companion instances. Quit Stream Deck from its tray menu and reopen it **normally**, so the newly linked plugin can load. The previously running Stream Deck was elevated; Windows denied this task access to restart it.
2. Launch the newly built companion using `artifacts/stream-deck/Launch Companion.ps1`, or the executable in `artifacts/playwright/electron-builds.json` under `public-companion`.
3. Select **PoE2 Companion XL** in Stream Deck. A separate profile has been added; the original **Default Profile** and its unrelated actions were backed up and preserved. If importing elsewhere, double-click `artifacts/stream-deck/com.poe2companion.deck.streamDeckPlugin`; it includes the editable XL profile. The standalone `.streamDeckProfile` is also provided.
4. Press **DRY ON** first for physical testing. Open Settings and Calibration from the deck. Unavailable buttons explain their reasons in the Stream Deck Property Inspector. Keep **E STOP** in the bottom-right corner of every page.

The local development install links `stream-deck/com.poe2companion.deck.sdPlugin` into the user's Stream Deck Plugins folder. Keep that source directory in place. The packaged `.streamDeckPlugin` is independent of the checkout and can replace the development link through Stream Deck's normal plugin installation UI. Developer mode was enabled using Elgato's CLI for local validation.

To rebuild: run `npm ci` in `stream-deck`, then `npm run typecheck`, `npm run build`, `npm test`, and `npm run pack -- --force`. Run `npm run pack:smoke` from the repository to rebuild both app editions. No external Node or `npx` is needed by the packaged app's bundled workflows.

## Hardware and layout

Detected USB VID `0FD9`, PID `008F`, corroborated by the saved profile model `20GAT9902`: **Stream Deck XL 2022**, 8 columns × 4 rows, 96×96 key images, no dials. Installed software: **7.5.1.22901**. The existing profile was **Default Profile**. No device serial is included in the distributable profile.

The dedicated profile has three named pages: Workflows, Combat & tools, and Settings. The last row contains Previous/Next page navigation and fixed controls: Dry on, Live, Rearm, Stop, Emergency stop. Some less frequent workflow tools are on Settings because the first page is full. [Complete mapping](STREAM_DECK_MAPPING.md) lists every assigned action and location. Drag actions from the **PoE2 Companion** category to change assignments using Stream Deck itself. Every action is independently reusable; multi-actions are disabled to prevent accidental workflow chains.

## Behavior and boundaries

- The app owns execution. The plugin sends only registered IDs with an explicit empty parameter object; there are no arbitrary IPC calls, shell commands, keyboard shortcuts, coordinate clicks, or copied workflow implementations in the plugin.
- Ring gambling calls the existing bounded `gamble` stage (at most 60 purchases); cleanup calls `cleanup` and passes `--rescan`, never purchasing. The existing reject/retain policy and native input interlocks are reused unchanged.
- Empty, Fill and Two-cycle share saved desktop allowlists and transfer pacing. Sort execution requires a current executable preview. Gear sorting, crafting, shop, repricing, vendor cycle and valuation use the existing service and scripts, now bundled for installed builds and given writable app-data paths.
- Combat Start/Resume explicitly starts the saved configuration. Pause is the app's existing stop-and-preserve-config behavior. Flask, Unleash, Sigil and Verisium controls toggle settings through the same validator; configuration changes stop combat and require an explicit restart. They do not synthesize physical triggers or drink/cast directly. Sigil validation still requires its supported module configuration.
- “Open” actions only navigate to the named tool. Editors and operations requiring an item selection, search text, a reviewed tab plan or other contextual data remain in those tools. Clipboard item evaluation, scan grids, price feed refresh, helper calibration/modes, saved valuation, and tab survey have direct buttons.
- Bag Identify/Drop stages have no existing no-input live preview. The deck reports them unavailable while Dry-run is enabled; use the existing replay tools for those workflows. Ring previews use the existing worker's no-input path. Scripts retain their existing preview semantics (some scan the game to construct a plan); tests of destructive actions use fixtures/replay instead of running those scripts against the live game. Operations without a preview refuse under Dry-run.
- Existing native Num5 pause/step-teaching controls remain unchanged; the app exposes no corresponding service command for those workers. The deck's Pause/Resume buttons control combat. Stop and Emergency stop cancel all app-owned workflows. A separately launched legacy action daemon is not an app-owned worker; its own native stop controls remain applicable.

## Connection and status

The app binds HTTP only to `127.0.0.1` on an OS-assigned port and writes a per-launch capability token to `<app userData>/stream-deck/connection.json`. The plugin reads the standard user's `poe2-trade-companion` directory. Browser origins and missing/incorrect tokens are rejected. Only `/v1/status` and `/v1/command` exist. Credentials are never placed in profiles, property-inspector settings, or distributable assets.

Every command has a unique ID and app-session ID. Duplicate IDs and stale sessions are rejected; commands are never queued or replayed after disconnect, timeout, or restart. Lost acknowledgements tell the operator to check the app before pressing again. Pending starts exclude other workflows, including desktop and voice starts through the shared service gates. Emergency stop bypasses status checks and optional connection-log failures. Rearm starts nothing and refuses while workers remain active.

The plugin polls current service state every 750 ms and turns disconnected within the request timeout. Icons use symbols plus labels: active triangle, pause bars, unavailable barred circle, disconnected cross and error exclamation. Real bag/combat counts and transfer/sort progress are displayed when available; no synthetic progress percentage is shown. The Property Inspector gives live reasons. Command acknowledgements are logged under `assistive-artifacts/stream-deck-actions.jsonl`; services retain their existing mandatory input traces.

## Artwork

`stream-deck/icons.mjs` is the editable drawing source. `stream-deck/assets/svg/` contains an SVG for every action/state (75 × 6). The build emits 72-pixel PNGs and `@2x` 144-pixel PNGs, plus 96-pixel XL previews. Icons use original geometric fantasy motifs and command-specific labels/badges. Contact sheets are in `artifacts/stream-deck/contact-sheet.png` and `states.png`.

## Validation and physical check

See [test results](STREAM_DECK_TESTS.md). Physical keypress verification is still required after restarting the elevated Stream Deck and closing older companion instances. Begin with Home, Open Settings, Dry on, Emergency stop and Rearm. Confirm the bottom-right stop key on each page, then run the ring preview. Only after verifying calibration and the saved settings should you explicitly select Live for game workflows.

Official references consulted September 17, 2026: [SDK distribution](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/), [manifest and image formats](https://docs.elgato.com/streamdeck/sdk/references/manifest/), [runtime versions](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/), [XL hardware](https://docs.elgato.com/streamdeck/hid/stream-deck-xl/). The plugin uses official `@elgato/streamdeck` 2.1.2, Node 24, minimum Stream Deck 7.1 and the official CLI packager/validator.

