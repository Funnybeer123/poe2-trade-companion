# HANDOFF — PoE Overlay II feature port (2026-09-11)

This document is being written alongside the work. It records the scaffold
every ported feature plugs into, the packages, and the live checks still
open. Sections marked *pending* are filled in as packages land.

## The scaffold (shipped first)

- **Feature modules** — `src/main/features/types.ts` (`FeatureModule`,
  `FeatureContext`, `FeatureServiceMap`), `src/main/features/context.ts`
  (`createFeatureRuntime`: registers modules in order, owns the channel set,
  the window list `emit` reaches, the dry-run mirror and the settings
  channels), `src/main/features/registry.ts` (the ordered `FEATURE_MODULES`
  list; foundations first). `src/main/index.ts` builds the runtime after the
  existing services exist and disposes it on `window-all-closed`.
- **One generic bridge** — `src/shared/features.ts` (`FeatureCall`,
  `ContractShape`, `isFeatureChannel`, `bindFeatureApi`, the scaffold's
  `AppFeatureContract`), `window.poe2.features` in `src/main/preload.ts`
  (`invoke`/`on`, channel pattern `pkg:verb`), and
  `src/renderer/services/featureApi.ts` (`createFeatureApi<Contract,
  Events>()` → `null` in the browser preview).
- **Settings store** — `src/main/settingsStore.ts`:
  `%APPDATA%/poe2-trade-companion/companion-settings.json`, one sanitized
  namespace per feature (`ctx.settings.namespace(id, normalize)`), atomic
  writes, `settings:get` / `settings:set` channels and a `settings:changed`
  event.
- **Dry-run mirror** — the renderer's top-bar switch is mirrored into main
  through `app:set-dry-run`; hotkey-driven actions read `ctx.dryRun()`.

Tests: `tests/features-scaffold.test.ts`, `tests/integration/preload-contract.test.ts`.

## Foundations (wave 1, shipped 2026-09-11, offline-tested only)

Interfaces are pinned in the design notes; every wave-2 feature consumes
them through `ctx.require(<service>)` and the `pkg:verb` channels.

- **F1 overlay + hotkeys** — `src/main/overlayWindow.ts` (transparent,
  frameless, always-on-top at the screen-saver level, click-through
  always except while the pointer is over a panel — the game keeps every
  other click; "close on click outside" means a typing panel closes when
  the window loses focus — focus hand-off for typing panels, display under the cursor or the primary display, hidden
  within 5 s of the game closing), `src/main/hotkeyService.ts` +
  `src/core/hotkeyRegistry.ts` (Electron accelerators, reserved keys:
  Ctrl+C/V, Ctrl+D, Ctrl+Shift+Esc, the voice hotkey, Num0–9 and the
  numpad operators; persisted in `%APPDATA%/poe2-trade-companion/overlay-hotkeys.json`),
  `src/renderer/overlay/` (OverlayApp + PanelHost chrome + the built-in
  `notice` toast panel; mounted by `src/renderer/main.ts` for `#/overlay`),
  `src/renderer/features/hotkeys/OverlayHotkeysSection.vue` (in Tools →
  Hotkeys). Channels `overlay:*`, `hotkeys:*`; settings namespace
  `overlay`; hotkey action `overlay.hide-all` (unbound).
- **F2 client log** — `src/core/clientLog.ts` (every observed PoE2
  Client.txt line shape; trade whispers in 11 languages, English verified),
  `src/core/areaCatalog.ts` (all 378 observed area ids → name/category/
  act/level; unverified names flagged), `src/core/gameSettingsFile.ts`,
  `src/main/features/clientLog/` (Steam incl. libraryfolders.vdf →
  standalone → Epic → override; 2 MB backfill without live events; 500 ms
  polling; truncation restart; 5,000-event ring buffer). Channels
  `client-log:*`; settings `client-log`; service `clientLog`.
