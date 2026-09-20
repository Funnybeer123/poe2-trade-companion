# Follow & Loot — two-PC companion

Open **Dashboard → Open follower setup** or **Tools & QA → Follow & Loot**.

## Implemented in the first increment

- Persistent PC role, main-character name, LAN address/port, following distance,
  loot leash, loot toggle, score threshold, and confidence preferences.
- Authenticated main-PC listener and follower-PC connection with heartbeat,
  network round-trip measurement, disconnection detection, and reconnect.
- Deterministic planner for follow → loot → verify → follow; off-screen map
  routing; inventory-full behavior; target loss; stale frames; and stalled movement.
- Interactive synthetic route replay. It includes a wall detour and emits no input.
- Emergency stop and application shutdown close peer connections.

At that increment the feature did not recognize ground loot, register maps across
PCs, move a character, or pick up an item. Movement now exists (see "Following by
the overlay map"); loot, map registration between PCs, and area transitions still
do not. A connected peer is not evidence of working game perception. Network
latency is not capture-to-input latency. No API model is required at runtime.

## Live observation preview (second increment)

**Follow & Loot → Live observation preview** watches the follower PC's game view
for the selected character's nameplate. It is capture-only:

- `scripts/win-follower-host.ps1` contains no input, hook, or cursor API, and
  `FollowerPerceptionService` has no `GameInputController`, input sink, or peer
  transport. Screenshots and observations stay on this PC.
- It captures only while an allowlisted Path of Exile process owns the foreground
  window, and stops on emergency stop, app shutdown, and background smoke runs.

Calibrate: save the character to follow, put the leader on screen, **Capture game
view**, then click two opposite corners tightly around the name above their
character. Optionally select a search area that excludes the party panel if it
shows the same name. The main process builds a binary text template from its own
captured pixels (`min(R,G,B)` at an Otsu threshold clamped to 110–235); the
renderer supplies rectangles only. Calibration is saved to
`follower/calibration.json` under the app's user data and survives navigation and
restarts. It is invalidated when the game client size or the selected character
changes; recalibrate after changing resolution, window size, or UI scale.

Observation: each cycle captures either a ±160 px window around the last sighting
or, at least every 2 s and after a loss, the whole search area. Matches are scored
with the Dice coefficient over text pixels, so missing text and surplus bright
pixels both lower the score; 0.6 is the detection floor. Confidence is the score
scaled down when a second, non-overlapping candidate scores within 0.1 of the
best, reaching zero for identical nameplates. The screen shows identity and
method, position in client pixels, confidence against your configured minimum,
evidence (score, next-best score, matched/template pixels, candidates, search
mode), observation age, and capture/match/cycle timings.

Known limits, none yet measured on real gameplay:

- All automated tests use **synthetic** frames and a scripted capture host. No
  accuracy, false-acquisition rate, or frame rate has been measured in the game.
- A nameplate position is a screen position, not a map position. Nothing feeds
  `FollowerPlanner` yet.
- There is no gameplay-state detection: menus, loading screens, and cutscenes
  simply produce "not visible".
- Template matching assumes the name renders at a fixed pixel size. Bright or
  busy scenery behind the text, partial occlusion, and similar names lower or
  confuse scores. Borderless/windowed modes are required for screen capture.
- Full frames cross a PowerShell pipe as base64; expect well below the 30–60
  observations/second target during full searches until this is measured and,
  if needed, replaced.

## Following by the overlay map (third increment)

**Follow & Loot → Follow by overlay map** moves this PC's character toward the
leader. It was designed from live frames of the game at 2560 × 1440:

- With the **overlay map open** (Tab), the game draws the player's own marker as an
  orange X at the map centre (about 0.4998 × width, 0.4858 × height of the client)
  and each party member as a saturated-green X with a green name label above it.
  The vector between the two is the direction and distance to the leader, on
  screen or off. In one real frame only 321 of 3.7 million pixels were that green.
  In-world nameplates are not shown for party members, so the second increment's
  white-nameplate template does not see them; the map label does.
- `scripts/win-follower-host.ps1` gained a `key` op: one capture, then only the
  coordinates of pixels passing a colour-channel threshold cross the pipe
  (green = G − max(R,B), orange = min(R − G, G − B)). It remains capture-only.
- `src/core/followerMapMarker.ts` holds the pure logic. `findTemplateSparse` is the
  same Dice-scored template search as `findNameplate`, over sparse pixels.
  `buildMapCalibration` finds the label/marker pair automatically when exactly one
  party label is on the map (otherwise pass a rectangle around the label: the
  terminal runner takes `--label x,y,width,height`; the app has no selection UI
  yet, so calibrate while the leader is the only other member on the map), and requires
  the orange marker inside a small box at the overlay-map centre, so the corner
  minimap or orange scenery cannot calibrate. `MapMarkerTracker` searches a window
  around the last label and the whole view at least every second, and verifies on
  every capture that the orange marker is still where calibration put it: an open
  side panel shifts the map centre, and steering from a wrong centre would walk the
  wrong way. Our marker found somewhere else, or the leader's label jumping more
  than 30 px between captures, withdraws that trust at once; a marker that is
  merely hidden (effects, the leader standing on it) keeps it for 1.5 s (10 s when
  covered by the leader). A name that merely contains the leader's ("RangerTwo"
  for "Ranger") is rejected by checking for ink beside the match, and a rival seen
  by the once-a-second full search keeps confidence low during window searches
  too. Calibration cannot read names: it shows the captured label so the operator
  can check it. `FollowSteering` clicks only when the label confidence passes your
  minimum **and** the map centre is verified. It has stop/resume hysteresis, paces
  clicks, and aims at `centre + direction × clamp(distance × map scale, 0.06 h,
  0.26 h)`. When the label is not visible it sends nothing: the character finishes
  its last move and stands still. There is no blind pursuit.
