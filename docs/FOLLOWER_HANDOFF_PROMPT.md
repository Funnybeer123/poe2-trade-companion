# Follow & Loot continuation prompt

Paste the prompt below into a coding task opened in this repository on the new PC.
It is self-contained; access to the previous conversation is not required.

---

Continue implementing the **Follow & Loot** feature in
`https://github.com/Funnybeer123/poe2-trade-companion` from the latest `master`.
The initial follower implementation is commit `e79ac53` (original development
commit `b2ed196`). It was applied to master without bringing in separate tablet
work. Preserve existing merchant, stash, combat, and Stream Deck features.

## User's intended outcome

This is a Windows-first Path of Exile 2 companion. The user plays their main
character on one PC. A second PC runs another character that should follow the
main character, collect desirable nearby loot, and resume following. If the main
character leaves the follower's screen, use map observations and the observed
route to rejoin them. The feature is intended as an accessibility tool with low
maintenance, human-speed responsiveness, automatic recovery where reliable, and
accessible manual takeover. A physical controller is available if useful but is
not a required dependency.

Implement toward that outcome. Do not promise flawless or indefinitely unattended
operation; measure latency and intervention frequency. The user has authorized
feature development. Make routine implementation decisions and keep working;
ask only for genuinely missing information that blocks the next step. Do not
start live gameplay input merely to test the UI or a build.

## Start on this PC

For a new checkout, use PowerShell in a chosen development directory:

```powershell
git clone --branch master https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
git switch -c codex/follower-live-perception
npm ci --ignore-scripts
node node_modules/electron/install.js
```

Use Node.js 24, matching `.nvmrc`, and Git. For an existing checkout, inspect
`git status`, fetch origin, and preserve local changes before updating. Never
reset or overwrite another task's work. Use an isolated worktree if needed.

The install sequence above is intentional: on a clean Windows installation,
plain `npm ci` attempted an unnecessary `better-sqlite3` native rebuild and failed
without Visual Studio. The locked SQLite package already includes a working
Windows x64 N-API binary. Installing without lifecycle scripts, then explicitly
running Electron's installer, was tested for this dependency lockfile. Do not
assume this sequence remains sufficient after upgrading dependencies. Verify SQLite:

```powershell
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); console.log(db.prepare('select 1 as ready').get()); db.close();"
```

Read `AGENTS.md`, `docs/FOLLOWER.md`, `docs/PRODUCT_SPEC.md`,
`docs/ARCHITECTURE.md`, `docs/GGG_COMPLIANCE.md`, and
`docs/QA_AUTOMATION_BOUNDARY.md`. Follow the current repository instructions,
including its input interlocks and authorized testing boundary; do not infer an
external GGG approval from this handoff. Some older architecture prose differs
from the current operating-mode instructions in `AGENTS.md`.

Use paths relative to this checkout. The old PC's Documents paths, `release/`,
`node_modules/`, screenshots, app-data settings, and calibration are not portable
source dependencies. Build locally. Pairing keys are intentionally not saved or
committed. Configure each PC's role/address and recalibrate its own game view.

## What exists now

The Dashboard and Tools & QA expose **Follow & Loot**, labeled **Preview release**.

- Saved role, target name, private IPv4 address/port, following distance, loot
  leash, loot toggle, score threshold, and confidence preferences.
- Main-PC HTTP listener and follower heartbeat/reconnect service. Requests and
  responses use HMAC-SHA256 and a random shared 256-bit key kept in memory.
  Only connection metadata is exchanged; it is authenticated, not encrypted.
  There is no remote command or screenshot endpoint. RTT is network latency only.
- Deterministic observation-based planner for following, loot detours, explicit
  pickup confirmation, bounded retries, inventory-full behavior, identity loss,
  stale observations, blocked routes, and stalled movement.
- Four-way BFS on a small, already aligned walkability grid. Unknown cells are
  blocked and diagonal corner cutting is disallowed.
- Eight-step synthetic route demo, framework-independent tests, actual localhost
  socket integration tests, renderer tests, and packaged Electron smoke tests.
- Emergency stop, workflow stop, and application shutdown close connections.

**There is no live character detector, map extraction/registration, loot-label
detector, movement output, or pickup execution in this feature yet.** The current
demo does not prove perception works on actual gameplay. Two physical PCs have
not been validated together; socket tests used localhost.

## Files to inspect