- **F3 chat commands** — `src/core/chatCommands.ts` (placeholders,
  sanitation, host-typable characters, 30/min + 400 ms limiter),
  `src/main/chatCommandService.ts` (kill switch → enabled → text → dry-run
  → rate → another-host probe → host `rect` foreground/allowlist check →
  Enter / type / Enter, each preceded by a kill-switch check; host closes
  after 60 s idle; every attempt traced to `qa-action-trace.jsonl` with
  `module: "chat"`). The host script gained `ctrlf` and the `@`/`^`
  keys for it. Channels `chat:*`; settings `chat-commands`; service
  `chatCommands`.
- **F4 trade2 generic** — `src/core/tradeQuery.ts` (typed query →
  trade2 body, exchange body, trade-site URL build/parse incl. the encoded
  `?q=` form, `tradeQueryFromItem` with the Evaluate profiles),
  `src/core/tradeListings.ts` (rich listing + exchange parsing),
  `PriceFeedService.tradeSearch/tradeFetch/tradeExchange/tradeBudget/hasSession`
  (additive; same pacer, cookie, cache and 429 memory),
  `src/main/liveSearchService.ts` (`ws`, cookie required, ≤ 20 sockets,
  backoff, paced fetches). Channels `live-search:*`; settings
  `live-search`; service `liveSearch`.

## Foundation extensions (2026-09-14)

Reviewed designs for the ported features asked the foundations for a few
more seams; these were accepted and added (additive only, every existing
test unchanged). Baseline after them: 143 test files, 1,422 tests,
`npm run typecheck` and `npm run lint` clean.

- **Scaffold** — `FeatureContext.openPath(target)` (Electron `shell.openPath`
  semantics: `""` means success, any other string is the OS error) and
  `readonly appPath`; the `app:navigate` event any feature may emit to bring
  the desktop window to a route (the integrator subscribes once in `App.vue`).
- **Overlay** — `setFocus(panelId, focus)` and `overlay:set-focus` so a panel
  can take and release keyboard focus without being re-shown (releasing it
  cannot be mistaken for a click outside), `onStateChange(cb)` for main-side
  subscribers, and `hideAll(includePinned?)`.
- **Client log** — `client-log:reload-settings` plus `reloadGameSettings()`
  on the service; `MapHideout*` ids now classify as hideouts, not maps.
- **Chat commands** — `stashSearch(text, reason, { focus })` and
  `copyHoveredItem({ reason, source })`: one audited Ctrl+C that saves the
  clipboard, types the copy, polls for item text for at most 900 ms, and
  restores the clipboard when nothing arrives. The item text is returned to
  the caller only — it never reaches the trace, the status or the event.
- **Trade2** — `statsPayloadCached()`, `statCatalogue(types)`,
  `fetchStatic()`, `tradeSearchById()` (UNVERIFIED endpoint — keep an
  id-only fallback until the first live check), `MarketTrendsService.series()`,
  and a budget guard on live search: a fetch batch is dropped, never retried,
  when the trade2 budget is short or a penalty window is open, and a rate-limit
  error stops every live search.
- **Guard** — `tests/input-boundary.test.ts` now walks the whole feature tree
  and fails if any ported feature imports the input host or sends an input op.
  The single audited exception is the stash-tracker's read-only window probe.

## Packages (wave 2, 2026-09-14)

Ten feature modules, registered in this order after the foundations in
`src/main/features/registry.ts`. All of them are implemented, unit- and
component-tested offline, and wired into the renderer; **none has been run
against the live game**. Each package's own `src/main/features/<pkg>/WIRING.md`
holds the exact shared-file edits, and `docs/features/<pkg>.md` is its reference
doc.

**P1 `evaluate` — the price-check overlay.** Hover an item, press `Alt+E` (or
`Ctrl+D`): one audited `Ctrl+C` through `chatCommands.copyHoveredItem`, an
editable trade2 query built from the item, one paced search plus one paced
fetch, the listings, the bulk-exchange price for stackables and an estimated
band with its sample size. Channels `evaluate:*` (11) plus the
`evaluate:session` event; settings namespace `evaluate`; overlay panel
`evaluate` (anchor `cursor`, 620×560); hotkeys `evaluate` (`Alt+E`) and
`evaluate.clipboard` (unbound). Code in `src/core/evaluate{Item,Query,Results}.ts`,
`src/shared/evaluate.ts`, `src/main/features/evaluate/`,
`src/renderer/features/evaluate/` (workbench, overlay panel, Item log section).
Persists nothing but its settings namespace — sessions, item text and listings
stay in memory.

