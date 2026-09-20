# Follow & Combat continuation prompt

Two strands of work, meant to run **in parallel as two agents**:

- **Agent F — Follow & Loot.** Keep improving what already works live.
- **Agent C — Combat.** New: the follower casts spells while it follows, so it
  contributes in a fight instead of only trailing behind.

Give Agent F everything down to "Agent C brief"; give Agent C the shared
sections plus its own brief; give both the working agreement at the end, which
is what keeps them out of each other's files.

State at handoff: 168 test files, 2179 passed, 1 expected fail, 5 skipped;
`npm run typecheck` and `npm run lint` clean. The figures in the "What works
live" table below come from live runs of this build and are not all recorded in
`docs/FOLLOWER.md` yet — adding them there is Agent F's first small job.

---

## Shared: what this is

A Windows-first Path of Exile 2 companion app (Electron + TypeScript + Vue 3).
The user plays their main character (`HarrisonBot`) on one PC. A second PC runs
`JasonWIlsonBot`, which follows them, picks up loot, crosses areas after them,
and recovers from panels opened by accident.

Perception is screen capture only — no game memory reading, no packet work, no
injection into the client. Input is synthetic mouse and keyboard through
Windows `SendInput`, guarded natively.

Repository: `https://github.com/Funnybeer123/poe2-trade-companion`, branch
`master`.

## Shared: setup

```powershell
git clone --branch master https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
npm ci --ignore-scripts
node node_modules/electron/install.js
```

Checks, all of which must stay green:

```powershell
npm.cmd run typecheck   # NOT `tsc -p .`: the root tsconfig has "files": [], so that checks nothing at all
npm.cmd run lint
npm.cmd test            # 168 files, 2179 passed, 1 expected fail, 5 skipped
.\scripts\test-follower-host.ps1        # synthetic, no capture, no input
.\scripts\test-follower-input-host.ps1  # synthetic, no capture, no input
.\scripts\test-combat-host.ps1          # synthetic, no capture, no input
```

The live follower runs from a terminal so the game keeps focus:

```powershell
npm.cmd run follower:live -- --target HarrisonBot --seconds 300 --live --loot --leash 25 --sprint --wait 900 --dir C:\Users\evanb\code\follower-live\cli
```

`--wait` polls until Path of Exile 2 is the foreground window, then starts.
Without `--live` it is a dry run that decides and traces but sends nothing.
The status line carries `lag=`, `gc=` and `mem=rss/heap/ext/ab`, and prints a
`!!` line for any event-loop block over a second and another for any garbage
collection over a second — which is what tells a blocked loop from a GC stall.
**Read those first when anything looks stuck.**
`--label x,y,width,height` picks one party label when several are on the map;
the Electron UI has no equivalent.

## Shared: hard rules

Not style preferences — several are enforced by tests.

1. **All game input goes through `GameInputController`**: kill switch, process
   allowlist, module-enabled check, confidence threshold, actions-per-minute
   cap, dry-run, and a trace per action. Nothing presses a key or clicks outside
   it. A held key is the sharpest case: renewals may never press, only renew.
2. **Every click is re-checked natively against the capture it was decided
   from** — refused if the capture is over 120 ms old, or the window handle or
   view size no longer match, or a modifier or physical mouse button is held.
3. **The human always wins.** Cursor movement over 24 px hands control back
   until the cursor rests. Ctrl+Shift+Esc is the emergency stop.
4. **Click areas are allowlisted natively**, by fraction of the view: `move`
   (central disc), `loot` (world-view rectangle), `party` (top-left party frame),
   `confirm` (the teleport modal's OK button only — it excludes CANCEL
   structurally, at every resolution). Any other area string is refused.
5. **Escape is the only key the input worker will tap**, as a tap whose down and
   up go in one `SendInput` batch. Sprint is the only held key, with a 350 ms
   dead-man's switch in the worker.
6. **Subagents must never run a live host**, capture the screen or send input.
   They may run `vitest` and `tsc`. Only the lead agent, with the user present,
   runs anything live.
7. **Do not weaken a guard to make something work.** If a guard blocks a
   feature, the guard is usually right and the feature needs different evidence.
