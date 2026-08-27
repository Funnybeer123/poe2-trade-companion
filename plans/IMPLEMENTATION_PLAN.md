# PoE2 Trade Companion — implementation plan

Source of truth: repository `README.md`, `AGENTS.md`, and `docs/*`.

## Product split

- `public-companion`: price check, catalog, sort/sell recommendations, market watchers, loot-filter export. No movement, loot clicks, stash moves, or trade completion.
- `authorized-qa`: same domain plus follow/loot/stash/listing/trade after build flag, local acknowledgement, window allowlist, persistent QA banner, and emergency stop. Destructive scenarios default to dry-run.

No invented PoE 2 stash HTTP API.

## Stack

Windows 11, Electron + TypeScript, Vue 3 + Vite, in-memory/SQLite-shaped persistence, Vitest, electron-builder. npm lockfile (pnpm was not available in the build environment). Game input only through `GameInputController`.

## Layout

- `src/main/` Electron lifecycle, hotkeys, clipboard, kill switch
- `src/renderer/` Vue overlay, catalog, dashboard, replay, filter, settings
- `src/core/` domain, parse, valuation, desirability, planners, capabilities
- `src/adapters/` clipboard and capture
- `fixtures/` item texts, frames, market quotes
- `tests/` unit, replay, input-boundary

## Phases

0 Foundation: RuntimeCapabilities, QA gates, CI, public vs QA packaging flags.
1 Clipboard parse + fixture market provider.
2 Live provider wrapper with cache/backoff, valuation, desirability.
3 FrameSource, InputSink, GameInputController, replay without OS input.
4 Window allowlist helpers, region detection, OCR label helper, perception fixtures.
5–11 Follow, loot, stash, listing, trade, orchestrator behind QA gates.
12 Companion UI.
13 Local loot filter export.
14 Separate public/QA electron-builder configs.

## Safety

Before emit: authorized-qa, allowlisted process, module flag, dry-run, confidence, rate limit, kill switch. Every action is traced.
