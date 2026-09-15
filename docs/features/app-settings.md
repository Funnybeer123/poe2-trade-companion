# App settings (`appSettings`)

Tools → Settings: the first-run checklist, overlay placement, the chat-command
switch, the Client.txt override and game read-outs, window options, the
changelog and the About/maintenance block.

Channel prefix `app:*`. Settings namespace `app`. One hotkey action
(`app.show-window`, group **Desktop**, unbound by default). No overlay panel of
its own — the overlay test reuses the foundation's `notice`.

## What it does NOT do

- **No game input.** No input host, no host ops, no `GameInputController`. The
  chat-command toggle only flips the chat-commands module's `enabled` setting;
  that module keeps its own kill-switch / foreground / rate-limit / dry-run
  chain. The overlay test shows the passive, click-through `notice` panel.
- **No network of its own.** *Check leagues* and *Refresh prices* on the
  checklist call the existing, throttled `PriceFeedService.leagues()` /
  `.refresh()`. There are no trade2 calls, no bulk anything, no webhooks.
- **No secrets.** Nothing here reads, writes or displays a token. POESESSID
  stays in `price-feed.secret.json`; Discord/Telegram webhooks stay in Trade's
  own `*.secret.json`. `normalizeAppSettings` drops every key it does not know,
  so a stray secret cannot survive a round trip through the `app` namespace,
  and `app:reset-settings` refuses every namespace except `app` and `overlay` —
  validating the whole list *before* it resets anything, so a mixed list wipes
  nothing.
- **No automation.** No auto-elevation, no auto-refresh, no background
  price lookups.

## PowerShell

Exactly two strings, both built in `src/core/appSettingsElevation.ts` and
covered by a blocking test:

1. `ELEVATION_PROBE_SCRIPT` — a constant with no interpolation. It asks whether
   the current process is in the Administrators role and tries to open a handle
   to each `PathOfExile*` process. A denial from a non-elevated caller means the
   game is *likely* elevated. It reads no memory and writes nothing.
2. `relaunchElevatedCommand(exe, args, env, options)` —
   `$env:POE2_BUILD_MODE = '…'; Start-Process -FilePath '…' [-ArgumentList @('…')]
   [-WorkingDirectory '…'] -Verb RunAs`. Every value goes through `psQuote`
   (single quotes, embedded `'` doubled — inside single quotes PowerShell
   expands nothing). Its only variable parts are `process.execPath`, the app
   path and the build mode; never user text.

**Neither runs on its own.** Opening Tools → Settings starts no process: the
probe fires only when the user presses *Check administrator rights* in the Game
client section, and `app:elevation` is refused outright in `public-companion`
(the button is hidden there too). That button forces a fresh run, so a second
press after restarting the game really re-checks rather than replaying the 30 s
memo. Until someone presses it the checklist's admin step reads `unknown`,
which is optional and blocks nothing.

The relaunch is refused outright in the `public-companion` build, refused when
the app is already elevated, hidden behind a disclosure plus a confirming second
click in the UI, and gated by Windows' own UAC prompt. It keeps the same
user-data directory, so the dry-run preference survives.

Two details about the elevated child, because the obvious assumptions are wrong:

- **The build mode travels in the bundle, not in the environment.** Vite defines
  `__POE2_BUILD_MODE__` for the dev *and* packaged main bundles, so the mode is
  already baked in. UAC elevation goes through ShellExecuteEx/AppInfo, which
  builds a **fresh** environment block for the elevated child — the `$env:`
  prefix in the command cannot reach it. The prefix stays as belt-and-braces for
  a future build that drops the define.
- **The app path is passed explicitly.** AppInfo does not carry the caller's
  working directory either, so the dev path (`electron .`) would elevate with a
  `.` that resolves somewhere else. The command therefore passes the absolute
  `ctx.appPath` as the argument *and* as `-WorkingDirectory`. A packaged build
  passes neither: it needs no argument, and its `ctx.appPath` is inside
  `app.asar`, which `Start-Process` cannot chdir into.

The default relaunch runner gives PowerShell a 5-minute timeout — the child
lives until the user answers the UAC prompt — and reports a killed child as
"the Windows prompt was not answered" rather than as an exit code.

## Why the admin hint exists

Windows UIPI silently drops keyboard/mouse input and global hotkeys sent from a
lower-privilege process to an elevated window. If the game runs as
administrator and the companion does not, transfers, chat commands and overlay
hotkeys fail with focus errors and nothing explains why. The probe turns that
into one sentence. It is a heuristic — protected and anti-cheat processes also
deny handles, and a localized Windows words the exception differently — so the
vocabulary is "likely" / "no" / "unknown", the checklist step is optional, and
nothing is ever blocked by the verdict.

## The setup checklist

`app:setup-checklist` is the single source: main derives every step and both the
Settings card and Home render the same payload. `SetupChecklist`, its
`SetupStepId` values and the `action` strings are a frozen cross-package
contract.

