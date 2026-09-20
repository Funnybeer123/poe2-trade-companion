# Follow & Combat continuation prompt

Two strands of work, meant to run **in parallel as two agents**:

- **Agent F — Follow & Loot.** Keep improving what already works live.
- **Agent C — Combat.** New: the follower casts spells while it follows, so it
  contributes in a fight instead of only trailing behind.

Each section below is self-contained. Give Agent F everything down to
"Agent C brief", give Agent C the shared sections plus its brief, and give both
the working agreement at the end, which is what keeps them out of each other's
files.

---

## Shared: what this is

A Windows-first Path of Exile 2 companion app (Electron + TypeScript + Vue 3).
The user plays their main character (`HarrisonBot`) on one PC. A second PC runs
`JasonWIlsonBot`, which follows them, picks up loot, crosses areas after them,
and recovers from panels that get opened by accident.

Perception is screen capture only. There is no game memory reading, no packet
work and no injection into the client. Input is synthetic mouse and keyboard
through Windows `SendInput`, guarded natively.

Repository: `https://github.com/Funnybeer123/poe2-trade-companion`, branch
`master`. Recent follower work is 23 commits ending at `6cc2d1b`.

## Shared: setup

```powershell
git clone --branch master https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
npm ci --ignore-scripts
node node_modules/electron/install.js
```

Checks, all of which must stay green:

```powershell
npx.cmd tsc --noEmit -p .
npm.cmd run lint
npm.cmd test                      # 168 files, 2176 tests
.\scripts\test-follower-host.ps1        # synthetic, no capture, no input
.\scripts\test-follower-input-host.ps1  # synthetic, no capture, no input
.\scripts\test-combat-host.ps1
```

The live follower runs from a terminal so the game keeps focus:

```powershell
npm.cmd run follower:live -- --target HarrisonBot --seconds 300 --live --loot --leash 25 --sprint --wait 900 --dir C:\Users\evanb\code\follower-live\cli
```

`--wait` polls until Path of Exile 2 is the foreground window, then starts.
Without `--live` it is a dry run that decides and traces but sends nothing.

## Shared: hard rules

These are not style preferences. Several are enforced by tests.

1. **All game input goes through `GameInputController`.** It applies the kill
   switch, the process allowlist, the module-enabled check, the confidence
   threshold, the actions-per-minute cap and dry-run, and it writes a trace for
   every action. Nothing may press a key or click outside it. A held key is the
   sharpest case: renewals may never press, only renew.
2. **Every click is re-checked natively against the capture it was decided
   from.** The worker refuses a click whose capture is older than 120 ms, whose
   window handle or view size no longer matches, or when a modifier or a
   physical mouse button is held.
3. **The human always wins.** Cursor movement over 24 px hands control back
   until the cursor has rested. Ctrl+Shift+Esc is the emergency stop.
4. **Click areas are allowlisted natively**, by fraction of the view: `move` (a
   central disc), `loot` (the world-view rectangle), `party` (the top-left party
   frame) and `confirm` (the teleport modal's OK button only — it excludes
   CANCEL structurally, at every resolution). Any other area string is refused.
5. **The only key the input worker will tap is Escape**, and only as a tap whose
   down and up go in one `SendInput` batch. Sprint is the only held key, with a
   350 ms dead-man's switch in the worker.
6. **Subagents must never run a live host**, capture the screen or send input.
   They may run `vitest` and `tsc`. Only the lead agent, with the user present,
   runs anything live.
7. **Do not weaken a guard to make something work.** If a guard blocks a
   feature, the guard is usually right and the feature needs different evidence.
8. Commit locally; push only when the user asks. Do not bypass Windows
   Application Control or any other security setting.

## Shared: how to work

- **Measure, don't reason, about the game.** Every real defect this session was
  found by running it live and reading the action traces, not by reading code.
  The traces are JSONL under `--dir`, one object per action, each with the
  evidence the decision was made from.