**P2 `market` — the in-app trade browser.** Route `/market`: query builder with
stat autocomplete, favourites in folders, ten live tabs, import from trade2
links, bulk exchange, websocket live searches (≤ 20) and per-row whisper /
`/hideout`, one chat line per click. Channels `market:*`; settings namespace
`market`; no overlay panel (it uses the foundation's `notice` toast); hotkey
`market.open` (`Alt+M`, group **Desktop**). Code in `src/core/market*.ts`,
`src/shared/market.ts`, `src/main/features/market/`,
`src/renderer/features/market/`, curated data in `src/data/market/`
(`category-labels.json`, `exchange-currencies.json`, `weight-templates.json` —
all three need a `files:` entry in both electron-builder configs). On disk:
`market-favorites.json`, `market-tabs.json`, `market-live-searches.json` under
userData — queries, drafts and live-search ids only, never listings or seller
names.

**P3 `trade` — offers and history.** Route `/trade` plus the `trade` overlay
panel: offer cards built from the whispers in `Client.txt` (buyers and sellers),
one chat line per click (invite, trade, hideout, stash highlight, quick
whispers), Windows notification / in-game toast / beep / Discord / Telegram, and
a 14-day history with CSV export that merges the shop ledger's verified sales.
Channels `trade:*` with `trade:changed` and `trade:history-changed`; settings
namespace `trade`; overlay panel `trade` (`top-right`, 380×260); hotkeys
`trade.panel` (`Alt+T`), `trade.invite-latest` and `trade.trade-latest` (both
unbound). Code in `src/core/{tradeOffers,tradeHistory,tradeNotify}.ts`,
`src/shared/trade.ts`, `src/main/features/trade/`,
`src/renderer/features/trade/`. On disk: `trade-offers.json`,
`trade-history.json` and `trade-webhooks.secret.json` (the ONE webhook editor
lives in Tools → Settings; no URL or token ever enters
`companion-settings.json`).

**P4 `commandsBookmarksNotes` — Commands & notes.** Tools entry at
`/tools/commands` with four lists: chat commands with `{player}`/`{area}`/…
placeholders, stash searches, bookmarks (external browser or one sandboxed
always-on-top window) and markdown/image notes. One key press = one gesture.
Channels `commands:*`, `bookmarks:*`, `notes:*`; settings namespaces `commands`,
`bookmarks`, `notes`; overlay panels `notes` (`left`, 440×380, `Alt+N`) and
`stash-search` (`cursor`, 380×220, `Alt+F`); per-item hotkeys are unbound until
the user picks a key. Code in `src/core/commandsBookmarksNotes{,Markdown}.ts`,
`src/shared/commandsBookmarksNotes.ts`,
`src/main/features/commandsBookmarksNotes/`,
`src/renderer/features/commandsBookmarksNotes/`. On disk: the three settings
namespaces plus `notes-images/`.

**P5 `inspect` — item insight overlay.** `Alt+I` analyses the item on the
clipboard: prefix/suffix, tier and roll per modifier, the best tier this item
level could hold, weapon DPS and defences at Q20, wiki/poe2db links, and
severity-rated map warnings for waystones and tablets. No network, no input
(unless the off-by-default `inspect.copyOnHotkey` asks chat-commands for one
`Ctrl+C`). Channels `inspect:*`; settings namespace `inspect`; overlay panel
`inspect` (`cursor`, 440×560); hotkey `inspect.show` (`Alt+I`, group
**Overlay**). Code in `src/core/inspect{,Tiers,MapMods,Links}.ts`,
`src/data/inspect/dangerousMapMods.ts` (every entry `verified: false`),
`src/shared/inspect.ts`, `src/main/features/inspect/`,
`src/renderer/features/inspect/`. Reads `artifacts/tab-admin/mod-tiers.json` and
`trade-stats.json` read-only; writes only its settings namespace.

**P6 `stashTracker` — snapshots, compare and the in-stash price overlay.** Tools
entry at `/tools/stash-tracker`: named and automatic snapshots of the sorter's
`Ctrl+C` ledger, history and compare (including removed items), session gains,
per-tab totals, exclusions and a worth timeline; `Alt+P` draws price labels over
the stash tab you picked, in a click-through window. Channels `stash-tracker:*`;
settings namespace `stash-tracker`; overlay panel `stash-prices`
(`bottom-right`, 300×168); hotkeys `stash-tracker.overlay-toggle` (`Alt+P`),
`stash-tracker.overlay-next-tab` and `stash-tracker.snapshot` (unbound). Code in
`src/core/stashTracker{Snapshot,Timeline,Overlay}.ts`,
`src/shared/stashTracker.ts`, `src/main/features/stashTracker/`,
`src/renderer/features/stashTracker/`. On disk:
`stash-tracker/snapshots.jsonl`, `stash-tracker/summary.json` and its
byte-identical mirror `stash-tracker-summary.json` (the frozen `TrackerSummaryFile`
contract P7 reads). `src/main/features/stashTracker/hostProbe.ts` is the one
audited `startWinHost` import outside chat-commands; its only op is
`{ op: "rect" }`.

**P7 `session` — Home, character, mapping, recap, deaths.** Route `/home` is now
the app's landing screen: character and campaign progress from `Client.txt`, map
runs with tiers and portals, AFK and post-game recap, death screenshots, stash
gains and market movers from local caches, and the setup checklist with
recommended actions. No game input, no network. Channels `session:*` (13) with
`session:changed`, `session:recap`, `session:death`; settings namespace
`session`; overlay panel `session-recap` (`center`, 380×300); hotkeys "Show
session recap" and "Capture a screenshot now" (both unbound, group **Session**).
Code in `src/core/session{Tracker,History,Home,Deaths}.ts`,
`src/shared/session.ts`, `src/main/features/session/`,
`src/renderer/features/session/`. On disk: `session-current.json`,
`session-history.jsonl` (newest 200) and `deaths/` (JPEG + thumbnail +
`deaths.jsonl`, capped at 60). Reads the stash-tracker summary and
`trade-history.json` read-only.

**P8 `campaignGuide` — levelling route, map and XP.** Tools entry at
`/tools/campaign`: the bundled community route per act, the area you are in
right now from the "Generating level N area" line, an under/over-levelled
estimate, a schematic world map, editable areas and objectives, and an overlay
panel that shows itself in campaign areas. Channels `campaign:*`; settings
namespace `campaign-guide`; overlay panel `campaign` (`right`, 380×520, pinned);
hotkey `campaign.toggle` (`Alt+G`, group **Overlay**). Code in
`src/core/campaignGuide{,Map}.ts`, `src/shared/campaignGuide.ts`,
`src/main/features/campaignGuide/`, `src/renderer/features/campaignGuide/`, and
the bundled `src/data/campaign/route.json` (every entry `verified: false`; it
needs a `files:` entry in both electron-builder configs or a packaged build
degrades to `bundled.source: "missing"`). Route corrections, ticked objectives
and visited area ids live in the settings namespace — nothing else.

**P9 `pricingHistory` — Tools → Pricing.** Every item poe2scout prices for the
league, with 1/3/7-day change, 7-day volume, sparklines, favorites and a local
timeline that grows past the seven days the feed serves. No game input and no
trade2 request: it asks the shared Market trends service for the cached
snapshot, so one paced refresh serves both screens. Channels `pricing:*`;
settings namespace `pricing-history`; no overlay panel; hotkey `pricing.open`
(unbound, group **Desktop**). Code in `src/core/pricingHistory.ts`,
`src/shared/pricingHistory.ts`, `src/main/features/pricingHistory/`,
`src/renderer/features/pricingHistory/`. On disk:
`pricing-history/<league>.json`, kept under about 4 MB per league.

**P10 `appSettings` — Tools → Settings.** The first-run checklist (five required
steps, five optional), overlay placement/scale/opacity, the chat-command switch,
the Client.txt override and game read-outs, window options, the changelog and
the About/maintenance block — plus the on-demand administrator-rights probe and
the UAC relaunch, both refused in `public-companion`. Channels `app:*`; settings
namespace `app`; no overlay panel (the overlay test reuses `notice`); hotkey
`app.show-window` (unbound, group **Desktop**). Code in
`src/core/appSettings{Checklist,Changelog,Elevation,Window}.ts`,
`src/shared/appSettings.ts`, `src/main/features/appSettings/`,
`src/renderer/features/appSettings/`. It creates `CHANGELOG.md` at the repo root
and needs it added to `files:` in both electron-builder configs. `SetupChecklist`,
its `SetupStepId` values and the `action` strings are a frozen cross-package
contract with P7.

## First live checks

**Nothing in wave 2 has been run against the live game.** Every package below is
offline-tested only; the list is the first pass, in the order it should be run —
read-only features first, then the ones that can type. Record what happened
next to each item.

Before starting: put Path of Exile 2 in **borderless windowed** (exclusive
fullscreen captures black frames and hides the overlay), pin the pricing league
under Tools → Settings → Market data, and leave the top-bar **Dry-run** switch
**on** until group 7.

### 1. Settings, window and overlay (P10)

1. Open Tools → Settings and confirm the setup checklist renders without
   spawning anything (no `powershell.exe`); the admin step reads `unknown`.
2. Press *Test overlay* on a second monitor with `primaryMonitorOnly` on, then
   off, and confirm where the panel lands each time.
3. Press *Reset window positions* with a panel pinned — it must hide the pinned
   panel too, and re-centre the window at 1120×860.
4. Move and resize the window, restart the app, and confirm the bounds come
   back. The window appears centred first and then jumps to the saved
   rectangle — expected, not a bug.
5. Tick *Open when the game starts*, quit and relaunch Path of Exile, and
   confirm the window restores within ~20 s **without** stealing the game's
   keyboard focus.
6. Press *Check administrator rights* against a normal game (expect "no") and
   against an elevated game (expect the "likely" hint).
7. Run *Relaunch as administrator* and confirm the elevated copy actually
   starts — the dev path passes the absolute app path plus `-WorkingDirectory`;
   check the packaged path too, which passes neither.

### 2. Home, session and deaths (P7)

1. Start the app after the game, with a level-up in the last 2 MB of
   `Client.txt` → Home shows the character.
2. Run one map → a run row with its tier appears under Home → Maps.
3. Die → a screenshot lands under Home → Deaths within ~2 s (or the black-frame
   note appears, which means the game is not borderless windowed).
4. Type `/afk` in game → the recap panel opens centred without taking focus;
   `/afk off` hides it again.
5. Quit the game → a Windows notification and the "Last session" card on Home
   within ~2–3 min (four absent process polls plus two minutes of log silence;
   the probe must have seen the game at least once, so a blocked PowerShell
   never ends a session on its own).

### 3. Campaign guide (P8)

1. Enter Clearfell with the app running → the panel appears pinned at the right
   edge and the game keeps the mouse.
2. Portal to the hideout → the panel hides within one poll.
3. Press × on the panel → it does not return until the next area.
4. `Alt+G` toggles it.
5. Trigger a level-up line → the XP chip updates.
6. Quit the game with the panel open, relaunch, enter an area → it auto-shows
   again (the silent-sweep path).
7. Check `Ngakanu` and the act-4 area names: rename them in-app, export the
   route JSON, and paste it into `src/data/campaign/route.json` if it is right.

### 4. Inspect (P5)

1. Copy one item with advanced descriptions (hold `Alt` before `Ctrl+C`) and
   compare the game's own `(Tier: N)` with the learned ladder — the tier
   **numbering direction** is still unverified (`knowledge.tierDirection`).
2. Confirm the advanced `value(min-max)` range form exists in PoE2; if it does
   not, add a real paste to `fixtures/inspect/` and adjust `stripAdvancedRanges`.
3. Copy a real T15 waystone and check it against
   `src/data/inspect/dangerousMapMods.ts` — every entry is `verified: false`,
   and unmatched lines are listed in the panel.
4. Confirm the tablet and waystone affix limits (currently 2/2 and 3/3, both
   unverified).

### 5. Pricing history (P9)

1. With the league pinned, press Refresh once and confirm the header stamp and
   the row counts.
2. The next day, Refresh again and confirm `pricing-history\<league>.json`
   gained bars (Expert options shows items · bars · file size).

### 6. Stash tracker (P6)

1. Press `Alt+P` over an open, previously scanned tab → the labels align with
   the items (top-level tabs are shifted one strip row).
2. Click over the labelled grid → the clicks still reach the game.
3. Press the legend's × → the labels disappear with it.

### 7. Evaluate (P1)

1. Dry-run **on**: `Ctrl+C` an item, press `Alt+E` → the panel opens at the
   cursor with the rows ticked and the chip "Dry-run · clipboard · lookups still
   run"; Search fills the table and the band.
2. Dry-run **off**: hover an item, press `Alt+E` → the clipboard changes, one
   `copy-hovered` line appears in
   `assistive-artifacts/qa-action-trace.jsonl`, and the panel says "Copied with
   one Ctrl+C".
3. Press `Alt+E` with the desktop app focused → the notice panel says Path of
   Exile is not the foreground window, and no input was sent.
4. Press `Alt+E` on a rare with auto-search on → the panel must be on screen
   **before** the table fills, and a second press while it is still spinning
   must re-show the same panel without a second search.
5. Evaluate a currency stack → the bulk-exchange table shows a per-unit price
   and stock, labelled with the quote currency (an exalted stack is quoted in
   divine). A median that disagrees with the feed by over 25 % prints as a note
   under the median, not as a red error.
6. After the watchlist has spent the window → Search is disabled with a penalty
   countdown and no request goes out.
7. Confirm the pseudo texts resolve against the **real** `/data/stats` payload
   (`+#% total Elemental Resistance`, `+# total maximum Life`, and whether the
   attribute/mana/ES ones exist at all) — an unresolved pseudo silently produces
   no row, which is safe but invisible.

### 8. Market (P2)

1. Search a base type (`Ruby Ring`, sorted by price) → exactly one search and
   one fetch in Tools → Diagnostics, and ten rows.
2. "Load 10 more" → exactly one more fetch.
3. **Copy whisper**, then paste it into the game by hand, and confirm the text
   the site produced is what landed on the clipboard.
4. **Send whisper** with Dry-run **on** → the notice reads "Dry-run: would type
   «…»" and no keystroke reaches the game.
5. Send the same whisper live with Path of Exile in the foreground → one line,
   and that seller's other rows fold.
6. **/hideout** on a row that names a character → one line, a separate gesture.
7. Bulk exchange divine → exalted → one request and a plausible ratio.
8. Live search from the tab in step 1 with a POESESSID set → the state chip goes
   `connecting → open`, a new listing chimes, and Stop closes it.
9. A weighted template with and without a session cookie → the "too complex"
   message must appear only without one.
10. Import a share link copied from the trade site → it opens as an id-only tab
    (or, once `tradeSearchById` is verified, with results).

### 9. Trade (P3)

1. Dry-run **on**: whisper yourself from a second account → a card appears
   within a second, and Invite shows "would type /invite …".
2. Dry-run **off**: press Invite from the **desktop** view → the game comes
   forward and the invite lands (the F3 `focus` path).
3. Press Highlight with the stash open, once from the desktop view and once from
   the overlay panel.
4. Panel → **Custom…** → type → `Ctrl+Enter`: the panel must stay open and the
   whisper must land (the `setFocus` hand-off is UNVERIFIED).
5. Send an `@Name text` quick whisper and confirm it lands as a whisper, not as
   local chat (UNVERIFIED through the host).
6. Complete a real 1-ex trade → a history row and updated totals.
7. Check the party / area-join lines for an **outgoing** trade (UNVERIFIED).
8. Press `Alt+T` with the game borderless-fullscreen.
9. Press **Test** on a Discord webhook.

### 10. Commands & notes (P4)

1. Bind a command to `Alt+1` and press it in the hideout → exactly one
   `/hideout` line and exactly one trace entry.
2. `Alt+F`, type `"^Waystone"`, press Enter → the stash box fills exactly once
   (the focus hand-back is UNVERIFIED live; it fails safe with
   "Blocked: not-foreground").
3. `Alt+N` → the note shows without taking focus from the game.
4. Open a bookmark in the always-on-top window mode and confirm it is visible
   over a borderless-windowed client.