- `src/core/follower.ts`: config, observation validation, route planner, state.
- `src/core/followerReplay.ts`: synthetic eight-step observations.
- `src/shared/follower.ts`: typed main/renderer feature bridge and status.
- `src/main/followerService.ts`: settings, authenticated connection, reconnect.
- `src/main/followerIntegration.ts`: trusted-renderer IPC registration.
- `src/renderer/components/tools/FollowerTool.vue`: feature screen and demo.
- `src/main/index.ts`, `src/main/preload.ts`, `src/shared/ipc.ts`: integration.
- `src/renderer/views/DashboardView.vue` and `ToolsView.vue`: entry points.
- `src/core/gameInputController.ts`, `src/core/safety.ts`,
  `src/core/killSwitch.ts`: mandatory generated-input controls and traces.
- `src/main/combatAssistService.ts`, `src/adapters/combatInputSink.ts`,
  `src/adapters/winHost.ts`, `scripts/win-combat-host.ps1`: existing Windows capture
  and input patterns to assess for reuse. Do not assume they already solve navigation.
- `tests/follower.test.ts`, `tests/integration/follower-service.test.ts`,
  `tests/component/follower-tool.test.ts`, `e2e/follower-smoke.ts`.

The older generic controllers in `src/core/controllers.ts` are simplistic.
Do not mistake their existence for working live following or looting.

## Next work, in order

1. Establish a verified baseline, then implement follower-side game capture,
   calibration, and live observation preview. Show selected-character identity,
   evidence, confidence, and observation age without sending game input. Preserve
   settings across navigation; invalidate calibration when the view changes.
2. Build recorded gameplay fixtures for character/nameplate tracking, occlusion,
   similar-looking characters, map markers, menus, loading screens, and target
   disappearance. Request a short recording or calibration session when actual
   game evidence is needed. Never label synthetic accuracy as measured game accuracy.
3. Implement main-PC route observations and follower-side map landmark matching.
   Camera positions and map origins differ between PCs. A leader marker alone is
   not a path. Extend the peer protocol with bounded/versioned observations,
   session identity, sequence/replay rejection, and freshness checks. Audit transport
   security before extending it beyond metadata. Do not assume synchronized clocks.
4. Connect verified decisions to `GameInputController`. Preserve exact process and
   foreground-window checks, capture freshness, global dry-run, emergency release
   of held inputs, action limits, workflow exclusion, and structured action traces.
   Start with a measured follow-only loop before adding loot interruptions.
5. Add loot-label detection, desirability selection, inventory evidence, pickup
   execution, and observed success/failure. The current planner advances retry
   state when producing a decision; adapt this to actual execution acknowledgements
   so a blocked or dry-run action does not count as a real attempt or success.
6. Add bounded stuck recovery, doors/area transitions, network-loss handling,
   manual takeover, and extended reliability tests. Keep unverified routes paused.

The current grid is limited to 64 by 64 cells; choose a justified representation
for real maps. The planner assumes positions share an already aligned coordinate
system. Its 500 ms observation cutoff is provisional and should be measured for
live use. Its stalled-movement behavior pauses; it does not yet recover itself.

Keep the fast control loop local. A cloud LLM call should not be required for
every movement or pickup decision. An initial performance target is 30–60 local
observations/second and under 150 ms at the 95th percentile from visible change
to emitted input, subject to hardware measurements. Measure input acceptance and
game response separately. These are targets, not achieved results.

## Verification and delivery

Publication baseline, verified on 2026-09-19 in a fresh Windows checkout of the
master integration: Node 24.16.0, the install sequence above, SQLite in-memory
query, typecheck, lint, 156 test files (1,839 passing tests and 3 skipped), both
Windows packages, and 2 packaged follower smoke tests passed. Commit `a5e2e3c`
fixes the clean-install clipboard typing, map-key typing, and checkout-name test
issues encountered during that verification. These are local/replay/build
checks, not a claim of live two-PC gameplay validation.

```powershell
npm run typecheck
npm run lint
npm run test:all
npm run pack:smoke
npm run test:e2e -- --grep "follower setup"
```

`npm run dev` opens the development Electron app when an interactive UI is needed.
The packaged build paths are recorded in
`artifacts/playwright/electron-builds.json`; build them on this PC rather than
copying old paths. For transfer of an unpacked app, copy the entire `win-unpacked`
directory, not only its executable. Recalibrate on the destination PC.

Preserve the input-free replay and background smoke behavior. Add meaningful tests
for new perception, timing, execution, and recovery behavior. Commit complete
increments, report what actually works and what remains, and keep
`docs/FOLLOWER.md` accurate. Begin with the baseline and live observation preview;
do not stop after writing another plan.