- Input: `src/main/followerDriveService.ts` sends every click through
  `GameInputController` (kill switch, process allowlist, navigation module flag,
  confidence threshold, 600 actions/minute, dry-run, structured trace) into
  `FollowerInputSink`, then `scripts/win-follower-input-host.ps1`, a separate
  compiled worker that never captures. Natively, before each click, it re-checks:
  the capture the decision came from is at most 120 ms old (system-wide QPC time
  shared with the capture worker); the foreground window is an allowlisted Path of
  Exile process and the same window and client size that were captured; the target
  lies inside a central disc (0.30 × height) clear of the HUD; no modifier key or
  physical mouse button is held; mouse buttons are not swapped; and nobody moved
  the mouse since its last click. It then places the cursor, waits 12 ms (with a
  1 ms timer period), re-checks all of that plus that the window under the cursor
  is the game, and sends button down and up as one OS batch, so nothing can stay
  held. Holding a mouse button or moving the mouse takes control back, and it
  stays away until the cursor has rested for a second; Ctrl+Shift+Esc stops
  everything. A run started as a preview never sends input, even if a dry-run
  switch is turned off while it runs: it stops and must be started again.
- Preview is the default: `drive.json` starts with `dryRun: true`, and the app-wide
  Dry-run switch also forces preview. Traces are appended to
  `follower/follow-actions-YYYY-MM-DD.jsonl`.
- `npm run follower:live -- --target <Leader> [--seconds 20] [--calibrate] [--live]`
  runs the same service from a terminal so the game keeps focus. Without `--live`
  it sends nothing. With `--live` it refuses to start until the emergency-stop
  monitor is ready, and always ends after `--seconds`.

### Following the leader's path, and getting round walls

Aiming straight at the leader walks into whatever they went round (seen live: 1,239
clicks into a building in three minutes). Two mechanisms replace that:

- **Trail.** `src/core/followerTrail.ts`. The overlay map is centred on the player,
  so its blue outlines (`blue = B − R`, threshold 60) slide across the screen as
  the player moves. `MapOdometry` votes for the slide between consecutive captures
  in a window around the map centre (±9 px search, at most 450 sampled points,
  2–6 ms) and refuses ambiguous slides (support below 30 %, or a rival shift
  within 10 %); a gap over 250 ms, a missing map, or six unmatched captures starts
  a new epoch. Adding the leader's offset to the player's position records where
  the leader has been (`LeaderTrail`, one point per 6 map px, 600 points). Steering
  aims 45 map px further along that trail than the point on it nearest to us, and
  straight at the leader only within 35 map px or when the trail has nothing to
  add. The trail only exists for what the follower watched: a cold start behind a
  building has none.
