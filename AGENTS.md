# Project Instructions

## Mission
Build a reliable Windows-first Path of Exile 2 QA automation and trading accessory for authorized Grinding Gear Games testing. The repository has two intentionally separate operating modes:

1. **Public Companion Mode** — normal third-party-companion behavior that stays within published GGG macro/API guidance.
2. **Authorized QA Automation Mode** — test-only automation used to exercise bot behavior, anti-bot detection, trading, stash management, navigation, and loot pickup in environments where GGG has explicitly authorized that testing.

The QA automation capabilities are first-class requirements. Do not remove, weaken, or redesign them into manual-only recommendations merely because they would be inappropriate for ordinary public-player use.

## Working style
- Read `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/GGG_COMPLIANCE.md`, and `docs/QA_AUTOMATION_BOUNDARY.md` before changing architecture.
- Prefer the smallest implementation that satisfies acceptance criteria.
- Do not ask the user questions when a reasonable default is documented here; choose the documented default and record the decision.
- Keep modules small and typed. Avoid speculative abstractions.
- Add or update tests with each behavior change.
- Run lint, typecheck, unit tests, integration tests, simulation/replay tests, and relevant smoke tests before declaring a phase complete.
- Commit completed phases separately with concise conventional commit messages.
- Never commit secrets, session cookies, OAuth credentials, internal GGG credentials, or personal account data.

## Technology defaults
- Windows 11 first.
- Electron + TypeScript.
- Prefer Vue 3 + Vite if reusing Exiled Exchange 2 modules reduces porting work.
- SQLite for local durable data.
- Vitest for unit/integration tests.
- Playwright for overlay/UI smoke tests when feasible.
- Electron Builder for packaging.
- Native Windows input/screen-capture libraries may be introduced behind narrow adapters when required for QA automation.
- Prefer screen capture + computer vision + deterministic UI automation over process injection or undocumented client internals unless an explicitly supplied GGG test interface makes those unnecessary restrictions obsolete.

## Reuse policy
- Prefer well-maintained MIT-licensed components over rewriting mature PoE item parsing logic.
- Exiled Exchange 2 is the primary reference candidate. Verify the current upstream license and latest revision before importing code.
- Preserve upstream copyright/license notices for copied or vendored MIT code.
- Do not copy GPL code unless the repository intentionally adopts the GPL and the user approves that licensing choice.

## Operating-mode boundary
This app ships as one automation-capable companion. Stash transfer, sort, scan, and voice features are on by default. Do not reintroduce a public-only lock or QA opt-in checkbox.

Keep these interlocks:
- a global emergency stop (`Ctrl+Shift+Esc`);
- process/window allowlisting so input only targets Path of Exile;
- optional dry-run/preview that emits no OS input;
- structured action traces through `GameInputController`.

## Authorized QA automation requirements
The following are required in `authorized-qa` mode:
- automated target-following/navigation using screen perception;
- automatic detection and pickup of desirable ground loot;
- automatic inventory evaluation;
- automatic stash sorting and item transfer according to configurable rules;
- automatic pricing/listing workflows where the visible client/UI permits it;
- automated trade-session workflows for test cases, including configurable invite/party/trade-window behavior;
- desirable-item detection and item scoring;
- market-data-aware sell decisions;
- deterministic replay/simulation for testing without the live client;
- action logs sufficient to reconstruct why the bot took each action.

## QA safety/interlock requirements
Even in `authorized-qa` mode:
- implement a global kill switch that immediately stops generated input;
- prevent automation when the active window/process does not match the configured test target;
- use configurable environment/realm/account allowlists where identifiers are available;
- default all destructive or trade-completion tests to dry-run until a scenario explicitly enables execution;
- expose per-module feature flags for navigation, loot, stash, listing, and trading;
- cap actions per minute and expose scenario-specific timing profiles;
- store an append-only local QA action trace with timestamps, perception summary, decision reason, and input emitted;
- support deterministic screenshot/video replay tests that emit no real input.

## Reliability requirements
- Gracefully handle trade/API throttling and outages.
- Cache market responses with explicit timestamps.
- Never represent an estimated price as a guaranteed sale price.
- Show confidence and sample size for valuations.
- Make low-confidence perception results configurable: skip, request manual confirmation, or execute only in explicitly marked adversarial QA scenarios.
- Keep all generated input cancellable through the emergency stop.

## Security/privacy
- Local-first storage.
- No telemetry by default outside explicit QA logs.
- Redact account/session identifiers from general logs.
- Store tokens only through OS-protected storage if authentication is added.
- Keep QA automation builds/configuration separate from normal public builds.