8. Commit locally; push only when the user asks. Never bypass Windows
   Application Control or any other security setting.

## Shared: how to work

- **Measure; don't reason about the game.** Every real defect in this project
  was found by running it live and reading the action traces — JSONL under
  `--dir`, one object per action with the evidence its decision used.
- **Capture frames and analyse them offline** before changing a detector.
  Scratch scripts live in `C:\Users\evanb\code\follower-live\` (outside the
  repo) and run the real detectors over recorded PNGs.
- **Use the synthetic rig.** `tests/follower-drive-service.test.ts` drives the
  real service against injected hosts with no game — the fastest way to
  reproduce anything that isn't about pixels.
- **Reproduce before fixing.** The worst bug here (below) was diagnosed wrongly
  twice from plausible code reading, and settled in minutes by an offline
  reproduction.
- Write the *why* in comments, with the measurement that motivated it.

---

## Agent F brief — Follow & Loot

### What works live

Last clean run: 420 s, hands off, **zero manual takeovers**.

| Capability | Measured |
| --- | --- |
| Follow by the leader's overlay-map marker | 14–25 obs/s, cycle 28.5/52 ms, capture→click 58/117 ms, worst-case reaction 169 ms p95 |
| Terrain planning round walls | A* on a 4 px grid over the whole view; reached the leader from 243 map px in 7.6 s with 0 wall-blocked samples |
| Sprint (hold space) | 152 holds in that run |
| Loot | 1,372 scans, 22 items; 57 in an earlier run with more on the ground |
| Cross-area teleport | 6 teleports, 5 modals confirmed, unaided |
| Escape a stuck panel | 5 presses |
| Memory | rss flat 193–202 MB, no block over 1.1 s |

1,696 movement clicks in that run.

### Top open item: 14 % of clicks are refused as stale

237 refusals against 1,696 clicks in that run. Across every trace file of the
session, the sink errors behind a failed action were overwhelmingly freshness —
``Stale capture`` and ``Follow stopped or capture stale`` outnumbered
``Manual mouse movement`` by more than twenty to one. (Count them yourself per
run before sizing a fix; and note ``followerDriveService.ts`` classifies
``Mouse button held`` and ``Modifier key held`` as manual **takeovers**, not
refusals, so only the freshness errors land in ``stats.refused``.)

A click is refused when its capture is over 120 ms old. Cycle p95 is 52 ms and
capture→click p95 is 117 ms — but **that p95 is survivorship-biased**:
``captureToInputMs`` is only recorded for an emitted click, so the refused ones
never enter the sample. The true distribution is worse than it reads.

Do **not** raise `FRAME_MAX_AGE_MS` — that guard is why a click can never be
sent from a stale view of the world. Attack the latency instead. Read the tick
in `start()` end to end and establish where the time goes:

- the awaited loot `runs` scan sits between the marker capture and the movement
  click bound to it, on loot ticks;
- the terrain plan is asynchronous but shares the JS thread;
- sprint renewal is another round trip bound to the same frame;
- `execute()` awaits the controller.

Candidate fixes, in the spirit of "the click bound to a capture goes first":
don't spend a tick's budget on a loot scan when a movement click is already due;
skip sprint renewal on a tick where a click is pending; re-capture rather than
attempt a click whose frame is already too old to make it. A fix for exactly
this was scoped and interrupted — it is the obvious next piece of work.

### Other open work, roughly in order

1. **`leaderMissingMs` is often far above the 3 s travel trigger** (15.6 s in
   one trace) because earlier ticks were blocked. Find which guard delays the
   first attempt that reaches the worker.
2. **Re-acquisition after a teleport.** Measure how long it takes and whether
   the committed goal and odometry epoch handling are right across an area
   change.
3. **Loot in a magenta-lit zone.** The uniform filter uses magenta labels; a
   zone bathed in purple spell light is captured in
   `C:\Users\evanb\code\follower-live\tp-fail.png`. Check false positives there.
4. **Last-known-position pursuit** is not implemented: when the marker
   disappears without an area change, it waits rather than walking to where the
   leader was last seen.
5. The follower cannot open doors or use waypoints deliberately, only the party
   travel button.
6. **The party click guard and the party detector disagree off 16:9.** The
   native `party` area bounds x by *width* (`viewWidth * 0.035`) while
   `partyBand()` in `src/core/followerParty.ts` bounds the same column by
   *height* (`view.height * .0625`, with a comment saying every fraction there is
   of height). They coincide at 16:9 and diverge at any other aspect ratio, so
   the detector could find the button outside the box the worker will permit.
7. The Electron UI has no manual label selection for calibration (the CLI has
   `--label`), and packaged builds are blocked by Windows Application Control on
   this machine — do not try to bypass it; report it.

### Read this before touching the terrain planner

`docs/FOLLOWER.md` has the full account. In short: four live runs froze for
32–79 s with resident memory at 1.29 GB, and it was one `TerrainPlanner.plan`
call that never terminated. Costs were in a `Float32Array` while each relaxation
was computed as a double; when the float32 store rounds **up**, the identical
relaxation stays cheaper than the value just written, fires again on every
expansion, and the open list grows without end — 99.9 % of 20 million pushes
stored the value they had just compared against. Fixed by making costs doubles,
adding a `settled` array so a cell is expanded once, and giving each queued entry
the priority it was queued with. A 120 ms clock budget is a backstop, and
`TerrainPlan.searched` makes a runaway visible. The regression test rebuilds the
exact scene and asserts `searched <= cells`.

**Two false diagnoses preceded it** — a plausible GC theory and a plausible
string-retention theory, both argued from code, both wrong. The stderr
retention was real and worth fixing but was not the cause: a probe pushed 3.3 GB
of replies through the transport with the heap flat at 7 MB.

### Key files

```
src/main/followerDriveService.ts   the tick: capture, decide, execute, recover
src/core/followerMapMarker.ts      template matching, MapMarkerTracker, FollowSteering
src/core/followerTerrain.ts        the A* planner and bump memory
src/core/followerTrail.ts          odometry and the leader's trail
src/core/followerLoot.ts           label detection and the loot planner
src/core/followerParty.ts          the party-frame travel button
src/core/followerConfirm.ts        the teleport modal: white-channel points in the two button boxes
src/core/followerPerception.ts     nameplate template building and matching primitives
src/adapters/followerInputSink.ts  the only path to the input worker
src/adapters/winHost.ts            the PowerShell worker transport
scripts/win-follower-host.ps1      capture only, asserted to have no input API
scripts/win-follower-input-host.ps1 input only, every guard lives here
scripts/follower-live.ts           terminal runner, with the lag/gc/mem meters
docs/FOLLOWER.md                   the measured design record — keep it current
```

---

## Agent C brief — combat while following

### The goal

The follower should **cast while it follows**, so it contributes damage instead
of trailing behind. The user's words: "work on a combat feature so the character
can cast spells as well while it follows, to help out."

### Start from what exists

There is already a combat feature: `src/core/combatAssist.ts`,
`src/main/combatAssistService.ts`, `scripts/win-combat-host.ps1`, documented in
`docs/COMBAT_ASSIST.md`. It presses flask keys when a globe falls below a
threshold, and casts skills when their calibrated skill-bar icon looks ready,
confirming a cast by two consecutive cooldown frames. It has its own capture
host and calibration UI. The user already has Unleash on `R` and Powered by
Verisium on `T` configured there.

Read all of it before writing code. The question to answer first is whether
combat-while-following should:

- **(a)** run `combatAssistService` alongside the follower with a new
  arbitration layer deciding who may act when; or
- **(b)** grow a combat step inside the follower's own tick, reusing
  `combatAssist`'s ready-icon detection.

**The deciding constraint is that two independent actors must never fight over
the mouse**, and the follower's movement clicks are ~110 ms apart inside a
120 ms capture-freshness budget that is *already* missed 14 % of the time (see
Agent F's top open item). Adding work to that tick has a measurable cost. Write
up the trade-off with numbers before committing to one.

### What it must respect

- Every cast goes through `GameInputController`. Casting is a key press, so the
  same rule as sprint applies: the worker may only send keys it explicitly
  allows, and never leaves one held.
- **Do not break the 120 ms freshness budget.** A combat capture must not sit
  between a follower capture and the click bound to it. The follower already
  uses a second capture worker for its map scans precisely for this reason.
- Manual takeover, the kill switch and the process allowlist apply unchanged.

### Suggested first steps

1. Write `docs/COMBAT_WHILE_FOLLOWING.md` with the arbitration design and the
   measured cost of a combat capture per tick, **before** implementing.
2. Add the combat step behind a setting that is **off by default** and
   dry-runnable, so it can be traced before it is trusted.
3. Decide what "there is something to fight" means from pixels. Options worth
   measuring: monster health bars, the leader casting, on-screen damage numbers,
   or simply casting on cooldown while moving. The cheapest honest version is
   casting on cooldown whenever the follower is near the leader and not looting
   — measure how often that wastes a cast.
4. Keep the follower above 15 observations/s with combat on, and report the
   before and after.

### Tests

Mirror the follower's approach: a synthetic rig driving the service with
injected hosts, plus static assertions on the PowerShell host. Never run a live
host from a subagent.

---

## Working agreement for two agents in parallel

Ownership must be explicit — this project lost work twice to two writers on one
file.

**Agent F owns:** `src/main/followerDriveService.ts`, `src/core/follower*.ts`,
`src/adapters/followerInputSink.ts`, `src/adapters/winHost.ts`,
`scripts/win-follower-*.ps1`, `scripts/follower-live.ts`, `tests/follower*.ts`,
`docs/FOLLOWER.md`.

**Agent C owns:** `src/core/combatAssist.ts`, `src/main/combatAssistService.ts`,
`scripts/win-combat-host.ps1`, `tests/combat*.ts`,
`docs/COMBAT_ASSIST.md`, `docs/COMBAT_WHILE_FOLLOWING.md`, and any new
`src/core/combat*.ts`.

**Shared, coordinated by the lead agent only:**
`src/core/gameInputController.ts`, `src/shared/*.ts`, `src/main/index.ts`,
`src/main/preload.ts`, the renderer components, `package.json`. If either agent
needs a change there, it states the exact change in its report and the lead
applies it.

If Agent C chooses option (a), the arbitration layer is a new file Agent C owns,
and the single line calling it inside the follower tick is applied by the lead.

Neither agent runs anything live. Neither agent commits. The lead verifies,
commits, pushes, and is the only one who runs the game.

---

## What this project learned the hard way

Each of these cost a live run:

- **An A\* that never terminated** ate a gigabyte and froze the loop for up to
  79 s, from a `Float32Array` holding costs compared as doubles. Two plausible
  diagnoses from code reading were wrong before an offline reproduction settled
  it in minutes. **Reproduce first.**
- **A filter change fixed loot and broke self-verification.** Making every item
  label a large opaque magenta box took pickups from 35 to 57 — and the same
  boxes covered the follower's own map marker at the screen centre, which is how
  it knows the map is open. Detection and self-verification share the screen.
- **"Prefer" became "require".** The Escape trigger was told to prefer a marker
  scoring zero; it shipped as `=== 0`, and the ritual window, which only partly
  covers the marker (0.627), was invisible to it. 50 s idle, not one click.
- **A refusal is not an action.** Refused clicks were charged the full 10 s
  cooldown, delaying a teleport by 23 s.
- **A reset condition the failure makes unreachable is a deadlock.** The Escape
  cap reset only when the map centre verified — exactly what a stuck panel
  prevents.
- **Tolerances drift.** The map draws the own-marker about 11 px from where
  calibration pinned it, against what was then a 5 px tolerance (now 14).
- **Measure before building.** A detector for unstyled item labels was built,
  measured at 1 correct label in 7 with 16 false positives, and reverted. The
  measurement took less time than the implementation.
- **Never run the test suite during a live run.** It starves the loop and
  produces measurements that look like product defects.
- **Read agent diffs before committing them.** One commit swept in an excellent
  planner fix under a message that described something else entirely.