- **Wall-following.** `FollowSteering`. Six committed clicks that move us less
  than 2.5 map px in 1.5 s (own movement from odometry; the change in the leader's
  offset when odometry is not tracking) mean we are against something. It then
  holds a heading 60° to one side of the goal; turns 35° further away each time
  that heading is blocked for 0.9 s; eases 25° back toward the goal each 0.8 s it
  is moving, which hugs a wall round its corners; returns to the straight line
  when the heading is within 25° of it; tries the other side after turning more
  than 200° or after 25 s without getting 20 map px nearer; and rests 5 s after
  both sides fail. It is reactive, not pathfinding. In a simulated world whose
  character stops dead at walls it gets round a wall, a large building and two
  staggered walls, with and without odometry, and rests when sealed in.

### Reading the landscape and planning a way round it

Reacting to walls only after hitting them is slow and, from a cold start behind
a building, failed live. `src/core/followerTerrain.ts` reads the terrain the
overlay map already draws and plans before moving:

- **What counts as wall.** One native plane, `terrain`: the walkable-area outline
  (lavender; `B − max(R,G) ≥ 14` with `B ≥ 90`, which also takes the bright-blue
  water edges) or a building model (translucent white: `max − min ≤ 22` and
  `max ≥ 125`). Measured on a real frame: 2,586 outline and 15,699 building
  pixels in an 864 × 634 window, with only specks of scenery. The outline alone
  is not enough: where it crosses a white building model it is washed out, and
  on the real frame a path leaked through exactly such a gap next to the player.
- **Planning.** Five times a second the capture-only host returns those pixels
  for a window around the map centre (inside the world view, clear of the HUD).
  They become walls on a 4 px grid, dilated by one cell; A* (8 neighbours, no
  corner cutting, extra cost beside walls) runs from the player's marker to the
  leader's, or to where the line toward the leader leaves the window. Steering
  aims at the farthest point within 56 map px along that path that is reachable
  in a straight line. Unexplored map has no walls, so the path goes out through
  explored openings and then straight. On the real stuck frame it planned back
  down the corridor, out its open end, and round the building (1,045 px) in
  11 ms; typical plans take 3–7 ms.
- **Bump memory.** The map can be wrong or unexplored. Five committed clicks in a
  second that move the character less than 2.5 map px record a wall 14 px ahead,
  in the odometry frame, for 45 s (same odometry epoch only); the next plan goes
  round it. The same spot is therefore not tried twice. A bump needs positive
  evidence of standing still: tracked odometry samples covering the whole second
  of clicks. Blind odometry, a gap in it, or a previewed click proves nothing.
- **Guards.** More than 30 % of the grid cells blocked (a grey stone floor, a
  bright scene, speckle) means the map is being misread: no plan. No path (leader sealed
  off on the map) also means no plan. Without a plan steering falls back to the
  leader's trail, then to the straight line with reactive wall-following.
- Priority of where to aim: the trail the leader actually walked, while following
  it has not bumped into anything; otherwise the terrain plan (cold start, new
  odometry epoch, or after a bump); then straight at the leader, which is also
  used within 35 map px. The plane is a bare colour test, so item labels on screen
  can read as walls: a walked path is better evidence than a planned one.
- Reactive wall-following gives way to a plan or trail whose aim swings more than
  45° away from the side being felt along (90° either way), and its 25 s side
  timer only runs within 6 s of actually being blocked.

In the simulated world (character stops dead at walls) it rounds a mapped wall,
a building and two staggered walls with **no** bumps, leaves a dead-end pocket
the way it came in, and learns an unmapped wall after one or two bumps.
It depends on this zone's map colours; zones whose scenery is grey, white or blue
may trip the 30 % guard and fall back.

Changes after the first live runs:

- The planning window is now the whole world view (10–80 % of the width, 5–80 % of
  the height), scanned by a **second capture-only worker** about four times a
  second so marker tracking never waits for it. A real frame of a built-up area
  produced 56,264 wall pixels; the cap is 50,000 in the loop and 60,000 natively.
- **Goal selection.** When the straight line toward the leader is walled off, the
  plan heads for the reachable place nearest to them: preferably where walkable
  ground runs off the edge of the view (if that is not more than 160 map px farther
  from the leader than we are), else the nearest reachable spot, and only if it is
  nearer than where we stand. That goal is **committed** in the odometry frame for
  12 s, until reached or unreachable: in the first live run without commitment the
  plan flipped between exits (path lengths 200–2,335 px) and the character wandered
  for 85 s before making progress.