| Step | Required | Verified against |
|---|---|---|
| Game detected | optional | `ctx.poeWindows()` |
| Client.txt | **required** | `clientLog.status()` — watching, source, error |
| Pricing league | **required** | `priceFeed.status()` — resolved / ambiguous / last error |
| Market prices | **required** | feed entry count and age (stale after 36 h) |
| PoE session cookie | optional | `priceFeed.hasSession()` |
| Hotkeys | **required** | `hotkeys.list()` — count and registration errors |
| Overlay | **required** | the stamp left by a successful *Test overlay* |
| Administrator rights | optional | the cached elevation verdict |
| Calibration | optional | the stash and bag grids in `calibration.json` |
| Chat commands | optional | the chat-commands service's `enabled` / `dryRun` |

`required` is 5; `done` counts required steps in state `ok`. An optional step
can never block completion, `unknown` never counts as done, and a foundation
read that fails degrades exactly one step to `unknown` instead of throwing.

The card polls every 15 s while mounted — the handler reads cached state and
launches nothing at all. It does **not** probe the administrator rights: that
step reads `unknown` until the user presses *Check administrator rights*, after
which `app:elevation-changed` refreshes the card.

## Window behaviour

- **Remember position and size** — saved to the `app` namespace, debounced
  400 ms, skipped while maximised. On start the tracker polls `ctx.mainWindow()`
  (500 ms, ≤ 120 tries, because the scaffold has no window-created hook) and
  restores the rectangle only when at least half of it still lands on a display
  that exists. Expected on a restart: the window appears centred and then jumps
  to the saved bounds — `createWindow()` has no `show: false` handshake.
- **Keep above the game** — `setAlwaysOnTop`.
- **Open when the game starts** (expert) — a 20 s poll that runs only while the
  setting is on and the window is hidden or minimised, edge-triggered on
  absent → present, and never calls `focus()` so the game keeps keyboard focus.
  The first poll after the option is switched on only *records* whether the game
  is already running, so ticking the box mid-session never pops the window over
  the game; the edge fires on the next genuine start.
- **Reset window positions** — hides every overlay panel including pinned ones,
  then re-centres the window at 1120×860 and forgets the saved rectangle.
  `setSize`/`center` make Electron emit `resize`/`move`, so bounds saves are
  suppressed across the reset and for one debounce window afterwards —
  otherwise the centred rectangle would be written straight back and "forget
  where the window was" would never forget.

## Where the data lives

`%APPDATA%/poe2-trade-companion/companion-settings.json`, namespace `app`:

```json
"app": {
  "window": { "rememberBounds": true, "alwaysOnTop": true, "showOnGameStart": false,
              "bounds": { "x": 120, "y": 80, "width": 1180, "height": 900 } },
  "setup": { "dismissedAt": "…", "overlayTestedAt": "…" },
  "changelog": { "lastSeenVersion": "0.1.0" }
}
```

Elevation reports (memoised 30 s), the checklist (derived per call) and the
changelog text (read per call, capped at `MAX_CHANGELOG_CHARS` = 512 K UTF-16
characters; a leading UTF-8 BOM is stripped so a Notepad-saved file still
parses) are not persisted.

## User guide section (draft for `docs/USER_GUIDE.md`)

### Settings

- **Setup checklist** — what each step verifies, which steps are optional, and
  Dismiss / Show checklist.
- **Overlay** — panel scale and opacity, ultrawide handling, primary-monitor
  only, show only while Path of Exile runs, and *close on click outside*:
  panels that took keyboard focus (search fields) close when you click the game;
  the rest close with Escape or the Hide-all hotkey — the game always keeps its
  clicks. *Test overlay* shows one panel so you know where they appear.
- **Notifications & chat** — the chat-command switch (one line per gesture,
  stopped by Ctrl+Shift+Esc and by the Dry-run switch). Trade offers, quick
  whispers and Discord/Telegram webhooks live in Trade → Trade settings; the
  live-search chime lives in Market → Market settings.
- **Game client** — Client.txt detection order (Steam → standalone → Epic →
  your override), the language/resolution/chat-key read-outs, *Re-read game
  config*, and *Check administrator rights*: it lists the game's processes and
  tries to open one handle, nothing else, and runs only when you press it.
  *Relaunch as administrator* raises Windows' own prompt and is hidden in the
  public build.
- **Window** — remember position, keep above the game, open when the game
  starts, *Reset window positions*.
- **Changelog** — what changed, with a badge counting releases you have not
  opened yet.
- **About & maintenance** — version and paths, *Open data folder* / *Open
  shared config folder*, and *Reset app & overlay settings* (two clicks; it
  touches nothing else).

## Integration

`src/main/features/appSettings/WIRING.md` carries the exact lines the
integrator adds (registry entry, the `<AppSettingsSections />` drop-in,
`CHANGELOG.md` plus the two electron-builder `files:` entries, the e2e
expectations, the docs sections and the input-boundary lines).

## Tests

`tests/app-settings.test.ts`, `tests/app-settings-changelog.test.ts`,
`tests/app-settings-checklist.test.ts`, `tests/app-settings-elevation.test.ts`
(includes the blocking PowerShell-construction assertions),
`tests/app-settings-window.test.ts`, `tests/app-settings-module.test.ts`, and
the four `tests/component/app-settings-*.test.ts` files. All offline: the exec
seam, the Electron slice, the timers, the clock and the feature bridge are
injected.