- **Capture frames and analyse them offline.** There are scratch scripts in
  `C:\Users\evanb\code\follower-live\` (not in the repo) that record a PNG and
  run the real detectors over it. Use that loop before changing a detector.
- **Use the synthetic rig.** `tests/follower-drive-service.test.ts` drives the
  real service against injected hosts with no game. It is the fastest way to
  reproduce anything that is not about pixels.
- Write the *why* in comments, with the measurement that motivated it.

---

## Agent F brief — Follow & Loot

### What works live, with measurements

| Capability | Evidence |
| --- | --- |
| Follow by the leader's overlay-map marker | 18–25 observations/s, cycle 26–50 ms, capture→click 52/116 ms p50/p95, worst-case reaction 161 ms p95 |
| Terrain planning round walls | A* on a 4 px grid over the whole view, 3–11 ms typical; reached the leader from 243 map px in 7.6 s with 0 wall-blocked samples |
| Sprint (hold space) | 73 holds in one run; renewals can never press the key |
| Loot | 57 items in a 300 s run once the filter made every label identical |
| Cross-area teleport | Full chain proven live: marker gone 3 s → click the party swirl at (25,336) → recognise the modal → click OK at (1732,764) → land beside the leader |
| Escape a panel | Fires on a panel that only partly covers the marker |
| Worker rebuild | A worker that stops answering is rebuilt, bounded at 5 per session |

### The one open blocker: a memory leak

A 420 s live run reached **RSS 1.29 GB** and froze four times — 38.8 s, 79.1 s,
32.0 s, 53.3 s — measured by the heartbeat in `scripts/follower-live.ts`, which
prints `lag=`, `gc=` and `rss=` on every status line and a `!!` line for any
block over a second. Worst single GC pause was 81 ms, so it is not GC blocking;
it is the process being paged at that size.

**It does not reproduce offline.** A harness driving the real service against the
synthetic hosts for 12,000 ticks (600 virtual seconds, 8 worker restarts) held
`heapUsed` at 11.7 MB and RSS at 232 MB. So the leak is **not** in the tick, the
planner, the loot scan, the audit writes or the restart bookkeeping.

That leaves the live worker transport, `src/adapters/winHost.ts`, which the
synthetic path replaces entirely. In a live run it parses a JSON reply per
request over a pipe, and the terrain scan alone returns up to 50,000 points as
base64 — roughly 200 KB, four times a second. Things worth measuring there:

- `readline` over a stream whose lines are hundreds of kilobytes.
- Retained substrings. V8 sliced strings keep their parent alive, so one small
  slice of a 200 KB reply can retain all of it.
- Anything added per request or per worker rebuild and never removed:
  listeners, child handles, the `pending` array.
- Whether old child processes really exit when a worker is rebuilt.

Take a heap snapshot from a live run (`v8.writeHeapSnapshot`) at two points and
compare retained sizes. That is the decisive measurement, and it needs the game,
so it is the lead agent's job, not a subagent's.

### Other open work, roughly in order

1. **`leaderMissingMs` is often far above the 3 s trigger** (15.6 s in one
   trace) because earlier ticks were blocked. Find out which guard delays the
   first attempt that reaches the worker.
2. **A teleport lands the follower next to the leader, then it must re-acquire.**
   Measure how long re-acquisition takes and whether the committed goal and
   odometry epoch handling are right across an area change.
3. **Loot in a magenta-lit zone.** The uniform filter uses magenta labels; a
   zone bathed in purple spell light was captured in
   `C:\Users\evanb\code\follower-live\tp-fail.png`. Check the false-positive
   rate there.
4. **The follower cannot open doors or use waypoints deliberately**, only the
   party travel button.
5. **Last-known-position pursuit** is still not implemented: when the marker
   disappears without an area change, it waits rather than walking to where the
   leader was last seen.
6. The UI has no manual label selection for calibration, and packaged builds are
   blocked by Windows Application Control on this machine (do not try to bypass
   it; report it).

### Key files

```
src/main/followerDriveService.ts   the tick: capture, decide, execute, recover
src/core/followerMapMarker.ts      template matching, MapMarkerTracker, FollowSteering
src/core/followerTerrain.ts        the A* planner and bump memory
src/core/followerTrail.ts          odometry and the leader's trail
src/core/followerLoot.ts           label detection and the loot planner
src/core/followerParty.ts          the party-frame travel button
src/core/followerConfirm.ts        the teleport modal
src/adapters/followerInputSink.ts  the only path to the input worker
src/adapters/winHost.ts            the PowerShell worker transport  ← leak suspect
scripts/win-follower-host.ps1      capture only, asserted to have no input API
scripts/win-follower-input-host.ps1 input only, every guard lives here
scripts/follower-live.ts           the terminal runner, with the lag/gc meters
docs/FOLLOWER.md                   the measured design record — keep it current
```

---

## Agent C brief — combat while following

### The goal

The follower should **cast while it follows**, so it contributes damage instead
of trailing behind. The user's words: "work on a combat feature so the character
can cast spells as well while it follows, to help out."

### Start from what exists, not from scratch

There is already a combat feature: `src/core/combatAssist.ts`,
`src/main/combatAssistService.ts`, `scripts/win-combat-host.ps1`, documented in
`docs/COMBAT_ASSIST.md`. It presses flask keys when a globe falls below a
threshold, and casts skills when their calibrated skill-bar icon looks ready,
confirming a cast by two consecutive cooldown frames. It has its own capture
host and its own calibration UI.

Read all of that first. The question to answer before writing code is whether
combat-while-following should:

- **(a)** run `combatAssistService` alongside the follower, with a new
  arbitration layer deciding who may act when; or
- **(b)** grow a combat step inside the follower's own tick, reusing
  `combatAssist`'s ready-icon detection.

Both are defensible. (a) keeps the features separable and reuses the existing
calibration; (b) avoids two processes capturing and two input paths racing.
**The deciding constraint is that two independent actors must never fight over
the mouse**, and the follower's movement clicks are ~110 ms apart with a 120 ms
capture-freshness budget. Write up the trade-off with measurements before
committing to one.

### What it must respect

- Every cast goes through `GameInputController`, like every other action.
  Casting is a *key* press, so the same rule applies as to sprint: the input
  worker may only send keys it explicitly allows, and never leaves one held.
- **Do not break the 120 ms freshness budget.** A combat capture must not sit
  between a follower capture and the click bound to it. The follower already has
  a second capture worker for its map scans precisely for this reason; consider
  the same for combat.
- Manual takeover, the kill switch and the process allowlist apply unchanged.
- The user's build: level 95 main, low-level follower, with Unleash on `R` and
  Powered by Verisium on `T` already configured in the existing feature.

### Suggested first steps

1. Write `docs/COMBAT_WHILE_FOLLOWING.md` with the arbitration design and the
   measured cost of a combat capture per tick, before implementing.
2. Add a combat step behind a setting that is **off by default**, dry-runnable
   like everything else, so it can be traced before it is trusted.
3. Decide what "there is something to fight" means from pixels. Options worth
   measuring: monster health bars, the leader's own casting, on-screen damage
   numbers, or simply casting on cooldown while moving. The cheapest honest
   version is casting on cooldown whenever the follower is within some distance
   of the leader and not looting — measure how often that wastes a cast.
4. Keep the follower's observations/second above 15 with combat on. Report the
   before and after.

### Tests

Mirror the follower's approach: a synthetic rig that drives the service with
injected hosts, plus static assertions on the PowerShell host. Never run a live
host from a subagent.

---

## Working agreement for two agents in parallel

The two strands touch the same repository, so ownership must be explicit. This
session lost work twice to two writers on one file.

**Agent F owns:** `src/main/followerDriveService.ts`, everything in
`src/core/follower*.ts`, `src/adapters/followerInputSink.ts`,
`src/adapters/winHost.ts`, `scripts/win-follower-*.ps1`,
`scripts/follower-live.ts`, `tests/follower-*.test.ts`, `docs/FOLLOWER.md`.

**Agent C owns:** `src/core/combatAssist.ts`, `src/main/combatAssistService.ts`,
`scripts/win-combat-host.ps1`, `tests/combat-*.test.ts`,
`docs/COMBAT_ASSIST.md`, `docs/COMBAT_WHILE_FOLLOWING.md`, and any new
`src/core/combat*.ts`.

**Shared, and therefore coordinated by the lead agent only:**
`src/core/gameInputController.ts`, `src/shared/*.ts`, `src/main/index.ts`,
`src/main/preload.ts`, the renderer components, and `package.json`. If either
agent needs a change in one of those, it states the exact change in its report
and the lead applies it.

**If Agent C chooses option (a)**, the arbitration layer is a new file that
Agent C owns, and the single line that calls it inside the follower tick is
applied by the lead.

Neither agent runs anything live. Neither agent commits. The lead verifies,
commits and pushes, and is the only one who runs the game.

---

## What this session learned the hard way

Worth reading before changing anything, because each of these cost a live run:

- **A filter change fixed loot and broke self-verification.** Making every item
  label a large opaque magenta box took pickups from 35 to 57, and the same
  boxes then covered the follower's own map marker at the screen centre, which
  is how it knows the map is open. Detection and self-verification share the
  screen; improving one can blind the other.
- **"Prefer" became "require".** The Escape trigger was told to prefer a marker
  that scored zero. It was implemented as `=== 0`, and the ritual window — which
  only partly covers the marker, leaving 0.627 — was invisible to it. The
  follower idled 50 s without a click.
- **A refusal is not an action.** Refused clicks were charged the full 10 s
  cooldown, delaying a teleport by 23 s.
- **A reset condition that the failure makes unreachable is a deadlock.** The
  Escape cap reset only when the map centre verified, which is exactly what a
  stuck panel prevents.
- **Tolerances drift.** The map draws the own-marker about 11 px from where
  calibration pinned it, against a 5 px tolerance.
- **Measure before building.** A detector for unstyled item labels was built,
  measured against real frames at 1 correct label in 7 with 16 false positives,
  and reverted. The measurement took less time than the implementation and saved
  shipping something that would have walked the character out of the zone.
- **Do not run the test suite while a live run is going.** It starves the loop
  and produces measurements that look like product defects.