- **Marker-only sightings.** Far away, the leader's name label leaves the screen
  before the marker does; on a real frame the marker sat complete on the top edge
  of the view, the only green thing in it, which suggests the game pins far party
  markers to the screen edge. Calibration now also keeps the bare marker sprite.
  When the label is not found, a marker is believed only if it is the single one in
  view and either its label would be off-screen there or it is within 40 px of where
  the labelled leader was in the last 0.7 s; its score is scaled by 0.95. A clamped
  marker gives direction, not distance.
- With the leader's marker drawn over ours the remains of ours match a few pixels
  off; that is treated as cover, not as a moved map (it paused for 6 s live).

### Sprint

With `sprint` on (terminal: `--sprint`), space is held while the follower is
heading somewhere and at least 70 map px behind (let go under 40, for loot, for
manual control, near the leader, and whenever a sighting is not trusted). The
first press goes through `GameInputController` on the back of an accepted
movement click; renewals are re-checked natively with every guard a click has
and **can never press the key**: a hold that lapsed (watchdog, refusal) answers
"Sprint lapsed" and must be started again through the controller. The first
press is refused while a person already holds space. Letting go is never
refused, and happens before every loot click, after any refused click and on a
failed capture. The input worker releases the key itself if it is
not renewed within 350 ms, on any refusal of a sprint or a click, on `release`,
and when it ends. On stop the worker is kept alive, and asked again, until it
reports the key released (a secure desktop rejects input for a while). If the
worker process is killed outright while holding, the key stays logically down
until space is pressed once. **Not yet exercised live.**

### Loot pickup

With **Collect nearby eligible loot** on (terminal: `--loot`, `--leash`), every
250 ms, while following a leader no more than **two leashes** away with a trusted
sighting and a verified map centre, the capture-only host scans the world view (10–80 % of the
width, 5–80 % of the height: clear of the HUD, party frames and quest tracker) and
`src/core/followerLoot.ts` looks for ground-item labels two ways, both designed
from real frames:

- **Flat fills.** Rows of one flat colour across the label (top padding), rows
  broken by text, flat rows again, same left and right edges. Found the opaque
  orange "Lesser Desert Rune" label and the translucent dark-blue "Rawhide Belt".
- **Hue blocks.** A translucent label with a vivid border, fill and text is too
  noisy to be flat, and a drop beam behind it shifts its brightness, but it keeps
  one hue class (30° buckets, saturation ≥ 50 %, brightness ≥ 45) from edge to
  edge on nearly every row. Found the yellow-on-olive rare "Lapis Amulet" (61 of
  63 rows) that the flat detector missed.

**Dark labels are not clicked.** A flat fill must be bright (max channel ≥ 110) or
clearly coloured (chroma ≥ 35 % of its brightest channel, and ≥ 45 bright); a black
box lifted to grey by a bright backdrop fails both. A black box tinted by a
strongly coloured backdrop remains indistinguishable from a dim coloured fill. Doors, area transitions, waypoints, NPCs, the
ritual altar, and items your filter leaves unstyled all use the same near-black
box with white text; nothing in the pixels tells them apart, and clicking a
transition would leave the leader. Use an item filter that gives wanted items a
coloured background or border: a catch-all `Show` block with `SetBackgroundColor`
at the END of the filter styles everything earlier rules left alone, which is the
whole answer to "pick up anything on the ground".

Reading them anyway was tried and **rejected on measurement** (reverted in
`fd13f85`). A near-black fill carries a few counts of noise, so its rows split at
random columns under the 3-count run rule; a looser tolerance between two
near-black pixels (6) fixes that and does find the measured "Stitched Gloves" box
exactly (258 x 45 px at 1916, 221). It is not enough. Over six saved frames it
found **one of seven** real dark item labels and **sixteen** boxes that were panel
chrome, quest-tracker rows or plain shadow (one of them 943 px wide), and
dropping the brightness floor to 0 pushed two of the six past the native
4000-run cap, which discards the whole scan. The idea for telling a drop from
furniture - furniture can only enter across the edge of the view, while an item
appears in the middle of ground already seen and reported empty - is sound and
survives in that commit, but it cannot rescue a detector that is wrong nine times
in ten, and screen-fixed chrome does not move with the camera at all. On seven saved real frames the detector found all
four coloured labels and nothing else (none of nine black item labels, four NPC
and object labels, the Options panel, or the ritual tooltip).

