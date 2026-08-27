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

## Deferred

- Actual PoE 2 process image names / window title (Phase 05).
- `koffi` / `better-sqlite3` Electron ABI (Phases 03/04/15).
- EE2 MIT + parser revision immediately before Phase 08 copy.
