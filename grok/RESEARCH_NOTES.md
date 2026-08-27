# Research Notes

## 2026-08-27 — Phase 01 environment

- Host `node -v`: `v22.14.0` (`/exec-daemon/node`). nvm default `v22.22.2`. Matches locked Node 22 LTS. `.nvmrc` = `22`.
- npm: `10.9.7`.
- Electron 40 latest observed: `40.10.6` (EOL 2026-06-30). Current stable: `44.0.0` (2026-08-25). Phase 01 pins `electron@^40.10.6` per plan §4.3. Install succeeded; no swap.
- Installed toolchain (2026-08-27 `npm install`): TypeScript `5.9.3`, Vitest `3.2.7`, ESLint `9.39.5`, Prettier `3.9.6`, Vue `3.5.42`, Vite `6.4.3`, `vue-tsc` `3.3.11`. ESLint 9.39.5 prints a “no longer supported” warning; kept ESLint 9 per locked default.
- Vitest 3.2.7 deprecates `vitest.workspace.ts`. Phase 01 uses root `vitest.config.ts` `test.projects` instead.
- Production (`--omit=dev`) audit: 0 vulnerabilities.
- EE2 reference stack remains Electron `^40.9.1` from the plan audit; license re-check deferred to Phase 08 copy time.

## 2026-08-27 — Official GGG API re-check

Sources fetched:

- https://www.pathofexile.com/developer/docs
- https://www.pathofexile.com/developer/docs/reference
- https://www.pathofexile.com/developer/docs/authorization

Confirmed still true (matches plan §3.1–§3.2):

- Header: “There are currently limited APIs that return PoE2 game information.”
- Server: `https://api.pathofexile.com`.
- Account Stashes, Guild Stashes, Public Stashes: **PoE 1 only**.
- Account Leagues, League Accounts, PvP Matches: **PoE 1 only**.
- Character `inventory` and `rucksack`: **PoE1 only**. `skills` is PoE2-only.
- Item Filters and Leagues support `realm=poe2`.
- Currency Exchange: `GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]` with `realm=poe2`.
- No documented official PoE 2 item trade-search API in the developer reference.
- Developer portal still: “We are currently unable to process new applications.”

No Phase 01 code change required. Official filter sync and account APIs remain optional/blocked.

## 2026-08-27 — Phase 03 native input

- Host is Linux. `NativeInputSink` binds `koffi` → `user32.SendInput` / `SetCursorPos` and is Windows-only.
- `koffi` is a dependency of `packages/native-input` only. Installed `koffi@2.16.3` (requested `^2.14.1`). Public Electron start path does not import it.
- Constructing `NativeInputSink` on this host throws `native-unavailable` (non-win32). The same error is thrown if `koffi` itself cannot load (unit-tested via an injected loader).
- Live Windows `SendInput` is **BLOCKED: windows-native** on this agent. Phase 03 unit/replay/non-native tests do not require it.

## 2026-08-27 — Phase 04 persistence

- Added `better-sqlite3` for `packages/persistence-sqlite`. Unit/integration tests open `:memory:` databases in Node 22. Electron ABI rebuild remains Phase 15.
- Replay never constructs a native sink. `ReplayRunner` hard-wires `NoopInputSink`.

## 2026-08-27 — Phase 05 perception / process names

- Host is Linux. `Win32ProcessQuery` throws `perception-unavailable` off win32 (unit-tested). No live Path of Exile 2 client was available.
- Default allowlist remains the plan §4.3 placeholders:
  - process names: `PathOfExile.exe`, `PathOfExile_x64.exe`, `PathOfExileSteam.exe`
  - window title include: `Path of Exile 2`
- Record actual image names and titles here after a Windows live detection pass. Do not treat the defaults as verified client names.
- Screen capture v1 adapter is `ElectronFrameSource` (`desktopCapturer` injected). CI uses a fake capturer; it does not open PoE.
- Clipboard source is read-only and injected. No copy keystroke is synthesized.
- `koffi` is now used in two packages: `packages/native-input` (SendInput) and `packages/perception-live` (GetForegroundWindow / process image). Import guard allows koffi in both; SendInput stays native-input-only.
- `sharp@^0.34.3` added as a root devDependency for PNG fixture load in tests. `templateMatch` itself is a pure RGBA function in `packages/core`.

## 2026-08-27 — Phase 08 EE2 license + parser re-verify

Performed **before** copying any EE2 files.

- Repo: https://github.com/Kvan7/Exiled-Exchange-2
- `license.spdx_id`: MIT
- `LICENSE` at `acc7653f05629228f12e273ab1b8da3e46d6bcd1` (2026-06-20T13:57:42Z): MIT, Copyright (c) 2020 Alexander Drozdov
- Parser file list still matches plan §3.4 exactly (`Parser.ts`, `ParsedItem.ts`, `advanced-mod-desc.ts`, `calc-base.ts`, `calc-q20.ts`, `magic-name.ts`, `meta.ts`, `modifiers.ts`, `stat-translations.ts`, `index.ts`).
- `renderer/src/assets/data` in git is only `index.ts` + `interfaces.ts`. Item/stat tables are fetched at runtime from Vite `BASE_URL` ndjson/bin and are **not** in the git tree.
- `assets/data/index.ts` imports `@/web/background/TradeData` (trade-site). Not vendored.
- Record: `packages/core/src/vendor/exiled-exchange-2/SOURCE.txt`

## 2026-08-27 — Phase 08 official API re-check

Sources fetched:

- https://www.pathofexile.com/developer/docs
- https://www.pathofexile.com/developer/docs/reference

Confirmed still true (matches plan §3.1–§3.2):

- Header: “There are currently limited APIs that return PoE2 game information.”
- Currency Exchange still documented: `GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]` with `realm=poe2`. Hourly aggregate digests. Wait until the next hourly boundary when `next_change_id` equals the requested id. Historical only; no current-hour data.
- Still **no documented official PoE 2 item trade-search API**. Community `/api/trade2` and `POESESSID` flows remain undocumented. Not implemented.
- Account Stashes / Public Stashes / Character inventory: still PoE 1 only.
- Developer portal still: “We are currently unable to process new applications.”

Rate-limit behavior: honor `Retry-After`; do not retry-storm. Unit tests inject `fetch` and use `fixtures/market/currency-exchange-hourly.json`.

## 2026-08-27 — Phase 09 official stash API re-check

Source fetched: https://www.pathofexile.com/developer/docs/reference

Confirmed still true (matches plan §3.1 / §12.1):

- Header: “There are currently limited APIs that return PoE2 game information.”
- Account Stashes, Guild Stashes, Public Stashes: **PoE 1 only**.
- Character `inventory` and `rucksack`: **PoE1 only**.
- No documented official PoE 2 stash or inventory API.
- No `StashApiObservationPort` added. Observation is perception + clipboard hover + local shadow state only. No invented endpoints.

## Deferred

- Actual PoE 2 process image names / window title on a Windows client (still unverified).
- `koffi` / `better-sqlite3` Electron ABI (Phases 03/04/15).
- EE2 MIT + parser revision: completed 2026-08-27 (see Phase 08 note).
- Windows live SendInput + emergency hotkey on a real display (`BLOCKED: windows-native`).
- Live `desktopCapturer` against a real PoE 2 window.