It clicks the label nearest the character, through the same controller and native
worker as movement but with module `loot` and a separate click area (the world
view rectangle instead of the central disc), then leaves the character alone for
450 ms to walk there. Only labels within the leash **of the character**
(screen offset ÷ map scale) are considered, so the detour is bounded; a label
across the screen is not worth leaving the leader for, however near to them it
lies. Scanning does not wait until the follower has caught up, because items drop
where the leader fights: in the first live run with that rule there were 22 loot
scans in 180 s. Beyond two leashes, catching up is all that matters. The camera scrolls while the character runs, so a label is clicked on its
second sighting, led by its own drift between the two scans (70 ms worth); a
label that sits still is clicked at its centre. Loot labels have their own fixed
confidence floor (0.85); the leader-label confidence preference does not apply
to them. Two neighbouring labels that the detector joins are clicked on a real
piece, never in the gap between them. Rejoining the leader always comes first: beyond the leash it
stops looting and follows. Labels move with the camera, so an item cannot be
recognised between scans; five clicks in a row that never reduce the number of
labels (full inventory, unreachable item) make it back off for 6 s, doubling up
to 96 s. A lower count must be seen on two scans in a row to count as a pickup,
so one missed detection does not reset that. A backoff or an empty scan does not
interrupt following.

Requirements and limits:

- Mouse movement (`use_wasd_to_move=false`) with left-click bound to move; the
  overlay map open rather than the corner minimap; the leader in the same area.
- It follows through doors, portals and area transitions by teleporting: when the
  leader's marker has been absent for 3 s while our own map centre is still
  verified, it looks for the party frame's blue "travel to party member" swirl and
  clicks it, at most once every 10 s. The swirl was measured at x 11..38, y 322..349
  (28 x 28 px, centre 25,336) on a 2560 x 1440 frame: the existing `blue` channel
  (B - R) at threshold 60 gives 423 points bounded exactly to it, and nothing else
  in the band. It is scanned on the second capture worker, never on the marker
  capture that a click's 120 ms freshness is bound to. The button is present whether
  or not the leader is in our area, so it is never itself the signal that they left.
  The click needs its own tight native area, `party`: x below 3.5 % of width and
  y between 16 % and 50 % of height, which cannot reach the movement disc or the
  loot rectangle. It cannot open the map itself. Round obstacles it has the leader's trail and reactive
  wall-following (above), not a planner: a maze, or a cold start far behind several
  buildings, can still defeat it. A click can land on an item label, NPC, or object and interact
  with it; if that opens a panel the map centre check pauses following.
- Map scale (screen pixels per map pixel) is an estimate from one frame (≈ 7).
- Status reports observations/second, cycle time, and native capture-to-click time
  at the 50th and 95th percentile, plus a worst-case reaction estimate (one full
  cycle plus capture-to-click). See "Measured results" below for what has actually
  been measured; anything not listed there has not been.

### Measured results

One PC (2560 × 1440 borderless, Windows 11), one short session on 2026-09-19,
follower character next to a stationary leader. Small samples; not a soak test.

| What | Result |
| --- | --- |
| Capture cost, 400 × 400 window / full view | 8–27 ms / ≈ 45 ms (GDI `CopyFromScreen`, incl. channel pass) |
| Native key-pixel scan, full 2560 × 1440 | 5.5 ms (synthetic bitmap) |
| Sparse label match on a real frame | ≈ 10 ms first call, 426 green pixels; score 1.0, no rival |
| Dry-run loop, overlay map open | 34 observations/s; cycle 19 / 28 ms (median / 95th) |
| Live walk-up: 89 → 9.4 map px | ≈ 2 s, 13 clicks, 1 refused at start-up, 0 manual takeovers; stopped inside the following distance and stayed there |
| Live capture-start → click-complete (13 clicks) | 47 / 64 ms (median / 95th), native QPC |
| Worst-case reaction estimate (95th) | 92 ms = one cycle (28) + capture→click (64) |
| Live idle, leader stationary, 45 s | 1,678 observations at 37/s, 0 clicks, 0 refusals |
| Live walk-up after the review fixes and 1 ms timer: 194 → 7.8 map px | 4.5 s, 29 clicks, 0 refused, 0 manual takeovers; 36 observations/s, cycle 17.6 / 26.9 ms |
| Capture-start → click-complete after the fixes (29 clicks) | 37 / 54 ms (median / 95th) |
| Worst-case reaction estimate after the fixes (95th) | 81 ms = one cycle (27) + capture→click (54) |

