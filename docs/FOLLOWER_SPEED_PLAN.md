# Follower speed and reliability plan (revised): on top of the leader, including caves, corners and ramps

Repo: `C:\Users\evanb\code\poe2-trade-companion`. Paths are relative to it.

- **Line numbers** are for HEAD `bbb9272` (committed 18:07Z today). The lead has an uncommitted edit in `src/main/followerDriveService.ts` that shifts everything below line 124 by +11. Identifiers and strings are the reliable anchors.
- **Evidence labels:** **[M]** measured by an analyst; **[C]** reproduced by a verifier; **[M-new]** measured by me in this revision (scripts in `C:\Users\evanb\code\follower-live\agents\synth\`); **[I]** inferred; **[U]** unknown. Only [M], [C] and [M-new] are used as foundations.
- **Unit `u`** is one overlay-map pixel at the default Map Zoom. All baselines from before 17:30Z today are in `u`. After the zoom change, raw "map px" are no longer comparable, so the scorecard divides by the calibrated zoom.
- **Denominator:** closeness numbers use leader-visible samples (51% / 80% within 60 / 120 u). The lead's 37% / 59% was over all samples.
- **A live run is active right now:** `b0rh9en4x`, started 18:05Z with `--seconds 7200`. No vitest and no heavy analysis until it ends. Nothing here was run live.

---

## 1. Diagnosis: where the time goes

### Cause 0: today's "much slower now" has three parts, none in the steering logic

**0a. The game's Map Zoom was raised mid-session, between 17:11Z and 17:30Z, and nothing in the code scales with it. [M-new]**

- A frame recorded at 17:11Z has 2,229 odometry points. The next, at 17:30Z, has 1.
- The zoomed label template (206×30, 1,890 px) took about 220 ms per match, against a 120 ms freshness limit.
  - Run `byd55ny98`: obs/s 3.1, cycle p50 261 ms.
  - Run `bapkqexnx`: obs/s 3.6, cycle p50 256 ms, 3 clicks emitted and 1,770 refused in 496 s. The follower effectively did not move.
- Commit `bbb9272` fixed the matcher (224 → 22 ms).
- What is still degraded at that zoom, measured on the active run `b0rh9en4x` after the fix:

| | Default zoom (`briqmg515`) | High zoom (`b0rh9en4x`) |
|---|---|---|
| obs/s | 17.3 | 13.1 |
| cycle p50 / p95 | 29.5 / 55.6 ms | 43 / 73 ms |
| capture→click p50 / p95 | 52 / 120 ms | 68 / 117 ms |
| odometry tracked, driving rows | about 58% | 11% (44 of 384; 76% read q=0) |
| steering by trail | 32% of steering time | 1 row of 538 |
| refused | 11.6% | 12% |

- **Why odometry dies at the high zoom [M-new].** I ran the real detector offline on 4 high-zoom frames.
  - The odometry plane (`blue`, B−R ≥ 60) finds 0–8 points in its 634×460 window. `MIN_POINTS` is 60, so the matcher is starved. It is not the search radius and not the point cap.
  - The new `walls` channel finds 1,273–18,412 points on the same frames.
  - 3 of those 4 exceed the native 8,000-point cap for the third plane, and over the cap the worker returns `null` (`scripts/win-follower-host.ps1:172,284`).
- With odometry dead, everything built on it is off at that zoom: the trail, bump memory, the stuck sensor's own-motion input and the `moved=` figure.
- **Constants that do not scale with zoom:**
  - distance thresholds 12/18, 35, 70/40, 45 and the 300 u loot leash;
  - `SEARCH = 9`, `MIN_POINTS` and the odometry window;
  - `STUCK_TOLERANCE_PX`, `LABEL_JUMP_PX`, and the planner's 56/20 px aim;
  - `mapScale`, which is still 7 in `cli/drive.json`.
- The zoom ratio is about 2.0–2.1 from label height (28–30 px against about 14) [I]. The critic estimated 2.7 from key-pixel counts. It must be measured.
  - With `mapScale` 7 at a 2× zoom, close-in clicks land about twice as far as intended [I].
  - Every distance threshold is effectively halved in world terms [I].
- `map-calibration.json` has been rewritten three times in 80 minutes: 17:56Z and 18:05Z with a 206×30 label, then 18:14Z with a 67×12 label. The zoom is still changing.

**0b. An orphaned Space key crippled both flask runs. Timing [M][C]; mechanism [I].**

- All 108 "Space held - manual control" refusals sit in 4 streaks.
  - 3 of the 4 begin at the first sprint attempt of a run whose predecessor was killed within 1 s of an emitted sprint start.
  - The 4th streak inherited the orphan from two runs back.
- "Space held" matches the `MANUAL` regex (`followerDriveService.ts:124`), so each sprint attempt costs a 1.5 s pause (`:364`).
  - Flask run B (`bpj0k1y32`): 34 of 39 sprint starts refused, 74% of the run paused.
  - Flask run A (`b8jme1ks0`): 16 refusals, 17% paused.
  - `briqmg515`: 0 refusals in 1,075 attempts.
- The mechanism was never reproduced. A human holding Space is the open alternative: those runs show manual=36 and manual=18. Phase 2b's start-up `spaceDown` probe is the measurement that settles it.

**0c. Nobody was told.**

- `bapkqexnx` ran for 8 minutes with every click refused, and the status line only said "retrying".
- The user cannot see background-task output.
- Past "stuck" reports were usually the follower parked in manual control.

At the default zoom, loop latency has not changed since day 1 [M][C]: capture→click p50 51 vs 52 ms, stale share 9.5% vs 11.1%, 5.17 vs 5.32 clicks/s.

### Cause 1: clicking 5–6 times a second while the character does not move. This is the cave complaint. [M][C]

Reference run `briqmg515` (caves): 3,317 s active, 2,255 s following, 1,785 s steering.

- Inside falling-behind episodes (1,084 s, 33% of active time):
  - 220.6 s at under 5 u/s;
  - 198.3 s creeping at 5–20 u/s;
  - only 124 s actually running.
- 53% of all time spent more than 60 u behind (566 of 1,073 s) sits in 50 excursions that each contain a stall of 1 s or more.
- Episodes are no more frequent than on day 1. They last three times longer: p50 6.1 s vs 2 s, max 47.7 s vs 8.7 s.
- 27 of 49 decidable recoveries (55%) ended because the leader walked back.
- Frozen gap while behind (d > 60 u, ±4 u for 1.5 s or more, while driving) [M-new]: 60.7 s per hour (22 spells, max 10.7 s). The clean run shows about 24 s per hour. This is an odometry-free proxy for the user waiting for the bot.
- Mechanisms, confirmed in code and reproduced with the real class:
  - On any untracked tick the stuck detector substitutes the change in leader offset for the follower's own motion (`src/core/followerMapMarker.ts:428`).
  - It resets on 2.5 px per 1.5 s (`:432`). Reproduction: at 90% tracking with a running leader, 30 of 40 trials never fire; a 2 u/s creep never fires.
  - Wall-follow was active for about 6% of stuck time.
  - The same pixel was clicked for about 25 s (t=2483–2514).
  - The escape is a blind right-first sweep at a fixed 0.2h radius (`:440`). A failed sweep measured 9.2 s plus a 5 s rest.
- 9 incidents (about 50 s per hour) were total immobility on every heading (t=2441.9–2467.8). The cause is [U]. Candidates:
  - death and revive;
  - a click landing on a monster, because the follower's left click is a skill slot with `always_priortise_interact_over_skills=true`;
  - a ramp ray-cast landing on the wrong tier;
  - a stun.

### Cause 2: the route round the corner is forgotten every few seconds [M][C]

All at the default zoom:

- Odometry is untracked on 42.2% of moving rows.
- There are at least 36 epoch restarts per minute of moving. Each empties the trail (`src/core/followerTrail.ts:30,72`), the bump memory and the plan commitment.
- Trail lifetime is p50 2.5 s, with 166–219 wipes per hour.
- With the leader more than 35 u away, 43% of steering is "direct", at a median 3.2 u/s.
- When far behind, a trail that reaches back to the follower exists about 13–30% of the time.
- `LeaderTrail.aim` searches the whole trail and splices irreversibly (`:84-93`). Offline this deleted hairpins and bridge crossings.
- Gaps are long and bursty: P(untracked | untracked 0.5 s earlier) = 0.665, and 49% of untracked time sits in runs of 1.5 s or more. That refutes a short-gap re-lock as the fix.
- Failures are content failures (37% low support, 36% rival), not dropped frames.
- One offline data point [M-new]: on the combat-effects frame the `walls` channel picks up 4,713 points against 6,815 for `blue`, so it carries less effect clutter.

### Cause 3: standing still by design [M]

- Label lost: 507 s. Of that, 160.7 s began with the leader only 60–300 u away.
- "Own marker not at centre" pauses: 148 s, including 86 single-sample blips. Each blip releases sprint, kills the plan and holds movement.
- Manual-control pauses: 370 s (246 takeovers, 107 of them on Escape attempts). Focus-lost time: 262 s.
  - These are not waved through. Whether a human was at that PC is an open question for the user (§4).
  - If not, this false-positive class costs three times what stale refusals cost.
- Loot: about 47 s of holds, plus 1,394 u per hour of added gap. 48% of loot clicks were sent with the leader more than 40 u away.

### Cause 4: pipeline noise. Real and cheap to fix, but it does not fix caves. [M][C]

- 1,236 stale refusals per hour (11.1%).
  - 880 come from ticks where the awaited loot scan (`followerDriveService.ts:573`, +74 ms) ran before the click (`:620`).
  - 356 come from the 1 Hz full-view search.
  - None of about 17,600 attempts below relative age 80 ms was refused, across 6 runs.
- Each refusal releases Space (`:365` in JS, and `scripts/win-follower-input-host.ps1:198` natively). Result: 1,021 Space presses per hour, a median hold of 0.54 s, 1.16 presses per second of chase.
- The first click after a pause or a pickup is refused 27% of the time.
- Loot scans take about 25% of loop time while chasing.
- `setTimeout(1)` wastes a mean 7.7 ms per tick (`:655`).
- Caveat: refusal-free 2 s windows are just as slow in caves (10.7 vs 10.1 u/s).

### Cause 5: lag built into the thresholds, visible even in the clean run `b98j1b9qk` [M][C]

- "Near" is pure distance, 12/18 u (`followerMapMarker.ts:433`).
- 58 of 72 short near spells are back at d ≥ 30 within 2 s.
- The gap peaks at p50 40 / p90 80 u within 2 s of each departure.
- The 40–70 u band has sprint on only 25% of the time.
- Stall-free excursions total 507 s, 22% of following time.
- **There is no speed surplus.** The follower's best is p99 54–72 u/s against a leader radial p90 of 61–74 (max 154).
  - The honest floor is about 30 u behind while the leader runs and about 12 u when they stop [I from measured inputs].
  - Ground lost in a stall returns only when the leader stops.

---

## 2. Targets

These are goals in `u` over leader-visible samples, judged by one scorecard script. They are not projections: the only quantitative projection anyone made (the pursuit sim) was refuted.

**Primary gates (label-only, no odometry).** These cannot be moved by a change in odometry tracking.

| Metric | Baseline `briqmg515` | After Phases 2–3 | After Phases 4–6 | Final |
|---|---|---|---|---|
| Within 60 u / 120 u | 51% / 80% | not worse | ≥70% / ≥92% | ≥80% / ≥95% |
| Share of following time with d > 60 u | 48% | not worse | ≤30% | ≤22% (clean-run parity) |
| Excursions above 60 u: p90 / max | 9.2 s / 45.4 s | – | ≤5 s / ≤15 s | ≤3 s / ≤8 s |
| Episode recovery p50; active time in episodes | 6.1 s; 33% | – | ≤3.5 s; ≤18% | ≤3 s; ≤12% |
| Frozen gap while d > 60 u | 60.7 s/h | – | ≤30 s/h | ≤15 s/h |
| d p50 / p90 while following | 57 / 166 | not worse | ≤40 / ≤110 | ≤30 / ≤80 |
| Short-near sawtooth events; gap 300 ms after first click p50 / p90 | 58/h; 27.5 / 46 | – | – | ≤10/h; ≤20 / ≤32 |
| Open terrain: within 60 u; d p50 | 78%; 32 | not worse | not worse | ≥92%; ≤20 |

**Secondary (pipeline and odometry).** Stall seconds depend on `trk` and will rise mechanically when tracking improves. Never gate a rollback on them alone.

| Metric | Baseline | Target |
|---|---|---|
| Stale refusals per move attempt | 11.1% (22–31% with flask) | <1% (<3% with flask) |
| First click after a pause or pickup refused | 27% | <2% |
| Space presses per chase-minute; median hold | about 70; 0.54 s | ≤15; ≥2 s (or sprint off) |
| "Space held" refusals per run | up to 34 | ≤1 |
| Odometry tracked share of driving rows | 58% default zoom; 11% high zoom | ≥55% at the chosen zoom after Phase 2a; ≥80% after Phase 5 |
| Trail wipes while d > 35 u; trail lifetime p50 | 166/h; 2.5 s | ≤80/h and ≥6 s after Phase 6 alone; ≤20/h and ≥20 s only with Phase 5 |
| Stalled while clicking (moved < 5, trk ≥ .75, d ≥ 40); stall p90 | 220–300 s/h; 6.5 s | ≤60 s/h; ≤1.5 s |
| Recoveries closed by the leader walking back | 55% | ≤20% |
| obs/s while chasing; peak charged actions per 60 s | 15.8; 417 | ≥18 (≥22 with loot gating); ≤540, never stopped by the cap |
| Source switches between consecutive clicks; swings > 60° | 10.5%; 6.9/min | ≤5%; ≤3/min |

---

## 3. Working rules

1. One mechanism per commit. Every behaviour change sits behind a flag that defaults to today's behaviour. Rollback is the flag, or reverting the commit.
2. Offline proof comes before any live run.
3. Live validation is an **interleaved A/B inside one run**: `--ab <flag>:120` toggles the flag every 120 s and tags every tick and status row.
   - A human leader adapts to the bot, so "same route, two runs" is not repeatable.
   - Every toggle calls the same state reset as an area change (rule 7).
4. Revert on any regression in these:
   - a primary gate;
   - the origin-NO share at d < 18 u;
   - manual-takeover handling;
   - actions per minute.
5. Never run vitest or analysis during a live run. Never end a live run with TaskStop or a tree-kill.
6. Freeze the Map Zoom for a whole validation cycle. Never compare runs across zooms except through `u`.
7. Every new stateful piece resets on area change, own teleport, load grace, manual hold and an A/B toggle, through one `resetFollowState(reason)` call. Each piece gets a rig test. The pieces are:
   - the progress sensor;
   - the ladder's memory;
   - the leader-motion estimator;
   - trail re-anchoring;
   - `sprintBlocked` probing;
   - the immobile latch.
8. The user cannot see background output.
   - The lead relays in chat any status reason starting "PERCEPTION TOO SLOW", "CANNOT MOVE", "tap Space" or "manual control".
   - When the user reports "stuck" or "slow", read the status line first.

---

## 4. Phase 0: today, no code

1. **Space:** tap Space once on the follower PC before the next run. End runs only with `--seconds` or the emergency chord.
2. **Zoom (D0):** pick one Map Zoom and leave it alone.
   - My recommendation is the **default zoom** until Phase 2a is proven. At the high zoom, odometry is tracked 11% of the time, the trail never steers, the loop runs 13 obs/s against 17.3, and the label leaves the map sooner.
   - The new `walls` planner also routes to the leader on the default-zoom cave frame, per the lead's tests in `bbb9272`.
   - The user raised the zoom on purpose, so this is their decision.
3. **Working tree (D-S):** the lead's uncommitted edit implements two items that all three judges placed under "user's decision, not now".
   - First, a stale RETRY no longer calls `letGo()`.
     - It only half works: the native `MoveClick` catch still releases Space on the 832 native refusals (`ps1:198`).
     - JS then believes it is sprinting and the next renew silently fails with "Sprint lapsed".
     - Only the 404 JS-side refusals are affected.
   - Second, `SPRINT_BLIP_MS = 400` keeps renewing the hold on untrusted frames. That goes further than any design proposed; pipeline M4c was "skip the renew, 150 ms at most".
   - Get an explicit yes, or revert before the next live run.
4. **Questions for the user:**
   - Did you revive the follower at about 16:30Z (t ≈ 2463 s)?
   - Were you touching the follower PC's mouse during the cave run? Is a mouse-sharing tool (Mouse Without Borders, Synergy) running?
   - What takes focus from the game on that PC? It cost 262 s.
   - Which skill is on the follower's left-click slot?
5. **Hand test card** (§8, about 10 minutes, zero bot input). It includes the sprint A/B by stopwatch.
   - The bot cannot produce a continuous Space hold.
   - A user holding Space while the bot runs triggers "Space held".
6. **Frames:** record 20–30 cave and ramp frames with the overlay map open, at the zoom chosen in step 2.

---

## 5. Phases

### Phase 1: instruments, shadow sensors, alarms, and a harness that reproduces the live numbers

Apart from the alarm text, nothing in this phase changes behaviour.

**Changes**

- In `followerDriveService.ts` `tick()`:
  - whole-tick ms, recorded in the `finally` near `:655` (`cycles.push` at `:439` stops before the scans, the renew and the click);
  - loot-scan ms and renew ms;
  - counters `skippedOld`, `renewFailed` (the silent catch at `:617`) and `lapsed`;
  - Space releases by cause;
  - origin score per tick;
  - travel scans, found and clicked.
- Move-click evidence JSON gains:
  - `ageAtDispatchMs` (now − frame.at);
  - `lootScanBefore`, `searched`, `sprinting`, `via`, `radiusPx`, `sameTargetClicks`.
- `MapOdometry.update` returns a `cause` (`overflow | fewPoints | gap | lowSupport | rival | ok`) and the third-plane point count.
- `TerrainPlan` gains `searched` and a none-reason (`guard | sealedStart | noGoal`).
- **Opt-in recorders** in `scripts/follower-live.ts`. Both flush on the 500 ms report timer and never write between a capture and a click.
  - `--record-ticks <file>`: one JSONL row per tick.
  - `--record-points <file>`: the third-plane point stream, points only, about 100 KB/s. It is the corpus any odometry matcher change needs (Phase 5).
- **Shadow sensors, log-only:**
  - The immobile detector. When it fires, one full-frame PNG is saved through the **map worker's** existing `record` op.
    - The save is fire-and-forget and never awaited in the tick.
    - At most 10 frames are saved per run.
    - Using the marker worker would block ticks for 100 ms or more at the worst moment.
  - The progress sensor (spec in Phase 4).
- **Alarms (status text only):**
  - If cycle p50 exceeds 100 ms for 3 s, or there are 20 or more consecutive refusals, the reason reads "PERCEPTION TOO SLOW - following is not working".
  - The same alarm covers skip streaks once Phase 3 lands. Without it, a slowdown like 0a becomes silent standing with zero refusals.
- **Status line:** append fields at the end so existing parsers keep working.
  - `z=<zoom> du=<d in u>`, `tick p50/p95`, `stale=`, `skip=`, `rel=<causes>`, `odo=<cause counts>`.
  - `cap w/f=` and `match f=`, which come from `observation.timing`. The worker already returns it and nothing prints it.
- `scripts/follower-scorecard.ts`: a port of the analysts' scripts from `C:\Users\evanb\code\follower-live\agents\*`.
  - It normalises to `u`.
  - It prints the primary gates first.
  - It splits results by A/B tag.
- `scripts/follower-replay.ts`: runs recorded ticks open-loop through the real core classes.
- `tests/follower-drive-service.test.ts` (`LIVE`, about `:2285`):
  - refit to about `{ key:[25,36], runs:[56,30], input:[15,22], sprint:[2,6] }`;
  - add a `full` cost of +35 ms that grows with key pixels (live p50 was 223 ms at 3,000 or more);
  - model the native 350 ms dead-man's switch, including release on any refused `moveclick`.

**Guard impact:** none. These are diagnostics and extra fields in a string the input worker never reads. Full-screen PNGs are new data on disk (D6).

**Offline proof**

- The scorecard reproduces these from the existing logs: 57 / 166, 51% / 80%, 1,236 stale refusals, 1,021 Space presses, 58 sawtooth events, 60.7 s/h frozen gap.
- With the OLD tick order, the refit harness reproduces all of these. Until it does, no later pass counts as evidence.
  - 9–13% refused with loot and sprint on;
  - 1% or less with neither;
  - the bimodal age distribution;
  - capture→click p50 of 48–56 ms.
- Rig: the immobile shadow fires within 3 s on a static scene with clicks on 3 headings.
- Sensor unit tests as listed in Phase 4.

**Live acceptance:** with the recorders on, obs/s changes by no more than 0.5 and the stale share by no more than 0.5 points.

**Rollback:** turn the flags off.

### Phase 2a: make the follower zoom-proof. This is the code fix for regression 0a.

**Changes**

- Calibration stores `zoom = label.height / (14 × view.height / 1440)`.
  - `bbb9272` already computes `height / 12` inside calibration (`followerMapMarker.ts:190`).
  - Verify the ratio once with a two-landmark paired measurement.
- `FollowerDriveService.start()` scales every map-px constant by `zoom`:
  - in `followerDriveService.ts`: `MAP_PX_PER_FOLLOW_UNIT`, `PLAN_NOT_WITHIN_PX`, `SPRINT_START/STOP_PX`, the loot leash and steady test;
  - in `followerTrail.ts`: `TRAIL_SPACING`, `LOOKAHEAD`, `DIRECT_WITHIN`;
  - in `followerMapMarker.ts`: `STUCK_TOLERANCE_PX`, `LABEL_JUMP_PX`;
  - in the planner: `LOOKAHEAD_PX`, `MIN_AIM_PX`, the bump radius.
- Effective `mapScale` becomes `settings.mapScale / zoom`.
- **Odometry at zoom:**
  - At calibration, count points per channel in the odometry window. If `blue` yields fewer than 200, use `walls` for the third plane. `channel` is already a request parameter, so no native change is needed for this.
  - Keep the count under the 8,000 cap **without a native change** by shrinking the odometry window when the calibration-time count exceeds about 6,000. At 2× zoom, half the window still covers more than 60 points.
  - Native alternative (D7): on overflow, return a stride-subsampled set where today it returns `null`.
  - `SEARCH` becomes `ceil(9 × zoom)`, searched coarse-to-fine (stride 2, then ±2).
    - The full search at 2× would cost about 4× the 2.5 ms.
    - The refine runs after the click, never between a capture and its click.

**Guard impact:** none on input. Clicks stay inside the 0.06h–0.26h clamp, the `SAFE_DISC` .29 pull and the native 0.30h disc. D7 touches only the capture-only worker.

**Offline proof**

- Every steering, trail and planner unit test runs at `zoom ∈ {1, 2.1}` on worlds scaled by zoom, and gives identical decisions in `u`.
- A point-count test on the 9 recorded frames (`agents\synth\zoomodo2.ts` is the prototype): every frame yields 60–8,000 third-plane points with the chosen channel and window.
- One `--record-points` dry-run session at the chosen zoom, replayed through `MapOdometry`, tracks on at least 55% of moving ticks.

**Live acceptance**

- Odometry tracked on at least 55% of driving rows at the chosen zoom.
- obs/s of 15 or more.
- A close approach to a standing leader settles to "near" without orbiting.
- Primary gates not worse.

**Rollback:** `--zoom 1` forces the old constants, or the game returns to the default zoom.

### Phase 2b: orphaned-Space hardening. This is the code fix for regression 0b, with no new input.

**Changes**

- `scripts/follower-live.ts`: add `--stop-file <path>`, polled in the report loop, which calls `finish()`. This is the mechanism that actually helps.
  - Also add `SIGINT` and `SIGBREAK` handlers. They cost three lines and work for Ctrl+C and Ctrl+Break in a console.
  - They do nothing against TaskStop or a tree-kill, because `TerminateProcess` delivers no signal.
  - The real fix is rule 5.
- `src/adapters/winHost.ts` `close()` (`:158-171`) and the timeout path (`:146`), for the follower input host only:
  - send `release` or `quit`;
  - wait up to 500 ms for exit before `child.kill()`, so the ps1 `finally` (`:274`) releases Space.
- `win-follower-input-host.ps1` ping (`:249`): add a read-only `spaceDown = Down(0x20)` while the worker holds nothing.
  - Print it at start-up. That line is the measurement the orphan hypothesis lacks.
- Service: a `sprintBlocked` state. The behaviour is the user's choice (D1).
  - **Lenient:** one 1.5 s pause on the first refusal, then keep walking without sprint. Re-probe once a second and unblock after two "up" readings.
  - **Strict:** if Space reads down, wait with no input until it reads up.
  - Either way the reason reads "Space reads as held - tap Space once", and the lead relays it.
  - An unattended run after a crash stays sprint-less (lenient) or idle (strict) until someone taps Space. That limit is stated here, not hidden.
- Add the static tests that are missing today for the `finally` release, the `release` op and `SprintRenewMs = 350`.

**Guard impact:** no native input change. D1 changes how one human signal is honoured (see §6).

**Offline proof**

- Rig with `spaceDown:true`: 0 sprint attempts. Under the lenient choice, clicks continue at normal cadence.
- Five scripted "Space held" refusals give `manualTakeovers === 1`.
- A static assertion that the ping branch contains no `SendInput`.

**Live acceptance:** 1 or fewer "Space held" refusals per run, and 1.5 s or less of Space-attributable pause.

**Rollback:** revert the state. The stop-file and the graceful close stay.

### Phase 3: pipeline core. Every click lands.

Develop this in parallel with Phase 4, but validate it live first.

- It is one cheap run.
- It removes the refusal and sprint noise that would otherwise distort the Phase 4 sensor's "emitted clicks in 450 ms" evidence.

**Changes**, one commit each:

1. **Click-first tick** (`followerDriveService.ts:570-626`).
   - Nothing is awaited between the marker capture (`:391`) and the input bound to it.
   - Order on a click tick:
     1. apply the `collecting` hold;
     2. compute `wantSprint`, and `letGo` if sprint is not wanted;
     3. send the move click;
     4. send the sprint start;
     5. renew the held sprint.
   - On a non-click tick, renew immediately.
   - The loot `runs` scan (`:573`) runs only on a tick with no click attempt whose pacing interval has not yet elapsed.
     - It is forced after 500 ms of deferral.
     - `letGo()` before a label click stays.
     - The loot click stays bound to its own scan capture.
   - Why the scan stays on the marker worker for now:
     - The loot click already dispatches 75–105 ms after its scan.
     - A cross-worker hop plus a sink lock risks making loot clicks stale.
     - Phase 7 removes the scan from chase ticks anyway.
     - Fallback if inter-click p50 exceeds 170 ms or obs/s stays under 18: a fire-and-forget scan on the map worker.
2. **Skip and recapture.**
   - Do not call the controller when `now − frame.at` exceeds the click budget.
     - Start at 85 ms.
     - Set the final value from the Phase 1 `ageAtDispatchMs` histogram **at the chosen zoom**: the highest age with zero refusals, minus 10 ms. At the high zoom, dispatch p50 is already about 51 ms.
   - Do not call `letGo`, and do not call `steering.committed`.
   - Sprint start and renew get a separate 105 ms budget, because the start dispatches about 30 ms after the click.
   - Count skip streaks; they feed the Phase 1 alarm.
3. **Defer the 1 Hz full-view search off click ticks** (`followerMapMarker.ts:270-276`).
   - `nextRequest(now, deferFull)` postpones the search by at most 300 ms, and only while a lock exists.
   - This delays the rival-label identity evidence by up to 300 ms. It can only lower confidence, but it is flagged as D12.
4. **`setImmediate` when `delay − elapsed ≤ 1`** (`:655`), shipped together with an action-budget governor.
   - The governor stretches movement pacing at 540 charged actions per rolling 60 s.
   - 600 stops the run (`:362`), refusals count against it, and today's peak is 417.
5. **Space press limiter.** Build it only if sprint survives the Phase 0 A/B. It only removes input. No new press:
   - within 1.5 s of the last one;
   - while wall-following;
   - while `plan.blockedAhead` is set;
   - after the aim heading has changed by more than 30° in the last 300 ms.

**Guard impact:** none native. `FRAME_MAX_AGE_MS` stays 120. Two behaviour notes, D2 and D12, are in §6.

**Offline proof** (harness assertions replacing the `MEASURE` console.logs):

- refused share below 2% with loot and sprint on;
- a busy full-view scenario gives `refused === 0` and `skipped > 0`, with an attempt on the very next tick;
- `attempt.newestCaptureQpc === payload.capturedAtQpcMs` for every move click;
- inter-click p50 of 170 ms or less;
- at least 3 loot scans per simulated second;
- the first click after a scripted pause or pickup is never stale;
- no hold outlives 350 ms past its last accepted renew;
- 90 simulated seconds at a 100 ms click interval never stops the run;
- the loot and sprint suites pass unchanged.

**Live acceptance**

- Stale refusals below 1% (below 3% with `--flask`).
- First click after a pause refused less than 2% of the time.
- Skipped ticks below 3% of click ticks.
- Space presses of 15 or fewer per chase-minute.
- obs/s of 18 or more.
- Loot clicks per hour within noise of 97.
- Primary gates not worse.
- Busy full-view ticks (112–223 ms) become skips. Read `cap f=` and `match f=` before claiming more.

**Rollback:** `tickOrder: "legacy"` for one cycle, then delete the legacy path.

### Phase 4: stall work, behind `--unstick v2`, default off. This is where the cave complaint lives.

**4a. Progress sensor steers.** New pure `src/core/followerProgress.ts`. It replaces the `stuck` expression (`followerMapMarker.ts:373`), the reset (`:432`) and the untracked-tick substitution (`:428`).

- Evidence ticks are tracked odometry only.
- The "leader is world-stationary" inference counts **only** while it is anchored:
  - the leader was measured stationary on a tracked tick 1 s ago or less;
  - the offset has not changed by more than 2 px since.
- Unanchored, that inference is circular. A constant offset also means both characters running in parallel, which is the measured steady state.
- Untracked ticks pause the timer. They never reset it.
- A stall is either of:
  - speed projected on the commanded heading below 10 u/s over 450 ms of evidence, with 2 or more emitted clicks;
  - 4 or more emitted clicks within ±10° with under 3 u along the aim.
- **Gate from the Phase 1 shadow:** under 1 false fire per minute while moved ≥ 20 u/s on a recorded cave run.
  - Engine pathfinding may legitimately move the character off the commanded heading [U].
  - The designer's own sims showed 9–88 fires per minute under odometry failure.

**4b. Escape ladder.** It escalates one rung when the same spot (within 40 u) stalls again within 8 s.

1. A short click (0.08–0.10h) at the nearest forward crumb.
2. The trail tangent.
3. Back out about 25 u along our own walked path. If that path is empty or belongs to an older epoch, which happens often, fall straight through to rung 4.
4. The existing wall-follow, with:
   - the side chosen from the trail or plan bend;
   - a 0.10h radius (today `.2`, at `:440`);
   - easing by 12 u of real progress, not by a timer.

Further rules:

- Never re-click an aim that just failed. Today `followerDriveService.ts:432-433` reuses the same trail aim when the plan has none.
- After a stall, cap reach at 25 u for the next 40 u of path.
- The ladder is suppressed while `collecting`.
- The ladder is also an experiment. If 115–144 px clicks move the character where 288–374 px clicks did not, the all-headings class is an unwalkable-target or ramp ray-cast problem.

**4c. "Best-effort arrived".**

- Trigger: the leader is still, d is under 40 u, and the ladder has been exhausted once without progress.
- Response: hold.
- Re-arm when d changes by more than 6 u, or when the leader moves.
- Without this, the ladder escalates forever against a stationary leader on another tier, and that includes backing away. Measured cases: d frozen at 27.3, 26.7 and 32.9.

**4d. Let a routed plan steer inside 35 u.**

- At `:433` the `PLAN_NOT_WITHIN_PX` gate also blocks `routed` (`wallBetween && reachesLeader`).
- A stationary leader lays no crumbs after a wipe, so a routed plan is the only cover for the ledge case.
- Change the condition to `(routed || distance > PLAN_NOT_WITHIN_PX)`.
- The offline check that the leader's own label ink does not read as a wall at close range comes first.

**4e. Immobile response** (`--immobile-stop`). It acts on the Phase 1 shadow detection.

- Stop compass-clicking and call `letGo()`.
- Send one guarded probe click per 1.5 s, at 0.06h.
  - If the probe heading falls within ±45° of straight down, rotate it to the nearer horizontal.
  - A death-screen button may sit in the lower-centre of the move disc [U].
- Set the status reason to "CANNOT MOVE".
- Whether to tap the existing guarded Escape first is D11. It is decided from the saved frames.

**4f. Planner, re-measured.**

- The terrain analyst's numbers (guard 36.6%, sealed start 30.7%, `CLEAR_START_CELLS` 1→5 lifting plans from 146 to 192 of 216) were taken on the old channel. `bbb9272` replaced that channel with `walls` at 18:07Z.
- First read the Phase 1 none-reasons on one run.
- Then A/B `CLEAR_START_CELLS` 1/3/5 (`src/core/followerTerrain.ts:23,110`) offline, on the recorded frames at both zooms, behind a flag.
- Re-aim along `plan.path` per tick when odometry is tracked. Otherwise use the frozen vector.
- Do not erase a valid plan on one failed scan or one untrusted tick (`:421-425`).

**Guard impact:** none. There are fewer and shorter clicks, all inside the existing clamps [C].

**Offline proof:** a new `tests/follower-pursuit.test.ts`, ported from `agents\designer-path\sim.ts` and `agents\steering-geometry\stuckdetect.ts`.

- Worlds: L-corner, hairpin, pillars and a ledge with a stationary leader on the far side. Each runs with both stop-dead and sliding walls, and 10% refused clicks.
- Odometry gaps are drawn with the **measured** persistence, P(no|no) = 0.665.
- Required behaviour:
  - a pinned follower with a running leader at 80/90/100% tracking fires within 0.8 s;
  - a 2 u/s creep fires;
  - a free run at 48 u/s never fires;
  - a parallel run at equal speed with odometry blind never fires;
  - the ledge world reaches "best-effort arrived" and never backs away twice.
- Reset tests per rule 7.
- Replaying t=2441–2468 gives 20 clicks or fewer, against about 150 today.

**Live acceptance (interleaved A/B)**

- Share of following time with d > 60 u of 30% or less.
- Excursion p90 of 5 s or less.
- Frozen gap of 30 s/h or less.
- Recovery p50 of 3.5 s or less.
- 4e:
  - every "CANNOT MOVE" declaration has a saved frame;
  - clicks inside such incidents number 20 or fewer;
  - there are zero declarations where tracked movement above 5 u/s follows within 1 s.
- Secondary: stall p90 of 2 s or less.

**Rollback:** turn the flags off.

### Phase 5: odometry root cause at the default zoom

This phase is driven by the Phase 1 cause counts and the point stream. It comes before the trail work because the trail's targets depend on it.

**Changes**

- Give a missing frame the same `MAX_LOST = 6` grace as a mismatch (`followerTrail.ts:34-36`).
- On overflow, return a subsample where today the result is null (the D7 change from Phase 2a, if it is not already in).
- Compare `walls` against `blue` for the third plane on recorded point streams. Evidence so far:
  - The combat-effects frame gave 4,713 against 6,815 points.
  - The town frame went over the cap on `walls` (13,627).
- A peak-over-floor acceptance rule accepted 84 of 84 offline composites, against 62 of 84 today.
  - Adopt it only after replay on a **recorded live** point stream, with a bound on the per-frame shift change.
  - A false accept silently bends the trail.
- Re-measure the gap-length distribution.
- Only after that, decide whether a re-lock, keyframe or mosaic is justified. Re-run the path sim with the measured gaps before believing it.

**Guard impact:** none on input. D7 touches only the capture-only worker.

**Offline proof:** matcher replay on `--record-points` streams.

**Live acceptance**

- Odometry tracked on at least 80% of driving rows.
- Epoch restarts of 10 or fewer per minute of moving.

**Rollback:** turn the flags off.

### Phase 6: trail fidelity and steadier steering, behind `--pursuit`, default off

**Changes**

- `followerTrail.ts:84-93`:
  - search the nearest crumb forward only, within about 40 u of arc length;
  - go global only when more than 30 u off the trail;
  - keep an index, and never `splice`.
- Decide "direct" by remaining arc length plus a chord test.
  - This replaces `DIRECT_WITHIN`.
  - The gain is small, about 1.5% of moving time [C].
- Lookahead is the largest value in 18–50 u whose chord stays within about 5 u of the crumbs. A fixed 45 u chord cuts a right-angle corner by 16 u.
- **Re-anchor the trail, the bump memory and the plan commitment across an epoch restart**, by rigid translation on the leader label.
  - Touch points: `followerTrail.ts:72`, and the epoch filters in `followerTerrain.ts`.
  - The only gate that can actually be computed is **gap duration, under 1 s**.
    - The leader's movement during the gap cannot be observed without odometry.
    - So extrapolate with the leader's pre-gap velocity, and stamp the re-anchored crumbs with an error budget of `v_leader_max × gap`.
    - Never run the lookahead across them at full reach.
  - By count, about half of all gaps are under 1 s: 324 of 624 untracked runs are single rows. That is why the Phase 6 targets alone are modest (§2).
- **Source hysteresis:** a minimum dwell of 600–800 ms before switching between direct, trail and plan, unless the progress sensor fires.
  - This is the mechanism behind the flapping and swing targets.
  - Log the winning source per click.
  - Settle trail against `routed` by A/B. Do not settle it by argument.
- Soft crumbs laid during odometry gaps are **dropped from this plan**.
  - A frozen own-position misplaces them by our own displacement, and they would bend the nearest-crumb search.
  - Reconsider only if Phase 5 leaves most gaps under 0.5 s.

**Guard impact:** none, it is pure core code.

**Offline proof**

- Hairpins with legs 12, 20 and 30 u apart never flip the aim.
- The self-crossing world is never spliced. Ground truth is `agents\odo-trail\hairpin.ts` and `crossing.ts`.
- A re-anchor with a 0.8 s gap and a leader who turns stays within its stamped budget.
- Rig checks:
  - `via=trail` at d ≤ 35 when the trail bends;
  - the trail survives an overflow frame and a 6-frame mismatch burst;
  - every click stays within 0.26h.

**Live acceptance (A/B)**

- Trail wipes while d > 35 u of 80 per hour or fewer (20 or fewer once Phase 5 is in).
- Source switches between consecutive clicks of 5% or fewer.
- Swings above 60° of 3 per minute or fewer.
- Primary gates up.

**Rollback:** turn the flag off. Keep it off on open maps if it loses there.

### Phase 7: position over loot. A flag; it needs D4; it can ship any time after Phase 3.

**Changes**

- `canLoot` (`:570`) becomes: leader unseen for 1 s or more, **or** leader still for 600 ms or more with d ≤ 40 u.
- Clear `collecting` when the leader moves off and d > 30 u.
- No loot scan at all while chasing.
- Add a `lootSkipped` counter to the status line as the cost metric.

**Offline proof** (rig)

- No `runs` request while the scripted leader moves or d > 40 u.
- `collecting` cleared within one tick of the leader departing.
- Loot still clicked when the leader is still and near.
- The test near `:1539` is updated deliberately.

**Live acceptance (A/B)**

- Loot clicks with the leader more than 40 u away: 0% (today 48%).
- Gap change across the silence after a loot click: p50 ≤ +3 u, p90 ≤ +15 u (today +12.8 / +50.8).
- obs/s while d > 40 u of 22 or more.
- Skipped labels reported.

**Rollback:** turn the flag off.

### Phase 8: motion-gated near, behind `--shadow`

**Changes**

- New pure `src/core/followerLeaderMotion.ts`:
  - the gap rate, from the label only;
  - the leader velocity, which is exact only when the follower is at rest **and no click has been committed for 1.2 s or more** (a click queues up to about 1 s of travel);
  - a still/moving state with hysteresis.
- `FollowSteering.decide` gets an optional `leader` argument. When it is undefined, behaviour is identical to today.
- "Near" requires the leader to be still. The follower re-engages when the leader starts moving.
- This interlocks with 4c, so a still leader on another tier ends in a hold and not in shuffling.
- Keep a standoff at which our own marker stays matchable.
  - The one genuine 10 s cover (t=3097–3109, d = 8.1) did expire `ORIGIN_COVERED_MAX_MS` and paused the follower [C].
  - Never raise that constant.

**Offline proof**

- Unit tests on a 1-px-quantised 17 Hz track with 42% odometry dropouts:
  - leader onset detected within 120 ms;
  - a false "moving" state less than once per 10 simulated minutes.
- Rig with a scripted leader:
  - the first click comes within 2 captures of departure;
  - there is no "near" decision while the leader moves;
  - "near" comes within 300 ms of the leader stopping.
- Cover the `reset()` and wall-state interaction.

**Live acceptance:** open route first, then caves.

- Sawtooth events of 10 per hour or fewer.
- Gap 300 ms after the first click at p50 ≤ 20 and p90 ≤ 32.
- Origin-NO share at d < 18 u of 1.5% or less.
- Longest spell with the origin score at 0 at d < 25 u, tracked per run.

**Rollback:** turn the flag off.

### Phase 9: only if caves still fall short

Each item needs its own offline proof and acceptance line written before it starts. None is approved here. In this order:

1. Coasting through short label dropouts (needs a user decision).
2. Lead aim, in open terrain only.
3. A wider party-travel trigger.
4. The held-move capability (needs a user decision).

---

## 6. User decisions

**Needed for the phased plan**

| # | Decision | Honest trade-off | What informs it |
|---|---|---|---|
| D0 | Which Map Zoom. | The high zoom may read walls better [I]. It measurably costs odometry (11% tracked), the trail, 4 obs/s, 16 ms of capture→click, and label range. | The §1 table. A paired-frame planner comparison at both zooms. One interleaved run after Phase 2a. |
| D-S | The lead's uncommitted sprint edits: no `letGo` on a stale refusal, and 400 ms of renewals on unsure frames. | The first half is ineffective for two thirds of stale refusals, because the native release still fires. The second keeps Space down on untrusted frames, which changes "let go at anything unsure". | The Phase 1 release-cause counters, and the sprint A/B. Phase 3 removes the stale attempts at source, so neither may be needed. |
| D1 | When Space reads held: lenient (walk on without sprint) or strict (wait). | Lenient means a person physically holding Space no longer halts the bot, including at start-up. Clicks never checked Space, but sprint mode did pause every time. Strict means an orphan after a crash idles the whole run until someone taps Space. | The start-up `spaceDown` line from Phase 2b. 74% of flask run B was lost to the current behaviour. |
| D2 | A too-old frame is skipped. Today it is attempted, refused and released. | Space can stay down up to the unchanged 350 ms (+40 ms watchdog) longer. | Harness hold-bound assertion. |
| D3 | Keep sprint at all. | The logs show no gain (held p90 28.3 vs off 28.8 u/s). Every press may be an uncancellable roll [U]. Sprint off removes about 1,000 key-downs per hour and the orphan hazard. | The stopwatch A/B on the hand test card: keep sprint only if a continuous hold is at least 20% faster. |
| D4 | Position over loot. | Roughly half the pickups unless the leader pauses near drops. It reverses a recorded product choice. | The `lootSkipped` counter against 1,394 u/h of gap. |
| D5 | Shadow behaviour. | More time in melee range while the leader kites. | The `--shadow` A/B. |
| D6 | Recorders (ticks about 12 MB/h; points about 100 KB/s) and up to 10 **full-screen PNGs** per run on stalls. | Disk, and whatever is on screen when a stall happens. | – |
| D7 | The capture-only worker returns a subsample on overflow. | A native change, but that worker has no input API. The alternative without it is a smaller odometry window. | The Phase 1 overflow count; `zoomodo2.ts` point counts. |
| D8 | The native watchdog releases the Space hold on cursor drift over 24 px, a button or modifier down, or a foreground change, at about 15 ms. | It only strengthens "the human always wins". It is a change to the guarded worker. | Worth it only if sprint survives D3. |
| D9 | Let a click through one untrusted-origin tick (100 ms or less) after N verified ticks. | It attacks 148 s/h of pause, but it weakens click evidence. **Not recommended** until the cause of the blips is logged. Keeping the plan and trail through a blip (Phases 4 and 6) needs no decision. | Phase 1 origin score per tick. |
| D10 | Put the cursor delta and the key that tripped into the native "manual" refusal text. | A message-only edit to the guarded worker. | It answers whether 370 s/h of manual pauses were a human. |
| D11 | One guarded Escape tap before declaring "CANNOT MOVE". | A new trigger for an allowed key. With no panel open, Escape opens the game menu. | The Phase 1 stall frames. |
| D12 | Defer the 1 Hz rival-label search by up to 300 ms on click ticks. | Identity evidence arrives later. It can only lower confidence. | Skip% and share of full-search clicks after Phase 3. |
| D13 | More movement speed on the follower character (gear or skills). Zero code. | With equal speeds the floor is about 30 u while the leader runs. This is not a prerequisite: median own speed while "chasing" is 3.3 u/s, so utilisation comes first. | An open-straight parity test: both sprint for 10 s. |

**Deferred new capabilities.** None is built unless its experiment passes and the fixed click pipeline still falls short.

- **Held Move key plus a cursor-only steer op.**
  - Cost:
    - two new input surfaces;
    - a rewrite of hard rule 5;
    - a hard-killed worker would leave the character running;
    - per-tick steering reaches 548–612 actions per minute against a cap that stops the run.
  - Gain: single-digit points of closeness. The press reduction is about 7.6×, not 40× [C].
  - Experiment: hand test items 4 and 5 (§8).
- **Marker-file orphan reclaim.** A key-up at start, sent only when a file proves one of our own key-downs was never matched by a key-up. Revisit only if orphans recur after Phase 2b.
- **Coast along the trail for 1.5 s or less after label loss.**
  - It relaxes "no blind pursuit".
  - The trail has a median of 3 points at the moment of loss, so it is useless before Phase 6.
- **Wider party-travel trigger.**
  - Worth about 40 s/h.
  - It needs the same-area travel check.
- **Resurrect click.** Decide only after a stall frame shows a death screen.
- **Native "stale does not release Space".** Revisit only if stale refusals stay at 1% or more after Phase 3.

---

## 7. What not to do

- **Do not weaken guards or merge processes:**
  - do not raise `FRAME_MAX_AGE_MS` or `ORIGIN_COVERED_MAX_MS`;
  - do not shorten the 12 ms cursor settle;
  - do not merge capture and click into one process.
  - The refusals are an ordering problem, and the 0a slowdown was a matcher cost.
- **Do not tune or compare across zooms.** Do not judge a change by "stalled s/h" across an odometry change. Both move for reasons unrelated to following.
- **Do not build the keyframe re-lock and continuous-pose rebuild, or size anything on the pursuit sim's 31–77% figures.**
  - The short-gap assumption is refuted.
  - Under the measured gap persistence the sim's gain vanishes (14/15/16%).
- **Do not build predictive sprint, a minimum hold or soft release before the sprint A/B.**
  - Presses double (375 vs 196).
  - False onsets run 23–46%.
  - The speed benefit is unverified.
- **Do not send an unconditional Space key-up at start.** It cannot tell an orphan from a human holding the key.
- **Do not adopt WASD.**
  - It needs four physical held keys and a low-level hook.
  - It types into chat.
  - It loses engine pathfinding.
- **Do not speed up click pacing or align captures to pacing.** Only 0.2% of half-second intervals had no click, and it pushes toward the run-stopping cap.
- **Do not make a short reach (0.12h) the default.** The "no stutter" result assumes the character does not decelerate before its target. Use short radii only in the ladder and after a stall.
- **Do not use lead-the-target aim in caves.** It can point through the inside of the corner the leader just turned.
- **Do not apply the terrain analyst's planner numbers directly.** They were measured on a channel that was replaced at 18:07Z. Re-measure first (4f).
- **Do not start any of these:** DXGI, a BitBlt rewrite, binary IPC, ProcessName micro-savings, adaptive flask polling.
  - The flask is exonerated: ordinary ticks are no slower.
  - Transport costs under 1 ms.
  - Capture cost is not even logged yet.
- **Do not plan for the follower to sit at d < 12 u continuously.** The "overlap is free" claim was checked and found false.

---

## 8. Open unknowns and the cheapest experiment for each

| Unknown | Cheapest experiment |
|---|---|
| Why the character stays at 0 u while clicks land on 9 headings | The Phase 1 stall frames. The revive question. Hand test item 3. |
| Whether long clicks land off-tier on ramps | The ladder's 0.08–0.10h clicks against 0.26h clicks (4b). Offline now: compare odometry speed after the ~1,500 existing clicks under 150 px with speed after long ones. |
| Whether the engine routes to a click behind a thin wall or up a ramp, and from how far | Hand test item 2. |
| Roll duration; whether a long Space hold is faster under click-to-move; whether a flask press breaks sprint | Hand test item 1. |
| The true zoom ratio, and whether map directions stay isotropic at zoom | Two frames of the same spot at both zooms; measure the separation of two landmarks. |
| Which odometry branch fails, the true gap lengths, and whether `walls` beats `blue` at the default zoom | Phase 1 cause counters and `--record-points`, from one run. |
| Whether the 370 s/h of manual pauses and 262 s of focus loss are a human | The Phase 0 questions; D10. |
| Cost of busy full-view ticks (112–223 ms) | The `cap f=` and `match f=` status fields. |
| What the 242 untraced sprint drops are | The release-cause counters. |
| Why travel was not tried in 24 of 30 long label gaps | Travel scan, found and clicked counters. |
| Whether `routed` should outrank a connected trail | Per-click source log; the Phase 6 A/B. |
| Town and hideout behaviour (clicks on NPCs or the stash; no town detector exists) | Stall frames, plus one supervised town pass. Until then Ctrl+Shift+H in town. |
| Run `bd0xkbuks` (17:02–17:34Z, exit code 1) was never analysed | Read its last 50 status lines. |
| The harness baseline (the claimed 1.5%) | `vitest tests/follower-drive-service.test.ts -t MEASURE`, once no live run is active. |
| Whether the OneDrive config syncs to the leader PC | The user checks once. It matters only for the deferred keybind work. |

**Hand test card (user, about 10 minutes, zero bot input, at the chosen zoom):**

1. On an open straight between two landmarks, by stopwatch or recording:
   - walk;
   - one continuous Space hold;
   - 5 repeats each;
   - time one roll;
   - press a flask mid-sprint.
2. Three single clicks:
   - behind a thin wall, from a quarter-screen away;
   - up a ramp;
   - on unwalkable ground.
3. Left-click a monster with the follower: does it attack in place?
   - If the client offers "Move only", bind it to the left-click slot.
   - Then confirm that item labels are still picked up.
4. Hold a "Move only" key:
   - sweep the cursor round a corner and up a ramp;
   - drag it across a waypoint, an NPC, an item label and a monster.
5. Hold Space with no clicks and move the cursor: does sprint steer to it?
6. Check these three:
   - the death screen in a party, and whether a member can revive;
   - same-area party travel;
   - whether the config syncs between the two PCs.

---

## 9. Critic points not taken, or taken only in part

- **Zoom ratio 2.7×: not adopted as a number.** Label height gives about 2.0–2.1×. The key-pixel estimate mixes line thickness with scale. It is listed as an unknown with a two-frame measurement.
- **"Signal handlers are near-useless": partly taken.** `--stop-file` and `--seconds` are the fix. SIGINT and SIGBREAK stay because Ctrl+C and Ctrl+Break do deliver them in a Windows console, for three lines of code.
- **Loot scan on the map worker in place of pacing ticks: not taken as the first step.**
  - The loot click already dispatches 75–105 ms after its own scan, so a cross-worker hop risks stale loot clicks.
  - Phase 7 removes the scan from chase ticks anyway.
  - It stays as the stated fallback if inter-click p50 exceeds 170 ms.
- **Land `CLEAR_START_CELLS` 5 and outline-only now: not taken as specified.** Those measurements were on the terrain channel that `bbb9272` replaced at 18:07Z. The planner work is moved up to 4f, but it re-measures first.
- **Town and hideout mode as a phase: not taken.** No screen-based town detector exists and nothing was measured. It is listed as an unknown, with the manual-hold hotkey as today's answer.
- **Run the ladder before or alongside Phase 3 live: partly taken.** Development runs in parallel. Live validation stays serial with Phase 3 first, because refusals and 74 ms blind ticks distort the sensor's "emitted clicks in 450 ms" evidence, and Phase 3 is one cheap run.
- **Follower movement speed as a lever: listed (D13), not made a prerequisite.** Median own speed while chasing is 3.3 u/s, so utilisation is the deficit, not top speed.
- **Escape before declaring immobile: deferred to D11.** With no panel open, Escape opens the game menu. The stall frames decide it.
- **Soft crumbs "placed only when provably still": dropped entirely.** A queued click keeps the character walking for up to about 1 s, so "still" is itself an inference.

Everything else the critic raised is folded in above.

---

## 10. Start here

1. **Phase 0 today:** the Space tap, the zoom decision, the D-S decision, the questions, the hand test card, and frames at the chosen zoom.
2. **When the active run ends (about 20:05Z), start Phase 1 in this order:**
   1. run `follower-scorecard.ts` against the existing logs to freeze baselines in `u`;
   2. refit the harness until the old tick order reproduces about 11% refusals;
   3. add the recorders, status fields, shadow sensors and alarms.
3. **Then:** Phase 2a and 2b, then Phase 3. Phase 4 develops in parallel behind its flags.

**Inputs**

- Analysis scripts to port: `C:\Users\evanb\code\follower-live\agents\{analyst-a, analyst-b, latency-path, steering-geometry, odo-trail, designer-path, designer-predict, verifier-pipeline, verifier-path, critic, synth}\`.
- Traces: `C:\Users\evanb\code\follower-live\cli\follow-actions-2026-09-2{0,1}.jsonl`.
- Status logs: `C:\Users\evanb\AppData\Local\Temp\claude\C--Users-evanb-code-poe2-trade-companion\ec27a7db-9f17-4326-8902-011566e4a8a4\tasks\<id>.output`.
- Frames: `C:\Users\evanb\code\follower-live\*.png`. High zoom: `stuck-route-1`, `zoom-1`, `calib-now`, `zoomcheck`. Default zoom: `stuck-cave-1` and earlier.