| Live, leader running around for ≈ 46 s | 274 clicks, 0 refused, 0 manual takeovers; gap 7–106 map px, median 41, closing to ≤ 10 whenever the leader slowed (a level 6 follower cannot outrun a level 95 leader) |
| Reaction to the leader moving off (6 events): capture-start → first click complete | 42 / 60 ms (median / 95th); worst case incl. one cycle ≈ 100 ms |
| Same run, from ≈ 48 s | The label vanished, then returned with our own marker no longer at the map centre: the loop paused and sent nothing, as designed. The cause on screen was not recorded (no screenshot is kept). The game then lost focus and the loop idled to its time limit. |

| Live, straight-line chase into a building (before trail and wall-following) | Stuck 237 map px away for 3 min: 1,239 clicks, no progress. The later angle sweep moved it (237–290 px) but fell back into the same pocket; the operator freed it by hand |
| Map odometry on live captures | Tracking on 351 of 354 half-second samples in one run and 352 of 355 in the next; reported support 0.36–1.0 |
| Loot, live | 4 pickup clicks in one 3-minute run, each followed by the label count dropping to 0; 0 refused, 0 manual takeovers. 7 in the previous run, with the older detector |
| Loot scan cost | Native flat-run scan 5.7 ms and the loop's cycle 27 / 37 ms (median / 95th) with loot scanning on, against 18 / 27 ms without |

| Live, terrain planning, first run (no goal commitment, scan on the tracking worker) | From 641 map px away: 85 s of wandering (plan flipping between exits), then 613 → 186 px in 35 s; 10 bumps learned, 0 manual takeovers; loop slowed to 13 observations/s, capture→click 71 / 102 ms |
| Live, terrain planning with committed goals and its own map worker | Reached the leader from 243 map px in ≈ 7.6 s by the plan; then followed a moving leader for ≈ 100 s: near 16 samples, gap median 86 map px (max 383 at the end as the leader ran off), **0** wall-blocked samples, 18 loot pickups, 1 manual takeover, 17 stale refusals of 791 clicks |
| Loop speed with the map worker running | 18.9 observations/s, cycle 29.7 / 50.5 ms, capture→click 50 / 111 ms, first click after the leader moves off 6 times, worst-case reaction estimate 162 ms (95th). Slower than without planning (37/54 ms): decoding ≈ 40,000 wall pixels and A* share the JavaScript thread with the tracking loop |

The one-batch down/up click (no hold) is accepted by the game as a move.

Trail-following and wall-following have **not** been exercised live yet: in the
only run since they were added the leader stayed within 29 map px. Their evidence
is the simulation and unit tests only.

Not measured: accuracy with several party members or look-alike names, behaviour in combat
effects, long sessions, and a second PC's hardware. Human visual reaction time is
commonly around 200–250 ms; the 81–92 ms figures are this loop's own worst case
for sending a click, not the character's movement speed.

## Recording and measuring on real gameplay

Synthetic tests cannot say how well perception works in the game. To measure it:

1. **Record.** On the follower PC, with both characters in the same area, press
   **Record 20 s for testing** and switch to the game. The capture-only host writes
   about four full-view PNG frames per second plus `manifest.json` to
   `follower/recordings/<timestamp>/` under the app's user data (the screen shows
   the path). Only moments when the game is focused are recorded; resizing the game
   ends the recording. Useful scenes: leader walking across the screen, leader
   behind scenery or effects, another player with a similar name nearby, leader
   leaving the screen, a menu or the map overlay open, a loading screen.
   Recordings are full screenshots: they show character names and chat. They stay
   on this PC and are not sent to the peer. Do not commit them without checking.
2. **Replay.** `npm run follower:replay -- "<recording directory>"` runs every frame
   through the same `LeaderTracker` as the live preview, using recorded offsets as
   the clock, and prints per-frame position, score, next-best score, confidence,
   and match time. It reads `calibration.json` from the app's follower directory
   unless `--calibration <file>` is given; `--gate 0.85` sets the confidence gate.
   Without labels this output is **not** an accuracy measurement.
3. **Label.** Add `labels.json` beside the manifest. Give the rectangle around the
   leader's name text, or `null` when the leader is not visible. Unlisted frames
   are ignored.

   ```json
   { "version": 1, "targetName": "ExactLeaderName", "frames": {
     "frame-0001.png": { "leader": { "x": 1210, "y": 540, "width": 96, "height": 14 } },
     "frame-0040.png": { "leader": null, "note": "loading screen" } } }
   ```
4. **Measure.** Replay again. It reports recall, recall at the gate, misses, and —
   most important before any input is connected — **accepted but wrong** sightings
   (false acquisitions or wrong locations whose confidence passed the gate). Figures
   describe that recording only; record several scenes before drawing conclusions.

A tracking window cannot see a look-alike elsewhere on screen; only the periodic
full search (every 2 s) can. Replay reproduces this, so look-alike errors can
persist for up to 2 s in the results just as they would live.

## Connect two PCs

1. Run this build on both PCs on the same local network.
2. On the main PC choose **Main PC**, enter its local IPv4 address (the app lists
   available addresses), choose a port, and generate a pairing key.
3. On the second PC choose **Second PC**, enter the main PC's address and the same
   port and key. Start the main listener, then connect the follower.
4. Both screens should report connected. The follower shows authenticated main
   character metadata and network round-trip time.
5. If Windows asks about network access, permit the companion on your private
   network only. This feature does not alter firewall rules or open router ports.

127.0.0.1 is for testing two instances on the same PC. It cannot connect two PCs.
The listener binds only to the selected local interface. Requests and responses
use HMAC-SHA256 with a random 256-bit shared key and a fresh request nonce. Keys
are never transmitted or persisted. Only connection metadata is exchanged; this
transport does not encrypt that metadata. No command or screenshot endpoint exists.
Start/stop is explicit; restart always begins disconnected. Saving preferences
closes the connection. Navigating away leaves an active connection running, but
clears the displayed key. Stopping/reconnecting after returning requires the key again.

## Planner contract

`FollowObservation` uses map-cell coordinates in an already aligned map, not
screen pixels. A live adapter must provide actual identity, map registration,
walkability, confidence, gameplay state, and pickup evidence before using it.
Unknown cells are blocked. Four-way BFS avoids diagonal corner cutting. These
cells are not automatically extracted from a screenshot in this increment.

Observations expire after 500 ms. Duplicate/out-of-order and future timestamps
are rejected. Timestamp comparisons use the receiver's monotonic clock domain;
a future live adapter must convert observation age without assuming synchronized
PC clocks. Peer RTT is measured separately with the local monotonic clock.

Pickup confirmation must be explicit: disappearing labels alone are not proof.
After two unconfirmed attempts, skip that item for the area. Leaving the screen
or exceeding the leash interrupts looting. Full inventory disables loot, not
following. Missing identities, different areas, unknown routes, or no movement
progress cause acquisition/pause decisions. There is no invented teleport or
blind recovery input.

## Next implementation milestones

1. Recorded-frame datasets for character/nameplate detection (occlusion, similar
   names, menus, loading screens, target disappearance). Measure correct identity,
   false acquisitions, and achieved observation rate; add gameplay-state detection.
2. Main-PC route observations and matching map landmarks on the follower PC.
   Extend the authenticated peer protocol with versioned, bounded observations,
   freshness checks, and map-registration evidence.
3. Connect verified decisions to `GameInputController`, preserving focus/process
   allowlisting, global dry-run, emergency cancellation, action limits, and traces.
4. Loot-label detection, inventory evidence, and verified pickup outcomes.
5. Door/zone transitions, bounded stuck recovery, soak tests, and intervention metrics.

Do not mark live following or unattended operation complete on the strength of
synthetic replay or a network heartbeat. Validate on recorded and real two-PC
sessions and record the limitations.

## Verification

Run `npm run typecheck`, `npm run lint`, and `npm run test:all`. Dedicated tests
cover navigation/loot replay, malformed observations, identity/freshness failures,
real socket pairing/reconnect, secret-free persistence, shutdown, and UI behavior.
`tests/follower-perception.test.ts` and `tests/follower-perception-service.test.ts`
cover template building, search, ambiguity, tracking, calibration invalidation,
focus loss, and the emergency latch on synthetic frames.
`tests/follower-fixture.test.ts` covers recorded-PNG decoding and the replay
metrics, again on synthetic recordings.
`powershell.exe -NoProfile -File scripts/test-follower-host.ps1` checks the native
host without capturing the desktop and asserts it references no input API.
Packaged Electron smoke tests exercise the screen and replay with game input and
network startup disabled.
